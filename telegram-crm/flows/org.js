export async function handleNewOrgFlow(sendMessage, env, chatId, text, session, persistSession = async () => {}, removeSession = async () => {}) {
  console.log("[ORG FLOW DEBUG] step:", session.step, "| text:", text, "| session:", JSON.stringify(session));
  // Since this is a stub, just send a message and remove session
  await persistSession();
  await sendMessage(env, chatId, "Organization flow not implemented in this build.");
  await removeSession();
}
