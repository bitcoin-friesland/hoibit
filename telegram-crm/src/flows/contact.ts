import { isValidName, isValidEmail, isValidPhone, isValidNpub, isValidOrganizationName } from "../helpers/validation";
import { setStep } from "../helpers/session";
import { errorMessage, successMessage, promptWithSkip, promptWithOptions } from "../helpers/messaging";
import {
  ORG_MAX_RESULTS,
  INVALID_ORGANIZATION_NAME,
  contactInput,
  errorText,
  handleOrganizationStep,
  startOrganizationSteps
} from "./organization";
import type { ChatId, FlowHandler, SendMessage, Session } from "../types";

// Saves the contact, with no organization or an existing one.
async function addContact(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  removeSession: () => Promise<void>,
  organizationId: number | null,
  doneText: string
) {
  try {
    const res = await env.crmApi.newContact({ ...contactInput(session), organization_id: organizationId });
    if (!res.ok) {
      await sendMessage(env, chatId, errorMessage(`Failed to add contact (code ${res.status}).`));
      await removeSession();
      return;
    }
  } catch (e) {
    await sendMessage(env, chatId, errorMessage(`Error adding contact: ${errorText(e)}`));
    await removeSession();
    return;
  }
  await sendMessage(env, chatId, successMessage(doneText));
  await removeSession();
}

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
    case "awaiting_name": {
      const name = text && text.trim();
      if (!isValidName(name)) {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please enter a valid contact name (minimum 3 letters, only alphabetic).")
        );
        return;
      }
      session.name = name;
      setStep(session, "awaiting_email");
      await persistSession();
      const prompt = promptWithSkip("What is the email address of the contact? (optional)");
      await sendMessage(env, chatId, prompt.text, {
        reply_markup: prompt.reply_markup,
        accepts_text: prompt.accepts_text
      });
      break;
    }
    case "awaiting_email": {
      let email = text && text.trim();
      if (text === undefined || session.last_callback_data === "skip") {
        email = undefined;
      } else if (email && !isValidEmail(email)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid email address or tap Skip."));
        return;
      }
      session.email = email && email.toLowerCase() !== "skip" ? email : null;
      setStep(session, "awaiting_phone");
      await persistSession();
      const prompt = promptWithSkip("What is the phone number of the contact? (must start with + or 00, optional)");
      await sendMessage(env, chatId, prompt.text, {
        reply_markup: prompt.reply_markup,
        accepts_text: prompt.accepts_text
      });
      break;
    }
    case "awaiting_phone": {
      let phone = text && text.trim();
      if (text === undefined || session.last_callback_data === "skip") {
        phone = undefined;
      } else if (phone && !isValidPhone(phone)) {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please enter a valid phone number starting with + or 00, or tap Skip.")
        );
        return;
      }
      session.phone = phone && phone.toLowerCase() !== "skip" ? phone : null;
      setStep(session, "awaiting_nostr");
      await persistSession();
      const prompt = promptWithSkip("What is the nostr npub of the contact? (optional)");
      await sendMessage(env, chatId, prompt.text, {
        reply_markup: prompt.reply_markup,
        accepts_text: prompt.accepts_text
      });
      break;
    }
    case "awaiting_nostr": {
      let nostr = text && text.trim();
      if (text === undefined || session.last_callback_data === "skip" || nostr?.toLowerCase() === "skip") {
        nostr = undefined;
      } else if (nostr && !isValidNpub(nostr)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid nostr npub (npub1…) or tap Skip."));
        return;
      }
      session.nostr_npub = nostr || null;
      setStep(session, "awaiting_type");
      await persistSession();
      const types = [
        { label: "Consumer", value: "consumer" },
        { label: "Entrepreneur", value: "entrepreneur" }
      ];
      const prompt = promptWithOptions("What type of contact is this?", types);
      await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
      break;
    }
    case "awaiting_type": {
      const type = text || session.last_callback_data;
      if (type !== "consumer" && type !== "entrepreneur") {
        await sendMessage(env, chatId, errorMessage("Please select a valid type."));
        return;
      }
      session.type = type;
      if (session.type === "entrepreneur") {
        setStep(session, "awaiting_organization");
        await persistSession();
        await sendMessage(
          env,
          chatId,
          "Which organization is this contact linked to? (required, type part of the name to search or create a new one)"
        );
        return;
      }
      await addContact(sendMessage, env, chatId, session, removeSession, null, `Contact "${session.name}" added.`);
      break;
    }
    case "awaiting_organization": {
      const cb = session.last_callback_data;
      session.last_callback_data = null;
      if (cb === "search_org_again") {
        await persistSession();
        await sendMessage(env, chatId, "Which organization is this contact linked to?\nType part of the name.");
        return;
      }
      if (cb && cb.startsWith("select_org:")) {
        // Existing organization: link the contact to it, nothing to create
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
        await addContact(
          sendMessage,
          env,
          chatId,
          session,
          removeSession,
          Number(orgId),
          `Contact "${session.name}" added to "${orgName}".`
        );
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
      try {
        const found = await env.crmApi.searchOrganizations({ name: org });
        const orgs = found.slice(0, ORG_MAX_RESULTS);
        // Names stay in the session; buttons carry only ids (callback_data is limited to 64 bytes).
        session.pending_org = org;
        session.org_choices = Object.fromEntries(orgs.map(o => [String(o.id), o.name]));
        await persistSession();
        if (orgs.length > 0) {
          const keyboard = orgs.map(o => [{ text: o.name, callback_data: `select_org:${o.id}` }]);
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
      } catch (e) {
        await sendMessage(env, chatId, errorMessage(`Error searching organizations: ${errorText(e)}`));
      }
      break;
    }
    default:
      // The steps of a new organization (status, website, npub, communities, OpenStreetMap).
      if (await handleOrganizationStep(sendMessage, env, chatId, text, session, persistSession, removeSession)) {
        break;
      }
      await sendMessage(env, chatId, errorMessage("Unknown step in contact flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
};
