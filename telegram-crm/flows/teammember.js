import { isValidTelegramId, isValidName } from "../helpers/validation.js";
import { setStep } from "../helpers/session.js";
import { errorMessage, successMessage } from "../helpers/messaging.js";

export async function handleTeamMemberFlow(sendMessage, env, chatId, text, session, persistSession = async () => {}, removeSession = async () => {}) {
  console.log("[TEAMMEMBER FLOW DEBUG] step:", session.step, "| text:", text, "| session:", JSON.stringify(session));
  switch (session.step) {
    case "teammember_menu": {
      await sendMessage(env, chatId, "Team member management:\nChoose an action:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Invite new team member", callback_data: "invite_new" }],
            [{ text: "Edit existing team member", callback_data: "edit_existing" }]
          ]
        }
      });
      setStep(session, "awaiting_teammember_action");
      await persistSession();
      break;
    }
    case "awaiting_teammember_action": {
      const action = text || session.last_callback_data;
      if (!action) {
        await sendMessage(env, chatId, errorMessage("Please select an action."));
        return;
      }
      if (action === "invite_new") {
        setStep(session, "awaiting_invite_id");
        await persistSession();
        await sendMessage(env, chatId, "What is the Telegram user ID of the team member you want to invite?");
      } else if (action === "edit_existing") {
        await sendMessage(env, chatId, errorMessage("Editing existing team members is not implemented yet."));
        await removeSession();
      } else {
        await sendMessage(env, chatId, errorMessage("Unknown action. Please select a valid option."));
      }
      break;
    }
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
      await sendMessage(env, chatId, errorMessage("Unknown step in team member flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
}
