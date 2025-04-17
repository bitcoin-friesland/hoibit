import { isValidTelegramId, isValidName } from "../helpers/validation.js";
import { setStep } from "../helpers/session.js";
import { errorMessage, successMessage } from "../helpers/messaging.js";

export async function handleInviteFlow(sendMessage, env, chatId, text, session, persistSession = async () => {}, removeSession = async () => {}) {
  console.log("[INVITE FLOW DEBUG] step:", session.step, "| text:", text, "| session:", JSON.stringify(session));
  switch (session.step) {
    case "awaiting_invite_id": {
      const inviteId = text && text.trim();
      if (!isValidTelegramId(inviteId)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid Telegram user ID (numbers only)."));
        return;
      }
      session.invite_id = inviteId;
      setStep(session, "awaiting_invite_name");
      await persistSession();
      await sendMessage(env, chatId, "Please enter the name of the team member you want to invite:");
      break;
    }
    case "awaiting_invite_name": {
      const inviteName = text && text.trim();
      if (!isValidName(inviteName)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid name (minimum 3 characters)."));
        return;
      }
      session.invite_name = inviteName;
      try {
        const payload = {
          telegram_id: session.invite_id,
          name: session.invite_name,
          invited_by: session.created_by
        };
        const res = await env.crmApi.fetch(new Request(
          `${env.CRM_API_URL}/invite`,
          {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }
        ));
        if (res.ok) {
          await sendMessage(env, chatId, successMessage(`Invitation sent to "${session.invite_name}" (Telegram ID: ${session.invite_id}).`));
        } else {
          await sendMessage(env, chatId, errorMessage("Failed to send invitation. Please try again or contact support."));
        }
      } catch (e) {
        await sendMessage(env, chatId, errorMessage("Error sending invitation."));
      }
      await removeSession();
      break;
    }
    default:
      await sendMessage(env, chatId, errorMessage("Unknown step in invite flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
}
