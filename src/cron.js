// ⏰ Cron каждые 5 минут: обновление данных ДТЕК, изменения графика, аварии, предупреждения
import { ensureSchema, loadDtek, allAddressesWithUsers, getCache, setCache, markSent, now } from "./db.js";
import { fetchHouses } from "./dtek.js";
import { timeline, events, clock, hashDay, dayKeys, groupLabel } from "./schedule.js";
import { graphButtons, daySummary } from "./render.js";
import { send, esc, inline } from "./tg.js";

const WINDOW = 6 * 60; // окно срабатывания (сек) — чуть больше шага cron

function inQuiet(u, ts) {
  if (u.quiet_from == null || u.quiet_to == null) return false;
  const h = Number(clock(ts).slice(0, 2));
  const f = u.quiet_from, t = u.quiet_to;
  return f < t ? h >= f && h < t : h >= f || h < t;
}

const leads = (s) => String(s || "").split(",").map(Number).filter(Boolean);

export async function runCron(env) {
  await ensureSchema(env);
  const d = await loadDtek(env, 540);
  const addrs = await allAddressesWithUsers(env);
  const t = now();
  if (!addrs.length) return { addresses: 0, fresh: d.fresh };

  const out = { addresses: addrs.length, fresh: d.fresh, sent: 0 };
  const notify = async (a, key, text, extra = {}) => {
    if (!(await markSent(env, `${a.chat_id}|${key}`))) return;
    if (inQuiet(a, t)) return; // тихие часы: пропускаем, но помечаем как отправленное
    await send(env, a.chat_id, text, extra);
    out.sent++;
  };

  // 📅 Изменения графика (только когда скачали свежие данные)
  if (d.fresh) {
    const changed = new Map(); // `${day}|${group}` → "changed" | "new"
    const groups = [1, 2, 3, 4, 5, 6].flatMap((n) => [`GPV${n}.1`, `GPV${n}.2`]);
    const prevHashes = (await getCache(env, "hashes"))?.value || null;
    const hashes = {};
    for (const day of dayKeys(d.fact)) {
      for (const g of new Set([...groups, ...addrs.flatMap((a) => a.groups)])) {
        const h = await hashDay(d.fact, day, g);
        if (!h) continue;
        hashes[`${day}|${g}`] = h;
        if (!prevHashes) continue;
        const prev = prevHashes[`${day}|${g}`];
        if (prev && prev !== h) changed.set(`${day}|${g}`, "changed");
        if (!prev && day > Number(d.fact.today)) changed.set(`${day}|${g}`, "new");
      }
    }
    await setCache(env, "hashes", hashes);

    for (const a of addrs) {
      if (!a.notify_changes) continue;
      for (const day of dayKeys(d.fact)) {
        const hit = a.groups.map((g) => changed.get(`${day}|${g}`)).find(Boolean);
        if (!hit) continue;
        const dayIndex = day > Number(d.fact.today) ? 1 : 0;
        const what = hit === "new" ? "появился график на завтра" : `график на ${dayIndex ? "завтра" : "сегодня"} изменился`;
        const key = `chg|${a.id}|${day}|${a.groups.map((g) => hashes[`${day}|${g}`]).join(",")}`;
        await notify(a, key, `📅 <b>${esc(a.name)}</b> — ${what}\n${daySummary(a, d.fact, day)}`, inline(graphButtons(a, dayIndex)));
      }
    }

    // 🚨 Аварийные и текущие отключения по домам
    if (d.session) {
      const streets = new Map();
      for (const a of addrs) {
        const k = `${a.city}|${a.street}`;
        if (!streets.has(k)) streets.set(k, []);
        streets.get(k).push(a);
      }
      for (const [k, list] of streets) {
        let houses;
        try {
          const [city, street] = k.split("|");
          houses = await fetchHouses(d.session, city, street);
        } catch (e) {
          console.error("houses failed", k, e);
          continue;
        }
        for (const a of list) {
          const h = houses[a.house];
          if (!h) continue;
          // очередь дома могла смениться
          const groups = h.sub_type_reason || [];
          if (groups.length && JSON.stringify(groups) !== JSON.stringify(a.groups)) {
            await env.DB.prepare("UPDATE addresses SET groups = ? WHERE id = ?").bind(JSON.stringify(groups), a.id).run();
            if (a.notify_changes) {
              await notify(a, `grp|${a.id}|${groups.join(",")}`, `🔁 <b>${esc(a.name)}</b> — очередь изменилась\n<i>теперь ${groups.map(groupLabel).join(", ")}</i>`);
            }
            a.groups = groups;
          }
          const stateKey = `out:${a.city}|${a.street}|${a.house}`;
          const cur = h.sub_type ? `${h.sub_type}|${h.start_date}|${h.end_date}` : "";
          const prev = await getCache(env, stateKey);
          if (!prev) { await setCache(env, stateKey, cur); continue; }
          if (prev.value === cur) continue;
          await setCache(env, stateKey, cur);
          if (!a.notify_emergency) continue;
          if (cur) {
            const upd = prev.value ? " (обновлено)" : "";
            const end = h.end_date ? ` · примерно до ${esc(h.end_date)}` : "";
            await notify(a, `out|${a.id}|${cur}`,
              `🚨 <b>${esc(a.name)}</b> — ${esc(String(h.sub_type).toLowerCase())}${upd}\n<i>с ${esc(h.start_date || "—")}${end}</i>`);
          } else {
            await notify(a, `outend|${a.id}|${prev.value}`, `💡 <b>${esc(a.name)}</b> — отключение закончилось\n<i>по данным ДТЕК</i>`);
          }
        }
      }
    }
  }

  // ⚠️💡 Предупреждения перед выключением и включением (с указанием очереди)
  for (const a of addrs) {
    const due = new Map(); // одно событие у нескольких очередей → одно сообщение
    for (const g of a.groups) {
      for (const ev of events(timeline(d.fact, g))) {
        const until = ev.t - t;
        if (until <= 0) continue;
        const list = ev.kind === "off" ? leads(a.lead_off) : leads(a.lead_on);
        for (const m of list) {
          if (until > m * 60 || until <= m * 60 - WINDOW) continue;
          const key = `ev|${a.id}|${ev.kind}|${ev.t}|${m}`;
          if (!due.has(key)) due.set(key, { ev, until, groups: [] });
          due.get(key).groups.push(groupLabel(g));
        }
      }
    }
    for (const [key, { ev, until, groups }] of due) {
      const mins = Math.max(1, Math.round(until / 60));
      const q = `очередь ${groups.join(", ")}`;
      const until2 = ev.until ? ` · до ${clock(ev.until)}` : "";
      let text;
      if (ev.kind === "off") {
        text = ev.maybe
          ? `🟡 <b>${esc(a.name)}</b> — возможно отключение в ${clock(ev.t)}\n<i>${q} · через ${mins} мин${until2}</i>`
          : `⚠️ <b>${esc(a.name)}</b> — свет выключат в ${clock(ev.t)}\n<i>${q} · через ${mins} мин${until2}</i>`;
      } else {
        text = `💡 <b>${esc(a.name)}</b> — свет включат в ${clock(ev.t)}\n<i>${q} · через ${mins} мин</i>`;
      }
      await notify(a, key, text);
    }
  }

  // 🧹 Чистка старых отметок
  await env.DB.prepare("DELETE FROM sent WHERE created_at < ?").bind(t - 4 * 86400).run();
  return out;
}
