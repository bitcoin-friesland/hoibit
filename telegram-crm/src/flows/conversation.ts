import { isValidNote } from "../helpers/validation";
import { setStep } from "../helpers/session";
import { errorMessage, successMessage } from "../helpers/messaging";
import type { FlowHandler } from "../types";

const CONTACT_MAX_RESULTS = 8;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Steps: search and pick a contact, pick a channel, write the note, save.
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
    case "awaiting_contact": {
      // last_callback_data stays set until the next step, so only read it for a button press.
      const cb = text === undefined ? session.last_callback_data : null;
      if (cb && cb.startsWith("select_contact:")) {
        const contactId = cb.slice("select_contact:".length);
        const label = session.contact_choices && session.contact_choices[contactId];
        if (!label) {
          await sendMessage(env, chatId, errorMessage("Please choose a contact from the buttons, or type a name."));
          return;
        }
        let channels;
        try {
          channels = await env.crmApi.channels();
        } catch (e) {
          await sendMessage(env, chatId, errorMessage(`Error loading channels: ${errorText(e)}`));
          return;
        }
        session.contact_id = Number(contactId);
        session.contact_label = label;
        session.channel_choices = Object.fromEntries(channels.map(c => [c.id, c.label]));
        setStep(session, "awaiting_channel");
        await persistSession();
        await sendMessage(env, chatId, `How did you talk to ${label}?`, {
          reply_markup: { inline_keyboard: channels.map(c => [{ text: c.label, callback_data: `channel:${c.id}` }]) }
        });
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
          await sendMessage(
            env,
            chatId,
            `No contact found with the name "${name}". Type another name, or add the contact first with /newcontact.`
          );
          return;
        }
        const shown = contacts.slice(0, CONTACT_MAX_RESULTS);
        // Labels stay in the session; buttons carry only ids (callback_data is limited to 64 bytes).
        const choices = Object.fromEntries(
          shown.map(c => [String(c.id), c.organization_name ? `${c.name} (${c.organization_name})` : c.name])
        );
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
        await sendMessage(env, chatId, errorMessage(`Error searching contacts: ${errorText(e)}`));
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
      setStep(session, "awaiting_note");
      await persistSession();
      await sendMessage(env, chatId, "What was discussed? (minimum 5 characters)");
      break;
    }
    case "awaiting_note": {
      const note = text && text.trim();
      if (!isValidNote(note)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid note (minimum 5 characters)."));
        return;
      }
      try {
        // created_by is the team member id (team_members.id) of the user, not the Telegram user id.
        const res = await env.crmApi.logConversation({
          contact_id: session.contact_id ?? 0,
          channel: session.channel ?? "",
          note,
          created_by: session.created_by || null
        });
        if (!res.ok) {
          await sendMessage(env, chatId, errorMessage(`Failed to log conversation (code ${res.status}).`));
          await removeSession();
          return;
        }
      } catch (e) {
        await sendMessage(env, chatId, errorMessage(`Error logging conversation: ${errorText(e)}`));
        await removeSession();
        return;
      }
      const channelLabel = session.channel_choices?.[session.channel ?? ""] ?? session.channel;
      await sendMessage(
        env,
        chatId,
        successMessage(`Conversation with ${session.contact_label} (${channelLabel}) logged.`)
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
