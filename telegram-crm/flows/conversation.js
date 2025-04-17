import { isValidName, isValidNote } from "../helpers/validation.js";
import { setStep } from "../helpers/session.js";
import { errorMessage } from "../helpers/messaging.js";

export async function handleConversationFlow(sendMessage, env, chatId, text, session, persistSession = async () => {}, removeSession = async () => {}) {
  console.log("[CONVERSATION FLOW DEBUG] step:", session.step, "| text:", text, "| session:", JSON.stringify(session));
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
      try {
        const payload = {
          contact_name: session.contact_name,
          note: session.note,
          created_by: session.created_by
        };
        const res = await env.crmApi.fetch(new Request(
          `${env.CRM_API_URL}/logconversation`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }
        ));
        if (res.ok) {
          await sendMessage(env, chatId, `✅ Conversation logged for contact "${session.contact_name}".`);
        } else {
          await sendMessage(env, chatId, errorMessage("Failed to log conversation. Please try again or contact support."));
        }
      } catch (e) {
        await sendMessage(env, chatId, errorMessage("Error logging conversation."));
      }
      await removeSession();
      break;
    }
    default:
      await sendMessage(env, chatId, errorMessage("Unknown step in conversation flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
}
