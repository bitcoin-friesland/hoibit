const MAX_RETRY_WAIT_SECONDS = 30;

// Telegram HTML parse mode: only <, > and & in text need escaping.
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface TelegramResponse {
  ok?: boolean;
  result?: unknown;
  description?: string;
  parameters?: { retry_after?: number };
}

// Calls the Bot API and returns its result; throws unless Telegram confirms with ok: true.
// Waits out 429s (up to MAX_RETRY_WAIT_SECONDS in total) and retries a 5xx or network error once.
export async function callTelegram(env: Env, method: string, body: string | FormData) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`;
  const init: RequestInit = { method: "POST", body };
  if (typeof body === "string") init.headers = { "Content-Type": "application/json" };

  let waited = 0;
  let retried = false;
  for (;;) {
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      if (retried) throw new Error(`Telegram ${method} failed: ${err}`, { cause: err });
      console.warn(`Telegram ${method} network error, retrying once:`, err);
      retried = true;
      await sleep(1000);
      continue;
    }

    const data = (await resp.json().catch(() => ({}))) as TelegramResponse;
    if (resp.ok && data.ok) return data.result;

    const reason = `${resp.status} ${data.description ?? resp.statusText}`;
    if (resp.status === 429) {
      const wait = Math.max(1, data.parameters?.retry_after ?? 1);
      if (waited + wait <= MAX_RETRY_WAIT_SECONDS) {
        console.warn(`Telegram ${method} rate limited, retrying after ${wait}s`);
        waited += wait;
        await sleep(wait * 1000);
        continue;
      }
    } else if (resp.status >= 500 && !retried) {
      console.warn(`Telegram ${method} failed with ${reason}, retrying once`);
      retried = true;
      await sleep(1000);
      continue;
    }
    throw new Error(`Telegram ${method} failed: ${reason}`);
  }
}

// The bot's username, asked once per isolate; undefined while getMe fails.
let botUsername: string | undefined;

async function ownUsername(env: Env) {
  if (botUsername) return botUsername;
  try {
    botUsername = ((await callTelegram(env, "getMe", "{}")) as { username?: string } | undefined)?.username;
  } catch (err) {
    console.error("Could not get the bot's username:", err);
  }
  return botUsername;
}

// For tests, which start every case without it.
export function forgetBotUsername() {
  botUsername = undefined;
}

/**
 * The buttons under the last message of every email: 🚫 Spam (see buttons.ts), and ➕ Contact,
 * which opens the private chat with the bot (telegram-crm) as t.me/<bot>?start=mc_<email>, so a
 * team member can save the sender as a contact. Without the bot's username only the first.
 */
export async function emailKeyboard(env: Env, email: number) {
  const username = await ownUsername(env);
  const spam = { text: "🚫 Spam", callback_data: `spam:${email}` };
  return {
    inline_keyboard: [
      username ? [spam, { text: "➕ Contact", url: `https://t.me/${username}?start=mc_${email}` }] : [spam]
    ]
  };
}

// Returns the id of the message Telegram created.
function messageId(result: unknown) {
  const id = (result as { message_id?: unknown } | undefined)?.message_id;
  return typeof id === "number" ? id : undefined;
}

async function sendMessage(env: Env, send: Send & { kind: "message" }) {
  const html = escapeHtml(send.text);
  const result = await callTelegram(
    env,
    "sendMessage",
    JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: send.first ? html.replace("📩 New Email", "📩 <b>New Email</b>") : html,
      parse_mode: "HTML",
      ...(send.silent ? { disable_notification: true } : {}),
      ...(send.button && send.email !== undefined ? { reply_markup: await emailKeyboard(env, send.email) } : {})
    })
  );
  return messageId(result);
}

async function sendDocument(env: Env, send: Send & { kind: "document" }) {
  const form = new FormData();
  form.append("chat_id", String(env.TELEGRAM_CHAT_ID));
  form.append("document", new File([send.text], "email.txt", { type: "text/plain;charset=utf-8" }));
  if (send.silent) form.append("disable_notification", "true");
  if (send.button && send.email !== undefined) {
    form.append("reply_markup", JSON.stringify(await emailKeyboard(env, send.email)));
  }
  return messageId(await callTelegram(env, "sendDocument", form));
}

/**
 * One Bot API call that carries (part of) an email; plain data, so the outbox can store it.
 * silent: sent without a notification (likely spam). email: the id under which the blocklist
 * remembers the email's messages, so a spam button can delete them all. button: this call
 * carries the spam button, on the last message of the email.
 */
export type Send = ({ kind: "message"; text: string; first?: boolean } | { kind: "document"; text: string }) & {
  silent?: boolean;
  email?: number;
  button?: boolean;
};

// Returns the id of the message Telegram created, when it says.
export async function deliver(env: Env, send: Send) {
  return send.kind === "document" ? sendDocument(env, send) : sendMessage(env, send);
}
