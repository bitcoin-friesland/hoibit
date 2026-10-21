import { handleContactFlow } from "./flows/contact";
import { handleNewOrgFlow } from "./flows/org";
import { handleConversationFlow } from "./flows/conversation";
import { handleTeamMemberFlow } from "./flows/teammember";
import { errorMessage } from "./helpers/messaging";
import { botUsername, callTelegram, sendMessage, type ApiSendOptions } from "./helpers/telegram";
import type {
  ChatId,
  FlowHandler,
  SendMessage,
  SendOptions,
  Session,
  SessionStore,
  TelegramUpdate,
  TelegramUser,
  UpdateResult
} from "./types";
import type { TeamMember } from "../../crm-api/src/types";

const FLOWS: Record<NonNullable<Session["mode"]>, FlowHandler> = {
  contact: handleContactFlow,
  org: handleNewOrgFlow,
  conversation: handleConversationFlow,
  teammember: handleTeamMemberFlow
};

const SOMETHING_WENT_WRONG = "Something went wrong. Please try again later.";
const STALE_BUTTON = "This button is no longer active.";
const EXPIRED_BUTTON = "This button has expired. Start again with /help.";
const NOT_AUTHORIZED_BUTTON = "You are not authorized to use this bot.";
const ONLY_ADMINS = "Only admins can manage team members.";
const NOT_ON_TEAM = "You're not on the team yet. To join, ask an admin for an invite link.";
const INVALID_INVITE =
  "This invite link is no longer valid: it was used already or it expired. Ask an admin for a new one.";

// mail-to-tg's SpamButtons entrypoint (mail-to-tg/src/buttons.ts). Its types are not imported:
// they would type-check mail-to-tg's code against this Worker's Env.
interface SpamButtons {
  press(data: string, chatId: number, messageId: number): Promise<string>;
}

const COMMAND = /^\/(\w+)(?:@(\w+))?(?:\s+(.*))?$/;

/**
 * Parses text starting with "/" as a command; undefined for other text. With
 * privacy mode Telegram delivers group commands as /cmd@BotName. A command
 * addressed to another bot gets forOtherBot; when getMe fails the command is
 * accepted rather than every addressed command ignored. name is "" for text that
 * starts with "/" but is no command; args is the text after the command, such as
 * the parameter of a t.me/<bot>?start=<parameter> link.
 */
async function parseCommand(env: Env, text: string) {
  if (!text.startsWith("/")) return undefined;
  const match = COMMAND.exec(text);
  if (!match) return { name: "", args: "", forOtherBot: false };
  const [, name, addressee, args = ""] = match;
  if (addressee) {
    const own = await botUsername(env);
    if (own && own.toLowerCase() !== addressee.toLowerCase()) return { name, args, forOtherBot: true };
  }
  return { name, args, forOtherBot: false };
}

// The name in a user's Telegram profile.
const profileName = (user: TelegramUser) => [user.first_name, user.last_name].filter(Boolean).join(" ").trim();

function helpText(isAdmin: boolean) {
  const adminCommands = isAdmin
    ? `\n/teammember - Manage team members (invite, edit, remove, admin rights)\n/invite - Make an invite link for a new team member`
    : "";
  return `Available commands:
/newcontact - Add new contact
/neworg - Add new organization
/logconversation - Log a conversation${adminCommands}
/cancel - Cancel current input`;
}

// Keeps the member's @username in crm-api the one Telegram reports; a failure is only logged.
async function syncUsername(env: Env, member: TeamMember, user: TelegramUser) {
  const username = user.username ?? null;
  if ((member.telegram_username ?? null) === username) return;
  await env.crmApi
    .setTelegramUsername({ telegram_id: member.telegram_id, telegram_username: username })
    .catch((e: unknown) => console.error("Updating the Telegram username failed", e));
}

/**
 * /start inv_… from someone not on the team: they opened an invite link. Adds them to the
 * team, welcomes them and tells whoever made the link.
 */
async function acceptInvite(env: Env, chatId: ChatId, user: TelegramUser, token: string) {
  const name = profileName(user) || String(user.id);
  const res = await env.crmApi.acceptInvite({
    token,
    telegram_id: String(user.id),
    name,
    telegram_username: user.username ?? null
  });
  if (!res.ok) {
    await sendMessage(env, chatId, INVALID_INVITE);
    return;
  }
  // They got access in another way since handleMessage looked them up.
  if (res.existing) {
    await sendMessage(env, chatId, `You're already on the team.\n\n${helpText(false)}`);
    return;
  }
  const lines = [`👋 Welcome to the team, ${name}!`];
  if (res.invited_by?.name) lines.push(`${res.invited_by.name} invited you.`);
  if (res.communities.length > 0) lines.push(`Your communities: ${res.communities.join(", ")}.`);
  await sendMessage(env, chatId, `${lines.join("\n")}\n\n${helpText(false)}`);
  if (res.invited_by) {
    const who = user.username ? `${name} (@${user.username})` : name;
    await sendMessage(env, res.invited_by.telegram_id, `✅ ${who} joined the team with your invite link.`);
  }
}

const reply = (body: string): UpdateResult => ({ status: 200, body });

const REPLY_HINT = "↩️ To type an answer, reply to this message.";

