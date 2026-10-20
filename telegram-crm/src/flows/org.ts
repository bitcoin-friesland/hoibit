import type { FlowHandler } from "../types";

// /neworg is not implemented; organizations are created from /newcontact.
export const handleNewOrgFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  _text,
  _session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  await persistSession();
  await sendMessage(env, chatId, "Organization flow not implemented in this build.");
  await removeSession();
};
