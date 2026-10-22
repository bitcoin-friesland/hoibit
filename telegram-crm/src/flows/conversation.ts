import { isValidNote } from "../helpers/validation";
import { setStep } from "../helpers/session";
import { dayLabel, parseDay, teamDay } from "../helpers/day";
import { errorMessage, successMessage } from "../helpers/messaging";
import { handleContactFlow } from "./contact";
import { followUpButton } from "./followup";
import { statusButton } from "./status";
import type { ChatId, FlowHandler, SendMessage, SendOptions, Session } from "../types";

const CONTACT_MAX_RESULTS = 8;
// Contacts the member added or talked to lately, offered when /logconversation starts.
const RECENT_MAX_RESULTS = 5;
const CONTACT_PROMPT = "Which contact did you talk to? Type part of the name.";
const DAY_PROMPT = "Type the date, like 14-10 or 14-10-2026.";

// How a contact is named in this flow: with their organization, which tells equal names apart.
const contactLabel = (c: { name: string; organization_name: string | null }) =>
  c.organization_name ? `${c.name} (${c.organization_name})` : c.name;

// Who the conversation was with: a contact, or an organization itself (staff, nobody by name).
type Talker = { contactId: number } | { organizationId: number };

// The contact or organization is chosen: asks how the conversation went (awaiting_channel).
async function askChannel(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  persistSession: () => Promise<void>,
  talker: Talker,
  label: string
) {
  let channels;
  try {
    channels = await env.crmApi.channels();
  } catch (e) {
    console.error("Loading channels failed", e);
    await sendMessage(env, chatId, errorMessage("Something went wrong. Please choose the contact again."));
    return;
  }
  if ("contactId" in talker) {
    session.contact_id = talker.contactId;
    session.organization_id = undefined;
  } else {
    session.contact_id = undefined;
    session.organization_id = talker.organizationId;
  }
  session.contact_label = label;
  session.channel_choices = Object.fromEntries(channels.map(c => [c.id, c.label]));
  setStep(session, "awaiting_channel");
  await persistSession();
  await sendMessage(env, chatId, `How did you talk to ${label}?`, {
    reply_markup: { inline_keyboard: channels.map(c => [{ text: c.label, callback_data: `channel:${c.id}` }]) }
  });
}

// After a conversation with an organization or one of its entrepreneurs: buttons to update the
// organization's status and follow-up day, which such a conversation often changes. Nothing when
// it cannot be looked up.
async function organizationButtons(env: Env, session: Session): Promise<SendOptions | undefined> {
  let org: { id: number; name: string } | undefined;
  try {
    if (session.organization_id) {
      const details = await env.crmApi.organizationDetails(session.organization_id, 0);
      if (details) org = { id: details.id, name: details.name };
    } else {
      const contact = await env.crmApi.contactDetails(session.contact_id ?? 0, 0);
      if (contact?.type === "entrepreneur" && contact.organization_id && contact.organization_name) {
        org = { id: contact.organization_id, name: contact.organization_name };
      }
    }
  } catch (e) {
    console.error("Loading an organization for the status button failed", e);
  }
  if (!org) return undefined;
  return {
    reply_markup: {
      inline_keyboard: [
        [statusButton(org.id, `📊 Update status of ${org.name}`)],
        [followUpButton(org.id, `⏰ Set follow-up of ${org.name}`)]
      ]
    }
  };
}

