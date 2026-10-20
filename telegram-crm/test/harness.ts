import { createExecutionContext, env } from "cloudflare:test";
import { vi } from "vitest";
import CrmApi from "../../crm-api/src/index";
import worker from "../src/index";

export const SECRET = "test-webhook-secret";

// env.DB is a test-only D1 for crm-api. The bot gets the CrmApi class itself as its
// crmApi binding; crm-api's own tests cover the real RPC stub.
const crmApi = new CrmApi(createExecutionContext(), { DB: env.DB });
const workerEnv = {
  SESSIONS: env.SESSIONS,
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

// Clears CRM data and sessions, and stubs outgoing fetch: Telegram messages are recorded in
// the returned array, OpenStreetMap returns the given Nominatim results and nothing from Overpass.
export async function resetAndStubFetch({ nominatim = [] as object[] } = {}): Promise<SentMessage[]> {
  await env.DB.batch(DATA_TABLES.map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  const keys = await env.SESSIONS.list();
  await Promise.all(keys.keys.map(key => env.SESSIONS.delete(key.name)));

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
  return worker.fetch(request, workerEnv as Env);
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
