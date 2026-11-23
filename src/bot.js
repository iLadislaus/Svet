// 🤖 Логика бота: меню, адреса, график, настройки
import { send, edit, tg, esc, inline, MAIN_KB, ADD_KB } from "./tg.js";
import {
  getUser, upsertUser, setState, updateUser, listAddresses, getAddress, addAddress, deleteAddress,
  loadDtek, setCache,
} from "./db.js";
import { fetchHouses, DEFAULT_CITY } from "./dtek.js";
import { search } from "./fuzzy.js";
import { renderGraph, graphButtons, addrLine } from "./render.js";
import { groupLabel } from "./schedule.js";

const HELLO =
  "⚡ Привет! Я слежу за светом по твоим адресам в Одессе и области и предупрежу заранее.\n\n" +
  "➕ Добавь адрес — я сам найду твою очередь ДТЕК\n📊 Смотри график на сегодня и завтра\n🔔 Настрой, когда и о чём предупреждать";

export async function handleUpdate(env, update) {
  if (update.callback_query) return onCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const user = await upsertUser(env, chatId, [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" "));
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/menu" || text === "❌ Отмена") {
    await setState(env, chatId, null);
    const list = await listAddresses(env, chatId);
    if (text === "/start" && !list.length) {
      await send(env, chatId, HELLO, MAIN_KB);
      return startAdd(env, chatId);
    }
    return send(env, chatId, text === "❌ Отмена" ? "↩️ Отменил. Главное меню 👇" : HELLO, MAIN_KB);
  }
  if (text === "/graph" || text === "📊 График") return showGraphs(env, chatId);
  if (text === "/addresses" || text === "🏠 Мои адреса") return showAddresses(env, chatId);
  if (text === "/add" || text === "➕ Добавить адрес") return startAdd(env, chatId);
  if (text === "/settings" || text === "🔔 Уведомления") return showSettings(env, chatId);
  if (text === "/help") return send(env, chatId, HELP, MAIN_KB);

  if (msg.location && (!user.state || user.state === "add_street")) return onLocation(env, chatId, msg.location);

  const data = user.state_data ? JSON.parse(user.state_data) : {};
  if (user.state === "add_street" && text) return onStreetText(env, chatId, text, data);
  if (user.state === "add_city" && text) return onCityText(env, chatId, text, data);
  if (user.state === "add_house" && text) return onHouseText(env, chatId, text, data);
  if (user.state === "add_name" && text) return finishAdd(env, chatId, data, text);
  if (user.state === "rename" && text) {
    await updateName(env, chatId, data.id, text);
    return;
  }
  return send(env, chatId, "🤔 Не понял. Выбери действие в меню 👇", MAIN_KB);
}

const HELP =
  "ℹ️ <b>Как пользоваться</b>\n\n" +
  "➕ <b>Добавить адрес</b> — напиши улицу (можно по-русски) или отправь 📍 геопозицию, затем номер дома. Очередь я найду сам.\n" +
  "📊 <b>График</b> — полоска по часам на сегодня и завтра.\n" +
  "🔔 <b>Уведомления</b> — за сколько минут предупреждать, тихие часы, аварии и изменения графика.\n\n" +
  "Данные — с сайта ДТЕК Одеські електромережі, обновляю каждые ~10 минут. Бот неофициальный.";

// ───────── График ─────────
async function showGraphs(env, chatId) {
  const list = await listAddresses(env, chatId);
  if (!list.length) return send(env, chatId, "🏠 У тебя пока нет адресов.", inline([[{ text: "➕ Добавить адрес", callback_data: "add" }]]));
  const d = await loadDtek(env);
  for (const a of list) await send(env, chatId, renderGraph(a, d.fact, 0, d.factAt), inline(graphButtons(a, 0)));
}

// ───────── Адреса ─────────
async function showAddresses(env, chatId, messageId = null) {
  const list = await listAddresses(env, chatId);
  const rows = list.map((a) => [
    { text: `📊 ${a.name}`, callback_data: `g:${a.id}:0` },
    { text: "✏️", callback_data: `ren:${a.id}` },
    { text: "🗑", callback_data: `del:${a.id}` },
  ]);
  rows.push([{ text: "➕ Добавить адрес", callback_data: "add" }]);
  const text = list.length
    ? "🏠 <b>Мои адреса</b>\n\n" + list.map((a) => `${addrLine(a)}\n   ⚡ очередь ${a.groups.map(groupLabel).join(", ") || "—"}`).join("\n\n")
    : "🏠 У тебя пока нет адресов.";
  return messageId ? edit(env, chatId, messageId, text, inline(rows)) : send(env, chatId, text, inline(rows));
}

