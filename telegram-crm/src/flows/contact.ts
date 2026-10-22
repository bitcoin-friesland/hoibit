/**
 * /newcontact: the name (checked against existing contacts), consumer or entrepreneur, the
 * organization of an entrepreneur (existing or new), then the overview card with the optional
 * details and Save (see flows/organization.ts and helpers/card.ts).
 */
import {
  INVALID_ORGANIZATION_NAME,
  isValidName,
  isValidOrganizationName,
  NAME_RULE,
  toInternationalPhone
} from "../helpers/validation";
import { setStep } from "../helpers/session";
import { errorMessage, promptWithOptions } from "../helpers/messaging";
import { ORG_MAX_RESULTS, handleOrganizationStep, showRecordCard, startOrganizationSteps } from "./organization";
import type { OrganizationSearchRow } from "../../../crm-api/src/types";
import type { ChatId, FlowHandler, InlineKeyboardButton, SendMessage, Session } from "../types";

// Existing contacts shown when the new name resembles theirs.
const SIMILAR_MAX_RESULTS = 5;

const ORGANIZATION_PROMPT = "Which organization is this contact linked to? Type part of the name.";

async function askType(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  persistSession: () => Promise<void>
) {
  setStep(session, "awaiting_type");
  await persistSession();
  const prompt = promptWithOptions(`Is ${session.name} a consumer or an entrepreneur?`, [
    { label: "Consumer", value: "consumer" },
    { label: "Entrepreneur", value: "entrepreneur" }
  ]);
  await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
}

// The community of the team member, so organizations there are listed first.
export async function ownCommunityId(env: Env, session: Session) {
  try {
    return (await env.crmApi.teamMemberCommunities(session.telegram_id ?? ""))[0]?.id ?? null;
  } catch {
    return null;
  }
}

// A button per organization found (select_org:<id>); the place tells same names apart.
export const organizationButtons = (orgs: OrganizationSearchRow[]): InlineKeyboardButton[][] =>
  orgs.map(o => {
    const place = o.region || o.community_name;
    return [{ text: place ? `${o.name} · ${place}` : o.name, callback_data: `select_org:${o.id}` }];
  });

const NAME_PROMPT = "What is the contact name?";

