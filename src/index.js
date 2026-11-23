// 🧪 DTEK Odesa probe — пробный Worker: проверяет, отдаёт ли сайт ДТЕК данные Cloudflare'у.
// Открой URL воркера:            /            → проверка страницы графиков
// С адресом (необязательно):     /?city=м. Одеса&street=вул. Дерибасівська  → проверка поиска очереди по улице

const BASE = "https://www.dtek-oem.com.ua";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const report = { time: new Date().toISOString(), steps: [] };

    // 1️⃣ Страница графиков
    let html = "";
    let cookies = "";
    try {
      const res = await fetch(`${BASE}/ua/shutdowns`, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "uk-UA,uk;q=0.9,ru;q=0.8",
        },
        redirect: "follow",
      });
      html = await res.text();
      cookies = collectCookies(res.headers);
      report.steps.push({
        step: "page",
        status: res.status,
        bytes: html.length,
        server: res.headers.get("server"),
        hasFact: html.includes("DisconSchedule.fact"),
        hasPreset: html.includes("DisconSchedule.preset"),
        csrf: !!extractCsrf(html),
        cookieNames: cookies.split("; ").map((c) => c.split("=")[0]).filter(Boolean),
        looksBlocked: /incapsula|captcha|cf-chl|access denied|request unsuccessful/i.test(html),
        head: html.slice(0, 300),
      });
    } catch (e) {
      report.steps.push({ step: "page", error: String(e) });
      return json(report);
    }

    // 2️⃣ Разбор графика (какие очереди и дни есть)
    const fact = extractJson(html, "DisconSchedule.fact");
    if (fact) {
      const days = Object.keys(fact.data || {});
      const firstDay = days[0] ? fact.data[days[0]] : {};
      report.steps.push({
        step: "fact",
        update: fact.update || null,
        today: fact.today || null,
        days: days.map((d) => new Date(Number(d) * 1000).toISOString().slice(0, 10)),
        groups: Object.keys(firstDay),
        sampleGroup: Object.keys(firstDay)[0]
          ? { [Object.keys(firstDay)[0]]: firstDay[Object.keys(firstDay)[0]] }
          : null,
      });
    } else {
      report.steps.push({ step: "fact", error: "DisconSchedule.fact не найден" });
    }

    // 3️⃣ Поиск очереди по улице (если передали city и street)
    const city = url.searchParams.get("city");
    const street = url.searchParams.get("street");
    const csrf = extractCsrf(html);
    if (city && street && csrf) {
      try {
        const body = new URLSearchParams();
        body.set("method", "getHomeNum");
        body.set("data[0][name]", "city");
        body.set("data[0][value]", city);
        body.set("data[1][name]", "street");
        body.set("data[1][value]", street);
        body.set("data[2][name]", "updateFact");
        body.set("data[2][value]", fact?.update || "");
        const res = await fetch(`${BASE}/ua/ajax`, {
          method: "POST",
          headers: {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": csrf,
            Referer: `${BASE}/ua/shutdowns`,
            Origin: BASE,
            Cookie: cookies,
          },
          body,
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        const houses = parsed?.data ? Object.keys(parsed.data) : [];
        report.steps.push({
          step: "getHomeNum",
          status: res.status,
          ok: !!parsed,
          houses: houses.length,
          sample: houses.slice(0, 3).map((h) => ({ house: h, ...parsed.data[h] })),
          raw: parsed ? undefined : text.slice(0, 300),
        });
      } catch (e) {
        report.steps.push({ step: "getHomeNum", error: String(e) });
      }
    }

    return json(report);
  },
};

function collectCookies(headers) {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
  return list.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

function extractCsrf(html) {
  const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  return m ? m[1] : null;
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

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