// Steps: search and pick a contact, pick a channel, pick the day, write the note, save.
export const handleConversationFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  switch (session.step) {
    case "conversation_start": {
      let recent: { id: number; name: string; organization_name: string | null }[] = [];
      try {
        recent = await env.crmApi.recentContacts(session.created_by ?? 0, RECENT_MAX_RESULTS);
      } catch (e) {
        // Typing the name still works.
        console.error("Loading recent contacts failed", e);
      }
      session.contact_choices = Object.fromEntries(recent.map(c => [String(c.id), contactLabel(c)]));
      setStep(session, "awaiting_contact");
      await persistSession();
      if (recent.length === 0) {
        await sendMessage(env, chatId, CONTACT_PROMPT);
        return;
      }
      await sendMessage(env, chatId, `${CONTACT_PROMPT}\nOr tap one you added or talked to recently:`, {
        reply_markup: {
          inline_keyboard: recent.map(c => [{ text: contactLabel(c), callback_data: `select_contact:${c.id}` }])
        },
        accepts_text: true
      });
      break;
    }
    case "log_contact": {
      // Started from a "Log conversation with …" button, so the contact is known.
      let contact;
      try {
        contact = await env.crmApi.getContact(session.contact_id ?? 0);
      } catch (e) {
        console.error("Loading a contact failed", e);
        await sendMessage(env, chatId, errorMessage("Something went wrong. Please try again."));
        await removeSession();
        return;
      }
      if (!contact) {
        await sendMessage(env, chatId, errorMessage("This contact no longer exists."));
        await removeSession();
        return;
      }
      await askChannel(
        sendMessage,
        env,
        chatId,
        session,
        persistSession,
        { contactId: contact.id },
        contactLabel(contact)
      );
      break;
    }
    case "log_organization": {
      // Started from 💬 Log conversation on an organization's card: with the organization itself.
      let org;
      try {
        org = await env.crmApi.organizationDetails(session.organization_id ?? 0, 0);
      } catch (e) {
        console.error("Loading an organization failed", e);
        await sendMessage(env, chatId, errorMessage("Something went wrong. Please try again."));
        await removeSession();
        return;
      }
      if (!org) {
        await sendMessage(env, chatId, errorMessage("This organization no longer exists."));
        await removeSession();
        return;
      }
      await askChannel(sendMessage, env, chatId, session, persistSession, { organizationId: org.id }, org.name);
      break;
    }
    case "awaiting_contact": {
      // last_callback_data stays set until the next step, so only read it for a button press.
      const cb = text === undefined ? session.last_callback_data : null;
      // "Add as a new contact" after a name that found nothing: /newcontact with that name.
      if (cb === "add_contact" && session.pending_contact_name) {
        const name = session.pending_contact_name;
        const contact: Session = {
          mode: "contact",
          step: "awaiting_name",
          created_by: session.created_by,
          telegram_id: session.telegram_id,
          keyboard_message_id: session.keyboard_message_id
        };
        for (const key of Object.keys(session) as (keyof Session)[]) delete session[key];
        Object.assign(session, contact);
        await handleContactFlow(sendMessage, env, chatId, name, session, persistSession, removeSession);
        return;
      }
      if (cb && cb.startsWith("select_contact:")) {
        const contactId = cb.slice("select_contact:".length);
        const label = session.contact_choices && session.contact_choices[contactId];
        if (!label) {
          await sendMessage(env, chatId, errorMessage("Please choose a contact from the buttons, or type a name."));
          return;
        }
        await askChannel(sendMessage, env, chatId, session, persistSession, { contactId: Number(contactId) }, label);
        return;
      }
      const name = text && text.trim();
      if (!name || name.length < 2) {
        await sendMessage(env, chatId, errorMessage("Please type at least 2 letters of the contact name."));
        return;
      }
      try {
        const contacts = await env.crmApi.searchContacts(name);
        if (contacts.length === 0) {
          session.pending_contact_name = name;
          await persistSession();
          await sendMessage(env, chatId, `No contact found with the name "${name}". Type another name, or add them:`, {
            reply_markup: {
              inline_keyboard: [[{ text: `➕ Add "${name}" as a new contact`, callback_data: "add_contact" }]]
            },
            accepts_text: true
          });
          return;
        }
        const shown = contacts.slice(0, CONTACT_MAX_RESULTS);
        // Labels stay in the session; buttons carry only ids (callback_data is limited to 64 bytes).
        const choices = Object.fromEntries(shown.map(c => [String(c.id), contactLabel(c)]));
        session.contact_choices = choices;
        await persistSession();
        const more =
          contacts.length > shown.length
            ? ` Showing ${shown.length} of ${contacts.length}; type more of the name to narrow it down.`
            : "";
        await sendMessage(env, chatId, `Select the contact:${more}`, {
          reply_markup: {
            // Not Object.entries(choices): it would order the numeric ids, not the names.
            inline_keyboard: shown.map(c => [{ text: choices[String(c.id)], callback_data: `select_contact:${c.id}` }])
          },
          accepts_text: more !== ""
        });
      } catch (e) {
        console.error("Searching contacts failed", e);
        await sendMessage(env, chatId, errorMessage("Searching contacts failed. Please type the name again."));
      }
      break;
    }
    case "awaiting_channel": {
      const cb = text === undefined ? session.last_callback_data : null;
      const channel = cb && cb.startsWith("channel:") ? cb.slice("channel:".length) : null;
      if (!channel || !session.channel_choices || !session.channel_choices[channel]) {
        await sendMessage(env, chatId, errorMessage("Please choose a channel from the buttons."));
        return;
      }
      session.channel = channel;
      setStep(session, "awaiting_date");
      await persistSession();
      await sendMessage(env, chatId, `When did you talk to ${session.contact_label}?`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Today", callback_data: "date:today" },
              { text: "Yesterday", callback_data: "date:yesterday" }
            ],
            [{ text: "📅 Other date", callback_data: "date:other" }]
          ]
        },
        // A typed date counts too, without pressing Other date first.
        accepts_text: true
      });
      break;
    }
    case "awaiting_date": {
      const cb = text === undefined ? session.last_callback_data : null;
      if (cb === "date:other") {
        await sendMessage(env, chatId, DAY_PROMPT);
        return;
      }
      const day =
        cb === "date:today" ? teamDay(0) : cb === "date:yesterday" ? teamDay(1) : text ? parseDay(text) : undefined;
      if (!day) {
        await sendMessage(
          env,
          chatId,
          errorMessage(
            text
              ? `"${text.trim()}" is not a date that has passed. ${DAY_PROMPT}`
              : "Please choose a day from the buttons, or type a date."
          )
        );
        return;
      }
      session.happened_on = day;
      setStep(session, "awaiting_note");
      await persistSession();
      await sendMessage(env, chatId, "What was discussed? (minimum 5 characters)");
      break;
    }
    case "awaiting_note": {
      // Try again after a failed save uses the note that was typed then.
      const note = text === undefined && session.last_callback_data === "retry" ? session.note : text && text.trim();
      if (!isValidNote(note)) {
        await sendMessage(env, chatId, errorMessage("Please write at least 5 characters about the conversation."));
        return;
      }
      let saved = false;
      try {
        // created_by is the team member id (team_members.id) of the user, not the Telegram user id.
        const res = await env.crmApi.logConversation({
          ...(session.organization_id
            ? { organization_id: session.organization_id }
            : { contact_id: session.contact_id ?? 0 }),
          channel: session.channel ?? "",
          note,
          happened_on: session.happened_on ?? null,
          created_by: session.created_by || null
        });
        if (!res.ok) console.error("Logging a conversation was refused", res);
        saved = res.ok;
      } catch (e) {
        console.error("Logging a conversation failed", e);
      }
      if (!saved) {
        session.note = note;
        await persistSession();
        await sendMessage(env, chatId, errorMessage("Saving failed, nothing was saved. Your note is kept."), {
          reply_markup: { inline_keyboard: [[{ text: "🔁 Try again", callback_data: "retry" }]] }
        });
        return;
      }
      const channelLabel = session.channel_choices?.[session.channel ?? ""] ?? session.channel;
      await sendMessage(
        env,
        chatId,
        successMessage(
          `Conversation with ${session.contact_label} (${[channelLabel, session.happened_on && dayLabel(session.happened_on)].filter(Boolean).join(", ")}) logged.`
        ),
        await organizationButtons(env, session)
      );
      await removeSession();
      break;
    }
    default:
      await sendMessage(env, chatId, errorMessage("Unknown step in conversation flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
};
