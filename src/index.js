// ⚡ Svet — Telegram-бот отключений света (Одесса, ДТЕК Одеські електромережі)
import { ensureSchema, loadDtek } from "./db.js";
import { handleUpdate } from "./bot.js";
import { runCron } from "./cron.js";
import { tg, webhookSecret } from "./tg.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    await ensureSchema(env);

    // Вебхук Telegram
    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = await webhookSecret(env.BOT_TOKEN);
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return new Response("forbidden", { status: 403 });
      const update = await request.json();
      ctx.waitUntil(handleUpdate(env, update).catch((e) => console.error("update failed", e)));
      return new Response("ok");
    }

    // Однократная настройка: вебхук + команды
    if (url.pathname === "/setup") {
      if (!env.BOT_TOKEN) return json({ ok: false, error: "Нет секрета BOT_TOKEN" });
      const secret = await webhookSecret(env.BOT_TOKEN);
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      const cmds = await tg(env, "setMyCommands", {
        commands: [
          { command: "graph", description: "📊 График" },
          { command: "addresses", description: "🏠 Мои адреса" },
          { command: "add", description: "➕ Добавить адрес" },
          { command: "settings", description: "🔔 Уведомления" },
          { command: "help", description: "ℹ️ Помощь" },
        ],
      });
      const me = await tg(env, "getMe", {});
      return json({ webhook: hook, commands: cmds.ok, bot: me.result?.username });
    }

    // Ручной запуск проверки (то же, что cron)
    if (url.pathname === "/run") {
      const secret = await webhookSecret(env.BOT_TOKEN || "");
      if (url.searchParams.get("key") !== secret.slice(0, 12)) return new Response("forbidden", { status: 403 });
      return json(await runCron(env));
    }

    // Статус
    const d = await loadDtek(env).catch((e) => ({ error: String(e) }));
    return json({
      bot: "⚡ Svet",
      dtekUpdate: d.fact?.update || null,
      days: d.fact ? Object.keys(d.fact.data).length : 0,
      error: d.error || null,
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env).catch((e) => console.error("cron failed", e)));
  },
};

const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
