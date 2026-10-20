import { isValidName } from "../helpers/validation";
import { errorMessage, successMessage } from "../helpers/messaging";
import type { FlowHandler } from "../types";

export const handleFirstUserFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  switch (session.step) {
    case "awaiting_first_name": {
      const name = text && text.trim();
      if (!isValidName(name)) {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please enter a valid name (minimum 3 characters) to register as the first team member.")
        );
        return;
      }
      // Save name and move to time zone step
      session.name = name;
      session.step = "awaiting_time_zone";
      await persistSession();
      await sendMessage(env, chatId, "Please enter your time zone (e.g., Europe/Amsterdam or UTC+2).");
      break;
    }
    case "awaiting_time_zone": {
      const timeZone = text && text.trim();
      // Basic validation: allow "UTC", "UTC+2", "Europe/Amsterdam", etc.
      if (!timeZone || timeZone.length < 3) {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please enter a valid time zone (e.g., Europe/Amsterdam or UTC+2).")
        );
        return;
      }
      session.time_zone = timeZone;
      try {
        const res = await env.crmApi.firstUser({
          telegram_id: String(chatId),
          name: session.name ?? "",
          time_zone: session.time_zone
        });
        if (res.ok) {
          await sendMessage(
            env,
            chatId,
            successMessage(`First team member "${session.name}" registered successfully.`)
          );
        } else {
          await sendMessage(
            env,
            chatId,
            errorMessage("Failed to register first team member. Please try again or contact support.")
          );
        }
      } catch {
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
};
