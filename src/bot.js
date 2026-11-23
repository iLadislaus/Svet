// 🤖 Логика бота: команды меню, адреса, график, настройки (лаконичный стиль)
import { send, edit, tg, esc, inline, NO_KB, ADD_KB } from "./tg.js";
import {
  getUser, upsertUser, setState, updateUser, listAddresses, getAddress, addAddress, deleteAddress,
  loadDtek, getCache, setCache,
} from "./db.js";
import { fetchHouses, DEFAULT_CITY } from "./dtek.js";
import { search } from "./fuzzy.js";
import { renderGraph, graphButtons, addrShort, groupsText } from "./render.js";
import { groupLabel } from "./schedule.js";

const HELLO =
  "⚡ <b>Свет</b>\nПредупреждаю об отключениях света по твоим адресам в Одессе и области.\n\n" +
  "Всё управление — в кнопке <b>Меню</b> слева внизу:\n" +
  "/graph — график\n/addresses — мои адреса\n/add — добавить адрес\n/settings — уведомления";

const HELP =
  "<b>Как пользоваться</b>\n\n" +
  "/add — напиши улицу (можно по-русски) или отправь геопозицию, затем номер дома. Очередь найду сам.\n" +
  "/graph — есть ли свет сейчас и когда выключат или включат.\n" +
  "/settings — за сколько предупреждать, тихие часы, аварии.\n\n" +
  "<i>Данные с сайта ДТЕК Одеські електромережі, обновляю каждые ~10 минут. Бот неофициальный.</i>";

export async function handleUpdate(env, update) {
  if (update.callback_query) return onCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const user = await upsertUser(env, chatId, [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" "));
  const text = (msg.text || "").trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0] : text;

  // Один раз убираем старую нижнюю клавиатуру у тех, у кого она осталась
  if (!(await getCache(env, `kbrm:${chatId}`))) {
    await setCache(env, `kbrm:${chatId}`, 1);
    if (cmd !== "/start") await send(env, chatId, "Меню обновлено — всё в кнопке <b>Меню</b> слева внизу", NO_KB);
  }

  if (cmd === "/start" || cmd === "/menu" || cmd === "Отмена" || cmd === "❌ Отмена") {
    await setState(env, chatId, null);
    if (cmd.includes("Отмена")) return send(env, chatId, "Отменил", NO_KB);
    const list = await listAddresses(env, chatId);
    await send(env, chatId, HELLO, NO_KB);
    if (cmd === "/start" && !list.length) return startAdd(env, chatId);
    return;
  }
  if (cmd === "/graph" || cmd === "📊 График") return showGraphs(env, chatId);
  if (cmd === "/addresses" || cmd === "🏠 Мои адреса") return showAddresses(env, chatId);
  if (cmd === "/add" || cmd === "➕ Добавить адрес") return startAdd(env, chatId);
  if (cmd === "/settings" || cmd === "🔔 Уведомления") return showSettings(env, chatId);
  if (cmd === "/help") return send(env, chatId, HELP, NO_KB);

  if (msg.location && (!user.state || user.state === "add_street")) return onLocation(env, chatId, msg.location);

  const data = user.state_data ? JSON.parse(user.state_data) : {};
  if (user.state === "add_street" && text) return onStreetText(env, chatId, text, data);
  if (user.state === "add_city" && text) return onCityText(env, chatId, text);
  if (user.state === "add_house" && text) return onHouseText(env, chatId, text, data);
  if (user.state === "add_name" && text) return finishAdd(env, chatId, data, text);
  if (user.state === "rename" && text) return updateName(env, chatId, data.id, text);
  return send(env, chatId, "Не понял. Открой <b>Меню</b> слева внизу", NO_KB);
}

// ───────── График ─────────
async function showGraphs(env, chatId) {
  const list = await listAddresses(env, chatId);
  if (!list.length) return send(env, chatId, "Адресов пока нет. Добавь первый: /add", NO_KB);
  const d = await loadDtek(env);
  for (const a of list) await send(env, chatId, renderGraph(a, d.fact, 0, d.factAt), inline(graphButtons(a, 0)));
}

