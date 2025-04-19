import { isValidTelegramId, isValidName } from "../helpers/validation.js";
import { setStep } from "../helpers/session.js";
import { errorMessage, successMessage } from "../helpers/messaging.js";
import { selectCommunities, fetchCommunitiesByCountry, fetchCountries } from "../helpers/community.js";

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
      setStep(session, "awaiting_invite_timezone");
      await persistSession();
      await sendMessage(env, chatId, "Please enter the time zone of the team member (e.g. Europe/Amsterdam):");
      break;
    }
    case "awaiting_invite_timezone": {
      const timezone = text && text.trim();
      if (!timezone) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid time zone."));
        return;
      }
      session.invite_timezone = timezone;
      setStep(session, "awaiting_invite_community");
      await persistSession();
      // Start community selection flow
      await selectCommunities({
        sendMessage, env, chatId, session, persistSession, removeSession,
        userId: session.invite_id,
        onComplete: async (communities) => {
          session.invite_communities = communities;
          setStep(session, "awaiting_invite_confirm");
          await persistSession();
          await sendMessage(env, chatId, `Communities selected: ${communities.map(c => c.name).join(", ")}. Type 'confirm' to send the invitation or 'cancel' to abort.`);
        },
        onSkip: async () => {
          session.invite_communities = [];
          setStep(session, "awaiting_invite_confirm");
          await persistSession();
          await sendMessage(env, chatId, "No communities selected. Type 'confirm' to send the invitation or 'cancel' to abort.");
        },
        context: "teammember"
      });
      break;
    }
    case "awaiting_invite_community": {
      // This step is handled by the community helper callbacks, so ignore text input here
      break;
    }
    case "awaiting_invite_confirm": {
      const confirmation = text && text.trim().toLowerCase();
      if (confirmation === "confirm") {
        try {
          const payload = {
            telegram_id: session.invite_id,
            name: session.invite_name,
            time_zone: session.invite_timezone,
            community_ids: session.invite_communities ? session.invite_communities.map(c => c.id) : [],
            invited_by: session.created_by
          };
          const res = await env.crmApi.fetch(new Request(
            `${env.CRM_API_URL}/team_member`,
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
      } else if (confirmation === "cancel") {
        await sendMessage(env, chatId, errorMessage("Invitation cancelled."));
        await removeSession();
      } else {
        await sendMessage(env, chatId, errorMessage("Please type 'confirm' to send the invitation or 'cancel' to abort."));
      }
      break;
    }
    default:
      await sendMessage(env, chatId, errorMessage("Unknown step in team member flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
}
