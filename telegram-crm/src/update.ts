import { handleContactFlow } from "./flows/contact";
import { handleNewOrgFlow } from "./flows/org";
import { handleConversationFlow } from "./flows/conversation";
import { handleFirstUserFlow } from "./flows/first_user";
import { handleTeamMemberFlow } from "./flows/teammember";
import type {
  ChatId,
  FlowHandler,
  SendMessage,
  SendOptions,
  Session,
  SessionStore,
  TelegramUpdate,
  UpdateResult
} from "./types";

const FLOWS: Record<NonNullable<Session["mode"]>, FlowHandler> = {
  contact: handleContactFlow,
  org: handleNewOrgFlow,
  conversation: handleConversationFlow,
  first_user: handleFirstUserFlow,
  teammember: handleTeamMemberFlow
};

const SOMETHING_WENT_WRONG = "Something went wrong. Please try again later.";
const STALE_BUTTON = "This button is no longer active.";
const EXPIRED_BUTTON = "This button has expired. Start again with /help.";
const NOT_AUTHORIZED_BUTTON = "You are not authorized to use this bot.";
const ONLY_ADMINS = "Only admins can manage team members.";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

/**
 * Calls the Bot API. Returns the result, or undefined when Telegram refused the
 * call or could not be reached; both are logged. The request URL contains the
 * bot token, so it is never logged.
 */
async function callTelegram<T>(env: Env, method: string, body: object): Promise<T | undefined> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const token = env.TELEGRAM_TOKEN;
    console.error("Telegram API call failed", { method, error: token ? error.replaceAll(token, "<token>") : error });
    return undefined;
  }
  const data = await res.json<TelegramResponse<T>>().catch(() => undefined);
  if (!data?.ok) {
    console.error("Telegram API call failed", {
      method,
      status: res.status,
      error_code: data?.error_code,
      description: data?.description
    });
    return undefined;
  }
  return data.result;
}

// Sends a message; returns its message_id, or undefined when Telegram did not send it.
async function sendMessage(env: Env, chatId: ChatId, text: string, options: SendOptions = {}) {
  const { reply_markup, ...rest } = options;
  const message = await callTelegram<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...rest,
    ...(reply_markup ? { reply_markup: JSON.stringify(reply_markup) } : {})
  });
  return message?.message_id;
}

// The bot's own username, asked once per isolate; undefined while getMe fails.
let ownUsername: string | undefined;

async function botUsername(env: Env) {
  ownUsername ??= (await callTelegram<{ username?: string }>(env, "getMe", {}))?.username;
  return ownUsername;
}

const COMMAND = /^\/(\w+)(?:@(\w+))?(?:\s+(.*))?$/;

/**
 * Parses text starting with "/" as a command; undefined for other text. With
 * privacy mode Telegram delivers group commands as /cmd@BotName. A command
 * addressed to another bot gets forOtherBot; when getMe fails the command is
 * accepted rather than every addressed command ignored. name is "" for text that
 * starts with "/" but is no command.
 */
async function parseCommand(env: Env, text: string) {
  if (!text.startsWith("/")) return undefined;
  const match = COMMAND.exec(text);
  if (!match) return { name: "", forOtherBot: false };
  const [, name, addressee] = match;
  if (addressee) {
    const own = await botUsername(env);
    if (own && own.toLowerCase() !== addressee.toLowerCase()) return { name, forOtherBot: true };
  }
  return { name, forOtherBot: false };
}

const reply = (body: string): UpdateResult => ({ status: 200, body });

// The chat a Telegram update belongs to; updates without one are ignored.
export function chatIdOf(update: TelegramUpdate): ChatId | undefined {
  return update.callback_query ? update.callback_query.message?.chat?.id : update.message?.chat?.id;
}

/**
 * Handles one Telegram update for one chat. store holds that chat's sessions,
 * one per user; the chat's Durable Object calls this for one update at a time.
 * Always answers 200: any other status makes Telegram redeliver the update.
 * Errors are logged; the chat only gets a short notice, never details.
 */
export async function processUpdate(env: Env, store: SessionStore, update: TelegramUpdate): Promise<UpdateResult> {
  const chatId = chatIdOf(update);
  try {
    // Telegram redelivers an update when it gets no answer in time; handle each once.
    if (update.update_id !== undefined && !store.markUpdateSeen(update.update_id)) return reply("Duplicate");
    if (update.callback_query) return await handleButton(env, store, update.callback_query);
    return await handleMessage(env, store, update.message);
  } catch (e) {
    console.error("Handling Telegram update failed", { update_id: update.update_id, chat_id: chatId }, e);
    if (chatId) await sendMessage(env, chatId, SOMETHING_WENT_WRONG);
    return reply("Error");
  }
}

/**
 * Runs the step of session's flow for userId. The flow gets a sendMessage that
 * records the message_id of every message with buttons in the session, so only
 * buttons of the latest keyboard count (see handleButton).
 */
async function runFlow(
  env: Env,
  store: SessionStore,
  chatId: ChatId,
  userId: string,
  session: Session,
  text: string | undefined
) {
  const flow = session.mode && FLOWS[session.mode];
  if (!flow) {
    await sendMessage(env, chatId, "Unknown input. Type /cancel to start over.");
    store.deleteSession(userId);
    return;
  }
  let removed = false;
  const persistSession = async () => {
    removed = false;
    store.putSession(userId, session);
  };
  const removeSession = async () => {
    removed = true;
    store.deleteSession(userId);
  };
  const send: SendMessage = async (env, chatId, text, options) => {
    const messageId = await sendMessage(env, chatId, text, options);
    if (options?.reply_markup && messageId !== undefined && !removed) {
      session.keyboard_message_id = messageId;
      store.putSession(userId, session);
    }
  };
  await flow(send, env, chatId, text, session, persistSession, removeSession);
}

