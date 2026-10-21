import { isValidTelegramId, isValidName } from "../helpers/validation";
import { setStep } from "../helpers/session";
import { errorMessage, successMessage } from "../helpers/messaging";
import {
  startCommunityPicker,
  renderCommunityPicker,
  handleCommunityPickerInput,
  pickedCommunities
} from "../helpers/community";
import type { ChatId, FlowHandler, SendMessage, Session } from "../types";
import type { TeamMemberSummary, UpdateTeamMemberInput } from "../../../crm-api/src/types";

const INVITE_PICKER_TITLE = "Select Bitcoin communities for the new team member:";
const ONLY_ADMINS = "Only admins can manage team members.";

// How a member is named in messages; a member without a name by their Telegram ID.
const memberLabel = (m: Pick<TeamMemberSummary, "name" | "telegram_id">) => m.name ?? m.telegram_id;

// One button per member; the Telegram ID tells members with the same name apart.
function memberButtons(members: TeamMemberSummary[]) {
  return members.map(m => [
    { text: m.name ? `${m.name} (${m.telegram_id})` : m.telegram_id, callback_data: `member:${m.id}` }
  ]);
}

const editPickerTitle = (label: string) => `Select the Bitcoin communities of ${label}:`;

type MemberChanges = Omit<UpdateTeamMemberInput, "team_member_id" | "updated_by">;

// Saves changes to the member chosen in this flow and reports the result.
async function saveMemberChanges(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  changes: MemberChanges,
  success: string
) {
  try {
    const res = await env.crmApi.updateTeamMember({
      team_member_id: session.member_id ?? "",
      ...changes,
      updated_by: session.created_by ?? null
    });
    if (res.ok) {
      await sendMessage(env, chatId, successMessage(success));
    } else if (res.status === 403) {
      await sendMessage(env, chatId, errorMessage(ONLY_ADMINS));
    } else if (res.status === 404) {
      await sendMessage(env, chatId, errorMessage("Team member not found."));
    } else {
      await sendMessage(env, chatId, errorMessage("Failed to update the team member. Please try again."));
    }
  } catch {
    await sendMessage(env, chatId, errorMessage("Error updating the team member."));
  }
}

