/**
 * /me: a member's own name and communities, which they change themselves; only admins change
 * someone else's (/teammember). Uses the community picker and saving of the team member flow.
 */
import { isValidName, NAME_RULE } from "../helpers/validation";
import { setStep } from "../helpers/session";
import { errorMessage } from "../helpers/messaging";
import {
  startCommunityPicker,
  renderCommunityPicker,
  handleCommunityPickerInput,
  pickedAnswer,
  pickedCommunities
} from "../helpers/community";
import { memberLine, saveMemberChanges } from "./teammember";
import type { FlowHandler } from "../types";

const PICKER_TITLE = "Select your Bitcoin communities:";
const LOAD_FAILED = "Could not load your details. Please try again.";

// Steps: the card with the member's details, then the name or the communities.
export const handleMeFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  switch (session.step) {
    case "me_start": {
      let member, communities;
      try {
        [member, communities] = await Promise.all([
          env.crmApi.validateUser(session.telegram_id ?? ""),
          env.crmApi.teamMemberCommunities(session.telegram_id ?? "")
        ]);
      } catch (e) {
        console.error("Loading a member's own details failed", e);
      }
      if (!member || !communities) {
        await sendMessage(env, chatId, errorMessage(LOAD_FAILED));
        await removeSession();
        return;
      }
      session.member_id = String(member.id);
      setStep(session, "me_menu");
      await persistSession();
      const lines = [
        `🙋 ${memberLine(member)}`,
        communities.length > 0 ? `👥 ${communities.map(c => c.name).join(", ")}` : "👥 No communities",
        ...(member.is_admin === 1 ? ["🔑 Admin"] : [])
      ];
      await sendMessage(env, chatId, lines.join("\n"), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✏️ Name", callback_data: "me:name" },
              { text: "👥 Communities", callback_data: "me:communities" }
            ]
          ]
        }
      });
      break;
    }
    case "me_menu": {
      const choice = session.last_callback_data;
      if (choice === "me:name") {
        setStep(session, "me_name");
        await persistSession();
        await sendMessage(env, chatId, "What is your name?");
      } else if (choice === "me:communities") {
        let current;
        try {
          current = await env.crmApi.teamMemberCommunities(session.telegram_id ?? "");
        } catch {
          await sendMessage(env, chatId, errorMessage(LOAD_FAILED));
          await removeSession();
          return;
        }
        session.edit_picker = await startCommunityPicker(
          env,
          session.telegram_id,
          current.map(c => ({ id: c.id, name: c.name, region: c.region || null }))
        );
        setStep(session, "me_communities");
        await persistSession();
        await sendMessage(
          env,
          chatId,
          ...renderCommunityPicker(session.edit_picker, PICKER_TITLE, { skipLabel: "Keep unchanged" })
        );
      } else {
        await sendMessage(env, chatId, errorMessage("Please choose what to change from the buttons, or type /cancel."));
      }
      break;
    }
    case "me_name": {
      const name = text && text.trim();
      if (!isValidName(name)) {
        await sendMessage(env, chatId, errorMessage(NAME_RULE));
        return;
      }
      await saveMemberChanges(sendMessage, env, chatId, session, { name }, `Your name is now "${name}".`);
      await removeSession();
      break;
    }
    case "me_communities": {
      const picker = session.edit_picker;
      if (!picker) {
        await sendMessage(env, chatId, errorMessage("Session expired. Please start again with /me."));
        await removeSession();
        return;
      }
      const cb = session.last_callback_data;
      session.last_callback_data = null;
      const result = await handleCommunityPickerInput(env, picker, cb);
      await persistSession();
      if (result === "updated") {
        await sendMessage(
          env,
          chatId,
          ...renderCommunityPicker(picker, PICKER_TITLE, { replace: true, skipLabel: "Keep unchanged" })
        );
      } else if (result === "skip") {
        await sendMessage(env, chatId, "Your communities are unchanged.");
        await removeSession();
      } else if (result === "done") {
        session.pressed_answer = pickedAnswer(picker);
        const communities = pickedCommunities(picker);
        await saveMemberChanges(
          sendMessage,
          env,
          chatId,
          session,
          { community_ids: communities.map(c => c.id) },
          communities.length > 0
            ? `Your communities are now: ${communities.map(c => c.name).join(", ")}.`
            : "You no longer belong to any community."
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
      await sendMessage(env, chatId, errorMessage("Unknown step in /me. Type /cancel to start over."));
      await removeSession();
      break;
  }
};
