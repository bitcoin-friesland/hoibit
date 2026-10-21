import { isValidOrganizationName } from "../helpers/validation";
import { errorMessage } from "../helpers/messaging";
import {
  ORG_MAX_RESULTS,
  INVALID_ORGANIZATION_NAME,
  handleOrganizationStep,
  startOrganizationSteps
} from "./organization";
import type { ChatId, FlowHandler, SendMessage, Session } from "../types";

const NAME_PROMPT = "What is the name of the organization?";

// awaiting_org_name: the name of the new organization. When organizations with a similar name
// exist, the user sees them and chooses to create it anyway or to search again.
async function handleName(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  text: string | undefined,
  session: Session,
  persistSession: () => Promise<void>
) {
  const cb = session.last_callback_data;
  session.last_callback_data = null;
  if (cb === "search_org_again") {
    await persistSession();
    await sendMessage(env, chatId, NAME_PROMPT);
    return;
  }
  if (cb === "create_org") {
    if (!session.pending_org) {
      await sendMessage(env, chatId, errorMessage("Please type the name of the organization."));
      return;
    }
    await startOrganizationSteps(sendMessage, env, chatId, session, persistSession, session.pending_org);
    return;
  }
  const name = text && text.trim();
  if (!isValidOrganizationName(name)) {
    await sendMessage(env, chatId, errorMessage(INVALID_ORGANIZATION_NAME));
    return;
  }
  let found;
  try {
    found = await env.crmApi.searchOrganizations({ name });
  } catch (e) {
    console.error("Searching organizations failed", e);
    await sendMessage(env, chatId, errorMessage("Searching organizations failed. Please type the name again."));
    return;
  }
  if (found.length === 0) {
    await startOrganizationSteps(sendMessage, env, chatId, session, persistSession, name);
    return;
  }
  session.pending_org = name;
  await persistSession();
  const shown = found.slice(0, ORG_MAX_RESULTS);
  const list = shown.map(o => `• ${o.name}`).join("\n");
  const more = found.length > shown.length ? `\n…and ${found.length - shown.length} more.` : "";
  const intro =
    found.length === 1
      ? "⚠️ An organization with a similar name already exists:"
      : "⚠️ Organizations with a similar name already exist:";
  await sendMessage(env, chatId, `${intro}\n${list}${more}\n\nCreate "${name}" anyway, or search again?`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: `Create new "${name}"`, callback_data: "create_org" }],
        [{ text: "Search again", callback_data: "search_org_again" }]
      ]
    }
  });
}

// /neworg: the name, then the organization steps shared with /newcontact.
export const handleNewOrgFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  if (session.step === "awaiting_org_name") {
    await handleName(sendMessage, env, chatId, text, session, persistSession);
    return;
  }
  if (await handleOrganizationStep(sendMessage, env, chatId, text, session, persistSession, removeSession)) return;
  await sendMessage(env, chatId, errorMessage("Unknown step in organization flow. Type /cancel to start over."));
  await removeSession();
};
