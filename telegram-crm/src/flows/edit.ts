/**
 * Editing a saved contact or organization: the ✏️ Edit button of its card (edit:c:<id> or
 * edit:o:<id>, see helpers/record.ts) starts this flow at edit_start. It shows the overview card
 * of helpers/card.ts with the name and the optional details; Save stores only what changed
 * (updateContact / updateOrg) and shows the card again.
 */
import { handleCardStep, showCard, type CardHeader } from "../helpers/card";
import { errorMessage, successMessage } from "../helpers/messaging";
import { recordCard } from "../helpers/record";
import type { ChatId, FlowHandler, SendMessage, Session } from "../types";

const SAVE_FAILED = "Saving failed, nothing was saved. Please try again.";

// Per session key of the card: the field of updateContact / updateOrg it is saved as.
const CONTACT_FIELDS = { name: "name", email: "email", phone: "phone", nostr_npub: "nostr_npub" } as const;
const ORGANIZATION_FIELDS = {
  organization: "name",
  organization_website: "website",
  organization_nostr_npub: "nostr_npub"
} as const;

type CardKey = keyof typeof CONTACT_FIELDS | keyof typeof ORGANIZATION_FIELDS;

const fieldsOf = (session: Session): Record<string, string> =>
  session.edit_target === "organization" ? ORGANIZATION_FIELDS : CONTACT_FIELDS;

const header: CardHeader = session => [
  session.edit_target === "organization" ? "✏️ Edit organization" : "✏️ Edit contact"
];

const recordOf = (session: Session) =>
  session.edit_target === "organization"
    ? { kind: "organization" as const, id: session.organization_id ?? 0 }
    : { kind: "contact" as const, id: session.contact_id ?? 0 };

// Puts the saved details in the session, for the card; false when the record no longer exists.
async function load(env: Env, session: Session) {
  if (session.edit_target === "organization") {
    const org = await env.crmApi.organizationDetails(session.organization_id ?? 0);
    if (!org) return false;
    session.organization = org.name;
    session.organization_website = org.website;
    session.organization_nostr_npub = org.nostr_npub;
  } else {
    const contact = await env.crmApi.contactDetails(session.contact_id ?? 0);
    if (!contact) return false;
    session.name = contact.name;
    // The card edits the first email address and phone number; any others stay as they are.
    session.email = contact.emails[0] ?? null;
    session.phone = contact.phones[0] ?? null;
    session.nostr_npub = contact.nostr_npub;
  }
  session.edit_original = Object.fromEntries(
    Object.keys(fieldsOf(session)).map(key => [key, session[key as CardKey] ?? null])
  );
  return true;
}

async function save(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  removeSession: () => Promise<void>
) {
  const changes: Record<string, string | null> = {};
  for (const [key, field] of Object.entries(fieldsOf(session))) {
    const value = session[key as CardKey] ?? null;
    if (value !== (session.edit_original?.[key] ?? null)) changes[field] = value;
  }
  const ref = recordOf(session);
  if (Object.keys(changes).length > 0) {
    try {
      const res =
        ref.kind === "organization"
          ? await env.crmApi.updateOrg({ organization_id: ref.id, ...changes, updated_by: session.created_by || null })
          : await env.crmApi.updateContact({ contact_id: ref.id, ...changes, updated_by: session.created_by || null });
      if (!res.ok) throw new Error(res.error);
    } catch (e) {
      console.error("Saving an edit failed", e);
      await sendMessage(env, chatId, errorMessage(SAVE_FAILED));
      return;
    }
  }
  const name = ref.kind === "organization" ? session.organization : session.name;
  await removeSession();
  await sendMessage(
    env,
    chatId,
    Object.keys(changes).length > 0 ? successMessage(`"${name}" updated.`) : "Nothing changed."
  );
  try {
    const card = await recordCard(env, ref);
    if (card) await sendMessage(env, chatId, card.text, card.options);
  } catch (e) {
    // The change is saved; only showing it again failed.
    console.error("Loading a card failed", e);
  }
}

export const handleEditFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  if (session.step === "edit_start") {
    let found;
    try {
      found = await load(env, session);
    } catch (e) {
      console.error("Loading a record to edit failed", e);
      await sendMessage(env, chatId, errorMessage("Something went wrong. Please try again."));
      await removeSession();
      return;
    }
    if (!found) {
      await sendMessage(env, chatId, errorMessage("This no longer exists."));
      await removeSession();
      return;
    }
    await showCard(sendMessage, env, chatId, session, persistSession, header);
    return;
  }
  const handled = await handleCardStep(sendMessage, env, chatId, text, session, persistSession, header, () =>
    save(sendMessage, env, chatId, session, removeSession)
  );
  if (handled) return;
  await sendMessage(env, chatId, errorMessage("Unknown step in edit flow. Type /cancel to start over."));
  await removeSession();
};
