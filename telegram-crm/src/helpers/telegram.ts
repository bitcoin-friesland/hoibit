import type { ChatId, InlineKeyboardButton, SendOptions } from "../types";

// Telegram's limit for the text of one message.
const MAX_MESSAGE_LENGTH = 4096;

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
  const { reply_markup, accepts_text: _, replace: __, ...rest } = options;
  const message = await callTelegram<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...rest,
    ...(reply_markup ? { reply_markup: JSON.stringify(reply_markup) } : {})
  });
  return message?.message_id;
}

// Gives a message new text and buttons; false when Telegram refused, e.g. for a message too old to edit.
export async function editMessage(env: Env, chatId: ChatId, messageId: number, text: string, options: SendOptions) {
  const edited = await callTelegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
    ...(options.reply_markup ? { reply_markup: options.reply_markup } : {})
  });
  return edited !== undefined;
}

// Takes the buttons off a message, so they can no longer be pressed.
export async function clearKeyboard(env: Env, chatId: ChatId, messageId: number) {
  await callTelegram(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] }
  });
}

// A message whose button was pressed, as Telegram sends it along with the press.
export interface PressedMessage {
  messageId: number;
  text?: string;
  // The formatting of text (bold, links); kept when the message is edited.
  entities?: unknown[];
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
}

// The text of the pressed button.
export function pressedLabel(message: PressedMessage, data: string | undefined) {
  const button = message.reply_markup?.inline_keyboard
    .flat()
    .find(b => "callback_data" in b && b.callback_data === data);
  return button?.text;
}

/**
 * Marks the question in message as answered: the buttons go and the answer is added below the
 * text, so the chat keeps showing what was chosen. Without an answer, or when the text would get
 * too long, only the buttons go.
 */
export async function markAnswered(env: Env, chatId: ChatId, message: PressedMessage, answer: string | undefined) {
  const text = message.text && answer ? `${message.text}\n\n➡️ ${answer}` : undefined;
  if (text && text.length <= MAX_MESSAGE_LENGTH) {
    const edited = await callTelegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: message.messageId,
      text,
      ...(message.entities ? { entities: message.entities } : {}),
      reply_markup: { inline_keyboard: [] }
    });
    if (edited !== undefined) return;
  }
  await clearKeyboard(env, chatId, message.messageId);
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
