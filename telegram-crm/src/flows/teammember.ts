import { isValidName } from "../helpers/validation";
import { setStep } from "../helpers/session";
import { errorMessage, successMessage } from "../helpers/messaging";
import { botUsername, startLink } from "../helpers/telegram";
import {
  startCommunityPicker,
  renderCommunityPicker,
  handleCommunityPickerInput,
  pickedCommunities
} from "../helpers/community";
import type { ChatId, FlowHandler, SendMessage, Session } from "../types";
import type { TeamMemberSummary, UpdateTeamMemberInput } from "../../../crm-api/src/types";

const INVITE_PICKER_TITLE = "Which Bitcoin communities will the new team member join?";
const ONLY_ADMINS = "Only admins can manage team members.";
const INVITE_FAILED = "Could not create the invite link. Please try again.";

type MemberNames = Pick<TeamMemberSummary, "name" | "telegram_username" | "telegram_id">;

// How a member is named in messages: their name, else their @username, else their Telegram ID.
const memberLabel = (m: MemberNames) => m.name ?? (m.telegram_username ? `@${m.telegram_username}` : m.telegram_id);

// How a member is listed: the name with the @username, which also tells equal names apart.
const memberLine = (m: MemberNames) =>
  m.name && m.telegram_username ? `${m.name} (@${m.telegram_username})` : memberLabel(m);

// One button per member. Members with the same name and no username are told apart by Telegram ID.
function memberButtons(members: TeamMemberSummary[]) {
  return members.map(m => {
    const sameName = m.name !== null && members.filter(o => o.name === m.name).length > 1;
    const text = sameName && !m.telegram_username ? `${m.name} (${m.telegram_id})` : memberLine(m);
    return [{ text, callback_data: `member:${m.id}` }];
  });
}

// Opens Telegram's share sheet with the invite link, so the admin can pick who gets it.
const shareUrl = (link: string) =>
  `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Open this link to join our team in the CRM bot.")}`;

/**
 * Starts an invite: the communities of the new member, then the link. Not in a group, where
 * anyone could open the link first; there the admin gets a button to a private chat instead.
 */
async function startInvite(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  persistSession: () => Promise<void>,
  removeSession: () => Promise<void>
) {
  if (Number(chatId) < 0) {
    const link = await startLink(env, "invite");
    const text = "Invite links are made in a private chat with me, so nobody else in this group can use them.";
    await sendMessage(
      env,
      chatId,
      link ? text : `${text} Send me /invite there.`,
      link ? { reply_markup: { inline_keyboard: [[{ text: "Open private chat", url: link }]] } } : undefined
    );
    await removeSession();
    return;
  }
  // The admin's own communities start selected: usually the new member joins those.
  session.invite_picker = await startCommunityPicker(env, session.telegram_id, [], { selectOwn: true });
  setStep(session, "awaiting_invite_community");
  await persistSession();
  await sendMessage(env, chatId, ...renderCommunityPicker(session.invite_picker, INVITE_PICKER_TITLE));
}

// Creates the invite link for the chosen communities and gives it to the admin.
async function sendInviteLink(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  communities: { id: number; name: string }[]
) {
  // Known before the invite exists, so no unusable invite is created while getMe fails.
  const username = await botUsername(env);
  let res;
  try {
    res = username
      ? await env.crmApi.createInvite({
          invited_by: session.created_by ?? null,
          community_ids: communities.map(c => c.id)
        })
      : undefined;
  } catch {
    res = undefined;
  }
  if (!res?.ok) {
    await sendMessage(env, chatId, errorMessage(res?.status === 403 ? ONLY_ADMINS : INVITE_FAILED));
    return;
  }
  const link = `https://t.me/${username}?start=${res.token}`;
  const until = new Date(res.expires_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Amsterdam"
  });
  const joins = communities.length > 0 ? ` They will join ${communities.map(c => c.name).join(", ")}.` : "";
  await sendMessage(
    env,
    chatId,
    `🔗 Invite link for a new team member:\n${link}\n\nSend it only to the person you want to add.${joins} It works once, until ${until}.`,
    { reply_markup: { inline_keyboard: [[{ text: "📤 Share link", url: shareUrl(link) }]] } }
  );
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
            [{ text: "Show team", callback_data: "show_team" }],
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
        await startInvite(sendMessage, env, chatId, session, persistSession, removeSession);
      } else if (action === "show_team") {
        let members;
        try {
          members = await env.crmApi.listTeamMembers();
        } catch {
          await sendMessage(env, chatId, errorMessage("Could not load team members."));
          await removeSession();
          return;
        }
        const lines = members.map(m => `• ${memberLine(m)}${m.is_admin === 1 ? " · admin" : ""}`);
        await sendMessage(env, chatId, `👥 Team (${members.length}):\n${lines.join("\n")}`);
        await removeSession();
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
    case "invite_start": {
      await startInvite(sendMessage, env, chatId, session, persistSession, removeSession);
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
        await sendInviteLink(sendMessage, env, chatId, session, result === "skip" ? [] : pickedCommunities(picker));
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
