import { DurableObject } from "cloudflare:workers";
import type { Send } from "./telegram";

// A spam button stops working after this; the sender of an older email cannot be blocked from it.
const KEEP_EMAILS_MS = 90 * 24 * 3_600_000;

export interface EmailRecord {
  sender: string;
  // The sender's display name, "" without one.
  name: string;
  received: number;
  messages: number[];
}

export type BlockedSender = {
  id: number;
  address: string;
  // When it was blocked, in milliseconds since 1970.
  since: number;
};

/**
 * The senders marked as spam, and for each recent email the sender and the Telegram messages
 * that carry it, so a spam button can block the one and delete the others. There is one
 * instance, named "blocklist".
 */
export class Blocklist extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS blocked (
      address TEXT PRIMARY KEY,
      since INTEGER NOT NULL
    )`);
    // sender is "" when the email named none; it can then be deleted but not blocked.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      received INTEGER NOT NULL
    )`);
    // Added for the ➕ Contact button; emails remembered before it have no name.
    if (
      !ctx.storage.sql
        .exec("PRAGMA table_info(emails)")
        .toArray()
        .some(c => c.name === "name")
    ) {
      ctx.storage.sql.exec("ALTER TABLE emails ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    }
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      email INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      PRIMARY KEY (email, message_id)
    )`);
  }

  isBlocked(addresses: string[]) {
    return addresses.some(
      address => this.ctx.storage.sql.exec("SELECT 1 FROM blocked WHERE address = ?", address).toArray().length > 0
    );
  }

  block(address: string) {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO blocked (address, since) VALUES (?, ?)", address, Date.now());
  }

  // The blocked senders, the most recently blocked first. id is the row's rowid, short enough for
  // the callback_data of an Unblock button, which an address may not be.
  listBlocked() {
    return this.ctx.storage.sql
      .exec<BlockedSender>("SELECT rowid AS id, address, since FROM blocked ORDER BY since DESC, rowid DESC")
      .toArray();
  }

  // Unblocks the sender with that id; returns their address, or undefined when it was not blocked.
  unblock(id: number) {
    return this.ctx.storage.sql
      .exec<{ address: string }>("DELETE FROM blocked WHERE rowid = ? RETURNING address", id)
      .toArray()[0]?.address;
  }

  // Starts remembering an email; returns its id. Forgets emails older than KEEP_EMAILS_MS.
  addEmail(sender: string, name = "") {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM messages WHERE email IN (SELECT id FROM emails WHERE received < ?)",
        now - KEEP_EMAILS_MS
      );
      this.ctx.storage.sql.exec("DELETE FROM emails WHERE received < ?", now - KEEP_EMAILS_MS);
      return this.ctx.storage.sql
        .exec<{ id: number }>(
          "INSERT INTO emails (sender, name, received) VALUES (?, ?, ?) RETURNING id",
          sender,
          name,
          now
        )
        .one().id;
    });
  }

  addMessage(email: number, messageId: number) {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO messages (email, message_id) VALUES (?, ?)", email, messageId);
  }

  // Named find, not email: a Durable Object method called email would be its email handler.
  find(id: number): EmailRecord | undefined {
    const row = this.ctx.storage.sql
      .exec<{ sender: string; name: string; received: number }>(
        "SELECT sender, name, received FROM emails WHERE id = ?",
        id
      )
      .toArray()[0];
    if (!row) return undefined;
    const messages = this.ctx.storage.sql
      .exec<{ message_id: number }>("SELECT message_id FROM messages WHERE email = ? ORDER BY message_id", id)
      .toArray()
      .map(m => m.message_id);
    return { sender: row.sender, name: row.name, received: row.received, messages };
  }

  forget(id: number) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE email = ?", id);
      this.ctx.storage.sql.exec("DELETE FROM emails WHERE id = ?", id);
    });
  }
}

export const blocklist = (env: Env) => env.BLOCKLIST.get(env.BLOCKLIST.idFromName("blocklist"));

// Remembers which email a delivered message belongs to. A failure only costs the spam button
// the ability to delete that message, so it is logged rather than thrown.
export async function remember(env: Env, send: Send, messageId: number | undefined) {
  if (send.email === undefined || messageId === undefined) return;
  try {
    await blocklist(env).addMessage(send.email, messageId);
  } catch (err) {
    console.error("Could not remember the Telegram message of an email:", err);
  }
}
