// 🗄️ D1: пользователи, адреса, кэш, отправленные уведомления
import { fetchPage } from "./dtek.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    chat_id INTEGER PRIMARY KEY,
    name TEXT,
    state TEXT,
    state_data TEXT,
    lead_off TEXT DEFAULT '30',
    lead_on TEXT DEFAULT '10',
    notify_emergency INTEGER DEFAULT 1,
    notify_changes INTEGER DEFAULT 1,
    quiet_from INTEGER,
    quiet_to INTEGER,
    created_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    street TEXT NOT NULL,
    house TEXT NOT NULL,
    groups TEXT NOT NULL,
    created_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_addr_chat ON addresses(chat_id)`,
  `CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sent (key TEXT PRIMARY KEY, created_at INTEGER)`,
];

let ready = false;
export async function ensureSchema(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  ready = true;
}

export const now = () => Math.floor(Date.now() / 1000);

export async function getCache(env, key) {
  const row = await env.DB.prepare("SELECT value, updated_at FROM cache WHERE key = ?").bind(key).first();
  return row ? { value: JSON.parse(row.value), at: row.updated_at } : null;
}

export async function setCache(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, JSON.stringify(value), now()).run();
}

// Свежие данные ДТЕК (кэш до maxAge секунд), с запасным старым кэшем при ошибке
export async function loadDtek(env, maxAge = 540) {
  const [fact, session, streets] = await Promise.all([getCache(env, "fact"), getCache(env, "session"), getCache(env, "streets")]);
  if (fact && session && streets && now() - fact.at < maxAge) {
    return { fact: fact.value, session: session.value, streets: streets.value, fresh: false, factAt: fact.at };
  }
  try {
    const page = await fetchPage();
    await setCache(env, "fact", page.fact);
    await setCache(env, "session", page.session);
    let st = streets?.value;
    if (page.streets && (!streets || now() - streets.at > 6 * 3600)) {
      st = page.streets;
      await setCache(env, "streets", st);
    }
    return { fact: page.fact, session: page.session, streets: st || page.streets, fresh: true, prevFact: fact?.value, factAt: now() };
  } catch (e) {
    console.error("DTEK fetch failed", e);
    if (fact) return { fact: fact.value, session: session?.value, streets: streets?.value, fresh: false, factAt: fact.at, error: String(e) };
    throw e;
  }
}

export async function getUser(env, chatId) {
  return env.DB.prepare("SELECT * FROM users WHERE chat_id = ?").bind(chatId).first();
}

export async function upsertUser(env, chatId, name) {
  await env.DB.prepare(
    "INSERT INTO users (chat_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name"
  ).bind(chatId, name, now()).run();
  return getUser(env, chatId);
}

export async function setState(env, chatId, state, data = null) {
  await env.DB.prepare("UPDATE users SET state = ?, state_data = ? WHERE chat_id = ?")
    .bind(state, data ? JSON.stringify(data) : null, chatId).run();
}

export async function updateUser(env, chatId, fields) {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE chat_id = ?`)
    .bind(...keys.map((k) => fields[k]), chatId).run();
}

export async function listAddresses(env, chatId) {
  const { results } = await env.DB.prepare("SELECT * FROM addresses WHERE chat_id = ? ORDER BY id").bind(chatId).all();
  return results.map((a) => ({ ...a, groups: JSON.parse(a.groups) }));
}

export async function getAddress(env, chatId, id) {
  const a = await env.DB.prepare("SELECT * FROM addresses WHERE chat_id = ? AND id = ?").bind(chatId, id).first();
  return a ? { ...a, groups: JSON.parse(a.groups) } : null;
}

export async function addAddress(env, chatId, a) {
  const r = await env.DB.prepare(
    "INSERT INTO addresses (chat_id, name, city, street, house, groups, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(chatId, a.name, a.city, a.street, a.house, JSON.stringify(a.groups), now()).run();
  return r.meta.last_row_id;
}

export async function deleteAddress(env, chatId, id) {
  await env.DB.prepare("DELETE FROM addresses WHERE chat_id = ? AND id = ?").bind(chatId, id).run();
}

export async function allAddressesWithUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.*, u.lead_off, u.lead_on, u.notify_emergency, u.notify_changes, u.quiet_from, u.quiet_to
     FROM addresses a JOIN users u ON u.chat_id = a.chat_id`
  ).all();
  return results.map((a) => ({ ...a, groups: JSON.parse(a.groups) }));
}

// true, если ключ новый (уведомление ещё не отправляли)
export async function markSent(env, key) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO sent (key, created_at) VALUES (?, ?)").bind(key, now()).run();
  return r.meta.changes > 0;
}
