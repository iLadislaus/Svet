// 🖼️ Тексты: график адреса, подпись адреса
import { bar, LEGEND, intervalsText, daySlots, dayKeys, timeline, nowStatus, groupLabel, dateLabel, clock } from "./schedule.js";
import { esc } from "./tg.js";
import { now } from "./db.js";

export const addrTitle = (a) => `${esc(a.name)}`;
export const addrLine = (a) =>
  `${esc(a.name)} — ${esc(a.street)}, ${esc(a.house)}${a.city !== "м. Одеса" ? ` (${esc(a.city)})` : ""}`;

// dayIndex: 0 — сегодня, 1 — завтра
export function renderGraph(a, fact, dayIndex = 0, factAt = null) {
  const keys = dayKeys(fact);
  const todayKey = Number(fact.today) || keys[0];
  const key = dayIndex === 0 ? todayKey : keys.find((k) => k > todayKey);
  const groups = a.groups.length ? a.groups : [];
  const head = `📊 <b>${addrTitle(a)}</b> · ${esc(a.street)}, ${esc(a.house)}`;
  if (!groups.length) return `${head}\n\n❔ ДТЕК не указал очередь для этого дома.`;
  if (!key) {
    return `${head}\n\n📅 График на завтра ещё не опубликован. Пришлю, как только появится 🔔`;
  }
  const parts = [head + ` · ${dateLabel(key)}`];
  for (const g of groups) {
    const slots = daySlots(fact, key, g);
    if (!slots) { parts.push(`\n⚡ Очередь ${groupLabel(g)}: нет данных`); continue; }
    let block = `\n⚡ Очередь <b>${groupLabel(g)}</b>\n${bar(slots)}\n${intervalsText(slots)}`;
    if (dayIndex === 0) {
      const st = nowStatus(timeline(fact, g), now());
      if (st) block += `\n${st}`;
    }
    parts.push(block);
  }
  parts.push(`\n<i>${LEGEND}</i>`);
  const upd = fact.update ? `🕒 ДТЕК обновил: ${esc(fact.update)}` : "";
  const stale = factAt && now() - factAt > 3600 ? `\n⚠️ Данные могут быть устаревшими (загружены в ${clock(factAt)})` : "";
  if (upd || stale) parts.push(`<i>${upd}${stale}</i>`);
  return parts.join("\n");
}

export function graphButtons(a, dayIndex) {
  return [[
    { text: dayIndex === 0 ? "• Сегодня •" : "⬅️ Сегодня", callback_data: `g:${a.id}:0` },
    { text: dayIndex === 1 ? "• Завтра •" : "Завтра ➡️", callback_data: `g:${a.id}:1` },
  ], [{ text: "🔄 Обновить", callback_data: `g:${a.id}:${dayIndex}` }]];
}