// ───────── Адреса ─────────
async function showAddresses(env, chatId, messageId = null) {
  const list = await listAddresses(env, chatId);
  const rows = chunk(list.map((a) => ({ text: a.name, callback_data: `a:${a.id}` })), 2);
  rows.push([{ text: "➕ Добавить адрес", callback_data: "add" }]);
  const text = list.length
    ? "<b>Мои адреса</b>\n" + list.map((a) => `${esc(a.name)} <i>· ${addrShort(a)} · ${groupsText(a)}</i>`).join("\n")
    : "<b>Мои адреса</b>\nПока пусто";
  return messageId ? edit(env, chatId, messageId, text, inline(rows)) : send(env, chatId, text, inline(rows));
}

async function showAddressCard(env, chatId, messageId, a) {
  const city = a.city !== DEFAULT_CITY ? ` · ${esc(a.city)}` : "";
  return edit(env, chatId, messageId,
    `<b>${esc(a.name)}</b>\n<i>${addrShort(a)}${city} · очередь ${groupsText(a)}</i>`,
    inline([
      [{ text: "График", callback_data: `gn:${a.id}` }],
      [{ text: "Переименовать", callback_data: `ren:${a.id}` }, { text: "Удалить", callback_data: `del:${a.id}` }],
      [{ text: "← Назад", callback_data: "addr" }],
    ]));
}

async function startAdd(env, chatId, city = DEFAULT_CITY) {
  await setState(env, chatId, "add_street", { city });
  const where = city === DEFAULT_CITY ? "" : ` · ${esc(city)}`;
  await send(env, chatId, `<b>Новый адрес</b>${where}\nНапиши улицу или отправь геопозицию.\n<i>Например: Дерибасовская</i>`, ADD_KB);
  if (city === DEFAULT_CITY) {
    return send(env, chatId, "<i>Не в Одессе?</i>", inline([[{ text: "Выбрать населённый пункт", callback_data: "city" }]]));
  }
}

async function onCityText(env, chatId, text) {
  const d = await loadDtek(env);
  const cities = Object.keys(d.streets || {});
  const found = search(text, cities, 8, 0.5);
  if (!found.length) return send(env, chatId, "Не нашёл такой населённый пункт. Попробуй иначе");
  return send(env, chatId, "Выбери населённый пункт", inline(found.map((f) => [{ text: cities[f.i], callback_data: `ct:${f.i}` }])));
}

async function onStreetText(env, chatId, text, data) {
  const city = data.city || DEFAULT_CITY;
  const d = await loadDtek(env);
  const streets = d.streets?.[city] || [];
  const found = search(text, streets, 8);
  if (!found.length) return send(env, chatId, `Не нашёл «${esc(text)}». Попробуй по-украински или короче`);
  await setState(env, chatId, "add_street", { city });
  return send(env, chatId, "Выбери улицу", inline(found.map((f) => [{ text: streets[f.i], callback_data: `st:${f.i}` }])));
}

async function onLocation(env, chatId, loc) {
  let addr;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${loc.latitude}&lon=${loc.longitude}&accept-language=uk&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "svet-odesa-telegram-bot/1.0" } }
    );
    addr = (await r.json()).address || {};
  } catch {
    return send(env, chatId, "Не получилось определить адрес. Напиши улицу текстом", NO_KB);
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
  if (!found.length) return send(env, chatId, `Похоже, это ${esc(road || place)}, но в базе ДТЕК не нашёл. Напиши улицу текстом`, NO_KB);
  const hint = addr.house_number ? `, ${esc(addr.house_number)}` : "";
  await send(env, chatId, `📍 ${esc(road)}${hint}`, NO_KB);
  return send(env, chatId, "Выбери улицу", inline(found.map((f) => [{ text: streets[f.i], callback_data: `st:${f.i}` }])));
}

async function chooseStreet(env, chatId, data, street) {
  const city = data.city || DEFAULT_CITY;
  const d = await loadDtek(env, 1200);
  let houses;
  try {
    houses = await fetchHouses(d.session, city, street);
  } catch {
    const fresh = await loadDtek(env, 0);
    houses = await fetchHouses(fresh.session, city, street);
  }
  const numbers = Object.keys(houses);
  if (!numbers.length) return send(env, chatId, "ДТЕК не вернул дома для этой улицы. Попробуй другую");
  const next = { city, street, houses: Object.fromEntries(numbers.map((n) => [n, houses[n].sub_type_reason || []])) };
  if (data.suggestHouse && houses[data.suggestHouse]) return chooseHouse(env, chatId, next, data.suggestHouse);
  await setState(env, chatId, "add_house", next);
  const kb = numbers.length <= 24 ? inline(chunk(numbers.map((n) => ({ text: n, callback_data: `hs:${n}`.slice(0, 64) })), 6)) : NO_KB;
  return send(env, chatId, `<b>${esc(street)}</b>\nНапиши номер дома${numbers.length <= 24 ? " или выбери" : ""}`, kb);
}

