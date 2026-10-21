import { DurableObject } from "cloudflare:workers";
import { remember } from "./blocklist";
import { deliver, sleep, type Send } from "./telegram";

// First retry after a minute, then twice as long each time, up to an hour. It never gives up:
// the email has nowhere else to go.
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 3_600_000;
// A row holds at most 2 MB; at up to 3 UTF-8 bytes per character a chunk stays below that.
const CHUNK_LENGTH = 500_000;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// Splits text into chunks without cutting a surrogate pair: SQLite would store half a pair as U+FFFD.
function chunks(text: string) {
  const result: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_LENGTH) {
    const cut = isHighSurrogate(rest.charCodeAt(CHUNK_LENGTH - 1)) ? CHUNK_LENGTH - 1 : CHUNK_LENGTH;
    result.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  result.push(rest);
  return result;
}

const formatTime = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

interface Row extends Record<string, SqlStorageValue> {
  id: number;
  kind: string;
  first: number;
  text: string;
  continued: number;
  silent: number;
  email: number | null;
  button: number;
}

// Columns added after v1; a table created before them gets them on first use.
const LATER_COLUMNS = {
  silent: "INTEGER NOT NULL DEFAULT 0",
  email: "INTEGER",
  button: "INTEGER NOT NULL DEFAULT 0"
};

/**
 * The Bot API calls of emails Telegram did not take, oldest first. An alarm retries them in
 * order; a call that keeps failing holds back the ones after it, so emails never arrive out
 * of order or with a part missing. There is one instance, named "outbox".
 */
export class Outbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // continued = 1: the next row holds more of this text (a document longer than one row).
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      first INTEGER NOT NULL,
      text TEXT NOT NULL,
      continued INTEGER NOT NULL
    )`);
    const columns = new Set(
      ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(sends)")
        .toArray()
        .map(c => c.name)
    );
    for (const [name, type] of Object.entries(LATER_COLUMNS)) {
      if (!columns.has(name)) ctx.storage.sql.exec(`ALTER TABLE sends ADD COLUMN ${name} ${type}`);
    }
  }

  async add(sends: Send[]) {
    this.ctx.storage.transactionSync(() => {
      for (const send of sends) {
        const parts = chunks(send.text);
        parts.forEach((text, i) =>
          this.ctx.storage.sql.exec(
            "INSERT INTO sends (kind, first, text, continued, silent, email, button) VALUES (?, ?, ?, ?, ?, ?, ?)",
            send.kind,
            send.kind === "message" && send.first ? 1 : 0,
            text,
            i < parts.length - 1 ? 1 : 0,
            send.silent ? 1 : 0,
            send.email ?? null,
            send.button ? 1 : 0
          )
        );
      }
    });
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + FIRST_RETRY_MS);
  }

  // Retries right away instead of at the next alarm, if anything is waiting.
  async retrySoon() {
    if (this.ctx.storage.sql.exec("SELECT 1 FROM sends LIMIT 1").toArray().length === 0) return;
    await this.ctx.storage.setAlarm(Date.now());
  }

  // The oldest waiting call, with the ids of the rows it takes up.
  private next(): { ids: number[]; send: Send } | undefined {
    const rows: Row[] = [];
    for (const row of this.ctx.storage.sql.exec<Row>("SELECT * FROM sends ORDER BY id")) {
      rows.push(row);
      if (!row.continued) break;
    }
    if (rows.length === 0) return undefined;
    const text = rows.map(row => row.text).join("");
    const [row] = rows;
    const options = {
      ...(row.silent ? { silent: true } : {}),
      ...(row.email !== null ? { email: row.email, button: row.button === 1 } : {})
    };
    const send: Send =
      row.kind === "document"
        ? { kind: "document", text, ...options }
        : { kind: "message", text, first: row.first === 1, ...options };
    return { ids: rows.map(row => row.id), send };
  }

  async alarm() {
    try {
      for (let entry = this.next(); entry; entry = this.next()) {
        const messageId = await deliver(this.env, entry.send);
        this.ctx.storage.sql.exec("DELETE FROM sends WHERE id BETWEEN ? AND ?", entry.ids[0], entry.ids.at(-1)!);
        this.ctx.storage.kv.delete("failures");
        await remember(this.env, entry.send, messageId);
        await sleep(100);
      }
    } catch (err) {
      const failures = (this.ctx.storage.kv.get<number>("failures") ?? 0) + 1;
      this.ctx.storage.kv.put("failures", failures);
      const wait = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
      console.error(`Outbox: Telegram failed ${failures} time(s) in a row, next try in ${wait / 1000} s:`, err);
      await this.ctx.storage.setAlarm(Date.now() + wait);
    }
  }
}

const outbox = (env: Env) => env.OUTBOX.get(env.OUTBOX.idFromName("outbox"));

// Stores what is left of an email, behind a note that says when it arrived.
export async function enqueue(env: Env, receivedAt: Date, sends: Send[], partial: boolean) {
  const note = partial
    ? `⏳ The rest of an email that arrived ${formatTime(receivedAt)}; Telegram failed halfway through it.`
    : `⏳ Delayed: the next email arrived ${formatTime(receivedAt)}, when Telegram could not take it.`;
  // The note belongs to the email: it is as silent, and a spam button deletes it too.
  const { silent, email } = sends[0] ?? {};
  await outbox(env).add([
    { kind: "message", text: note, ...(silent ? { silent } : {}), ...(email !== undefined ? { email } : {}) },
    ...sends
  ]);
}

export async function retrySoon(env: Env) {
  await outbox(env).retrySoon();
}
