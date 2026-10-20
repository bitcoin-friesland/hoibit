import { isValidTelegramId, isValidName } from "../helpers/validation.js";
import { setStep } from "../helpers/session.js";
import { errorMessage, successMessage } from "../helpers/messaging.js";
import { selectCommunitiesList } from "../helpers/community.js";

function inviteCommunityKeyboard(session) {
  const rows = session.invite_options.map(c => [{
    text: `${session.invite_selected.includes(c.id) ? "✅ " : ""}${c.name}`,
    callback_data: `community:${c.id}`
  }]);
  rows.push([{ text: "Done", callback_data: "done" }], [{ text: "Skip", callback_data: "skip" }]);
  return { inline_keyboard: rows };
}

export async function handleTeamMemberFlow(sendMessage, env, chatId, text, session, persistSession = async () => {}, removeSession = async () => {}) {
  console.log("[TEAMMEMBER FLOW DEBUG] step:", session.step, "| text:", text, "| session:", JSON.stringify(session));
  switch (session.step) {
    case "teammember_menu": {
      await sendMessage(env, chatId, "Team member management:\nChoose an action:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Invite new team member", callback_data: "invite_new" }],
            [{ text: "Grant admin rights", callback_data: "grant_admin" }],
            [{ text: "Revoke admin rights", callback_data: "revoke_admin" }],
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
      } else if (action === "grant_admin" || action === "revoke_admin") {
        const granting = action === "grant_admin";
        let members;
        try {
          const res = await env.crmApi.fetch(new Request(`${env.CRM_API_URL}/team_members`));
          if (!res.ok) throw new Error(`status ${res.status}`);
          members = await res.json();
        } catch (e) {
          await sendMessage(env, chatId, errorMessage("Could not load team members."));
          await removeSession();
          return;
        }
        const candidates = members.filter(m => (m.is_admin === 1) !== granting);
        if (candidates.length === 0) {
          await sendMessage(env, chatId, errorMessage(granting ? "All team members are already admins." : "No admins found."));
          await removeSession();
          return;
        }
        session.admin_action = granting ? "grant" : "revoke";
        session.admin_candidates = Object.fromEntries(candidates.map(m => [String(m.id), m.name]));
        setStep(session, "awaiting_admin_member");
        await persistSession();
        await sendMessage(env, chatId, granting ? "Who should get admin rights?" : "Whose admin rights should be revoked?", {
          reply_markup: {
            inline_keyboard: candidates.map(m => [{ text: `${m.name} (${m.telegram_id})`, callback_data: `member:${m.id}` }])
          }
        });
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
      // Offer the inviter's own communities; button presses arrive as separate updates
      // and are handled in awaiting_invite_community.
      let options = [];
      try {
        options = (await selectCommunitiesList(env, session.telegram_id)).map(c => ({ id: c.id, name: c.name }));
      } catch (e) {
        options = [];
      }
      if (options.length === 0) {
        session.invite_communities = [];
        setStep(session, "awaiting_invite_confirm");
        await persistSession();
        await sendMessage(env, chatId, "No communities selected. Type 'confirm' to send the invitation or 'cancel' to abort.");
        break;
      }
      session.invite_options = options;
      session.invite_selected = [];
      setStep(session, "awaiting_invite_community");
      await persistSession();
      await sendMessage(env, chatId, "Select Bitcoin communities for the new team member:", { reply_markup: inviteCommunityKeyboard(session) });
      break;
    }
    case "awaiting_invite_community": {
      const cb = session.last_callback_data;
      if (cb && cb.startsWith("community:")) {
        const id = Number(cb.slice("community:".length));
        session.invite_selected = session.invite_selected.includes(id)
          ? session.invite_selected.filter(x => x !== id)
          : [...session.invite_selected, id];
        session.last_callback_data = null;
        await persistSession();
        await sendMessage(env, chatId, "Select Bitcoin communities for the new team member:", { reply_markup: inviteCommunityKeyboard(session) });
      } else if (cb === "done" || cb === "skip") {
        session.invite_communities = cb === "skip" ? [] : session.invite_options.filter(c => session.invite_selected.includes(c.id));
        setStep(session, "awaiting_invite_confirm");
        await persistSession();
        await sendMessage(env, chatId, session.invite_communities.length > 0
          ? `Communities selected: ${session.invite_communities.map(c => c.name).join(", ")}. Type 'confirm' to send the invitation or 'cancel' to abort.`
          : "No communities selected. Type 'confirm' to send the invitation or 'cancel' to abort.");
      } else {
        await sendMessage(env, chatId, errorMessage("Please use the buttons to select communities, then press Done or Skip."));
      }
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
              headers: { "Content-Type": "application/json" },
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
    case "awaiting_admin_member": {
      const choice = session.last_callback_data || "";
      const memberId = choice.startsWith("member:") ? choice.slice("member:".length) : null;
      const memberName = memberId && session.admin_candidates && session.admin_candidates[memberId];
      if (!memberName) {
        await sendMessage(env, chatId, errorMessage("Please choose a team member from the buttons, or type /cancel."));
        return;
      }
      const granting = session.admin_action === "grant";
      try {
        const res = await env.crmApi.fetch(new Request(
          `${env.CRM_API_URL}/team_member/admin`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ team_member_id: memberId, is_admin: granting, updated_by: session.created_by })
          }
        ));
        if (res.ok) {
          await sendMessage(env, chatId, successMessage(granting ? `${memberName} is now an admin.` : `${memberName} is no longer an admin.`));
        } else if (res.status === 409) {
          await sendMessage(env, chatId, errorMessage("Cannot revoke the last admin."));
        } else if (res.status === 403) {
          await sendMessage(env, chatId, errorMessage("Only admins can change admin rights."));
        } else {
          await sendMessage(env, chatId, errorMessage("Failed to change admin rights. Please try again."));
        }
      } catch (e) {
        await sendMessage(env, chatId, errorMessage("Error changing admin rights."));
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