async function onHouseText(env, chatId, text, data) {
  const q = text.toLowerCase().replace(/\s+/g, "");
  const numbers = Object.keys(data.houses || {});
  const exact = numbers.find((n) => n.toLowerCase().replace(/\s+/g, "") === q);
  if (exact) return chooseHouse(env, chatId, data, exact);
  const digits = q.replace(/[^0-9]/g, "");
  const near = digits ? numbers.filter((n) => n.toLowerCase().startsWith(digits)).slice(0, 12) : [];
  if (!near.length) return send(env, chatId, "Такого дома нет в базе ДТЕК. Проверь номер");
  return send(env, chatId, "Может, один из этих?", inline(chunk(near.map((n) => ({ text: n, callback_data: `hs:${n}`.slice(0, 64) })), 4)));
}

async function chooseHouse(env, chatId, data, house) {
  const groups = data.houses?.[house] || [];
  await setState(env, chatId, "add_name", { city: data.city, street: data.street, house, groups });
  const g = groups.length ? groups.map(groupLabel).join(", ") : "не указана";
  return send(env, chatId,
    `<b>${esc(data.street)}, ${esc(house)}</b>\n<i>Очередь ${g}</i>\n\nКак назвать адрес? Выбери или напиши своё`,
    inline(chunk(["🏠 Дом", "💼 Работа", "👵 Родители", "🏡 Дача"].map((n) => ({ text: n, callback_data: `nm:${n}` })), 2)));
}

async function finishAdd(env, chatId, data, name) {
  if (!data.street) return send(env, chatId, "Начни заново: /add", NO_KB);
  const clean = name.trim().slice(0, 40);
  const id = await addAddress(env, chatId, { name: clean, city: data.city, street: data.street, house: data.house, groups: data.groups });
  await setState(env, chatId, null);
  await setCache(env, `out:${data.city}|${data.street}|${data.house}`, "");
  await send(env, chatId, `✓ Адрес «${esc(clean)}» добавлен`, NO_KB);
  const a = await getAddress(env, chatId, id);
  const d = await loadDtek(env);
  return send(env, chatId, renderGraph(a, d.fact, 0, d.factAt), inline(graphButtons(a, 0)));
}

async function updateName(env, chatId, id, name) {
  await env.DB.prepare("UPDATE addresses SET name = ? WHERE chat_id = ? AND id = ?").bind(name.trim().slice(0, 40), chatId, id).run();
  await setState(env, chatId, null);
  await send(env, chatId, "✓ Переименовал", NO_KB);
  return showAddresses(env, chatId);
}

// ───────── Настройки ─────────
const LEADS = [30, 10];
const parseLeads = (s) => String(s || "").split(",").map(Number).filter(Boolean);
const hh = (h) => `${String(h).padStart(2, "0")}:00`;
const leadText = (l) => (l.length ? `за ${l.sort((a, b) => b - a).join(" и ")} мин` : "выкл");

function settingsView(u) {
  const off = parseLeads(u.lead_off), on = parseLeads(u.lead_on);
  const quiet = u.quiet_from != null && u.quiet_to != null ? `${hh(u.quiet_from)} – ${hh(u.quiet_to)}` : "выкл";
  const text =
    "<b>Уведомления</b>\n" +
    `<i>Перед отключением</i> — ${leadText(off)}\n` +
    `<i>Перед включением</i> — ${leadText(on)}\n` +
    `<i>Аварии</i> — ${u.notify_emergency ? "вкл" : "выкл"}\n` +
    `<i>Изменения графика</i> — ${u.notify_changes ? "вкл" : "выкл"}\n` +
    `<i>Тихие часы</i> — ${quiet}`;
  const mark = (on) => (on ? " ✓" : "");
  const rows = [
    LEADS.map((m) => ({ text: `⚠️ ${m} мин${mark(off.includes(m))}`, callback_data: `lo:${m}` })),
    LEADS.map((m) => ({ text: `💡 ${m} мин${mark(on.includes(m))}`, callback_data: `ln:${m}` })),
    [{ text: `🚨 Аварии${mark(u.notify_emergency)}`, callback_data: "em" }, { text: `📅 Изменения${mark(u.notify_changes)}`, callback_data: "ch" }],
    [{ text: "🌙 Тихие часы", callback_data: "qs" }],
  ];
  return { text, rows };
}

