import { env } from "cloudflare:test";
import { vi } from "vitest";
import crmApi from "../../crm-api/index.js";
import worker from "../index.js";

export const SECRET = "test-webhook-secret";

// env.DB is a test-only D1 for crm-api; telegram-crm itself only gets SESSIONS and crmApi.
const workerEnv = {
  SESSIONS: env.SESSIONS,
  TELEGRAM_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  CRM_API_URL: "https://crm-api",
  crmApi: { fetch: request => crmApi.fetch(request, { DB: env.DB }) }
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

// Clears CRM data and sessions, and stubs outgoing fetch: Telegram calls are recorded in
// the returned array, OpenStreetMap lookups find nothing.
export async function resetAndStubFetch() {
  await env.DB.batch(DATA_TABLES.map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  const keys = await env.SESSIONS.list();
  await Promise.all(keys.keys.map(key => env.SESSIONS.delete(key.name)));

  const sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.telegram.org/bottest-token/")) {
      if (url.endsWith("/sendMessage")) sent.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }
    if (url.startsWith("https://nominatim.openstreetmap.org/")) return Response.json([]);
    if (url.startsWith("https://overpass-api.de/")) return Response.json({ elements: [] });
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return sent;
}

let updateId = 0;

function deliver(update, secret = SECRET) {
  const headers = { "Content-Type": "application/json" };
  if (secret) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  const request = new Request("https://telegram-crm.example/", {
    method: "POST",
    headers,
    body: JSON.stringify({ update_id: ++updateId, ...update })
  });
  return worker.fetch(request, workerEnv);
}

// A private chat with one Telegram user; chat id equals user id, as in Telegram.
export function chatAs(userId) {
  const user = { id: userId, is_bot: false, first_name: "Test" };
  const chat = { id: userId, type: "private" };
  return {
    text: (text, { secret } = {}) =>
      deliver({ message: { message_id: ++updateId, from: user, chat, date: 0, text } }, secret),
    press: data =>
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

export async function addAdmin(telegramId, name = "Admin") {
  const res = await workerEnv.crmApi.fetch(
    new Request("https://crm-api/first-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telegram_id: String(telegramId), name })
    })
  );
  if (!res.ok) throw new Error(`first-user failed: ${res.status}`);
  return (await res.json()).id;
}
