// 🖼️ Тексты: график (вариант B2 — коротко), адреса, длительности
import { daySlots, dayKeys, timeline, intervals, groupLabel, dateLabel, clock, hm } from "./schedule.js";
import { esc } from "./tg.js";
import { now } from "./db.js";

const short = (s) => String(s).replace(/^(вул\.|просп\.|пров\.|бул\.|пл\.|узвіз|туп\.)\s*/i, "");
export const addrShort = (a) => `${esc(short(a.street))}, ${esc(a.house)}`;
export const groupsText = (a) => (a.groups.length ? a.groups.map(groupLabel).join(", ") : "—");

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
    return `<b>Свет есть</b>\n${next ? `${what} ${clock(next.t)} · через ${left}` : "отключений больше не запланировано"}`;
  }
  const title = cur === "maybe" ? "Возможно отключение" : "Света нет";
  return `<b>${title}</b>\n${next ? `включат в ${clock(next.t)} · через ${left}` : "время включения пока неизвестно"}`;
}

function offList(slots) {
  const list = intervals(slots);
  const offMin = list.filter((x) => x.type === "off").reduce((s, x) => s + (x.to - x.from) * 30, 0);
  const lines = list.map((x) => `${hm(x.from)} – ${hm(x.to)}${x.type === "maybe" ? " <i>возможно</i>" : ""}`);
  return { lines, offMin };
}

// dayIndex: 0 — сегодня, 1 — завтра
export function renderGraph(a, fact, dayIndex = 0, factAt = null) {
  const keys = dayKeys(fact);
  const todayKey = Number(fact.today) || keys[0];
  const key = dayIndex === 0 ? todayKey : keys.find((k) => k > todayKey);
  const day = dayIndex === 0 ? "сегодня" : "завтра";
  const out = [`<b>${esc(a.name)}</b> · ${addrShort(a)}`];
  if (!a.groups.length) return out.concat("", "ДТЕК не указал очередь для этого дома").join("\n");
  if (!key) {
    out.push(`<i>Очередь ${groupsText(a)}</i>`, "", "График на завтра ещё не опубликован.\nПришлю, как только появится.");
    return out.join("\n");
  }
  out.push(`<i>Очередь ${groupsText(a)} · ${dateLabel(key)}</i>`);
  const t = now();
  for (const g of a.groups) {
    const slots = daySlots(fact, key, g);
    if (a.groups.length > 1) out.push("", `<b>Очередь ${groupLabel(g)}</b>`);
    if (!slots) { out.push("нет данных"); continue; }
    if (dayIndex === 0) {
      const nb = nowBlock(timeline(fact, g), t);
      if (nb) out.push(`<blockquote>${nb}</blockquote>`);
    } else out.push("");
    const { lines, offMin } = offList(slots);
    if (!lines.length) out.push(`<i>Без света ${day} — нет</i>`);
    else out.push(`<i>Без света ${day}${offMin ? ` · ${dur(offMin)}` : ""}</i>`, ...lines);
  }
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
    const { lines: list } = offList(slots);
    const txt = list.length ? list.join(", ").replace(/ <i>возможно<\/i>/g, "?") : "отключений нет";
    lines.push(`<i>очередь ${groupLabel(g)}:</i> ${txt}`);
  }
  return lines.join("\n") || "<i>нет данных</i>";
}
