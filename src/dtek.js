// ⚡ Работа с сайтом ДТЕК Одеські електромережі
const BASE = "https://www.dtek-oem.com.ua";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_CITY = "м. Одеса";

// Загружает страницу графиков: fact (график), streets (улицы), csrf + cookies для AJAX
export async function fetchPage() {
  const res = await fetch(`${BASE}/ua/shutdowns`, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "uk-UA,uk;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`DTEK page HTTP ${res.status}`);
  const html = await res.text();
  const fact = extractJson(html, "DisconSchedule.fact");
  if (!fact || !fact.data) throw new Error("DTEK: DisconSchedule.fact не найден");
  const streets = extractJson(html, "DisconSchedule.streets");
  const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  const cookies = list.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  return { fact, streets, session: { csrf: m ? m[1] : "", cookies, update: fact.update || "" } };
}

// Дома улицы: { "3": { sub_type, start_date, end_date, type, sub_type_reason: ["GPV4.2"] }, ... }
export async function fetchHouses(session, city, street) {
  const body = new URLSearchParams();
  body.set("method", "getHomeNum");
  body.set("data[0][name]", "city");
  body.set("data[0][value]", city);
  body.set("data[1][name]", "street");
  body.set("data[1][value]", street);
  body.set("data[2][name]", "updateFact");
  body.set("data[2][value]", session.update || "");
  const res = await fetch(`${BASE}/ua/ajax`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": session.csrf,
      Referer: `${BASE}/ua/shutdowns`,
      Origin: BASE,
      Cookie: session.cookies,
    },
    body,
  });
  if (!res.ok) throw new Error(`DTEK ajax HTTP ${res.status}`);
  const json = await res.json();
  return json && json.data ? json.data : {};
}

function extractJson(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf("{", i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; }
    }
  }
  return null;
}
