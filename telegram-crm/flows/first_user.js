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
      // Save name and move to time zone step
      session.name = name;
      session.step = "awaiting_time_zone";
      await persistSession(session);
      await sendMessage(env, chatId, "Please enter your time zone (e.g., Europe/Amsterdam or UTC+2).");
      break;
    }
    case "awaiting_time_zone": {
      const timeZone = text && text.trim();
      // Basic validation: allow "UTC", "UTC+2", "Europe/Amsterdam", etc.
      if (!timeZone || timeZone.length < 3) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid time zone (e.g., Europe/Amsterdam or UTC+2)."));
        return;
      }
      // Save time zone
      session.time_zone = timeZone;
      // Prepare payload
      const payload = {
        telegram_id: String(chatId),
        name: session.name,
        time_zone: session.time_zone
      };
      try {
        const res = await env.crmApi.fetch(new Request(
          `${env.CRM_API_URL}/first-user`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }
        ));
        if (res.ok) {
          await sendMessage(env, chatId, successMessage(`First team member "${session.name}" registered successfully.`));
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
