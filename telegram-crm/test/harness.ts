import { createExecutionContext, env } from "cloudflare:test";
import { vi } from "vitest";
import CrmApi from "../../crm-api/src/index";
import { storeFor } from "../src/chat";
import { createSerialQueue } from "../src/helpers/queue";
import worker from "../src/index";
import { chatIdOf, processUpdate } from "../src/update";
import type { SessionStore, TelegramUpdate } from "../src/types";

export const SECRET = "test-webhook-secret";
export const BOT_USERNAME = "HoiBitBot";

// env.DB is a test-only D1 for crm-api. The bot gets the CrmApi class itself as its
// crmApi binding; crm-api's own tests cover the real RPC stub.
const crmApi = new CrmApi(createExecutionContext(), { DB: env.DB });
export const workerEnv = {
  TELEGRAM_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  crmApi: crmApi as unknown as Env["crmApi"]
} as Env;

const DATA_TABLES = [
  "audit_log",
  "conversations",
  "organization_communities",
  "contact_phones",
  "contact_emails",
  "contacts",
  "organizations",
  "team_member_communities",
  "team_members"
];

export interface SentMessage {
  chat_id: number;
  text: string;
  reply_markup?: string;
  parse_mode?: string;
}

export interface CallbackAnswer {
  callback_query_id: string;
  text?: string;
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
// Per chat: the message id of the last message the bot sent with an inline keyboard.
let keyboards = new Map<string, number>();
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
  keyboards = new Map();
  answers = [];
  lastDelivered = undefined;

  const sent: SentMessage[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(TELEGRAM_API)) {
      const method = url.slice(TELEGRAM_API.length);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (method === "sendMessage") {
        sent.push(body);
        const messageId = ++nextId;
        if (body.reply_markup) keyboards.set(String(body.chat_id), messageId);
        return Response.json({ ok: true, result: { message_id: messageId, chat: { id: body.chat_id }, date: 0 } });
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
    if (url.startsWith("https://overpass-api.de/")) return Response.json({ elements: [] });
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return sent;
}

// The answerCallbackQuery calls of the current test, in order.
export function callbackAnswers(): CallbackAnswer[] {
  return answers;
}

// The message id of the last message with an inline keyboard the bot sent to this chat.
export function lastKeyboardMessageId(chatId: number) {
  return keyboards.get(String(chatId));
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

// One Telegram user in one chat.
function userIn(chat: Chat, userId: number) {
  const user = { id: userId, is_bot: false, first_name: "Test" };
  return {
    text: (text: string, { secret }: { secret?: string | null } = {}) =>
      deliver({ message: { message_id: ++nextId, from: user, chat, date: 0, text } }, secret),
    // Presses a button on message messageId; by default on the last message with a
    // keyboard the bot sent to this chat (a fresh id when it sent none).
    press: (data: string, { messageId }: { messageId?: number } = {}) =>
      deliver({
        callback_query: {
          id: String(++nextId),
          from: user,
          data,
          message: { message_id: messageId ?? keyboards.get(String(chat.id)) ?? ++nextId, chat, date: 0 }
        }
      })
  };
}

// A private chat with one Telegram user; chat id equals user id, as in Telegram.
export function chatAs(userId: number) {
  return userIn({ id: userId, type: "private" }, userId);
}

// A group chat: groupChat(id).as(userId) sends as one of its members.
export function groupChat(chatId = -1001234567890) {
  const chat = { id: chatId, type: "supergroup" };
  return {
    id: chatId,
    as: (userId: number) => userIn(chat, userId),
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