async function handleButton(
  env: Env,
  store: SessionStore,
  callback: NonNullable<TelegramUpdate["callback_query"]>
): Promise<UpdateResult> {
  // Shown to the user as a short notice on the button instead of a chat message.
  let notice: string | undefined;
  try {
    const chatId = callback.message?.chat?.id;
    if (!chatId) return reply("Invalid input");
    // Buttons belong to the session of whoever presses them.
    const userId = String(callback.from.id);
    const member = await env.crmApi.validateUser(userId);
    if (!member) {
      notice = NOT_AUTHORIZED_BUTTON;
      store.deleteSession(userId);
      return reply("Forbidden");
    }
    const session = store.getSession(userId);
    if (!session) {
      notice = EXPIRED_BUTTON;
      return reply("No active session");
    }
    // An older keyboard, or the same button tapped twice after the flow moved on.
    if (callback.message.message_id === undefined || callback.message.message_id !== session.keyboard_message_id) {
      notice = STALE_BUTTON;
      return reply("Stale button");
    }
    if (session.mode === "teammember" && member.is_admin !== 1) {
      notice = ONLY_ADMINS;
      store.deleteSession(userId);
      return reply("Forbidden");
    }
    session.last_callback_data = callback.data ?? null;
    store.putSession(userId, session);
    await runFlow(env, store, chatId, userId, session, undefined);
    return reply("OK");
  } finally {
    // Telegram shows a spinner on the button until this is called.
    await callTelegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      ...(notice ? { text: notice } : {})
    });
  }
}

async function handleMessage(env: Env, store: SessionStore, message: TelegramUpdate["message"]): Promise<UpdateResult> {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id?.toString();
  const text = message?.text?.trim();
  // Only proceed if chatId, userId, and text exist to avoid repeated sends on non-user input updates
  if (!message || !chatId || !userId || !text) {
    return reply("Invalid input");
  }
  const isPrivate = message.chat?.type === "private";

  const command = await parseCommand(env, text);
  if (command?.forOtherBot) return reply("Command for another bot");

  let session = store.getSession(userId);
  const member = await env.crmApi.validateUser(userId);
  if (!member) {
    const count = await env.crmApi.countTeamMembers();
    if (count > 0) {
      // In groups only answer commands, not every message of a non-member.
      if ((isPrivate || command) && !store.wasUnauthorizedNotified()) {
        store.markUnauthorizedNotified();
        await sendMessage(
          env,
          chatId,
          `You are not authorized to use this bot. Contact a team member for access. Share the team member your Telegram user ID ${userId}`
        );
      }
      return reply("Forbidden");
    }
    if (session?.mode !== "first_user") {
      session = { step: "awaiting_first_name", telegram_id: userId, mode: "first_user" };
      store.putSession(userId, session);
      await sendMessage(
        env,
        chatId,
        "Welcome! You are the first user. Please enter your name to register as the first team member:"
      );
      return reply("OK");
    }
  }
  const createdBy = member ? member.id : null;
  const isAdmin = member?.is_admin === 1;

  // Starts a new flow for this user, replacing any flow they had.
  async function startFlow(newSession: Session, prompt: string) {
    store.putSession(userId!, newSession);
    await sendMessage(env, chatId!, prompt);
    return reply("OK");
  }

  if (command) {
    const owner = { created_by: createdBy, telegram_id: userId };
    switch (command.name) {
      case "start":
      case "help": {
        const adminCommands = isAdmin
          ? `\n/teammember - Manage team members (invite, edit, remove, admin rights)\n/invite - Invite a new team member`
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
      case "cancel":
        store.deleteSession(userId);
        await sendMessage(
          env,
          chatId,
          "Active input has been cancelled. You can start again with /newcontact, /neworg, etc."
        );
        return reply("OK");
      case "newcontact":
        return startFlow({ step: "awaiting_name", mode: "contact", ...owner }, "What is the contact name?");
      case "neworg":
        return startFlow({ step: "awaiting_org_name", mode: "org", ...owner }, "What is the name of the organization?");
      case "logconversation":
        return startFlow(
          { step: "awaiting_contact", mode: "conversation", ...owner },
          "Which contact did you talk to? Type part of the name."
        );
      case "invite":
      case "teammember":
        if (!isAdmin) {
          await sendMessage(env, chatId, ONLY_ADMINS);
          return reply("OK");
        }
        if (command.name === "invite") {
          // Shortcut into the invite steps of the team member flow
          return startFlow(
            { step: "awaiting_invite_id", mode: "teammember", ...owner },
            "What is the Telegram user ID of the team member you want to invite?"
          );
        }
        session = { step: "teammember_menu", mode: "teammember", ...owner };
        store.putSession(userId, session);
        await runFlow(env, store, chatId, userId, session, text);
        return reply("OK");
      default:
        // Never hand a command to a flow as input, e.g. as the note of a conversation.
        await sendMessage(env, chatId, "Unknown command. Type /help for available commands.");
        return reply("Unknown command");
    }
  }

  if (!session) {
    // In a group, ordinary chat between members is not meant for the bot.
    if (isPrivate) await sendMessage(env, chatId, "Unknown input. Type /help for available commands.");
    return reply("No active session");
  }
  if (session.mode === "teammember" && !isAdmin) {
    await sendMessage(env, chatId, ONLY_ADMINS);
    store.deleteSession(userId);
    return reply("OK");
  }
  // Text answers the current step; a button pressed earlier must not count for it.
  session.last_callback_data = null;
  await runFlow(env, store, chatId, userId, session, text);
  return reply("OK");
}
