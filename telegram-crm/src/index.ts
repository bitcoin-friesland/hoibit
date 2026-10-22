import { sendFollowUpReminders } from "./flows/followup";
import { chatIdOf } from "./update";
import type { TelegramUpdate } from "./types";

export { ChatSession } from "./chat";

// Verify the request comes from Telegram: setWebhook was called with
// secret_token = TELEGRAM_WEBHOOK_SECRET, Telegram echoes it in this header.
// Fails closed when the secret is not configured.
function isFromTelegram(request: Request, env: Env) {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!expected || !received) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(received);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    if (!isFromTelegram(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }
    // Any answer other than 2xx makes Telegram send the update again, and again;
    // a failing update would then be handled over and over. So a request with the
    // right secret always gets 200, and failures are logged instead.
    try {
      const update = await request.json<TelegramUpdate>();
      const chatId = chatIdOf(update);
      if (!chatId) return new Response("Invalid input");
      // Each chat has its own Durable Object holding its sessions (see chat.ts).
      const { status, body } = await env.CHATS.getByName(String(chatId)).handleUpdate(update);
      return new Response(body, { status });
    } catch (e) {
      console.error("Webhook update failed", e);
      return new Response("Error");
    }
  },

  // The morning reminder of follow-ups (crons in wrangler.toml).
  async scheduled(_controller, env): Promise<void> {
    await sendFollowUpReminders(env);
  }
} satisfies ExportedHandler<Env>;