async function startAdd(env, chatId, city = DEFAULT_CITY) {
  await setState(env, chatId, "add_street", { city });
  await send(env, chatId, `🏠 Напиши улицу (${esc(city)}) или отправь 📍 геопозицию.\n\nНапример: <i>Дерибасовская</i>, <i>Фонтанская дорога</i>`, ADD_KB);
  return send(env, chatId, "🏙 Другой город или село?", inline([[{ text: "🏙 Выбрать населённый пункт", callback_data: "city" }]]));
}

async function onCityText(env, chatId, text) {
  const d = await loadDtek(env);
  const cities = Object.keys(d.streets || {});
  const found = search(text, cities, 8, 0.5);
  if (!found.length) return send(env, chatId, "😕 Не нашёл такой населённый пункт. Попробуй иначе.");
  return send(env, chatId, "🏙 Выбери населённый пункт:", inline(found.map((f) => [{ text: cities[f.i], callback_data: `ct:${f.i}` }])));
}

async function onStreetText(env, chatId, text, data) {
  const city = data.city || DEFAULT_CITY;
  const d = await loadDtek(env);
  const streets = d.streets?.[city] || [];
  const found = search(text, streets, 8);
  if (!found.length) return send(env, chatId, `😕 Не нашёл улицу «${esc(text)}» в ${esc(city)}. Попробуй по-украински или короче.`);
  await setState(env, chatId, "add_street", { city });
  return send(env, chatId, "🔎 Выбери улицу:", inline(found.map((f) => [{ text: streets[f.i], callback_data: `st:${f.i}` }])));
}

async function onLocation(env, chatId, loc) {
  await send(env, chatId, "📍 Ищу адрес по геопозиции…");
  let addr;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${loc.latitude}&lon=${loc.longitude}&accept-language=uk&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "svet-odesa-telegram-bot/1.0" } }
    );
    addr = (await r.json()).address || {};
  } catch {
    return send(env, chatId, "😕 Не получилось определить адрес. Напиши улицу текстом ✍️");
  }
  const d = await loadDtek(env);
  const cities = Object.keys(d.streets || {});
  const place = addr.city || addr.town || addr.village || addr.hamlet || "Одеса";
  const cf = search(place, cities, 1, 0.6);
  const city = cf.length ? cities[cf[0].i] : DEFAULT_CITY;
  const streets = d.streets?.[city] || [];
  const road = addr.road || addr.pedestrian || addr.street || "";
  const found = road ? search(road, streets, 5, 0.5) : [];
  await setState(env, chatId, "add_street", { city, suggestHouse: addr.house_number || null });
  if (!found.length) {
    return send(env, chatId, `📍 Похоже, это ${esc(road || place)}. Улицу в базе ДТЕК не нашёл — напиши её текстом ✍️`);
  }
  const hint = addr.house_number ? `, дом ${esc(addr.house_number)}` : "";
  return send(env, chatId, `📍 Похоже, ты здесь: <b>${esc(road)}${hint}</b> (${esc(city)})\nВыбери улицу:`,
    inline(found.map((f) => [{ text: streets[f.i], callback_data: `st:${f.i}` }])));
}

async function chooseStreet(env, chatId, data, street) {
  const city = data.city || DEFAULT_CITY;
  const d = await loadDtek(env, 1200);
  let houses;
  try {
    houses = await fetchHouses(d.session, city, street);
  } catch {
    // сессия могла протухнуть — обновим и повторим
    const fresh = await loadDtek(env, 0);
    houses = await fetchHouses(fresh.session, city, street);
  }
  const numbers = Object.keys(houses);
  if (!numbers.length) return send(env, chatId, "😕 ДТЕК не вернул дома для этой улицы. Попробуй другую.");
  const next = { city, street, houses: Object.fromEntries(numbers.map((n) => [n, houses[n].sub_type_reason || []])) };
  if (data.suggestHouse && houses[data.suggestHouse]) return chooseHouse(env, chatId, next, data.suggestHouse);
  await setState(env, chatId, "add_house", next);
  const preview = numbers.length <= 24
    ? inline(chunk(numbers.map((n) => ({ text: n, callback_data: `hs:${n}`.slice(0, 64) })), 6))
    : {};
  return send(env, chatId, `🏢 <b>${esc(street)}</b>\nНапиши номер дома${numbers.length <= 24 ? " или выбери:" : ` (в базе ${numbers.length} домов)`}`, preview);
}

