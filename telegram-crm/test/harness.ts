import { createExecutionContext, env } from "cloudflare:test";
import { vi } from "vitest";
import CrmApi from "../../crm-api/src/index";
import { storeFor } from "../src/chat";
import { forgetCommandMenus } from "../src/helpers/menu";
import { createSerialQueue } from "../src/helpers/queue";
import worker from "../src/index";
import { chatIdOf, processUpdate } from "../src/update";
import type { SessionStore, TelegramUpdate } from "../src/types";

export const SECRET = "test-webhook-secret";
export const BOT_USERNAME = "HoiBitBot";

// env.DB is a test-only D1 for crm-api. The bot gets the CrmApi class itself as its
// crmApi binding; crm-api's own tests cover the real RPC stub.
const crmApi = new CrmApi(createExecutionContext(), { DB: env.DB });
// Stands in for mail-to-tg's SpamButtons; mail-to-tg's own tests cover the real one.
type SpamAnswer = string | { text: string; alert?: boolean };
let spamPresses: { data: string; chatId: number; messageId: number }[] = [];
let spamAnswer: () => Promise<SpamAnswer> = async () => "Delete this email and block its sender?";
// The senders of emails, by email id, for the ➕ Contact button.
let emailSenders = new Map<number, { address: string; name: string }>();
const mailToTg = {
  press: async (data: string, chatId: number, messageId: number) => {
    spamPresses.push({ data, chatId, messageId });
    return spamAnswer();
  },
  sender: async (email: number) => emailSenders.get(email),
  blocked: async () => [...blockedSenders.values()].sort((a, b) => b.since - a.since),
  unblock: async (id: number) => {
    const address = blockedSenders.get(id)?.address;
    blockedSenders.delete(id);
    return address;
  }
};
// The senders mail-to-tg has blocked, by id.
let blockedSenders = new Map<number, { id: number; address: string; since: number }>();

// Lets mail-to-tg list address as blocked since since, until the next reset.
export function blockSender(id: number, address: string, since: number) {
  blockedSenders.set(id, { id, address, since });
}
export const workerEnv = {
  TELEGRAM_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  crmApi: crmApi as unknown as Env["crmApi"],
  mailToTg: mailToTg as unknown as Env["mailToTg"]
} as Env;

// The spam button presses passed on to mail-to-tg in the current test.
export function spamButtonPresses() {
  return spamPresses;
}

// Lets mail-to-tg know the sender of email, until the next reset.
export function emailFrom(email: number, sender: { address: string; name: string }) {
  emailSenders.set(email, sender);
}

// What mail-to-tg answers a spam button press with, until the next reset.
export function answerSpamButtons(answer: () => Promise<SpamAnswer>) {
  spamAnswer = answer;
}

const DATA_TABLES = [
  "audit_log",
  "conversations",
  "organization_communities",
  "organization_team_members",
  "organization_notes",
  "contact_phones",
  "contact_emails",
  "contacts",
  "organizations",
  "team_invites",
  "team_member_communities",
  "team_members"
];

export interface SentMessage {
  chat_id: number;
  text: string;
  reply_markup?: string;
  reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
  parse_mode?: string;
}

export interface CallbackAnswer {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

type Keyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };

// A message the bot sent, as it looks now: edits change its text and buttons.
export interface ChatMessage {
  chat_id: number;
  message_id: number;
  text: string;
  entities?: unknown[];
  reply_markup?: Keyboard;
}

// A Bot API call other than sendMessage, such as editMessageText or setMyCommands.
export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

// SyncKvStorage backed by a Map, standing in for a ChatSession's ctx.storage.kv.
// Values are copied like real storage does, so two readers never share one object.
export function memoryKv(): SyncKvStorage {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    put: (key, value) => void map.set(key, structuredClone(value)),
    delete: key => map.delete(key),
    list: <T>() => map.entries() as Iterable<[string, T]>
  };
}

