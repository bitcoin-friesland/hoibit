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
    const update = await request.json<TelegramUpdate>();
    const chatId = chatIdOf(update);
    if (!chatId) return new Response("Invalid input");
    // Each chat has its own Durable Object holding its session (see chat.ts).
    const { status, body } = await env.CHATS.getByName(String(chatId)).handleUpdate(update);
    return new Response(body, { status });
  }
} satisfies ExportedHandler<Env>;