async function showSettings(env, chatId, messageId = null) {
  const u = await getUser(env, chatId);
  const v = settingsView(u);
  return messageId ? edit(env, chatId, messageId, v.text, inline(v.rows)) : send(env, chatId, v.text, inline(v.rows));
}

function hourGrid(prefix, withOff = false) {
  const rows = chunk([...Array(24).keys()].map((h) => ({ text: hh(h), callback_data: `${prefix}:${h}` })), 4);
  if (withOff) rows.push([{ text: "Выключить тихие часы", callback_data: "qx" }]);
  rows.push([{ text: "← Назад", callback_data: "set" }]);
  return rows;
}

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
    case "add": return startAdd(env, chatId);
    case "city":
      await setState(env, chatId, "add_city", {});
      return send(env, chatId, "Напиши населённый пункт\n<i>Например: Біляївка, Чорноморськ</i>");
    case "ct": {
      const d = await loadDtek(env);
      const city = Object.keys(d.streets || {})[Number(a1)];
      return city ? startAdd(env, chatId, city) : undefined;
    }
    case "st": {
      const city = st.city || DEFAULT_CITY;
      const d = await loadDtek(env);
      const street = (d.streets?.[city] || [])[Number(a1)];
      if (!street) return send(env, chatId, "Начни заново: /add");
      return chooseStreet(env, chatId, st, street);
    }
    case "hs":
      if (user.state !== "add_house") return;
      return chooseHouse(env, chatId, st, data.slice(3));
    case "nm":
      if (user.state !== "add_name") return;
      return finishAdd(env, chatId, st, data.slice(3));
    case "g":
    case "gn": {
      const a = await getAddress(env, chatId, Number(a1));
      if (!a) return send(env, chatId, "Адрес не найден");
      const d = await loadDtek(env);
      const day = Number(a2) || 0;
      const text = renderGraph(a, d.fact, day, d.factAt);
      // gn — из карточки адреса (новое сообщение), g — переключение дня в графике
      if (cmd === "gn") return send(env, chatId, text, inline(graphButtons(a, day)));
      return edit(env, chatId, mid, text, inline(graphButtons(a, day)));
    }
    case "a": {
      const a = await getAddress(env, chatId, Number(a1));
      return a ? showAddressCard(env, chatId, mid, a) : showAddresses(env, chatId, mid);
    }
    case "ren":
      await setState(env, chatId, "rename", { id: Number(a1) });
      return send(env, chatId, "Напиши новое название");
    case "del": {
      const a = await getAddress(env, chatId, Number(a1));
      if (!a) return;
      return edit(env, chatId, mid, `Удалить «${esc(a.name)}»?`, inline([[
        { text: "Удалить", callback_data: `delok:${a.id}` },
        { text: "Отмена", callback_data: `a:${a.id}` },
      ]]));
    }
    case "delok":
      await deleteAddress(env, chatId, Number(a1));
      return showAddresses(env, chatId, mid);
    case "addr": return showAddresses(env, chatId, mid);
    case "set": return showSettings(env, chatId, mid);
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
      return edit(env, chatId, mid, "<b>Тихие часы</b>\nС какого часа не присылать уведомления?", inline(hourGrid("qf", user.quiet_from != null)));
    case "qf":
      return edit(env, chatId, mid, `<b>Тихие часы</b>\nС ${hh(a1)} до какого часа?`, inline(hourGrid(`qt:${a1}`)));
    case "qt": {
      const from = Number(a1), to = Number(a2);
      if (from === to) return edit(env, chatId, mid, "<b>Тихие часы</b>\nНачало и конец совпадают. До какого часа?", inline(hourGrid(`qt:${a1}`)));
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
