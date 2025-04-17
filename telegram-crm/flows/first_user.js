import { isValidName } from "../helpers/validation.js";
import { setStep } from "../helpers/session.js";
import { errorMessage, successMessage } from "../helpers/messaging.js";

export async function handleFirstUserFlow(sendMessage, env, chatId, text, session, persistSession = async () => {}, removeSession = async () => {}) {
  console.log("[FIRST USER FLOW DEBUG] step:", session.step, "| text:", text, "| session:", JSON.stringify(session));
  switch (session.step) {
    case "awaiting_first_name": {
      const name = text && text.trim();
      if (!isValidName(name)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid name (minimum 3 characters) to register as the first team member."));
        return;
      }
      try {
        const payload = {
          name: name
        };
        const res = await env.crmApi.fetch(new Request(
          `${env.CRM_API_URL}/first-user`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }
        ));
        if (res.ok) {
          await sendMessage(env, chatId, successMessage(`First team member "${name}" registered successfully.`));
        } else {
          await sendMessage(env, chatId, errorMessage("Failed to register first team member. Please try again or contact support."));
        }
      } catch (e) {
        await sendMessage(env, chatId, errorMessage("Error registering first team member."));
      }
      await removeSession();
      break;
    }
    default:
      await sendMessage(env, chatId, errorMessage("Unknown step in first user flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
}