// Per chat: its session store and its update queue, as the chat's Durable Object would have.
let chats = new Map<number, { store: SessionStore; serial: ReturnType<typeof createSerialQueue> }>();
// Every message the bot sent, by message id, as it looks after edits.
let messages = new Map<number, ChatMessage>();
let calls: TelegramCall[] = [];
let answers: CallbackAnswer[] = [];
let lastDelivered: { body: string; secret: string | null } | undefined;
// One counter for update ids and message ids, so ids never collide.
let nextId = 0;

const TELEGRAM_API = "https://api.telegram.org/bottest-token/";

// Clears CRM data and sessions, and stubs outgoing fetch: Telegram messages are recorded in
// the returned array, OpenStreetMap returns the given Nominatim results and nothing from Overpass.
export async function resetAndStubFetch({ nominatim = [] as object[] } = {}): Promise<SentMessage[]> {
  await env.DB.batch(DATA_TABLES.map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  chats = new Map();
  messages = new Map();
  calls = [];
  answers = [];
  forgetCommandMenus();
  lastDelivered = undefined;
  spamPresses = [];
  emailSenders = new Map();
  blockedSenders = new Map();
  spamAnswer = async () => "Delete this email and block its sender?";

  const sent: SentMessage[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(TELEGRAM_API)) {
      const method = url.slice(TELEGRAM_API.length);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      // sendMessage gets reply_markup as a JSON string, the edit methods as an object.
      const markup = (value: unknown): Keyboard | undefined =>
        typeof value === "string" ? JSON.parse(value) : (value as Keyboard | undefined);
      if (method === "sendMessage") {
        sent.push(body);
        const messageId = ++nextId;
        const keyboard = markup(body.reply_markup);
        messages.set(messageId, {
          chat_id: Number(body.chat_id),
          message_id: messageId,
          text: body.text,
          ...(keyboard?.inline_keyboard ? { reply_markup: keyboard } : {})
        });
        return Response.json({ ok: true, result: { message_id: messageId, chat: { id: body.chat_id }, date: 0 } });
      }
      calls.push({ method, body });
      if (method === "editMessageText" || method === "editMessageReplyMarkup") {
        const message = messages.get(body.message_id);
        if (!message || String(message.chat_id) !== String(body.chat_id)) {
          return Response.json({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
        }
        if (method === "editMessageText") {
          message.text = body.text;
          message.entities = body.entities;
        }
        message.reply_markup = markup(body.reply_markup);
        return Response.json({ ok: true, result: { message_id: message.message_id } });
      }
      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: { id: 1, is_bot: true, first_name: "HoiBit", username: BOT_USERNAME }
        });
      }
      if (method === "answerCallbackQuery") answers.push(body);
      return Response.json({ ok: true, result: true });
    }
    if (url.startsWith("https://nominatim.openstreetmap.org/")) return Response.json(nominatim);
    if (url.startsWith("https://overpass-api.de/")) {
      // Recorded among the Bot API calls, so tests can check what was searched for.
      calls.push({ method: "overpass", body: { data: new URLSearchParams(String(init?.body)).get("data") } });
      return Response.json({ elements: [] });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return sent;
}

// The answerCallbackQuery calls of the current test, in order.
export function callbackAnswers(): CallbackAnswer[] {
  return answers;
}

// The Bot API calls of the current test other than sendMessage, in order.
export function telegramCalls(method?: string): TelegramCall[] {
  return method ? calls.filter(c => c.method === method) : calls;
}

// A message the bot sent, as it looks now.
export function messageById(messageId: number) {
  return messages.get(messageId);
}

// The newest message in the chat that still has buttons to press, as it looks now.
export function lastKeyboardMessage(chatId: number): ChatMessage | undefined {
  return [...messages.values()]
    .filter(m => String(m.chat_id) === String(chatId) && m.reply_markup?.inline_keyboard.some(row => row.length > 0))
    .at(-1);
}

// The message id of the newest message in the chat that still has buttons.
export function lastKeyboardMessageId(chatId: number) {
  return lastKeyboardMessage(chatId)?.message_id;
}

function post(body: string, secret: string | null) {
  lastDelivered = { body, secret };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  const request = new Request<unknown, IncomingRequestCfProperties>("https://telegram-crm.example/", {
    method: "POST",
    headers,
    body
  });
  if (secret !== SECRET) return worker.fetch(request, workerEnv);
  // Valid updates go where index.ts sends them: processUpdate in the chat's (here in-memory) Durable Object.
  return request.json<TelegramUpdate>().then(async parsed => {
    const chatId = Number(chatIdOf(parsed));
    if (!chats.has(chatId)) chats.set(chatId, { store: storeFor(memoryKv()), serial: createSerialQueue() });
    const chat = chats.get(chatId)!;
    const { status, body } = await chat.serial(() => processUpdate(workerEnv, chat.store, parsed));
    return new Response(body, { status });
  });
}

function deliver(update: object, secret: string | null = SECRET) {
  return post(JSON.stringify({ update_id: ++nextId, ...update }), secret);
}

// Delivers the last update again with the same update_id, as Telegram does after a
// non-2xx or slow response.
export function redeliverLast() {
  if (!lastDelivered) throw new Error("Nothing delivered yet");
  return post(lastDelivered.body, lastDelivered.secret);
}

// The session of userId in chatId; in a private chat the user id is the chat id.
export function sessionOf(chatId: number, userId: number = chatId) {
  return chats.get(chatId)?.store.getSession(userId);
}

type Chat = { id: number; type: string };

// What a user's Telegram profile says about them; first_name is always set in Telegram.
export interface Profile {
  first_name?: string;
  last_name?: string;
  username?: string;
}

// One Telegram user in one chat.
function userIn(chat: Chat, userId: number, profile: Profile = {}) {
  const user = { id: userId, is_bot: false, first_name: "Test", ...profile };
  return {
    text: (text: string, { secret }: { secret?: string | null } = {}) =>
      deliver({ message: { message_id: ++nextId, from: user, chat, date: 0, text } }, secret),
    // Shares a contact from the user's Telegram contacts, as a message without text.
    shareContact: (contact: { phone_number: string; first_name: string; last_name?: string }) =>
      deliver({ message: { message_id: ++nextId, from: user, chat, date: 0, contact } }),
    // Presses a button on message messageId; by default on the newest message in this chat
    // that still has buttons (a fresh id when there is none). Telegram sends the message along.
    press: (data: string, { messageId }: { messageId?: number } = {}) => {
      const id = messageId ?? lastKeyboardMessageId(chat.id) ?? ++nextId;
      const message = messages.get(id);
      return deliver({
        callback_query: {
          id: String(++nextId),
          from: user,
          data,
          message: {
            message_id: id,
            chat,
            date: 0,
            ...(message ? { text: message.text, entities: message.entities, reply_markup: message.reply_markup } : {})
          }
        }
      });
    }
  };
}

// A private chat with one Telegram user; chat id equals user id, as in Telegram.
export function chatAs(userId: number, profile?: Profile) {
  return userIn({ id: userId, type: "private" }, userId, profile);
}

// A group chat: groupChat(id).as(userId) sends as one of its members.
export function groupChat(chatId = -1001234567890) {
  const chat = { id: chatId, type: "supergroup" };
  return {
    id: chatId,
    as: (userId: number, profile?: Profile) => userIn(chat, userId, profile),
    sessionOf: (userId: number) => sessionOf(chatId, userId)
  };
}

export async function addAdmin(telegramId: number, name = "Admin") {
  const res = await crmApi.firstUser({ telegram_id: String(telegramId), name });
  if (!res.ok) throw new Error(`firstUser failed: ${res.error}`);
  return res.id;
}

// A team member without admin rights.
export async function addMember(telegramId: number, name = "Member") {
  return env.DB.prepare("INSERT INTO team_members (telegram_id, name) VALUES (?, ?) RETURNING id")
    .bind(String(telegramId), name)
    .first<number>("id");
}
