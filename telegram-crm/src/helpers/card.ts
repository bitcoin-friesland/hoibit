/**
 * The overview card of a new contact or organization: what was entered so far, with a button per
 * optional detail and one to save. Optional details are only asked for when the user taps them,
 * so the quickest contact is a name, a type and Save. Editing an existing contact or organization
 * (session.edit_target, see flows/edit.ts) uses the same card, with the name as a detail too.
 *
 * Steps: awaiting_card (a button of the card) and awaiting_card_field (the value of the tapped
 * detail, or Back / Remove). Saving is up to the flow: handleCardStep calls onSave. A flow can add
 * actions: details that take more than one typed value (a choice, a search), which it asks for
 * itself when their button (card:<key>) is tapped.
 */
import { followUpLabel, parseFutureDay } from "./day";
import { errorMessage } from "./messaging";
import { setStep } from "./session";
import {
  INVALID_ORGANIZATION_NAME,
  isNationalPhone,
  isValidEmail,
  isValidName,
  isValidNpub,
  isValidOrganizationName,
  isValidWebsite,
  NAME_RULE,
  toInternationalPhone
} from "./validation";
import type { ChatId, InlineKeyboardButton, SendMessage, Session } from "../types";

type FieldKey =
  | "name"
  | "organization"
  | "email"
  | "phone"
  | "nostr_npub"
  | "organization_website"
  | "organization_nostr_npub"
  | "organization_category"
  | "organization_address"
  | "organization_phone"
  | "organization_email"
  | "organization_follow_up_on";

interface Field {
  button: string;
  // Shown on the card in front of the value.
  label: string;
  prompt: string;
  // The value to store, or the error to show.
  parse: (env: Env, session: Session, text: string) => Promise<{ value: string } | { error: string }>;
  // A name: it can be changed, not removed.
  required?: true;
  // How the card shows the stored value, when not as it is.
  show?: (value: string) => string;
}

// National numbers get +32 when all of the member's communities are Belgian, +31 otherwise.
async function countryCode(env: Env, session: Session) {
  try {
    const own = await env.crmApi.teamMemberCommunities(session.telegram_id ?? "");
    if (own.length > 0 && own.every(c => c.country === "Belgium")) return "32";
  } catch {
    // The usual case is good enough when the communities cannot be read.
  }
  return "31";
}

const npub = async (_env: Env, _session: Session, text: string) =>
  isValidNpub(text) ? { value: text } : { error: "Please enter a valid nostr npub (npub1…)." };

async function phone(env: Env, session: Session, text: string) {
  const value = toInternationalPhone(text, isNationalPhone(text) ? await countryCode(env, session) : "31");
  return value ? { value } : { error: "Please enter a valid phone number, for example 06 12345678." };
}

const email = async (_env: Env, _session: Session, text: string) =>
  isValidEmail(text) ? { value: text } : { error: "Please enter a valid email address." };

// Free text of a reasonable length, such as an address.
const text = (what: string, max: number) => async (_env: Env, _session: Session, input: string) =>
  input.length >= 2 && input.length <= max ? { value: input } : { error: `Please type the ${what}.` };

const FIELDS: Record<FieldKey, Field> = {
  name: {
    button: "👤 Name",
    label: "👤 Name",
    prompt: "What is the name?",
    parse: async (_env, _session, text) => (isValidName(text) ? { value: text } : { error: NAME_RULE }),
    required: true
  },
  organization: {
    button: "🏢 Name",
    label: "🏢 Name",
    prompt: "What is the name of the organization?",
    parse: async (_env, _session, text) =>
      isValidOrganizationName(text) ? { value: text } : { error: INVALID_ORGANIZATION_NAME },
    required: true
  },
  email: { button: "📧 Email", label: "📧 Email", prompt: "What is the email address?", parse: email },
  phone: {
    button: "📞 Phone",
    label: "📞 Phone",
    prompt: "What is the phone number? For example 06 12345678 or +32 470 12 34 56.",
    parse: phone
  },
  nostr_npub: { button: "🟣 Nostr", label: "🟣 Nostr", prompt: "What is the nostr npub? (npub1…)", parse: npub },
  organization_website: {
    button: "🌐 Website",
    label: "🌐 Website",
    prompt: "What is the website of the organization? For example example.com.",
    parse: async (_env, _session, text) =>
      isValidWebsite(text) ? { value: text } : { error: "Please enter a valid website, for example example.com." }
  },
  organization_nostr_npub: {
    button: "🟣 Organization nostr",
    label: "🟣 Organization nostr",
    prompt: "What is the nostr npub of the organization? (npub1…)",
    parse: npub
  },
  organization_category: {
    button: "🏪 Kind",
    label: "🏪 Kind of business",
    prompt: "What kind of business is it? For example Restaurant, Hairdresser or Bike shop.",
    parse: text("kind of business", 100)
  },
  organization_address: {
    button: "🏠 Address",
    label: "🏠 Address",
    prompt: "What is the address? Street and number with the place, for example Kleinzand 1, Sneek.",
    parse: text("address", 200)
  },
  organization_phone: {
    button: "📞 Phone",
    label: "📞 Phone",
    prompt: "What is the organization's own phone number? For example 0515 123456.",
    parse: phone
  },
  organization_email: {
    button: "📧 Email",
    label: "📧 Email",
    prompt: "What is the organization's own email address? For example info@example.com.",
    parse: email
  },
  organization_follow_up_on: {
    button: "⏰ Follow-up",
    label: "⏰ Follow up",
    prompt: "On which day should it be followed up? For example 12-01 or 12-01-2027.",
    parse: async (_env, _session, text) => {
      const day = parseFutureDay(text);
      return day ? { value: day } : { error: "Please type today or a day to come, for example 12-01-2027." };
    },
    show: followUpLabel
  }
};

