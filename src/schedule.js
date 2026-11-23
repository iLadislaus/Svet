// 📊 Разбор графика ДТЕК: получасовые слоты, полоска по часам, интервалы, события
const TZ = "Europe/Kyiv";
const SLOT_MAP = {
  yes: ["on", "on"],
  no: ["off", "off"],
  first: ["off", "on"],
  second: ["on", "off"],
  maybe: ["maybe", "maybe"],
  mfirst: ["maybe", "on"],
  msecond: ["on", "maybe"],
};

export const groupLabel = (g) => g.replace("GPV", "");

// 48 получасовых слотов дня для группы
export function daySlots(fact, dayKey, group) {
  const day = fact?.data?.[dayKey]?.[group];
  if (!day) return null;
  const slots = [];
  for (let h = 1; h <= 24; h++) slots.push(...(SLOT_MAP[day[String(h)]] || ["on", "on"]));
  return slots;
}

export function dayKeys(fact) {
  return Object.keys(fact?.data || {}).map(Number).sort((a, b) => a - b);
}

export const hm = (slot) => {
  const m = slot * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

// Полоска 2×12 часов: 🟩 есть, 🟥 нет, 🟧 полчаса нет, 🟨 возможно
export function bar(slots) {
  const cell = (a, b) => {
    if (a === "on" && b === "on") return "🟩";
    if (a === "off" && b === "off") return "🟥";
    if (a === "off" || b === "off") return "🟧";
    return "🟨";
  };
  const hours = [];
  for (let h = 0; h < 24; h++) hours.push(cell(slots[h * 2], slots[h * 2 + 1]));
  return `<code>00</code> ${hours.slice(0, 12).join("")} <code>11</code>\n<code>12</code> ${hours.slice(12).join("")} <code>23</code>`;
}

export const LEGEND = "🟩 есть · 🟥 нет · 🟧 полчаса · 🟨 возможно";

// Интервалы без света внутри дня
export function intervals(slots) {
  const out = [];
  let i = 0;
  while (i < 48) {
    if (slots[i] === "on") { i++; continue; }
    const type = slots[i];
    let j = i;
    while (j < 48 && slots[j] === type) j++;
    out.push({ from: i, to: j, type });
    i = j;
  }
  return out;
}

export function intervalsText(slots) {
  const list = intervals(slots);
  if (!list.length) return "🟢 Отключений не запланировано";
  return list
    .map((x) => (x.type === "off" ? `🔴 ${hm(x.from)}–${hm(x.to)} нет света` : `🟡 ${hm(x.from)}–${hm(x.to)} возможно отключение`))
    .join("\n");
}

// Сплошная лента слотов по всем опубликованным дням (для событий через полночь)
export function timeline(fact, group) {
  const out = [];
  for (const key of dayKeys(fact)) {
    const slots = daySlots(fact, key, group);
    if (!slots) continue;
    slots.forEach((s, i) => out.push({ t: key + i * 1800, s }));
  }
  return out;
}

// События: off_start (свет выключат), on_start (свет включат)
export function events(tl) {
  const ev = [];
  for (let i = 1; i < tl.length; i++) {
    if (tl[i].t - tl[i - 1].t !== 1800) continue;
    const a = tl[i - 1].s, b = tl[i].s;
    if (a === "on" && b !== "on") {
      let j = i;
      while (j < tl.length && tl[j].s !== "on") j++;
      ev.push({ kind: "off", t: tl[i].t, until: j < tl.length ? tl[j].t : null, maybe: b === "maybe" });
    } else if (a !== "on" && b === "on") {
      ev.push({ kind: "on", t: tl[i].t });
    }
  }
  return ev;
}

// Статус «сейчас» по ленте
export function nowStatus(tl, now) {
  const idx = tl.findIndex((x) => x.t <= now && now < x.t + 1800);
  if (idx < 0) return "";
  const cur = tl[idx].s;
  let j = idx;
  while (j < tl.length && (cur === "on" ? tl[j].s === "on" : tl[j].s !== "on")) j++;
  const next = j < tl.length ? clock(tl[j].t) : null;
  if (cur === "on") return next ? `🟢 Сейчас свет есть · до ${next}` : "🟢 Сейчас свет есть";
  if (cur === "maybe") return next ? `🟡 Сейчас возможно отключение · до ${next}` : "🟡 Сейчас возможно отключение";
  return next ? `🔴 Сейчас света нет · включат в ${next}` : "🔴 Сейчас света нет";
}

// Время по Киеву
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtDate = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, weekday: "short", day: "numeric", month: "long" });
export const clock = (ts) => fmt.format(new Date(ts * 1000));
export const dateLabel = (ts) => fmtDate.format(new Date(ts * 1000 + 3600 * 1000));
export function kyivHour(ts) {
  return Number(clock(ts).slice(0, 2));
}

export async function hashDay(fact, dayKey, group) {
  const day = fact?.data?.[dayKey]?.[group];
  if (!day) return null;
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(JSON.stringify(day)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
