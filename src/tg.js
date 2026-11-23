// ✉️ Telegram Bot API
export async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.error("TG error", method, json.description);
  return json;
}

export const send = (env, chatId, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

export const edit = (env, chatId, messageId, text, extra = {}) =>
  tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const inline = (rows) => ({ reply_markup: { inline_keyboard: rows } });

// Нижняя клавиатура не используется — только кнопка «Меню» с командами
export const NO_KB = { reply_markup: { remove_keyboard: true } };

export const ADD_KB = {
  reply_markup: {
    keyboard: [[{ text: "📍 Отправить геопозицию", request_location: true }], [{ text: "Отмена" }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

export async function webhookSecret(token) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`svet:${token}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
