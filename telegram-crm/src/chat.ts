import { DurableObject } from "cloudflare:workers";
import { createSerialQueue } from "./helpers/queue";
import { processUpdate } from "./update";
import type { Session, SessionStore, TelegramUpdate, UpdateResult } from "./types";

// A flow can be resumed within a working day; after that it is forgotten.
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const UNAUTHORIZED_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
// Storage of a chat is wiped this long after its last update; at least the longest TTL above.
export const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * One Durable Object per Telegram chat (named by chat id). It keeps the chat's
 * session and handles the chat's updates strictly one at a time, so quick button
 * presses never overwrite each other's changes. Different chats run in parallel.
 */
export class ChatSession extends DurableObject<Env> {
  private readonly serial = createSerialQueue();

  async handleUpdate(update: TelegramUpdate): Promise<UpdateResult> {
    // Input gates only cover storage calls, not the awaits on Telegram and crm-api,
    // so updates of this chat are queued explicitly.
    return this.serial(async () => {
      const result = await processUpdate(this.env, storeFor(this.ctx.storage.kv), update);
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_AFTER_MS);
      return result;
    });
  }

  async alarm() {
    // With compatibility date 2026-02-24 or later this also removes the alarm.
    await this.ctx.storage.deleteAll();
  }
}

export function storeFor(kv: SyncKvStorage, now: () => number = Date.now): SessionStore {
  return {
    getSession() {
      const stored = kv.get<{ session: Session; expiresAt: number }>("session");
      return stored && stored.expiresAt > now() ? stored.session : undefined;
    },
    putSession(session) {
      kv.put("session", { session, expiresAt: now() + SESSION_TTL_MS });
    },
    deleteSession() {
      kv.delete("session");
    },
    wasUnauthorizedNotified() {
      const until = kv.get<number>("unauthorized_notified_until");
      return until !== undefined && until > now();
    },
    markUnauthorizedNotified() {
      kv.put("unauthorized_notified_until", now() + UNAUTHORIZED_NOTICE_TTL_MS);
    }
  };
}
