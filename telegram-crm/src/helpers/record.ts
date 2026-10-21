/**
 * The card of a saved contact or organization: its details, status and most recent conversations.
 * Its buttons belong to no session and work on old cards too, like log:<id>: show:c:<id> and
 * show:o:<id> open a card, edit:c:<id> and edit:o:<id> start editing one (flows/edit.ts).
 */
import type { ConversationSummary } from "../../../crm-api/src/types";
import type { InlineKeyboardButton, SendOptions } from "../types";

export interface RecordRef {
  kind: "contact" | "organization";
  id: number;
}

// The other contacts and organizations a card links to, at most.
const LINKED_MAX = 5;
// Longer notes are cut, so five conversations keep the card short.
const NOTE_MAX_LENGTH = 120;

export const recordData = (action: "show" | "edit", ref: RecordRef) =>
  `${action}:${ref.kind === "contact" ? "c" : "o"}:${ref.id}`;

// The record a show:… or edit:… button is about; undefined for other data.
export function parseRecordData(data: string, action: "show" | "edit"): RecordRef | undefined {
  const match = /^(\w+):([co]):(\d+)$/.exec(data);
  if (!match || match[1] !== action) return undefined;
  return { kind: match[2] === "c" ? "contact" : "organization", id: Number(match[3]) };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// "• 2026-10-21 · Anna · Phone (Jan): Interested in a terminal"; withContact on an organization's card.
function conversationLine(c: ConversationSummary, withContact: boolean) {
  const when = c.logged_at?.slice(0, 10);
  const about = [when, withContact ? c.contact_name : undefined, c.channel].filter(Boolean).join(" · ");
  const by = c.logged_by ? ` (${c.logged_by})` : "";
  return `• ${about}${by}${c.note ? `: ${clip(c.note, NOTE_MAX_LENGTH)}` : ""}`;
}

function conversationLines(conversations: ConversationSummary[], withContact: boolean) {
  if (conversations.length === 0) return ["No conversations logged yet."];
  return ["Recent conversations:", ...conversations.map(c => conversationLine(c, withContact))];
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
  const lines = [`🏢 ${org.name}`, `🏷️ ${org.status_label ?? "No status"}`];
  if (org.communities.length > 0) lines.push(`👥 ${org.communities.join(", ")}`);
  if (org.website) lines.push(`🌐 ${org.website}`);
  if (org.nostr_npub) lines.push(`🟣 ${org.nostr_npub}`);
  if (org.location_osm_id) lines.push(`📍 https://www.openstreetmap.org/${org.location_osm_id}`);
  lines.push(
    org.contacts.length > 0 ? `👤 ${org.contacts.map(c => c.name).join(", ")}` : "👤 No contacts yet",
    "",
    ...conversationLines(org.conversations, true)
  );
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