export const handleTeamMemberFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  switch (session.step) {
    case "teammember_menu": {
      await sendMessage(env, chatId, "Team member management:\nChoose an action:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Invite new team member", callback_data: "invite_new" }],
            [{ text: "Edit existing team member", callback_data: "edit_existing" }],
            [{ text: "Remove team member", callback_data: "remove_member" }],
            [{ text: "Grant admin rights", callback_data: "grant_admin" }],
            [{ text: "Revoke admin rights", callback_data: "revoke_admin" }]
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
          members = await env.crmApi.listTeamMembers();
        } catch {
          await sendMessage(env, chatId, errorMessage("Could not load team members."));
          await removeSession();
          return;
        }
        const candidates = members.filter(m => (m.is_admin === 1) !== granting);
        if (candidates.length === 0) {
          await sendMessage(
            env,
            chatId,
            errorMessage(granting ? "All team members are already admins." : "No admins found.")
          );
          await removeSession();
          return;
        }
        session.admin_action = granting ? "grant" : "revoke";
        session.admin_candidates = Object.fromEntries(candidates.map(m => [String(m.id), memberLabel(m)]));
        setStep(session, "awaiting_admin_member");
        await persistSession();
        await sendMessage(
          env,
          chatId,
          granting ? "Who should get admin rights?" : "Whose admin rights should be revoked?",
          {
            reply_markup: { inline_keyboard: memberButtons(candidates) }
          }
        );
      } else if (action === "edit_existing" || action === "remove_member") {
        const editing = action === "edit_existing";
        let members;
        try {
          members = await env.crmApi.listTeamMembers();
        } catch {
          await sendMessage(env, chatId, errorMessage("Could not load team members."));
          await removeSession();
          return;
        }
        session.member_action = editing ? "edit" : "remove";
        session.member_choices = Object.fromEntries(
          members.map(m => [String(m.id), { telegram_id: m.telegram_id, label: memberLabel(m) }])
        );
        setStep(session, "awaiting_member_choice");
        await persistSession();
        await sendMessage(
          env,
          chatId,
          editing ? "Which team member do you want to edit?" : "Which team member do you want to remove?",
          { reply_markup: { inline_keyboard: memberButtons(members) } }
        );
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
      // Offer the inviter's own communities, plus any other country (shared community picker)
      session.invite_picker = await startCommunityPicker(env, session.telegram_id);
      setStep(session, "awaiting_invite_community");
      await persistSession();
      await sendMessage(env, chatId, ...renderCommunityPicker(session.invite_picker, INVITE_PICKER_TITLE));
      break;
    }
    case "awaiting_invite_community": {
      const picker = session.invite_picker;
      if (!picker) {
        await sendMessage(env, chatId, errorMessage("Session expired. Please start again with /invite."));
        await removeSession();
        return;
      }
      const cb = session.last_callback_data;
      session.last_callback_data = null;
      const result = await handleCommunityPickerInput(env, picker, cb);
      await persistSession();
      if (result === "updated") {
        await sendMessage(env, chatId, ...renderCommunityPicker(picker, INVITE_PICKER_TITLE));
      } else if (result === "done" || result === "skip") {
        const communities = result === "skip" ? [] : pickedCommunities(picker);
        session.invite_communities = communities;
        setStep(session, "awaiting_invite_confirm");
        await persistSession();
        await sendMessage(
          env,
          chatId,
          communities.length > 0
            ? `Communities selected: ${communities.map(c => c.name).join(", ")}. Type 'confirm' to add the team member or 'cancel' to abort.`
            : "No communities selected. Type 'confirm' to add the team member or 'cancel' to abort."
        );
      } else if (typeof result === "object") {
        await sendMessage(env, chatId, errorMessage(result.error));
      } else {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please use the buttons to select communities, then press Done or Skip.")
        );
      }
      break;
    }
    case "awaiting_invite_confirm": {
      const confirmation = text && text.trim().toLowerCase();
      if (confirmation === "confirm") {
        try {
          const res = await env.crmApi.addTeamMember({
            telegram_id: session.invite_id ?? "",
            name: session.invite_name ?? "",
            time_zone: session.invite_timezone,
            community_ids: (session.invite_communities ?? []).map(c => c.id),
            invited_by: session.created_by ?? null
          });
          // Nothing is sent to the new member: a bot cannot message someone who never opened it.
          if (res.ok && res.existing) {
            await sendMessage(
              env,
              chatId,
              successMessage(
                `Telegram ID ${session.invite_id} is already a team member; communities/time zone updated.`
              )
            );
          } else if (res.ok) {
            await sendMessage(
              env,
              chatId,
              successMessage(`"${session.invite_name}" added as team member. Ask them to open the bot and send /help.`)
            );
          } else if (res.status === 403) {
            await sendMessage(env, chatId, errorMessage(ONLY_ADMINS));
          } else {
            await sendMessage(env, chatId, errorMessage("Failed to add the team member. Please try again."));
          }
        } catch {
          await sendMessage(env, chatId, errorMessage("Error adding the team member."));
        }
        await removeSession();
      } else if (confirmation === "cancel") {
        await sendMessage(env, chatId, errorMessage("Invitation cancelled."));
        await removeSession();
      } else {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please type 'confirm' to add the team member or 'cancel' to abort.")
        );
      }
      break;
    }
    case "awaiting_admin_member": {
      const choice = session.last_callback_data || "";
      const memberId = choice.startsWith("member:") ? choice.slice("member:".length) : null;
      const memberName = memberId && session.admin_candidates && session.admin_candidates[memberId];
      if (!memberId || !memberName) {
        await sendMessage(env, chatId, errorMessage("Please choose a team member from the buttons, or type /cancel."));
        return;
      }
      const granting = session.admin_action === "grant";
      try {
        const res = await env.crmApi.setAdmin({
          team_member_id: memberId,
          is_admin: granting,
          updated_by: session.created_by ?? null
        });
        if (res.ok) {
          await sendMessage(
            env,
            chatId,
            successMessage(granting ? `${memberName} is now an admin.` : `${memberName} is no longer an admin.`)
          );
        } else if (res.status === 409) {
          await sendMessage(env, chatId, errorMessage("Cannot revoke the last admin."));
        } else if (res.status === 403) {
          await sendMessage(env, chatId, errorMessage("Only admins can change admin rights."));
        } else {
          await sendMessage(env, chatId, errorMessage("Failed to change admin rights. Please try again."));
        }
      } catch {
        await sendMessage(env, chatId, errorMessage("Error changing admin rights."));
      }
      await removeSession();
      break;
    }
    case "awaiting_member_choice": {
      const choice = session.last_callback_data || "";
      const memberId = choice.startsWith("member:") ? choice.slice("member:".length) : null;
      const member = memberId ? session.member_choices?.[memberId] : undefined;
      if (!memberId || !member) {
        await sendMessage(env, chatId, errorMessage("Please choose a team member from the buttons, or type /cancel."));
        return;
      }
      session.member_id = memberId;
      session.member_telegram_id = member.telegram_id;
      session.member_label = member.label;
      if (session.member_action === "remove") {
        setStep(session, "awaiting_remove_confirm");
        await persistSession();
        await sendMessage(env, chatId, `Remove ${member.label} from the team? They will lose access to the bot.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Remove", callback_data: "confirm_remove" }],
              [{ text: "Cancel", callback_data: "cancel_remove" }]
            ]
          }
        });
      } else {
        setStep(session, "awaiting_edit_field");
        await persistSession();
        await sendMessage(env, chatId, `What do you want to change for ${member.label}?`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Name", callback_data: "edit_field:name" }],
              [{ text: "Time zone", callback_data: "edit_field:time_zone" }],
              [{ text: "Communities", callback_data: "edit_field:communities" }]
            ]
          }
        });
      }
      break;
    }
    case "awaiting_remove_confirm": {
      const choice = session.last_callback_data;
      const label = session.member_label;
      if (choice === "cancel_remove") {
        await sendMessage(env, chatId, errorMessage("Removal cancelled."));
        await removeSession();
        return;
      }
      if (choice !== "confirm_remove") {
        await sendMessage(env, chatId, errorMessage("Please press Remove or Cancel, or type /cancel."));
        return;
      }
      try {
        const res = await env.crmApi.deleteTeamMember({
          telegram_id: session.member_telegram_id ?? "",
          performed_by: session.created_by ?? null
        });
        if (res.ok) {
          // A member with history keeps their row (without access), so their entries stay readable.
          await sendMessage(
            env,
            chatId,
            successMessage(res.deactivated ? `${label} removed (history kept).` : `${label} deleted.`)
          );
        } else if (res.status === 409) {
          await sendMessage(env, chatId, errorMessage("Cannot remove the last admin."));
        } else if (res.status === 403) {
          await sendMessage(env, chatId, errorMessage(ONLY_ADMINS));
        } else if (res.status === 404) {
          await sendMessage(env, chatId, errorMessage("Team member not found."));
        } else {
          await sendMessage(env, chatId, errorMessage("Failed to remove the team member. Please try again."));
        }
      } catch {
        await sendMessage(env, chatId, errorMessage("Error removing the team member."));
      }
      await removeSession();
      break;
    }
    case "awaiting_edit_field": {
      const field = session.last_callback_data;
      const label = session.member_label ?? "";
      if (field === "edit_field:name") {
        setStep(session, "awaiting_edit_name");
        await persistSession();
        await sendMessage(env, chatId, `Please enter the new name for ${label}:`);
      } else if (field === "edit_field:time_zone") {
        setStep(session, "awaiting_edit_timezone");
        await persistSession();
        await sendMessage(env, chatId, `Please enter the new time zone for ${label} (e.g. Europe/Amsterdam):`);
      } else if (field === "edit_field:communities") {
        let current;
        try {
          current = await env.crmApi.teamMemberCommunities(session.member_telegram_id ?? "");
        } catch {
          await sendMessage(env, chatId, errorMessage("Could not load the communities of this team member."));
          await removeSession();
          return;
        }
        // The member's current communities start selected; the admin's own are offered too.
        session.edit_picker = await startCommunityPicker(
          env,
          session.telegram_id,
          current.map(c => ({ id: c.id, name: c.name, region: c.region || null }))
        );
        setStep(session, "awaiting_edit_communities");
        await persistSession();
        await sendMessage(env, chatId, ...renderCommunityPicker(session.edit_picker, editPickerTitle(label)));
      } else {
        await sendMessage(env, chatId, errorMessage("Please choose what to change from the buttons, or type /cancel."));
      }
      break;
    }
    case "awaiting_edit_name": {
      const name = text && text.trim();
      if (!isValidName(name)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid name (minimum 3 characters)."));
        return;
      }
      await saveMemberChanges(
        sendMessage,
        env,
        chatId,
        session,
        { name },
        `Name of ${session.member_label} changed to "${name}".`
      );
      await removeSession();
      break;
    }
    case "awaiting_edit_timezone": {
      const timeZone = text && text.trim();
      if (!timeZone) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid time zone."));
        return;
      }
      await saveMemberChanges(
        sendMessage,
        env,
        chatId,
        session,
        { time_zone: timeZone },
        `Time zone of ${session.member_label} changed to ${timeZone}.`
      );
      await removeSession();
      break;
    }
    case "awaiting_edit_communities": {
      const picker = session.edit_picker;
      const label = session.member_label ?? "";
      if (!picker) {
        await sendMessage(env, chatId, errorMessage("Session expired. Please start again with /teammember."));
        await removeSession();
        return;
      }
      const cb = session.last_callback_data;
      session.last_callback_data = null;
      const result = await handleCommunityPickerInput(env, picker, cb);
      await persistSession();
      if (result === "updated") {
        await sendMessage(env, chatId, ...renderCommunityPicker(picker, editPickerTitle(label)));
      } else if (result === "skip") {
        await sendMessage(env, chatId, `Communities of ${label} unchanged.`);
        await removeSession();
      } else if (result === "done") {
        const communities = pickedCommunities(picker);
        await saveMemberChanges(
          sendMessage,
          env,
          chatId,
          session,
          { community_ids: communities.map(c => c.id) },
          communities.length > 0
            ? `Communities of ${label} changed to: ${communities.map(c => c.name).join(", ")}.`
            : `${label} no longer belongs to any community.`
        );
        await removeSession();
      } else if (typeof result === "object") {
        await sendMessage(env, chatId, errorMessage(result.error));
      } else {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please use the buttons to select communities, then press Done or Skip.")
        );
      }
      break;
    }
    default:
      await sendMessage(env, chatId, errorMessage("Unknown step in team member flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
};
