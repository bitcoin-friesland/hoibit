import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CLEANUP_AFTER_MS, RECENT_UPDATE_IDS, SESSION_TTL_MS, UNAUTHORIZED_NOTICE_TTL_MS, storeFor } from "../src/chat";
import { createSerialQueue } from "../src/helpers/queue";
import worker from "../src/index";
import { addAdmin, chatAs, memoryKv, resetAndStubFetch, SECRET, sessionOf, type SentMessage } from "./harness";

const ADMIN = 5001;
let sent: SentMessage[];

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

describe("storeFor", () => {
  it("expires the session and the unauthorized notice after their TTL", () => {
    const start = 1_000_000;
    let now = start;
    const store = storeFor(memoryKv(), () => now);
    store.putSession(ADMIN, { mode: "contact", step: "awaiting_name" });
    store.markUnauthorizedNotified();
    now = start + SESSION_TTL_MS - 1;
    expect(store.getSession(ADMIN)).toEqual({ mode: "contact", step: "awaiting_name" });
    now = start + SESSION_TTL_MS;
    expect(store.getSession(ADMIN)).toBeUndefined();
    now = start + UNAUTHORIZED_NOTICE_TTL_MS - 1;
    expect(store.wasUnauthorizedNotified()).toBe(true);
    now = start + UNAUTHORIZED_NOTICE_TTL_MS;
    expect(store.wasUnauthorizedNotified()).toBe(false);
  });

  it("keeps one session per user", () => {
    const store = storeFor(memoryKv());
    store.putSession(ADMIN, { mode: "contact" });
    store.putSession("5002", { mode: "org" });
    expect(store.getSession(String(ADMIN))).toEqual({ mode: "contact" });
    store.deleteSession(5002);
    expect(store.getSession(5002)).toBeUndefined();
    expect(store.getSession(ADMIN)).toEqual({ mode: "contact" });
  });

  it("recognises the last RECENT_UPDATE_IDS update ids", () => {
    const store = storeFor(memoryKv());
    for (let id = 1; id <= RECENT_UPDATE_IDS + 1; id++) expect(store.markUpdateSeen(id)).toBe(true);
    expect(store.markUpdateSeen(RECENT_UPDATE_IDS + 1)).toBe(false);
    expect(store.markUpdateSeen(2)).toBe(false);
    // The oldest id was dropped to keep the list short.
    expect(store.markUpdateSeen(1)).toBe(true);
  });

  it("is wiped no earlier than its data expires", () => {
    expect(CLEANUP_AFTER_MS).toBeGreaterThanOrEqual(Math.max(SESSION_TTL_MS, UNAUTHORIZED_NOTICE_TTL_MS));
  });
});

describe("createSerialQueue", () => {
  it("runs tasks one after another in call order, also after a failure", async () => {
    const run = createSerialQueue();
    const log: string[] = [];
    const task = (name: string, ms: number, fail = false) =>
      run(async () => {
        log.push(`start ${name}`);
        await new Promise(resolve => setTimeout(resolve, ms));
        log.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([task("a", 20, true), task("b", 1), task("c", 5)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map(r => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });
});

describe("updates arriving together in one chat", () => {
  it("handles them in order, each seeing the session the previous one left", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    // Delivered at the same time, as Telegram does with parallel webhook connections.
    // Without the per-chat queue both read step awaiting_name, and the email is rejected as a name.
    await Promise.all([chat.text("Alice"), chat.text("alice@example.com")]);
    expect(sessionOf(ADMIN)).toMatchObject({ name: "Alice", email: "alice@example.com", step: "awaiting_phone" });
    expect(sent.map(m => m.text)).not.toContain(
      "❌ Please enter a valid contact name (minimum 3 letters, only alphabetic)."
    );
  });
});

describe("ChatSession", () => {
  const ignoredUpdate = { message: { chat: { id: 777, type: "private" }, from: { id: 777 } } };

  it("schedules cleanup after an update and wipes its storage when the alarm runs", async () => {
    const stub = env.CHATS.getByName("777");
    const result = await stub.handleUpdate(ignoredUpdate);
    expect(result).toEqual({ status: 200, body: "Invalid input" });
    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThan(Date.now() + CLEANUP_AFTER_MS - 60_000);
      storeFor(state.storage.kv).putSession(777, { mode: "contact" });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(storeFor(state.storage.kv).getSession(777)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("receives updates from the webhook under the chat id", async () => {
    const request = new Request<unknown, IncomingRequestCfProperties>("https://telegram-crm.example/", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
      body: JSON.stringify({ update_id: 1, ...ignoredUpdate, message: { ...ignoredUpdate.message, chat: { id: 888 } } })
    });
    const res = await worker.fetch(request, { TELEGRAM_WEBHOOK_SECRET: SECRET, CHATS: env.CHATS } as unknown as Env);
    expect(await res.text()).toBe("Invalid input");
    await runInDurableObject(env.CHATS.getByName("888"), async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});
