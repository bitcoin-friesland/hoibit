import { handleContactFlow } from "./flows/contact";
import { handleNewOrgFlow } from "./flows/org";
import { handleConversationFlow } from "./flows/conversation";
import { handleFirstUserFlow } from "./flows/first_user";
import { handleTeamMemberFlow } from "./flows/teammember";
import type { ChatId, FlowHandler, SendMessage, Session, SessionStore, TelegramUpdate, UpdateResult } from "./types";

const FLOWS: Record<NonNullable<Session["mode"]>, FlowHandler> = {
  contact: handleContactFlow,
  org: handleNewOrgFlow,
  conversation: handleConversationFlow,
  first_user: handleFirstUserFlow,
  teammember: handleTeamMemberFlow
};

async function callTelegram(env: Env, method: string, body: object) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

const sendMessage: SendMessage = async (env, chatId, text, options = {}) => {
  const { reply_markup, ...rest } = options;
  await callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...rest,
    ...(reply_markup ? { reply_markup: JSON.stringify(reply_markup) } : {})
  });
};

const stackOf = (e: unknown) => (e instanceof Error && e.stack ? e.stack : String(e));

const reply = (body: string, status = 200): UpdateResult => ({ status, body });

// The chat a Telegram update belongs to; updates without one are ignored.
export function chatIdOf(update: TelegramUpdate): ChatId | undefined {
  return update.callback_query ? update.callback_query.message.chat.id : update.message?.chat?.id;
}

/**
 * Handles one Telegram update for one chat. store holds that chat's session;
 * the chat's Durable Object calls this for one update at a time.
 */
export async function processUpdate(env: Env, store: SessionStore, update: TelegramUpdate): Promise<UpdateResult> {
  const chatId = chatIdOf(update);
  const userId = update.callback_query
    ? update.callback_query.from.id.toString()
    : update.message?.from?.id?.toString();
  let session = chatId ? store.getSession() : undefined;

  async function persistSession() {
    if (session) store.putSession(session);
  }
  async function removeSession() {
    store.deleteSession();
  }

  // Handle button/inline callbacks
  if (update.callback_query && chatId) {
    const callback = update.callback_query;
    // Sessions are per chat; in a group only the user who started the flow may press its buttons.
    if (!(session && session.telegram_id && String(session.telegram_id) !== userId)) {
      if (session) {
        session.last_callback_data = callback.data ?? null;
        await persistSession();
      }
      const flow = session?.mode && FLOWS[session.mode];
      if (session && flow) {
        await flow(sendMessage, env, chatId, undefined, session, persistSession, removeSession);
      } else {
        await sendMessage(env, chatId, "Unknown input. Type /cancel to start over.");
        await removeSession();
      }
    }
    await callTelegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
    return reply("OK");
  }

  const message = update.message;
  const text = message?.text?.trim();

  // Only proceed if chatId, userId, and text exist to avoid repeated sends on non-user input updates
  if (!message || !chatId || !userId || !text) {
    return reply("Invalid input");
  }

  let createdBy: number | null = null;
  let isAdmin = false;
  let member;
  try {
    member = await env.crmApi.validateUser(userId);
  } catch (e) {
    await sendMessage(env, chatId, `[crmApi EXCEPTION: validateUser] ${stackOf(e)}`);
    return reply("Error", 500);
  }
  if (member) {
    createdBy = member.id;
    isAdmin = member.is_admin === 1;
  } else {
    let count: number;
    try {
      count = await env.crmApi.countTeamMembers();
    } catch (e) {
      await sendMessage(env, chatId, `[crmApi EXCEPTION: countTeamMembers] ${stackOf(e)}`);
      return reply("Error", 500);
    }
    if (count === 0) {
      if (!session || session.mode !== "first_user") {
        session = { step: "awaiting_first_name", telegram_id: userId, mode: "first_user" };
        store.putSession(session);
        await sendMessage(
          env,
          chatId,
          "Welcome! You are the first user. Please enter your name to register as the first team member:"
        );
        return reply("OK");
      }
    } else {
      // Only send unauthorized message in private chats or if message is a bot command in group chats
      const isPrivate = message.chat?.type === "private";
      const isBotCommand = text.startsWith("/");
      if ((isPrivate || isBotCommand) && !store.wasUnauthorizedNotified()) {
        store.markUnauthorizedNotified();
        await sendMessage(
          env,
          chatId,
          `You are not authorized to use this bot. Contact a team member for access. Share the team member your Telegram user ID ${userId}`
        );
      }
      return reply("Forbidden", 403);
    }
  }

  if (!member && (!session || session.mode !== "first_user")) {
    return reply("Forbidden", 403);
  }

  if (text === "/help") {
    const adminCommands = isAdmin
      ? `\n/teammember - Manage team members (invite, admin rights)\n/invite - Invite a new team member`
      : "";
    await sendMessage(
      env,
      chatId,
      `Available commands:
/newcontact - Add new contact
/neworg - Add new organization
/logconversation - Log a conversation${adminCommands}
/cancel - Cancel current input`
    );
    return reply("OK");
  }
  if (text === "/cancel") {
    await removeSession();
    await sendMessage(
      env,
      chatId,
      "Active input has been cancelled. You can start again with /newcontact, /neworg, etc."
    );
    return reply("OK");
  }
  if (text === "/newcontact") {
    session = { step: "awaiting_name", created_by: createdBy, telegram_id: userId, mode: "contact" };
    store.putSession(session);
    await sendMessage(env, chatId, "What is the contact name?");
    return reply("OK");
  }
  if (text === "/neworg") {
    session = { step: "awaiting_org_name", created_by: createdBy, telegram_id: userId, mode: "org" };
    store.putSession(session);
    await sendMessage(env, chatId, "What is the name of the organization?");
    return reply("OK");
  }
  if (text === "/logconversation") {
    session = { step: "awaiting_contact", created_by: createdBy, telegram_id: userId, mode: "conversation" };
    store.putSession(session);
    await sendMessage(env, chatId, "Which contact did you talk to? Type part of the name.");
    return reply("OK");
  }
  if ((text === "/invite" || text === "/teammember") && !isAdmin) {
    await sendMessage(env, chatId, "Only admins can manage team members.");
    return reply("OK");
  }
  if (text === "/invite") {
    // Shortcut into the invite steps of the team member flow
    session = { step: "awaiting_invite_id", created_by: createdBy, telegram_id: userId, mode: "teammember" };
    store.putSession(session);
    await sendMessage(env, chatId, "What is the Telegram user ID of the team member you want to invite?");
    return reply("OK");
  }
  if (text === "/teammember") {
    session = { step: "teammember_menu", created_by: createdBy, telegram_id: userId, mode: "teammember" };
    store.putSession(session);
    await handleTeamMemberFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
    return reply("OK");
  }
  if (!session) {
    await sendMessage(env, chatId, "Unknown input. Type /help for available commands.");
    return reply("No active session");
  }
  if (session.mode === "teammember" && !isAdmin) {
    await sendMessage(env, chatId, "Only admins can manage team members.");
    await removeSession();
    return reply("OK");
  }
  const flow = session.mode && FLOWS[session.mode];
  if (flow) {
    await flow(sendMessage, env, chatId, text, session, persistSession, removeSession);
  } else {
    await sendMessage(env, chatId, "Unknown input. Type /cancel to start over.");
    await removeSession();
  }
  return reply("OK");
}
