import { isValidName, isValidNote } from "../helpers/validation";
import { setStep } from "../helpers/session";
import { errorMessage } from "../helpers/messaging";
import type { FlowHandler } from "../types";

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
    case "awaiting_contact_name": {
      const name = text && text.trim();
      if (!isValidName(name)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid contact name (minimum 3 characters)."));
        return;
      }
      session.contact_name = name;
      setStep(session, "awaiting_note");
      await persistSession();
      await sendMessage(env, chatId, "Please enter the conversation note:");
      break;
    }
    case "awaiting_note": {
      const note = text && text.trim();
      if (!isValidNote(note)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid note (minimum 5 characters)."));
        return;
      }
      session.note = note;
      // Not wired up yet: crm-api logConversation needs a contact_id (chosen from a contact
      // search) and a channel, and the conversations table has no created_by column.
      // Until then this flow ends with the same failure message the bot always gave.
      await sendMessage(env, chatId, errorMessage("Failed to log conversation. Please try again or contact support."));
      await removeSession();
      break;
    }
    default:
      await sendMessage(env, chatId, errorMessage("Unknown step in conversation flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
};
