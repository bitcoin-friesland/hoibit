import { DurableObject } from "cloudflare:workers";
import { createSerialQueue } from "./helpers/queue";
import { processUpdate } from "./update";
import type { Session, SessionStore, TelegramUpdate, UpdateResult, UserId } from "./types";

// A flow can be resumed within a working day; after that it is forgotten.
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const UNAUTHORIZED_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
// Storage of a chat is wiped this long after its last update; at least the longest TTL above.
export const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * One Durable Object per Telegram chat (named by chat id). It keeps the sessions
 * of the chat's users and handles the chat's updates strictly one at a time, so
 * quick button presses never overwrite each other's changes. Different chats run
 * in parallel. processUpdate never throws, so a failing update does not make
 * Telegram redeliver it.
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

// How many recent update ids a chat remembers to skip redeliveries.
export const RECENT_UPDATE_IDS = 50;

// Sessions are per user: in a group every member runs their own flow.
const sessionKey = (userId: UserId) => `session:${userId}`;
// Per user too, so in a group every newcomer is told once how to join.
const unauthorizedKey = (userId: UserId) => `unauthorized_notified_until:${userId}`;

export function storeFor(kv: SyncKvStorage, now: () => number = Date.now): SessionStore {
  return {
    getSession(userId) {
      const stored = kv.get<{ session: Session; expiresAt: number }>(sessionKey(userId));
      return stored && stored.expiresAt > now() ? stored.session : undefined;
    },
    putSession(userId, session) {
      kv.put(sessionKey(userId), { session, expiresAt: now() + SESSION_TTL_MS });
    },
    deleteSession(userId) {
      kv.delete(sessionKey(userId));
    },
    markUpdateSeen(updateId) {
      const recent = kv.get<number[]>("recent_update_ids") ?? [];
      if (recent.includes(updateId)) return false;
      kv.put("recent_update_ids", [...recent, updateId].slice(-RECENT_UPDATE_IDS));
      return true;
    },
    wasUnauthorizedNotified(userId) {
      const until = kv.get<number>(unauthorizedKey(userId));
      return until !== undefined && until > now();
    },
    markUnauthorizedNotified(userId) {
      kv.put(unauthorizedKey(userId), now() + UNAUTHORIZED_NOTICE_TTL_MS);
    }
  };
}
