import type { ChatId, SendOptions } from "../types";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

/**
 * Calls the Bot API. Returns the result, or undefined when Telegram refused the
 * call or could not be reached; both are logged. The request URL contains the
 * bot token, so it is never logged.
 */
export async function callTelegram<T>(env: Env, method: string, body: object): Promise<T | undefined> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const token = env.TELEGRAM_TOKEN;
    console.error("Telegram API call failed", { method, error: token ? error.replaceAll(token, "<token>") : error });
    return undefined;
  }
  const data = await res.json<TelegramResponse<T>>().catch(() => undefined);
  if (!data?.ok) {
    console.error("Telegram API call failed", {
      method,
      status: res.status,
      error_code: data?.error_code,
      description: data?.description
    });
    return undefined;
  }
  return data.result;
}

// SendOptions as the Bot API takes them, plus what asQuestion adds in a group.
export interface ApiSendOptions extends Omit<SendOptions, "reply_markup"> {
  reply_markup?: SendOptions["reply_markup"] | { force_reply: true; selective?: boolean };
  reply_parameters?: { message_id: number; allow_sending_without_reply: true };
}

// Sends a message; returns its message_id, or undefined when Telegram did not send it.
export async function sendMessage(env: Env, chatId: ChatId, text: string, options: ApiSendOptions = {}) {
  const { reply_markup, accepts_text: _, ...rest } = options;
  const message = await callTelegram<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...rest,
    ...(reply_markup ? { reply_markup: JSON.stringify(reply_markup) } : {})
  });
  return message?.message_id;
}

// The bot's own username, asked once per isolate; undefined while getMe fails.
let ownUsername: string | undefined;

export async function botUsername(env: Env) {
  ownUsername ??= (await callTelegram<{ username?: string }>(env, "getMe", {}))?.username;
  return ownUsername;
}

// A link that opens a private chat with the bot and sends it /start <parameter>; undefined
// while the bot's username is unknown.
export async function startLink(env: Env, parameter: string) {
  const username = await botUsername(env);
  return username ? `https://t.me/${username}?start=${parameter}` : undefined;
}
