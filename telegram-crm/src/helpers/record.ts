/**
 * The card of a saved contact or organization: its details, status and most recent conversations.
 * Its buttons belong to no session and work on old cards too, like log:<id>: show:c:<id> and
 * show:o:<id> open a card, edit:c:<id> and edit:o:<id> start editing one (flows/edit.ts),
 * status:<id> changes an organization's status (flows/status.ts), fu:<id> its follow-up day
 * (flows/followup.ts), log:o:<id> logs a conversation with the organization itself, and
 * hist:c:<id>:0 and hist:o:<id>:0 show all conversations in full (helpers/history.ts).
 */
import type { ConversationSummary } from "../../../crm-api/src/types";
import { followUpLabel } from "./day";
import { followUpButton } from "../flows/followup";
import { historyButton } from "./history";
import { statusButton } from "../flows/status";
import type { InlineKeyboardButton, SendOptions } from "../types";

export interface RecordRef {
  kind: "contact" | "organization";
  id: number;
}

// The other contacts and organizations a card links to, at most.
const LINKED_MAX = 5;
// Longer notes are cut, so five conversations keep the card short; 📜 Conversations shows them in full.
const NOTE_MAX_LENGTH = 120;
// The organization's notes shown on its card, at most.
const NOTES_MAX = 3;

export const recordData = (action: "show" | "edit", ref: RecordRef) =>
  `${action}:${ref.kind === "contact" ? "c" : "o"}:${ref.id}`;

// The record a show:… or edit:… button is about; undefined for other data.
export function parseRecordData(data: string, action: "show" | "edit"): RecordRef | undefined {
  const match = /^(\w+):([co]):(\d+)$/.exec(data);
  if (!match || match[1] !== action) return undefined;
  return { kind: match[2] === "c" ? "contact" : "organization", id: Number(match[3]) };
}

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// "• 2026-10-21 · Anna · Phone (Jan): Interested in a terminal"; withContact on an organization's card.
// The day it took place, or for conversations logged before that was asked, the day it was logged.
// The note is cut to max.
export function conversationLine(c: ConversationSummary, withContact: boolean, max = Infinity) {
  const when = c.happened_on ?? c.logged_at?.slice(0, 10);
  const about = [when, withContact ? c.contact_name : undefined, c.channel].filter(Boolean).join(" · ");
  const by = c.logged_by ? ` (${c.logged_by})` : "";
  return `• ${about}${by}${c.note ? `: ${clip(c.note, max)}` : ""}`;
}

function conversationLines(conversations: ConversationSummary[], withContact: boolean) {
  if (conversations.length === 0) return ["No conversations logged yet."];
  return ["Recent conversations:", ...conversations.map(c => conversationLine(c, withContact, NOTE_MAX_LENGTH))];
}

/**
 * The card of the contact or organization ref names, as text and buttons; undefined when it no
 * longer exists. Throws when crm-api cannot be reached.
 */
export async function recordCard(
  env: Env,
  ref: RecordRef
): Promise<{ text: string; options: SendOptions } | undefined> {
  const buttons: InlineKeyboardButton[][] = [[{ text: "✏️ Edit", callback_data: recordData("edit", ref) }]];
  if (ref.kind === "contact") {
    const contact = await env.crmApi.contactDetails(ref.id);
    if (!contact) return undefined;
    const lines = [`👤 ${contact.name}`];
    const kind = [
      contact.type_label && `🏷️ ${contact.type_label}`,
      contact.organization_name && `🏢 ${contact.organization_name}`
    ];
    if (kind.some(Boolean)) lines.push(kind.filter(Boolean).join(" · "));
    for (const email of contact.emails) lines.push(`📧 ${email}`);
    for (const phone of contact.phones) lines.push(`📞 ${phone}`);
    if (contact.nostr_npub) lines.push(`🟣 ${contact.nostr_npub}`);
    lines.push("", ...conversationLines(contact.conversations, false));
    buttons[0].push({ text: "💬 Log conversation", callback_data: `log:${contact.id}` });
    if (contact.conversations.length > 0) buttons.push([historyButton(ref)]);
    if (contact.organization_id && contact.organization_name) {
      buttons.push([
        {
          text: `🏢 ${contact.organization_name}`,
          callback_data: recordData("show", { kind: "organization", id: contact.organization_id })
        }
      ]);
    }
    return { text: lines.join("\n"), options: { reply_markup: { inline_keyboard: buttons } } };
  }
  const org = await env.crmApi.organizationDetails(ref.id);
  if (!org) return undefined;
  buttons[0].push(statusButton(org.id));
  buttons.push([{ text: "💬 Log conversation", callback_data: `log:o:${org.id}` }, followUpButton(org.id)]);
  if (org.conversations.length > 0 || org.notes.length > 0) buttons.push([historyButton(ref)]);
  const lines = [`🏢 ${org.name}`, `🏷️ ${org.status_label ?? "No status"}`];
  if (org.category) lines.push(`🏪 ${org.category}`);
  if (org.address) lines.push(`🏠 ${org.address}`);
  if (org.phone) lines.push(`📞 ${org.phone}`);
  if (org.email) lines.push(`📧 ${org.email}`);
  if (org.communities.length > 0) lines.push(`👥 ${org.communities.join(", ")}`);
  if (org.website) lines.push(`🌐 ${org.website}`);
  if (org.nostr_npub) lines.push(`🟣 ${org.nostr_npub}`);
  if (org.location_osm_id) lines.push(`📍 https://www.openstreetmap.org/${org.location_osm_id}`);
  lines.push(`🤝 ${org.handled_by.map(h => h.name ?? "?").join(", ") || "Nobody handles it yet"}`);
  if (org.follow_up_on) lines.push(`⏰ Follow up: ${followUpLabel(org.follow_up_on)}`);
  lines.push(org.contacts.length > 0 ? `👤 ${org.contacts.map(c => c.name).join(", ")}` : "👤 No contacts yet");
  if (org.notes.length > 0) {
    lines.push("", "📝 Notes:", ...org.notes.slice(-NOTES_MAX).map(n => `• ${clip(n, NOTE_MAX_LENGTH)}`));
    if (org.notes.length > NOTES_MAX) lines.push(`…and ${org.notes.length - NOTES_MAX} older.`);
  }
  lines.push("", ...conversationLines(org.conversations, true));
  for (const contact of org.contacts.slice(0, LINKED_MAX)) {
    buttons.push([
      { text: `👤 ${contact.name}`, callback_data: recordData("show", { kind: "contact", id: contact.id }) }
    ]);
  }
  return {
    text: lines.join("\n"),
    options: { reply_markup: { inline_keyboard: buttons }, link_preview_options: { is_disabled: true } }
  };
}
