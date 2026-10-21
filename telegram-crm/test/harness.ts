import { createExecutionContext, env } from "cloudflare:test";
import { vi } from "vitest";
import CrmApi from "../../crm-api/src/index";
import { storeFor } from "../src/chat";
import { createSerialQueue } from "../src/helpers/queue";
import worker from "../src/index";
import { chatIdOf, processUpdate } from "../src/update";
import type { SessionStore, TelegramUpdate } from "../src/types";

export const SECRET = "test-webhook-secret";

// env.DB is a test-only D1 for crm-api. The bot gets the CrmApi class itself as its
// crmApi binding; crm-api's own tests cover the real RPC stub.
const crmApi = new CrmApi(createExecutionContext(), { DB: env.DB });
const workerEnv = {
  TELEGRAM_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  crmApi: crmApi as unknown as Env["crmApi"]
};

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

// Clears CRM data and sessions, and stubs outgoing fetch: Telegram messages are recorded in
// the returned array, OpenStreetMap returns the given Nominatim results and nothing from Overpass.
export async function resetAndStubFetch({ nominatim = [] as object[] } = {}): Promise<SentMessage[]> {
  await env.DB.batch(DATA_TABLES.map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  chats = new Map();

  const sent: SentMessage[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.telegram.org/bottest-token/")) {
      if (url.endsWith("/sendMessage")) sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    if (url.startsWith("https://nominatim.openstreetmap.org/")) return Response.json(nominatim);
    if (url.startsWith("https://overpass-api.de/")) return Response.json({ elements: [] });
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return sent;
}

let updateId = 0;

function deliver(update: object, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  const request = new Request<unknown, IncomingRequestCfProperties>("https://telegram-crm.example/", {
    method: "POST",
    headers,
    body: JSON.stringify({ update_id: ++updateId, ...update })
  });
  if (secret !== SECRET) return worker.fetch(request, workerEnv as Env);
  // Valid updates go where index.ts sends them: processUpdate in the chat's (here in-memory) Durable Object.
  return request.json<TelegramUpdate>().then(async parsed => {
    const chatId = Number(chatIdOf(parsed));
    if (!chats.has(chatId)) chats.set(chatId, { store: storeFor(memoryKv()), serial: createSerialQueue() });
    const chat = chats.get(chatId)!;
    const { status, body } = await chat.serial(() => processUpdate(workerEnv as Env, chat.store, parsed));
    return new Response(body, { status });
  });
}

export function sessionOf(chatId: number) {
  return chats.get(chatId)?.store.getSession();
}

// A private chat with one Telegram user; chat id equals user id, as in Telegram.
export function chatAs(userId: number) {
  const user = { id: userId, is_bot: false, first_name: "Test" };
  const chat = { id: userId, type: "private" };
  return {
    text: (text: string, { secret }: { secret?: string | null } = {}) =>
      deliver({ message: { message_id: ++updateId, from: user, chat, date: 0, text } }, secret),
    press: (data: string) =>
      deliver({
        callback_query: {
          id: String(++updateId),
          from: user,
          data,
          message: { message_id: updateId, chat, date: 0 }
        }
      })
  };
}

export async function addAdmin(telegramId: number, name = "Admin") {
  const res = await crmApi.firstUser({ telegram_id: String(telegramId), name });
  if (!res.ok) throw new Error(`firstUser failed: ${res.error}`);
  return res.id;
}
