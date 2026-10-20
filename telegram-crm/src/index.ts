import { handleContactFlow } from "./flows/contact";
import { handleNewOrgFlow } from "./flows/org";
import { handleConversationFlow } from "./flows/conversation";
import { handleFirstUserFlow } from "./flows/first_user";
import { handleTeamMemberFlow } from "./flows/teammember";
import type { ChatId, FlowHandler, SendMessage, Session } from "./types";

// The parts of a Telegram Update this bot reads.
interface TelegramUpdate {
  message?: {
    chat?: { id: number; type: string };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message: { chat: { id: number } };
  };
}

const FLOWS: Record<NonNullable<Session["mode"]>, FlowHandler> = {
  contact: handleContactFlow,
  org: handleNewOrgFlow,
  conversation: handleConversationFlow,
  first_user: handleFirstUserFlow,
  teammember: handleTeamMemberFlow
};

// Cloudflare Workers KV Session Helpers
async function getSession(env: Env, chatId: ChatId): Promise<Session | undefined> {
  const raw = await env.SESSIONS.get("session:chat:" + chatId);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
async function setSession(env: Env, chatId: ChatId, session: Session, ttl = 7200) {
  await env.SESSIONS.put("session:chat:" + chatId, JSON.stringify(session), { expirationTtl: ttl });
}
async function deleteSession(env: Env, chatId: ChatId) {
  await env.SESSIONS.delete("session:chat:" + chatId);
}

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

// Verify the request comes from Telegram: setWebhook was called with
// secret_token = TELEGRAM_WEBHOOK_SECRET, Telegram echoes it in this header.
// Fails closed when the secret is not configured.
function isFromTelegram(request: Request, env: Env) {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!expected || !received) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(received);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

const stackOf = (e: unknown) => (e instanceof Error && e.stack ? e.stack : String(e));

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    if (!isFromTelegram(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const update = await request.json<TelegramUpdate>();

    let chatId: ChatId | undefined;
    let userId: string | undefined;
    if (update.callback_query) {
      chatId = update.callback_query.message.chat.id;
      userId = update.callback_query.from.id.toString();
    } else if (update.message) {
      chatId = update.message.chat?.id;
      userId = update.message.from?.id?.toString();
    }
    let session = chatId ? await getSession(env, chatId) : undefined;

    async function persistSession() {
      if (chatId && session) await setSession(env, chatId, session);
    }
    async function removeSession() {
      if (chatId) await deleteSession(env, chatId);
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
      return new Response("OK");
    }

    const message = update.message;
    const text = message?.text?.trim();

    // Only proceed if chatId, userId, and text exist to avoid repeated sends on non-user input updates
    if (!message || !chatId || !userId || !text) {
      return new Response("Invalid input");
    }

    let createdBy: number | null = null;
    let isAdmin = false;
    let member;
    try {
      member = await env.crmApi.validateUser(userId);
    } catch (e) {
      await sendMessage(env, chatId, `[crmApi EXCEPTION: validateUser] ${stackOf(e)}`);
      return new Response("Error", { status: 500 });
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
        return new Response("Error", { status: 500 });
      }
      if (count === 0) {
        if (!session || session.mode !== "first_user") {
          session = { step: "awaiting_first_name", telegram_id: userId, mode: "first_user" };
          await setSession(env, chatId, session);
          await sendMessage(
            env,
            chatId,
            "Welcome! You are the first user. Please enter your name to register as the first team member:"
          );
          return new Response("OK");
        }
      } else {
        // Only send unauthorized message in private chats or if message is a bot command in group chats
        const isPrivate = message.chat?.type === "private";
        const isBotCommand = text.startsWith("/");
        if (isPrivate || isBotCommand) {
          const unauthorizedSentKey = `unauthorized_sent:${userId}`;
          const unauthorizedSent = await env.SESSIONS.get(unauthorizedSentKey);
          if (!unauthorizedSent) {
            session = session ?? {};
            session.unauthorizedMessageSent = true;
            await setSession(env, chatId, session);
            await env.SESSIONS.put(unauthorizedSentKey, "true", { expirationTtl: 86400 }); // 24 hours TTL
            await sendMessage(
              env,
              chatId,
              `You are not authorized to use this bot. Contact a team member for access. Share the team member your Telegram user ID ${userId}`
            );
          }
        }
        return new Response("Forbidden", { status: 403 });
      }
    }

    if (!member && (!session || session.mode !== "first_user")) {
      return new Response("Forbidden", { status: 403 });
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
      return new Response("OK");
    }
    if (text === "/cancel") {
      await removeSession();
      await sendMessage(
        env,
        chatId,
        "Active input has been cancelled. You can start again with /newcontact, /neworg, etc."
      );
      return new Response("OK");
    }
    if (text === "/newcontact") {
      session = { step: "awaiting_name", created_by: createdBy, telegram_id: userId, mode: "contact" };
      await setSession(env, chatId, session);
      await sendMessage(env, chatId, "What is the contact name?");
      return new Response("OK");
    }
    if (text === "/neworg") {
      session = { step: "awaiting_org_name", created_by: createdBy, telegram_id: userId, mode: "org" };
      await setSession(env, chatId, session);
      await sendMessage(env, chatId, "What is the name of the organization?");
      return new Response("OK");
    }
    if (text === "/logconversation") {
      session = { step: "awaiting_contact_name", created_by: createdBy, telegram_id: userId, mode: "conversation" };
      await setSession(env, chatId, session);
      await handleConversationFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
      return new Response("OK");
    }
    if ((text === "/invite" || text === "/teammember") && !isAdmin) {
      await sendMessage(env, chatId, "Only admins can manage team members.");
      return new Response("OK");
    }
    if (text === "/invite") {
      // Shortcut into the invite steps of the team member flow
      session = { step: "awaiting_invite_id", created_by: createdBy, telegram_id: userId, mode: "teammember" };
      await setSession(env, chatId, session);
      await sendMessage(env, chatId, "What is the Telegram user ID of the team member you want to invite?");
      return new Response("OK");
    }
    if (text === "/teammember") {
      session = { step: "teammember_menu", created_by: createdBy, telegram_id: userId, mode: "teammember" };
      await setSession(env, chatId, session);
      await handleTeamMemberFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
      return new Response("OK");
    }
    if (!session) {
      await sendMessage(env, chatId, "Unknown input. Type /help for available commands.");
      return new Response("No active session");
    }
    if (session.mode === "teammember" && !isAdmin) {
      await sendMessage(env, chatId, "Only admins can manage team members.");
      await removeSession();
      return new Response("OK");
    }
    const flow = session.mode && FLOWS[session.mode];
    if (flow) {
      await flow(sendMessage, env, chatId, text, session, persistSession, removeSession);
    } else {
      await sendMessage(env, chatId, "Unknown input. Type /cancel to start over.");
      await removeSession();
    }
    return new Response("OK");
  }
} satisfies ExportedHandler<Env>;
