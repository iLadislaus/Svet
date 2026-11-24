// 🖼️ Тексты: график (вариант B2 — коротко), адреса, длительности
import { daySlots, dayKeys, timeline, intervals, groupLabel, groupEmoji, dateLabel, clock, hm } from "./schedule.js";
import { esc } from "./tg.js";
import { now } from "./db.js";

const short = (s) => String(s).replace(/^(вул\.|просп\.|пров\.|бул\.|пл\.|узвіз|туп\.)\s*/i, "");
export const addrShort = (a) => `${esc(short(a.street))}, ${esc(a.house)}`;
export const groupsText = (a) => (a.groups.length ? a.groups.map(groupLabel).join(", ") : "—");
export const groupsEmoji = (a) => (a.groups.length ? a.groups.map(groupEmoji).join(", ") : "—");

export function dur(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

// Сейчас: «Свет есть · выключат в 17:00 · через 1 ч 35 мин»
function nowBlock(tl, t) {
  const idx = tl.findIndex((x) => x.t <= t && t < x.t + 1800);
  if (idx < 0) return null;
  const cur = tl[idx].s;
  let j = idx;
  while (j < tl.length && (cur === "on" ? tl[j].s === "on" : tl[j].s !== "on")) j++;
  const next = j < tl.length ? tl[j] : null;
  const left = next ? dur(Math.max(1, Math.round((next.t - t) / 60))) : null;
  if (cur === "on") {
    const what = next && next.s === "maybe" ? "возможно отключение в" : "выключат в";
    return `🟢 <b>Свет есть</b>\n${next ? `${what} ${clock(next.t)} · через ${left}` : "отключений больше не запланировано"}`;
  }
  const title = cur === "maybe" ? "Возможно отключение" : "Света нет";
  return `${cur === "maybe" ? "🟡" : "🔴"} <b>${title}</b>\n${next ? `включат в ${clock(next.t)} · через ${left}` : "время включения пока неизвестно"}`;
}

function offList(slots) {
  const list = intervals(slots);
  const offMin = list.filter((x) => x.type === "off").reduce((s, x) => s + (x.to - x.from) * 30, 0);
  const lines = list.map((x) => `${x.type === "maybe" ? "🟡" : "🔴"} ${hm(x.from)} – ${hm(x.to)}  <i>·  ${dur((x.to - x.from) * 30)}${x.type === "maybe" ? ", возможно" : ""}</i>`);
  return { lines, offMin };
}

// dayIndex: 0 — сегодня, 1 — завтра
export function renderGraph(a, fact, dayIndex = 0, factAt = null) {
  const keys = dayKeys(fact);
  const todayKey = Number(fact.today) || keys[0];
  const key = dayIndex === 0 ? todayKey : keys.find((k) => k > todayKey);
  const day = dayIndex === 0 ? "сегодня" : "завтра";
  const out = [`${/^[\p{L}\p{N}]/u.test(a.name) ? "🏠 " : ""}<b>${esc(a.name)}</b> · ${addrShort(a)}`];
  if (!a.groups.length) return out.concat("", "ДТЕК не указал очередь для этого дома").join("\n");
  if (!key) {
    out.push(`<i>${groupsEmoji(a)} очередь</i>`, "", "График на завтра ещё не опубликован.\nПришлю, как только появится.");
    return out.join("\n");
  }
  out.push(`<i>${groupsEmoji(a)} очередь · ${dateLabel(key)}</i>`);
  const t = now();
  a.groups.forEach((g, i) => {
    const slots = daySlots(fact, key, g);
    if (a.groups.length > 1) out.push(...(i ? ["", "· · ·", ""] : [""]), `<b>${groupEmoji(g)} очередь</b>`);
    if (!slots) { out.push("", "нет данных"); return; }
    out.push("");
    if (dayIndex === 0) {
      const nb = nowBlock(timeline(fact, g), t);
      if (nb) out.push(`<blockquote>${nb}</blockquote>`, "");
    }
    const { lines, offMin } = offList(slots);
    if (!lines.length) out.push(`<b>Без света ${day} — нет</b> 🎉`);
    else out.push(`<b>Без света ${day}</b>${offMin ? ` · ${dur(offMin)}` : ""}`, "", ...lines);
  });
  if (factAt && t - factAt > 3600) out.push("", `<i>Данные ДТЕК от ${clock(factAt)}, сайт не отвечает</i>`);
  return out.join("\n");
}

export function graphButtons(a, dayIndex) {
  return [[
    { text: dayIndex === 0 ? "• Сегодня" : "Сегодня", callback_data: `g:${a.id}:0` },
    { text: dayIndex === 1 ? "• Завтра" : "Завтра", callback_data: `g:${a.id}:1` },
  ]];
}

// Сводка дня для уведомления об изменении графика — по каждой очереди
export function daySummary(a, fact, dayKey) {
  const lines = [];
  for (const g of a.groups) {
    const slots = daySlots(fact, dayKey, g);
    if (!slots) continue;
    const { offMin } = offList(slots);
    const list = intervals(slots).map((x) => `${x.type === "maybe" ? "🟡" : "🔴"} ${hm(x.from)}–${hm(x.to)}${x.type === "maybe" ? "?" : ""}`);
    const txt = list.length ? list.join("  ") + (offMin ? ` · ${dur(offMin)}` : "") : "🟢 отключений нет";
    lines.push(`<i>${groupEmoji(g)} очередь:</i> ${txt}`);
  }
  return lines.join("\n") || "<i>нет данных</i>";
}