async function onHouseText(env, chatId, text, data) {
  const q = text.toLowerCase().replace(/\s+/g, "");
  const numbers = Object.keys(data.houses || {});
  const exact = numbers.find((n) => n.toLowerCase().replace(/\s+/g, "") === q);
  if (exact) return chooseHouse(env, chatId, data, exact);
  const near = numbers.filter((n) => n.toLowerCase().startsWith(q.replace(/[^0-9]/g, "")) && /\d/.test(q)).slice(0, 12);
  if (!near.length) return send(env, chatId, "😕 Нет такого дома в базе ДТЕК. Проверь номер ✍️");
  return send(env, chatId, "🏢 Может, один из этих?", inline(chunk(near.map((n) => ({ text: n, callback_data: `hs:${n}`.slice(0, 64) })), 4)));
}

async function chooseHouse(env, chatId, data, house) {
  const groups = data.houses?.[house] || [];
  await setState(env, chatId, "add_name", { city: data.city, street: data.street, house, groups });
  const g = groups.length ? groups.map(groupLabel).join(" и ") : "не указана";
  return send(env, chatId,
    `✅ Нашёл: <b>${esc(data.street)}, ${esc(house)}</b>, очередь ⚡ ${g}\n✏️ Как назвать адрес? Выбери или напиши своё:`,
    inline([[
      { text: "🏠 Дом", callback_data: "nm:🏠 Дом" },
      { text: "💼 Работа", callback_data: "nm:💼 Работа" },
    ], [
      { text: "👵 Родители", callback_data: "nm:👵 Родители" },
      { text: "🏡 Дача", callback_data: "nm:🏡 Дача" },
    ]]));
}

async function finishAdd(env, chatId, data, name) {
  if (!data.street) return send(env, chatId, "🤔 Начни заново: ➕ Добавить адрес", MAIN_KB);
  const clean = name.trim().slice(0, 40);
  const id = await addAddress(env, chatId, { name: clean, city: data.city, street: data.street, house: data.house, groups: data.groups });
  await setState(env, chatId, null);
  await setCache(env, `out:${data.city}|${data.street}|${data.house}`, "");
  await send(env, chatId, `✅ Добавил «${esc(clean)}». Буду предупреждать 🔔`, MAIN_KB);
  const a = await getAddress(env, chatId, id);
  const d = await loadDtek(env);
  return send(env, chatId, renderGraph(a, d.fact, 0, d.factAt), inline(graphButtons(a, 0)));
}

async function updateName(env, chatId, id, name) {
  await env.DB.prepare("UPDATE addresses SET name = ? WHERE chat_id = ? AND id = ?").bind(name.trim().slice(0, 40), chatId, id).run();
  await setState(env, chatId, null);
  await send(env, chatId, "✅ Переименовал", MAIN_KB);
  return showAddresses(env, chatId);
}

// ───────── Настройки ─────────
const LEADS = [30, 10];
const parseLeads = (s) => String(s || "").split(",").map(Number).filter(Boolean);
const hh = (h) => `${String(h).padStart(2, "0")}:00`;

function settingsView(u) {
  const off = parseLeads(u.lead_off), on = parseLeads(u.lead_on);
  const quiet = u.quiet_from != null && u.quiet_to != null ? `${hh(u.quiet_from)}–${hh(u.quiet_to)}` : "выключены";
  const text =
    "🔔 <b>Уведомления</b>\n\n" +
    `⚠️ До отключения: ${off.length ? off.map((m) => `за ${m} мин`).join(" и ") : "не предупреждать"}\n` +
    `💡 До включения: ${on.length ? on.map((m) => `за ${m} мин`).join(" и ") : "не предупреждать"}\n` +
    `🚨 Аварийные отключения: ${u.notify_emergency ? "✅ вкл" : "🚫 выкл"}\n` +
    `📅 Изменения графика: ${u.notify_changes ? "✅ вкл" : "🚫 выкл"}\n` +
    `🌙 Тихие часы: ${quiet}`;
  const t = (list, m) => (list.includes(m) ? "✅" : "▫️");
  const rows = [
    [{ text: "⚠️ До отключения:", callback_data: "noop" }],
    LEADS.map((m) => ({ text: `${t(off, m)} ${m} мин`, callback_data: `lo:${m}` })),
    [{ text: "💡 До включения:", callback_data: "noop" }],
    LEADS.map((m) => ({ text: `${t(on, m)} ${m} мин`, callback_data: `ln:${m}` })),
    [{ text: `${u.notify_emergency ? "✅" : "▫️"} 🚨 Аварии`, callback_data: "em" }, { text: `${u.notify_changes ? "✅" : "▫️"} 📅 Изменения`, callback_data: "ch" }],
    [{ text: "🌙 Настроить тихие часы", callback_data: "qs" }],
  ];
  if (u.quiet_from != null) rows.push([{ text: "🔕 Выключить тихие часы", callback_data: "qx" }]);
  return { text, rows };
}

