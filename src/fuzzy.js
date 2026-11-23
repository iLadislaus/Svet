// 🔎 Нечёткий поиск улиц и населённых пунктов (рус/укр, порядок слов, опечатки)
const TYPES = new Set([
  "вул", "вулиця", "ул", "улица", "просп", "проспект", "пр", "пров", "провулок", "переулок", "пер",
  "бул", "бульвар", "пл", "площа", "площадь", "узвіз", "узвиз", "спуск", "туп", "тупик", "шосе", "шоссе",
  "дорога", "пляж", "проїзд", "проезд", "алея", "аллея", "м", "с", "смт", "с-ще", "селище", "село", "місто", "город",
]);

const SYN = {
  большая: "велика", большой: "великий", малая: "мала", малый: "малий", старая: "стара", старый: "старий",
  новая: "нова", новый: "новий", средняя: "середня", средний: "середний", верхняя: "верхня", нижняя: "нижня",
  первая: "перша", вторая: "друга", третья: "третя", четвертая: "четверта", пятая: "пята", шестая: "шоста",
};

export function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/[’'`ʼ]/g, "")
    .replace(/ё/g, "е").replace(/[іїы]/g, "и").replace(/[єэ]/g, "е").replace(/ґ/g, "г").replace(/ъ/g, "")
    .replace(/[^a-zа-я0-9\- ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !TYPES.has(w) && !TYPES.has(w.replace(/-/g, "")))
    .map((w) => SYN[w] || w)
    .join(" ");
}

function grams(w) {
  const s = ` ${w} `;
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function dice(a, b) {
  if (a === b) return 1;
  const ga = grams(a), gb = grams(b);
  const m = new Map();
  for (const g of gb) m.set(g, (m.get(g) || 0) + 1);
  let hit = 0;
  for (const g of ga) if (m.get(g) > 0) { hit++; m.set(g, m.get(g) - 1); }
  return (2 * hit) / (ga.length + gb.length);
}

export function score(query, candidate) {
  const q = norm(query), c = norm(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  const qt = q.split(" "), ct = c.split(" ");
  let sum = 0;
  for (const w of qt) sum += Math.max(...ct.map((x) => (x.startsWith(w) && w.length >= 4 ? 0.95 : dice(w, x))));
  let s = sum / qt.length;
  if (ct.length > qt.length) s -= 0.05 * (ct.length - qt.length);
  return s;
}

// Возвращает индексы лучших совпадений
export function search(query, list, limit = 8, min = 0.45) {
  return list
    .map((name, i) => ({ i, s: score(query, name) }))
    .filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
}
