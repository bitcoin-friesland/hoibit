import { handleContactFlow } from "./flows/contact.js";
import { handleNewOrgFlow } from "./flows/org.js";
import { handleConversationFlow } from "./flows/conversation.js";
import { handleInviteFlow } from "./flows/invite.js";
import { handleFirstUserFlow } from "./flows/first_user.js";
import { handleTeamMemberFlow } from "./flows/teammember.js";

// Cloudflare Workers KV Session Helpers
async function getSession(env, chatId) {
  if (!chatId) return undefined;
  const raw = await env.SESSIONS.get("session:chat:" + chatId);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
async function setSession(env, chatId, session, ttl = 7200) {
  if (!chatId || !session) return;
  await env.SESSIONS.put("session:chat:" + chatId, JSON.stringify(session), { expirationTtl: ttl });
}
async function deleteSession(env, chatId) {
  if (!chatId) return;
  await env.SESSIONS.delete("session:chat:" + chatId);
}

// Telegram send message helper
async function sendMessage(env, chatId, text, options = {}) {
  const body = {
    chat_id: chatId,
    text,
    ...options
  };
  if (body.reply_markup && typeof body.reply_markup === "object") {
    body.reply_markup = JSON.stringify(body.reply_markup);
  }
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// Main fetch handler
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    const update = await request.json();
    let chatId, userId, session;

    if (update.callback_query) {
      chatId = update.callback_query.message.chat.id;
      userId = update.callback_query.from.id.toString();
    } else if (update.message) {
      chatId = update.message.chat?.id;
      userId = update.message.from?.id?.toString();
    }
    session = chatId ? await getSession(env, chatId) : undefined;

    async function persistSession() {
      if (chatId && session) {
        await setSession(env, chatId, session);
      }
    }
    async function removeSession() {
      if (chatId) await deleteSession(env, chatId);
    }

    // Handle button/inline callbacks
    if (update.callback_query) {
      const data = update.callback_query.data;
      if (session) {
        session.last_callback_data = data;
        await persistSession();
      }
      switch (session && session.mode) {
        case "contact":
          await handleContactFlow(sendMessage, env, chatId, undefined, session, persistSession, removeSession);
          break;
        case "org":
          await handleNewOrgFlow(sendMessage, env, chatId, undefined, session, persistSession, removeSession);
          break;
        case "conversation":
          await handleConversationFlow(sendMessage, env, chatId, undefined, session, persistSession, removeSession);
          break;
        case "invite":
          await handleInviteFlow(sendMessage, env, chatId, undefined, session, persistSession, removeSession);
          break;
        case "first_user":
          await handleFirstUserFlow(sendMessage, env, chatId, undefined, session, persistSession, removeSession);
          break;
        case "teammember":
          await handleTeamMemberFlow(sendMessage, env, chatId, undefined, session, persistSession, removeSession);
          break;
        default:
          await sendMessage(env, chatId, "Unknown input. Type /cancel to start over.");
          await removeSession();
          break;
      }
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: update.callback_query.id })
      });
      return new Response("OK");
    }

    const message = update.message;
    const text = message?.text?.trim();
    if (!chatId || !userId || !text) return new Response("Invalid input");

    let createdBy = null;
    let userValidated = false;
    try {
      const validationRes = await env.crmApi.fetch(new Request(
        `${env.CRM_API_URL}/validate-user`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ telegram_id: userId })
        }
      ));
      if (validationRes.ok) {
        userValidated = true;
        createdBy = (await validationRes.json()).id;
      } else {
        try {
          const countRes = await env.crmApi.fetch(new Request(`${env.CRM_API_URL}/team_members/count`));
          if (!countRes.ok) {
            const body = await countRes.text();
            await sendMessage(
              env,
              chatId,
              `[crmApi fetch error: team_members/count] Status: ${countRes.status}, body: ${body}`
            );
            return new Response("Error", { status: 500 });
          }
          const { count } = await countRes.json();
          if (count === 0) {
            if (!session || session.mode !== "first_user") {
              session = { step: "awaiting_first_name", telegram_id: userId, mode: "first_user" };
              await setSession(env, chatId, session);
              await sendMessage(env, chatId, "Welcome! You are the first user. Please enter your name to register as the first team member:");
              return new Response("OK");
            }
          } else {
            await sendMessage(env, chatId, "You are not authorized to use this bot. Contact a team member for access.");
            return new Response("Forbidden", { status: 403 });
          }
        } catch (e2) {
          await sendMessage(env, chatId, `[crmApi fetch EXCEPTION: team_members/count] ${e2 && e2.stack ? e2.stack : e2}`);
          return new Response("Error", { status: 500 });
        }
      }
    } catch (e) {
      await sendMessage(env, chatId, `[crmApi fetch EXCEPTION: validate-user] ${e && e.stack ? e.stack : e}`);
      return new Response("Error", { status: 500 });
    }

    if (!userValidated && (!session || session.mode !== "first_user")) {
      return new Response("Forbidden", { status: 403 });
    }

    if (text === "/help") {
      await sendMessage(env, chatId, `Available commands:
/newcontact - Add new contact
/neworg - Add new organization
/logconversation - Log a conversation
/invite - Invite a new team member
/cancel - Cancel current input`);
      return new Response("OK");
    }
    if (text === "/cancel") {
      await removeSession();
      await sendMessage(env, chatId, "Active input has been cancelled. You can start again with /newcontact, /neworg, etc.");
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
    if (text === "/invite") {
      session = { step: "awaiting_invite_id", created_by: createdBy, telegram_id: userId, mode: "invite" };
      await setSession(env, chatId, session);
      await handleInviteFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
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
    switch (session.mode) {
      case "contact":
        await handleContactFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
        break;
      case "org":
        await handleNewOrgFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
        break;
      case "conversation":
        await handleConversationFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
        break;
      case "invite":
        await handleInviteFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
        break;
      case "first_user":
        await handleFirstUserFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
        break;
      case "teammember":
        await handleTeamMemberFlow(sendMessage, env, chatId, text, session, persistSession, removeSession);
        break;
      default:
        await sendMessage(env, chatId, "Unknown input. Type /cancel to start over.");
        await removeSession();
        break;
    }
    return new Response("OK");
  }
};

export {
  index_default as default
};