// The details the card offers: of the contact, and of the organization when it is new; when
// editing, the name and the details of what is edited.
function fieldsOf(session: Session): FieldKey[] {
  if (session.edit_target === "contact") return ["name", "email", "phone", "nostr_npub"];
  if (session.edit_target === "organization")
    return [
      "organization",
      "organization_category",
      "organization_address",
      "organization_phone",
      "organization_email",
      "organization_website",
      "organization_nostr_npub",
      "organization_follow_up_on"
    ];
  if (session.mode === "org") return ["organization_website", "organization_nostr_npub"];
  const contact: FieldKey[] = ["email", "phone", "nostr_npub"];
  return session.organization ? [...contact, "organization_website", "organization_nostr_npub"] : contact;
}

// On a card of just an organization there is no contact, so the organization's npub is just "Nostr".
const organizationOnly = (session: Session) => session.mode === "org" || session.edit_target === "organization";
const plainNostr = (session: Session, key: FieldKey) => organizationOnly(session) && key === "organization_nostr_npub";
const labelOf = (session: Session, key: FieldKey) =>
  plainNostr(session, key) ? FIELDS.nostr_npub.label : FIELDS[key].label;

// session[key] for a detail; the name fields are typed without null, which only Remove sets.
const setField = (session: Session, key: FieldKey, value: string | null) =>
  void ((session as Record<FieldKey, string | null | undefined>)[key] = value);

const isField = (key: string | undefined): key is FieldKey => !!key && key in FIELDS;

// Lines that describe the card's subject apart from the optional details; set by the flow.
export type CardHeader = (session: Session) => string[];

// A detail the flow asks for itself: its button is card:<key>, line shows it on the card.
export interface CardAction {
  key: string;
  button: string;
  line: string;
}

export type CardActions = (session: Session) => CardAction[];

function cardText(session: Session, header: CardHeader, actions: CardAction[]) {
  const details = fieldsOf(session).map(key => {
    const value = session[key];
    return `${labelOf(session, key)}: ${value ? (FIELDS[key].show?.(value) ?? value) : "—"}`;
  });
  const hint = session.edit_target ? "Tap a detail to change it, then Save." : "Tap a detail to add it, or Save.";
  return [...header(session), "", ...details, ...actions.map(a => a.line), "", hint].join("\n");
}

function cardKeyboard(session: Session, actions: CardAction[]): InlineKeyboardButton[][] {
  const fields = [
    ...fieldsOf(session).map(key => ({
      text: plainNostr(session, key) ? FIELDS.nostr_npub.button : FIELDS[key].button,
      callback_data: `card:${key}`
    })),
    ...actions.map(a => ({ text: a.button, callback_data: `card:${a.key}` }))
  ];
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < fields.length; i += 3) rows.push(fields.slice(i, i + 3));
  rows.push([{ text: "✅ Save", callback_data: "card:save" }]);
  return rows;
}

// Shows the card and waits for one of its buttons.
export async function showCard(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  persistSession: () => Promise<void>,
  header: CardHeader,
  actions: CardActions = () => []
) {
  session.card_field = undefined;
  setStep(session, "awaiting_card");
  await persistSession();
  const shown = actions(session);
  await sendMessage(env, chatId, cardText(session, header, shown), {
    reply_markup: { inline_keyboard: cardKeyboard(session, shown) },
    // A location is shown as a link to the map.
    link_preview_options: { is_disabled: true }
  });
}

/**
 * Handles the update when session.step is a card step; returns false (and does nothing) for any
 * other step, and for the button of one of actions, which the flow handles. onSave runs when Save
 * is tapped; on a failure it reports an error and leaves the card in place, so Save can be tapped
 * again.
 */
export async function handleCardStep(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  text: string | undefined,
  session: Session,
  persistSession: () => Promise<void>,
  header: CardHeader,
  onSave: () => Promise<void>,
  actions: CardActions = () => []
): Promise<boolean> {
  const cb = session.last_callback_data;
  if (session.step === "awaiting_card") {
    const key = cb?.startsWith("card:") ? cb.slice("card:".length) : undefined;
    if (actions(session).some(a => a.key === key)) return false;
    if (key === "save") {
      await onSave();
    } else if (isField(key) && fieldsOf(session).includes(key)) {
      session.card_field = key;
      setStep(session, "awaiting_card_field");
      await persistSession();
      const buttons = [{ text: "⬅️ Back", callback_data: "card:back" }];
      if (session[key] && !FIELDS[key].required) buttons.push({ text: "🗑️ Remove", callback_data: "card:remove" });
      await sendMessage(env, chatId, FIELDS[key].prompt, {
        reply_markup: { inline_keyboard: [buttons] },
        accepts_text: true
      });
    } else {
      await sendMessage(env, chatId, errorMessage("Please tap a detail to add it, or Save."));
    }
    return true;
  }
  if (session.step === "awaiting_card_field") {
    const key = session.card_field;
    if (!isField(key)) {
      await showCard(sendMessage, env, chatId, session, persistSession, header, actions);
      return true;
    }
    if (text === undefined) {
      if (cb === "card:remove" && !FIELDS[key].required) setField(session, key, null);
      else if (cb !== "card:back") {
        await sendMessage(env, chatId, errorMessage(`${FIELDS[key].prompt} Or tap Back.`));
        return true;
      }
    } else {
      const parsed = await FIELDS[key].parse(env, session, text.trim());
      if ("error" in parsed) {
        await sendMessage(env, chatId, errorMessage(parsed.error));
        return true;
      }
      setField(session, key, parsed.value);
    }
    await showCard(sendMessage, env, chatId, session, persistSession, header, actions);
    return true;
  }
  return false;
}
