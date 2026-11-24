// ⏰ Cron каждые 5 минут: обновление данных ДТЕК, изменения графика, аварии, предупреждения
import { ensureSchema, loadDtek, allAddressesWithUsers, getCache, setCache, markSent, now } from "./db.js";
import { fetchHouses } from "./dtek.js";
import { timeline, events, clock, hashDay, dayKeys, groupLabel, groupEmoji, qEmoji } from "./schedule.js";
import { graphButtons, daySummary, dur } from "./render.js";
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
        await notify(a, key, `📅 <b>${esc(a.name)}</b> — ${what}\n\n${daySummary(a, d.fact, day)}`, inline(graphButtons(a, dayIndex)));
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
        const houseState = new Map(); // состояние отключения считаем один раз на дом
        for (const a of list) {
          const h = houses[a.house];
          if (!h) continue;
          // очередь дома могла смениться
          const groups = h.sub_type_reason || [];
          if (groups.length && JSON.stringify(groups) !== JSON.stringify(a.groups)) {
            const was = a.groups.map(groupLabel).join(", ") || "—";
            await env.DB.prepare("UPDATE addresses SET groups = ? WHERE id = ?").bind(JSON.stringify(groups), a.id).run();
            if (a.notify_changes) {
              await notify(a, `grp|${a.id}|${groups.join(",")}`,
                `🔁 <b>${esc(a.name)}</b> — очередь изменилась\n\n<i>была ${was} → стала ${groups.map(groupLabel).join(", ")}</i>`);
            }
            a.groups = groups;
          }
          const stateKey = `out:${a.city}|${a.street}|${a.house}`;
          if (!houseState.has(stateKey)) {
            const cur = h.sub_type ? `${h.sub_type}|${h.start_date}|${h.end_date}` : "";
            const prev = await getCache(env, stateKey);
            if (!prev || prev.value !== cur) await setCache(env, stateKey, cur);
            houseState.set(stateKey, { cur, prev: prev ? prev.value : null });
          }
          const { cur, prev } = houseState.get(stateKey);
          if (prev === null || prev === cur || !a.notify_emergency) continue;
          const q = `${a.groups.map(groupEmoji).join(", ") || "—"} очередь`;
          if (cur) {
            const kind = outageKind(h.sub_type);
            const from = dtekTime(h.start_date, t), to = dtekTime(h.end_date, t);
            const len = from && to ? ` · ~${dur(Math.round((to.ts - from.ts) / 60))}` : "";
            const range = from ? ` · с ${from.label}${to ? ` до ${to.label}` : ""}${len}` : "";
            const upd = prev ? " (обновлено)" : "";
            await notify(a, `out|${a.id}|${cur}`, `${kind.icon} <b>${esc(a.name)}</b> — ${kind.text}${upd}\n\n<i>${q}${range}</i>`);
          } else {
            await notify(a, `outend|${a.id}|${prev}`, `💡 <b>${esc(a.name)}</b> — свет должен быть\n\n<i>${q} · отключение по данным ДТЕК закончилось</i>`);
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
      const q = `${groups.map((x) => qEmoji(x)).join(", ")} очередь`;
      const until2 = ev.until ? ` · до ${clock(ev.until)} · ${dur(Math.round((ev.until - ev.t) / 60))} без света` : "";
      let text;
      if (ev.kind === "off") {
        text = ev.maybe
          ? `🟡 <b>${esc(a.name)}</b> — возможно отключение в ${clock(ev.t)}\n\n<i>${q} · через ${mins} мин${until2}</i>`
          : `⚠️ <b>${esc(a.name)}</b> — свет выключат в ${clock(ev.t)}\n\n<i>${q} · через ${mins} мин${until2}</i>`;
      } else {
        text = `💡 <b>${esc(a.name)}</b> — свет включат в ${clock(ev.t)}\n\n<i>${q} · через ${mins} мин</i>`;
      }
      await notify(a, key, text);
    }
  }

  // 🧹 Чистка старых отметок
  await env.DB.prepare("DELETE FROM sent WHERE created_at < ?").bind(t - 4 * 86400).run();
  return out;
}

// Тип отключения по тексту ДТЕК
function outageKind(subType) {
  const s = String(subType || "").toLowerCase();
  if (s.includes("стабілізац") || s.includes("графік")) return { icon: "⚡", text: "отключение по графику" };
  if (s.includes("аварі")) return { icon: "🚨", text: "аварийное отключение" };
  if (s.includes("планов") || s.includes("ремонт")) return { icon: "🛠", text: "плановое отключение (ремонт)" };
  return { icon: "⚡", text: esc(s) || "отключение" };
}

// «11:14 24.11.2026» → { ts, label: "11:14" (сегодня) или "11:14 25.11" }
function dtekTime(str, nowTs) {
  const m = String(str || "").match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const [, H, M, d, mo, y] = m;
  const ts = Date.UTC(+y, +mo - 1, +d, +H, +M) / 1000; // «киевское» время как UTC — годится для разницы и сравнения дат
  const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit" }).format(new Date(nowTs * 1000));
  const same = today === `${d.padStart(2, "0")}/${mo.padStart(2, "0")}`;
  return { ts, label: same ? `${H.padStart(2, "0")}:${M}` : `${H.padStart(2, "0")}:${M} ${d.padStart(2, "0")}.${mo.padStart(2, "0")}` };
}