/**
 * Turns the question that ends a turn into one a group can answer. With privacy
 * mode on, Telegram only gives a bot the commands in a group and the replies to
 * its own messages, so a plain answer would never arrive. A question without
 * buttons asks for a reply, which Telegram opens for the user it answers
 * (replyTo, their message); buttons cannot be combined with that, so a question
 * with buttons that also takes text says how to answer instead. Private chats
 * (positive ids) need none of this.
 */
function asQuestion(
  chatId: ChatId,
  text: string,
  options: SendOptions = {},
  replyTo?: number
): [string, ApiSendOptions] {
  if (Number(chatId) > 0) return [text, options];
  if (options.reply_markup) return [options.accepts_text ? `${text}\n\n${REPLY_HINT}` : text, options];
  if (replyTo === undefined) return [text, { ...options, reply_markup: { force_reply: true } }];
  return [
    text,
    {
      ...options,
      reply_markup: { force_reply: true, selective: true },
      reply_parameters: { message_id: replyTo, allow_sending_without_reply: true }
    }
  ];
}

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
 * buttons of the latest keyboard count (see handleButton). The last message is
 * held back until the flow is done: when the session is still open it is the
 * question for the next step and goes out through asQuestion. replyTo is the
 * user's message, absent when they pressed a button.
 */
async function runFlow(
  env: Env,
  store: SessionStore,
  chatId: ChatId,
  userId: string,
  session: Session,
  text: string | undefined,
  replyTo?: number
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
  const deliver = async (chatId: ChatId, text: string, options?: ApiSendOptions) => {
    const messageId = await sendMessage(env, chatId, text, options);
    if (options?.reply_markup && "inline_keyboard" in options.reply_markup && messageId !== undefined && !removed) {
      session.keyboard_message_id = messageId;
      store.putSession(userId, session);
    }
  };
  let last: [ChatId, string, SendOptions | undefined] | undefined;
  const send: SendMessage = async (_env, chatId, text, options) => {
    if (last) await deliver(...last);
    last = [chatId, text, options];
  };
  let done = false;
  try {
    await flow(send, env, chatId, text, session, persistSession, removeSession);
    done = true;
  } finally {
    if (last) {
      const [chatId, text, options] = last;
      if (done && !removed) await deliver(chatId, ...asQuestion(chatId, text, options, replyTo));
      else await deliver(chatId, text, options);
    }
  }
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
    await syncUsername(env, member, callback.from);
    // The spam button under an email that mail-to-tg posted; it belongs to no session.
    if (callback.data?.startsWith("spam:")) {
      notice = await (env.mailToTg as unknown as SpamButtons)
        .press(callback.data, chatId, callback.message.message_id ?? 0)
        .catch(e => {
          console.error("Spam button failed", e);
          return SOMETHING_WENT_WRONG;
        });
      return reply("OK");
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

  const session = store.getSession(userId);
  const member = await env.crmApi.validateUser(userId);
  // An invite link opened: t.me/<bot>?start=inv_… arrives as /start inv_…
  if (command?.name === "start" && command.args.startsWith("inv_")) {
    if (member) await sendMessage(env, chatId, `You're already on the team.\n\n${helpText(member.is_admin === 1)}`);
    else await acceptInvite(env, chatId, message.from!, command.args);
    return reply("OK");
  }
  if (!member) {
    const count = await env.crmApi.countTeamMembers();
    if (count > 0) {
      // In groups only answer commands, not every message of a non-member.
      if ((isPrivate || command) && !store.wasUnauthorizedNotified(userId)) {
        store.markUnauthorizedNotified(userId);
        await sendMessage(env, chatId, NOT_ON_TEAM);
      }
      return reply("Forbidden");
    }
    // No team yet: whoever talks to the bot first becomes its first admin, under their Telegram name.
    const name = profileName(message.from!) || userId;
    const res = await env.crmApi.firstUser({ telegram_id: userId, name });
    await sendMessage(
      env,
      chatId,
      res.ok
        ? `👋 Welcome! You are the first team member, so you are an admin, registered as "${name}".\n\n${helpText(true)}`
        : errorMessage("Registering you as the first team member failed. Please try again.")
    );
    return reply("OK");
  }
  await syncUsername(env, member, message.from!);
  const createdBy = member.id;
  const isAdmin = member.is_admin === 1;

  // Starts a new flow for this user, replacing any flow they had.
  async function startFlow(newSession: Session, prompt: string) {
    store.putSession(userId!, newSession);
    await sendMessage(env, chatId!, ...asQuestion(chatId!, prompt, {}, message!.message_id));
    return reply("OK");
  }

  if (command) {
    const owner = { created_by: createdBy, telegram_id: userId };
    // The "Open private chat" button of /invite in a group opens t.me/<bot>?start=invite.
    const name = command.name === "start" && command.args === "invite" ? "invite" : command.name;
    switch (name) {
      case "start":
      case "help": {
        await sendMessage(env, chatId, helpText(isAdmin));
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
      case "teammember": {
        if (!isAdmin) {
          await sendMessage(env, chatId, ONLY_ADMINS);
          return reply("OK");
        }
        // /invite is a shortcut into the invite steps of the team member flow.
        const flow: Session = {
          step: name === "invite" ? "invite_start" : "teammember_menu",
          mode: "teammember",
          ...owner
        };
        store.putSession(userId, flow);
        await runFlow(env, store, chatId, userId, flow, undefined, message.message_id);
        return reply("OK");
      }
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
  await runFlow(env, store, chatId, userId, session, text, message.message_id);
  return reply("OK");
}
