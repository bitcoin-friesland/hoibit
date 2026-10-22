/**
 * 📜 Conversations on a card: all conversations of a contact or organization in full, the most
 * recent first, and above them the organization's notes in full. Each message stays under
 * Telegram's length limit; ⬅️ Older below it sends the next one. Like the card's buttons these
 * belong to no session: hist:c:<id>:<position> and hist:o:<id>:<position> show the page that
 * starts at position, counting the notes first and then the conversations.
 */
import { MAX_MESSAGE_LENGTH } from "./telegram";
import { clip, conversationLine, type RecordRef } from "./record";
import type { InlineKeyboardButton, SendOptions } from "../types";

// Conversations fetched per page; more than fit in one message, so a page is full.
const FETCH = 50;

export const historyData = (ref: RecordRef, position = 0) =>
  `hist:${ref.kind === "contact" ? "c" : "o"}:${ref.id}:${position}`;

// What a hist:… button is about; undefined for other data.
export function parseHistoryData(data: string): { ref: RecordRef; position: number } | undefined {
  const match = /^hist:([co]):(\d+):(\d+)$/.exec(data);
  if (!match) return undefined;
  return {
    ref: { kind: match[1] === "c" ? "contact" : "organization", id: Number(match[2]) },
    position: Number(match[3])
  };
}

export const historyButton = (ref: RecordRef): InlineKeyboardButton => ({
  text: "📜 Conversations",
  callback_data: historyData(ref)
});

// A message being filled with entries under headings, up to Telegram's limit.
class Page {
  private lines: string[];
  // Entries added, under any heading.
  count = 0;

  constructor(title: string) {
    this.lines = [title];
  }

  private get length() {
    return this.lines.join("\n").length;
  }

  /**
   * Adds entries under heading while they fit; returns how many. The first entry of an empty
   * page is cut to fit rather than left out, so every page moves on.
   */
  add(heading: string, entries: string[]) {
    let added = 0;
    for (const entry of entries) {
      const lines = added === 0 ? ["", heading, entry] : [entry];
      const room = MAX_MESSAGE_LENGTH - this.length - 1 - lines.join("\n").length;
      if (room < 0) {
        if (this.count > 0) break;
        lines[lines.length - 1] = clip(entry, entry.length + room);
        this.lines.push(...lines);
        this.count++;
        return added + 1;
      }
      this.lines.push(...lines);
      this.count++;
      added++;
    }
    return added;
  }

  get text() {
    return this.lines.join("\n");
  }
}

/**
 * The page of the history of the contact or organization ref names that starts at position, as
 * text and buttons; undefined when it no longer exists. Throws when crm-api cannot be reached.
 */
export async function historyPage(
  env: Env,
  ref: RecordRef,
  position: number
): Promise<{ text: string; options: SendOptions } | undefined> {
  const record =
    ref.kind === "contact"
      ? await env.crmApi.contactDetails(ref.id, 0)
      : await env.crmApi.organizationDetails(ref.id, 0);
  if (!record) return undefined;
  const notes = "notes" in record ? record.notes : [];
  const page = new Page(`📜 ${ref.kind === "contact" ? "👤" : "🏢"} ${record.name}${position > 0 ? ", older" : ""}`);
  let next = position;
  let more = false;
  if (next < notes.length) {
    const remaining = notes.slice(next);
    const added = page.add(
      "📝 Notes:",
      remaining.map(n => `• ${n}`)
    );
    next += added;
    more = added < remaining.length;
  }
  if (!more) {
    const res = await env.crmApi.conversationHistory({
      ...(ref.kind === "contact" ? { contact_id: ref.id } : { organization_id: ref.id }),
      offset: next - notes.length,
      limit: FETCH
    });
    if (!res.ok) throw new Error(`Reading the conversations was refused: ${res.error}`);
    const lines = res.conversations.map(c => conversationLine(c, ref.kind === "organization"));
    const added = page.add("💬 Conversations:", lines);
    next += added;
    more = added < lines.length || res.more;
  }
  if (page.count === 0) {
    return {
      text: `${page.text}\n\n${position === 0 ? "No conversations logged yet." : "No older ones."}`,
      options: {}
    };
  }
  const older = { inline_keyboard: [[{ text: "⬅️ Older", callback_data: historyData(ref, next) }]] };
  return {
    text: page.text,
    options: { ...(more ? { reply_markup: older } : {}), link_preview_options: { is_disabled: true } }
  };
}