export const handleContactFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  switch (session.step) {
    case "from_email": {
      // ➕ Contact under an email: the sender's address is in session.email, their name (from the
      // email's From) in pending_contact_name. A name that is no valid contact name is asked for.
      const name = session.pending_contact_name?.trim();
      delete session.pending_contact_name;
      setStep(session, "awaiting_name");
      await sendMessage(
        env,
        chatId,
        `➕ New contact from email: ${name ? `${name} <${session.email}>` : session.email}`
      );
      if (isValidName(name)) {
        await handleContactFlow(sendMessage, env, chatId, name, session, persistSession, removeSession);
        return;
      }
      await persistSession();
      await sendMessage(env, chatId, NAME_PROMPT);
      break;
    }
    case "awaiting_name": {
      const name = text && text.trim();
      if (!isValidName(name)) {
        await sendMessage(env, chatId, errorMessage(NAME_RULE));
        return;
      }
      session.name = name;
      // A shared Telegram contact also brings a phone number, which Telegram sends without "+".
      if (session.shared_phone) {
        session.phone = toInternationalPhone(session.shared_phone.replace(/^(?=[1-9])/, "+"), "31") ?? null;
        session.shared_phone = undefined;
      }
      let similar: { id: number; name: string; organization_name: string | null }[] = [];
      try {
        similar = (await env.crmApi.searchContacts(name)).slice(0, SIMILAR_MAX_RESULTS);
      } catch {
        // Not knowing about lookalikes is no reason to stop adding the contact.
      }
      if (similar.length === 0) {
        await askType(sendMessage, env, chatId, session, persistSession);
        return;
      }
      setStep(session, "awaiting_duplicate");
      await persistSession();
      // log:<id> buttons work without this flow: they start logging a conversation instead.
      const keyboard = similar.map(c => [
        {
          text: `💬 ${c.organization_name ? `${c.name} (${c.organization_name})` : c.name}`,
          callback_data: `log:${c.id}`
        }
      ]);
      keyboard.push([{ text: `➕ Add "${name}" as a new contact`, callback_data: "new_contact" }]);
      await sendMessage(
        env,
        chatId,
        "⚠️ There are contacts with a similar name. Is it one of them? Tap them to log a conversation, or add a new contact.",
        { reply_markup: { inline_keyboard: keyboard } }
      );
      break;
    }
    case "awaiting_duplicate": {
      if (session.last_callback_data !== "new_contact") {
        await sendMessage(env, chatId, errorMessage("Please tap one of the contacts, or add a new contact."));
        return;
      }
      await askType(sendMessage, env, chatId, session, persistSession);
      break;
    }
    case "awaiting_type": {
      const type = text || session.last_callback_data;
      if (type !== "consumer" && type !== "entrepreneur") {
        await sendMessage(env, chatId, errorMessage("Please choose Consumer or Entrepreneur."));
        return;
      }
      session.type = type;
      if (type === "consumer") {
        await showRecordCard(sendMessage, env, chatId, session, persistSession);
        return;
      }
      setStep(session, "awaiting_organization");
      await persistSession();
      await sendMessage(env, chatId, ORGANIZATION_PROMPT);
      break;
    }
    case "awaiting_organization": {
      const cb = session.last_callback_data;
      session.last_callback_data = null;
      if (cb === "search_org_again") {
        await persistSession();
        await sendMessage(env, chatId, ORGANIZATION_PROMPT);
        return;
      }
      if (cb && cb.startsWith("select_org:")) {
        const orgId = cb.slice("select_org:".length);
        const orgName = session.org_choices && session.org_choices[orgId];
        if (!orgName) {
          await sendMessage(
            env,
            chatId,
            errorMessage("Please choose an organization from the buttons, or type a name to search.")
          );
          return;
        }
        session.organization_id = Number(orgId);
        session.organization_label = orgName;
        await showRecordCard(sendMessage, env, chatId, session, persistSession);
        return;
      }
      if (cb === "create_org") {
        if (!session.pending_org) {
          await sendMessage(env, chatId, errorMessage("Please type the name of the organization."));
          return;
        }
        await startOrganizationSteps(sendMessage, env, chatId, session, persistSession, session.pending_org);
        return;
      }
      const org = text && text.trim();
      if (!isValidOrganizationName(org)) {
        await sendMessage(env, chatId, errorMessage(INVALID_ORGANIZATION_NAME));
        return;
      }
      let found;
      try {
        found = await env.crmApi.searchOrganizations({ name: org, community_id: await ownCommunityId(env, session) });
      } catch (e) {
        console.error("Searching organizations failed", e);
        await sendMessage(env, chatId, errorMessage("Searching organizations failed. Please type the name again."));
        return;
      }
      const orgs = found.slice(0, ORG_MAX_RESULTS);
      // Names stay in the session; buttons carry only ids (callback_data is limited to 64 bytes).
      session.pending_org = org;
      session.org_choices = Object.fromEntries(orgs.map(o => [String(o.id), o.name]));
      await persistSession();
      if (orgs.length > 0) {
        const keyboard = organizationButtons(orgs);
        keyboard.push([{ text: `Create new "${org}"`, callback_data: "create_org" }]);
        const more =
          found.length > orgs.length
            ? ` Showing ${orgs.length} of ${found.length}; type more of the name to narrow it down.`
            : "";
        await sendMessage(env, chatId, `Select an existing organization or create new:${more}`, {
          reply_markup: { inline_keyboard: keyboard },
          accepts_text: more !== ""
        });
      } else {
        await sendMessage(env, chatId, `No organization found with the name "${org}".`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: `Confirm and create "${org}"`, callback_data: "create_org" }],
              [{ text: "Search again", callback_data: "search_org_again" }]
            ]
          }
        });
      }
      break;
    }
    default:
      // The shared steps: status and communities of a new organization, the card, OpenStreetMap.
      if (await handleOrganizationStep(sendMessage, env, chatId, text, session, persistSession, removeSession)) {
        break;
      }
      await sendMessage(env, chatId, errorMessage("Unknown step in contact flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
};