async function showSettings(env, chatId, messageId = null) {
  const u = await getUser(env, chatId);
  const v = settingsView(u);
  return messageId ? edit(env, chatId, messageId, v.text, inline(v.rows)) : send(env, chatId, v.text, inline(v.rows));
}

const hourGrid = (prefix) => chunk([...Array(24).keys()].map((h) => ({ text: hh(h), callback_data: `${prefix}:${h}` })), 4);

// ───────── Кнопки ─────────
async function onCallback(env, cq) {
  const chatId = cq.message?.chat?.id;
  const mid = cq.message?.message_id;
  const data = cq.data || "";
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  if (!chatId) return;
  const user = (await getUser(env, chatId)) || (await upsertUser(env, chatId, cq.from?.first_name || ""));
  const st = user.state_data ? JSON.parse(user.state_data) : {};
  const [cmd, a1, a2] = data.split(":");

  switch (cmd) {
    case "noop": return;
    case "add": return startAdd(env, chatId);
    case "city":
      await setState(env, chatId, "add_city", {});
      return send(env, chatId, "🏙 Напиши название населённого пункта (например: <i>Біляївка</i>, <i>Чорноморськ</i>)");
    case "ct": {
      const d = await loadDtek(env);
      const city = Object.keys(d.streets || {})[Number(a1)];
      if (!city) return;
      return startAdd(env, chatId, city);
    }
    case "st": {
      const city = st.city || DEFAULT_CITY;
      const d = await loadDtek(env);
      const street = (d.streets?.[city] || [])[Number(a1)];
      if (!street) return send(env, chatId, "🤔 Начни заново: ➕ Добавить адрес");
      return chooseStreet(env, chatId, st, street);
    }
    case "hs": {
      const house = data.slice(3);
      if (user.state !== "add_house") return;
      return chooseHouse(env, chatId, st, house);
    }
    case "nm":
      if (user.state !== "add_name") return;
      return finishAdd(env, chatId, st, data.slice(3));
    case "g": {
      const a = await getAddress(env, chatId, Number(a1));
      if (!a) return send(env, chatId, "🤔 Адрес не найден");
      const d = await loadDtek(env);
      const day = Number(a2) || 0;
      const text = renderGraph(a, d.fact, day, d.factAt);
      if (cq.message?.text?.startsWith("📊")) return edit(env, chatId, mid, text, inline(graphButtons(a, day)));
      return send(env, chatId, text, inline(graphButtons(a, day)));
    }
    case "ren":
      await setState(env, chatId, "rename", { id: Number(a1) });
      return send(env, chatId, "✏️ Напиши новое название адреса");
    case "del": {
      const a = await getAddress(env, chatId, Number(a1));
      if (!a) return;
      return edit(env, chatId, mid, `🗑 Удалить «${esc(a.name)}»?`, inline([[
        { text: "✅ Да, удалить", callback_data: `delok:${a.id}` },
        { text: "↩️ Нет", callback_data: "addr" },
      ]]));
    }
    case "delok":
      await deleteAddress(env, chatId, Number(a1));
      return showAddresses(env, chatId, mid);
    case "addr": return showAddresses(env, chatId, mid);
    case "lo":
    case "ln": {
      const field = cmd === "lo" ? "lead_off" : "lead_on";
      const cur = parseLeads(user[field]);
      const m = Number(a1);
      const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m].sort((a, b) => b - a);
      await updateUser(env, chatId, { [field]: next.join(",") });
      return showSettings(env, chatId, mid);
    }
    case "em":
      await updateUser(env, chatId, { notify_emergency: user.notify_emergency ? 0 : 1 });
      return showSettings(env, chatId, mid);
    case "ch":
      await updateUser(env, chatId, { notify_changes: user.notify_changes ? 0 : 1 });
      return showSettings(env, chatId, mid);
    case "qs":
      return edit(env, chatId, mid, "🌙 С какого часа не присылать уведомления?", inline(hourGrid("qf")));
    case "qf":
      return edit(env, chatId, mid, `🌙 Тихо с ${hh(a1)}. До какого часа?`, inline(hourGrid(`qt:${a1}`)));
    case "qt": {
      const from = Number(a1), to = Number(a2);
      if (from === to) return edit(env, chatId, mid, "🤔 Начало и конец совпадают. До какого часа?", inline(hourGrid(`qt:${a1}`)));
      await updateUser(env, chatId, { quiet_from: from, quiet_to: to });
      return showSettings(env, chatId, mid);
    }
    case "qx":
      await updateUser(env, chatId, { quiet_from: null, quiet_to: null });
      return showSettings(env, chatId, mid);
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

