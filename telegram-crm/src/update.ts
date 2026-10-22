import { handleContactFlow } from "./flows/contact";
import { handleNewOrgFlow } from "./flows/org";
import { handleConversationFlow } from "./flows/conversation";
import { handleTeamMemberFlow } from "./flows/teammember";
import { handleMeFlow } from "./flows/me";
import { handleFindFlow } from "./flows/find";
import { handleEditFlow } from "./flows/edit";
import { ensureCommandMenus, helpText, menuKeyboard } from "./helpers/menu";
import { blockedList, parseUnblockData, type BlockedSender } from "./helpers/blocked";
import { errorMessage, isErrorMessage } from "./helpers/messaging";
import { historyPage, parseHistoryData } from "./helpers/history";
import { parseRecordData, recordCard } from "./helpers/record";
import { parseStatusData, setStatus, statusQuestion } from "./flows/status";
import {
  chosenDay,
  followUpList,
  followUpQuestion,
  handleFollowUpFlow,
  parseFollowUpData,
  setFollowUp
} from "./flows/followup";
import {
  botUsername,
  callTelegram,
  clearKeyboard,
  editMessage,
  markAnswered,
  pressedLabel,
  sendMessage,
  type ApiSendOptions,
  type PressedMessage
} from "./helpers/telegram";
import type {
  ChatId,
  FlowHandler,
  InlineKeyboardButton,
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
  teammember: handleTeamMemberFlow,
  find: handleFindFlow,
  edit: handleEditFlow,
  me: handleMeFlow,
  followup: handleFollowUpFlow
};

const SOMETHING_WENT_WRONG = "Something went wrong. Please try again later.";
const STALE_BUTTON = "This button is no longer active.";
const EXPIRED_BUTTON = "This button has expired. Start again with /help.";
const NOT_AUTHORIZED_BUTTON = "You are not authorized to use this bot.";
const ONLY_ADMINS = "Only admins can manage team members.";
const ONLY_ADMINS_BLOCKED = "Only admins can see and unblock blocked email senders.";
const NOT_ON_TEAM = "You're not on the team yet. To join, ask an admin for an invite link.";
const INVALID_INVITE =
  "This invite link is no longer valid: it was used already or it expired. Ask an admin for a new one.";

// A short notice Telegram shows on a pressed button; with alert, in a box the user closes.
interface Notice {
  text: string;
  alert?: boolean;
}

// mail-to-tg's SpamButtons entrypoint (mail-to-tg/src/buttons.ts). Its types are not imported:
// they would type-check mail-to-tg's code against this Worker's Env. press answers with the
// notice text, or with a Notice for one the user must not miss; sender gives the sender of a
// recent email, for its ➕ Contact button; blocked and unblock list and unblock the senders that
// the spam button blocked (for admins only).
interface SpamButtons {
  press(data: string, chatId: number, messageId: number): Promise<string | Notice>;
  sender(email: number): Promise<{ address: string; name: string } | undefined>;
  blocked(): Promise<BlockedSender[]>;
  unblock(id: number): Promise<string | undefined>;
}

const mailButtons = (env: Env) => env.mailToTg as unknown as SpamButtons;

// The command that starts each flow, to name a flow that was stopped.
const FLOW_COMMANDS: Record<NonNullable<Session["mode"]>, string> = {
  contact: "/newcontact",
  org: "/neworg",
  conversation: "/logconversation",
  teammember: "/teammember",
  find: "/find",
  edit: "edit",
  me: "/me",
  followup: "follow-up"
};

const CANCEL_BUTTON = { text: "✖️ Cancel", callback_data: "cancel" };

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

// Keeps the member's @username in crm-api the one Telegram reports; a failure is only logged.
async function syncUsername(env: Env, member: TeamMember, user: TelegramUser) {
  const username = user.username ?? null;
  if ((member.telegram_username ?? null) === username) return;
  await env.crmApi
    .setTelegramUsername({ telegram_id: member.telegram_id, telegram_username: username })
    .catch((e: unknown) => console.error("Updating the Telegram username failed", e));
}

// The main menu below intro: buttons for the usual flows, and the command list.
async function sendMenu(env: Env, chatId: ChatId, isAdmin: boolean, intro: string) {
  await sendMessage(env, chatId, `${intro}\n\n${helpText(isAdmin)}`, { reply_markup: menuKeyboard(isAdmin) });
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
    await sendMenu(env, chatId, false, "You're already on the team.");
    return;
  }
  // An invite for a placeholder keeps the name the team already knew them by.
  const lines = [`👋 Welcome to the team, ${res.name ?? name}!`];
  if (res.invited_by?.name) lines.push(`${res.invited_by.name} invited you.`);
  if (res.communities.length > 0) lines.push(`Your communities: ${res.communities.join(", ")}.`);
  await sendMenu(env, chatId, false, lines.join("\n"));
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

/**
 * /start mc_<email>: the ➕ Contact button under an email (mail-to-tg) opened the private chat.
 * Starts /newcontact with the sender's address and name; without a sender, a plain /newcontact.
 */
async function startContactFromEmail(env: Env, store: SessionStore, actor: Actor, email: number) {
  const sender = await mailButtons(env)
    .sender(email)
    .catch((e: unknown) => {
      console.error("Looking up the sender of an email failed", e);
      return undefined;
    });
  if (!sender) {
    await sendMessage(env, actor.chatId, "ℹ️ The sender of that email is no longer known.");
    await startCommandFlow(env, store, actor, "newcontact");
    return;
  }
  await startFlow(env, store, actor, {
    step: "from_email",
    mode: "contact",
    email: sender.address,
    pending_contact_name: sender.name,
    created_by: actor.member.id,
    telegram_id: actor.userId
  });
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

// Adds a Cancel button to a flow's keyboard, unless it has one or only has link buttons.
function withCancel(keyboard: { inline_keyboard: InlineKeyboardButton[][] }) {
  const buttons = keyboard.inline_keyboard.flat();
  if (!buttons.some(b => "callback_data" in b) || buttons.some(b => /cancel/i.test(b.text))) return keyboard;
  return { inline_keyboard: [...keyboard.inline_keyboard, [CANCEL_BUTTON]] };
}

// The pressed message with the text of the pressed button.
type Press = PressedMessage & { label?: string };

/**
 * Runs the step of session's flow for userId. The flow gets a sendMessage that
 * records the message_id of every message with buttons in the session, so only
 * buttons of the latest keyboard count (see handleButton), and adds a Cancel
 * button to them. The last message is held back until the flow is done: when the
 * session is still open it is the question for the next step and goes out
 * through asQuestion. replyTo is the user's message, absent when they pressed a
 * button; pressed is then the message with the button.
 *
 * When the flow answers with more than an error, the question the input answered
 * is over: a pressed message shows the answer below its text and loses its buttons,
 * and the buttons of a question answered by text go. Old questions in the chat so
 * show what was chosen and offer nothing that no longer works.
 */
async function runFlow(
  env: Env,
  store: SessionStore,
  chatId: ChatId,
  userId: string,
  session: Session,
  text: string | undefined,
  replyTo?: number,
  pressed?: Press
) {
  const flow = session.mode && FLOWS[session.mode];
  if (!flow) {
    await sendMessage(env, chatId, "Unknown input. Type /cancel to start over.");
    store.deleteSession(userId);
    return;
  }
  const keyboardBefore = session.keyboard_message_id;
  let removed = false;
  let answered = false;
  // Whether a message replaced the pressed one (SendOptions.replace); it then needs no marking.
  let replaced = false;
  const persistSession = async () => {
    removed = false;
    store.putSession(userId, session);
  };
  const removeSession = async () => {
    removed = true;
    store.deleteSession(userId);
  };
  const deliver = async (chatId: ChatId, text: string, options: ApiSendOptions = {}) => {
    let keyboard = options.reply_markup && "inline_keyboard" in options.reply_markup ? options.reply_markup : undefined;
    if (keyboard && !removed) {
      keyboard = withCancel(keyboard);
      options = { ...options, reply_markup: keyboard };
    }
    let messageId: number | undefined;
    if (keyboard && options.replace && pressed && !replaced) {
      if (await editMessage(env, chatId, pressed.messageId, text, { ...options, reply_markup: keyboard })) {
        messageId = pressed.messageId;
        replaced = true;
      }
    }
    messageId ??= await sendMessage(env, chatId, text, options);
    if (keyboard && messageId !== undefined && !removed) {
      const previous = session.keyboard_message_id;
      // An earlier question of this flow is over; a pressed one is marked answered at the end.
      if (previous !== undefined && previous !== messageId && previous !== pressed?.messageId) {
        await clearKeyboard(env, chatId, previous);
      }
      session.keyboard_message_id = messageId;
      store.putSession(userId, session);
    }
  };
  let last: [ChatId, string, SendOptions | undefined] | undefined;
  const send: SendMessage = async (_env, chatId, text, options) => {
    if (!isErrorMessage(text)) answered = true;
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
  const answer = session.pressed_answer ?? pressed?.label;
  if (session.pressed_answer !== undefined) {
    delete session.pressed_answer;
    if (!removed) store.putSession(userId, session);
  }
  if ((answered || removed) && keyboardBefore !== undefined && !replaced) {
    if (pressed) await markAnswered(env, chatId, pressed, answer);
    else if (removed || session.keyboard_message_id === keyboardBefore)
      await clearKeyboard(env, chatId, keyboardBefore);
    // Its buttons are gone; nothing to clear again later.
    if (!removed && session.keyboard_message_id === keyboardBefore) {
      delete session.keyboard_message_id;
      store.putSession(userId, session);
    }
  }
}

// Who does something where: a team member in a chat, and their message (absent for a button).
interface Actor {
  chatId: ChatId;
  userId: string;
  member: TeamMember;
  replyTo?: number;
}

/**
 * Ends the user's flow, if they have one, and takes the buttons off its last question.
 * Returns the command of the flow that was stopped.
 */
async function stopFlow(env: Env, store: SessionStore, chatId: ChatId, userId: string) {
  const session = store.getSession(userId);
  if (!session) return undefined;
  store.deleteSession(userId);
  if (session.keyboard_message_id !== undefined) await clearKeyboard(env, chatId, session.keyboard_message_id);
  return session.mode ? FLOW_COMMANDS[session.mode] : undefined;
}

/**
 * Starts session as the actor's flow, replacing any flow they had; they are told when one
 * stopped. With prompt, that is the first question; otherwise the flow's first step asks it.
 */
async function startFlow(env: Env, store: SessionStore, actor: Actor, session: Session, prompt?: string) {
  const { chatId, userId, replyTo } = actor;
  const stopped = await stopFlow(env, store, chatId, userId);
  const notice = stopped ? `ℹ️ Your unfinished ${stopped} was stopped.` : undefined;
  store.putSession(userId, session);
  if (prompt) {
    await sendMessage(env, chatId, ...asQuestion(chatId, notice ? `${notice}\n\n${prompt}` : prompt, {}, replyTo));
    return;
  }
  if (notice) await sendMessage(env, chatId, notice);
  await runFlow(env, store, chatId, userId, session, undefined, replyTo);
}

/**
 * Starts the flow of a command, typed or from a main menu button (menu:<command>). args is the
 * text typed after the command. Returns false for a command that starts no flow.
 */
async function startCommandFlow(env: Env, store: SessionStore, actor: Actor, command: string, args = "") {
  const owner = { created_by: actor.member.id, telegram_id: actor.userId };
  switch (command) {
    case "newcontact":
      await startFlow(
        env,
        store,
        actor,
        { step: "awaiting_name", mode: "contact", ...owner },
        "What is the contact name?"
      );
      return true;
    case "neworg":
      await startFlow(
        env,
        store,
        actor,
        { step: "awaiting_org_name", mode: "org", ...owner },
        "What is the name of the organization?"
      );
      return true;
    case "logconversation":
      // The first step offers the member's recent contacts as buttons.
      await startFlow(env, store, actor, { step: "conversation_start", mode: "conversation", ...owner });
      return true;
    case "find":
      // The first step searches for the name typed after /find, or asks for one.
      await startFlow(env, store, actor, { step: "find_start", mode: "find", query: args, ...owner });
      return true;
    case "me":
      await startFlow(env, store, actor, { step: "me_start", mode: "me", ...owner });
      return true;
    case "followups": {
      let list;
      try {
        list = await followUpList(env, actor.member.id);
      } catch (e) {
        console.error("Loading the follow-ups failed", e);
        await sendMessage(env, actor.chatId, errorMessage("Loading the follow-ups failed. Please try again."));
        return true;
      }
      await sendMessage(env, actor.chatId, list.text, list.options);
      return true;
    }
    case "blocked": {
      if (actor.member.is_admin !== 1) {
        await sendMessage(env, actor.chatId, ONLY_ADMINS_BLOCKED);
        return true;
      }
      let senders;
      try {
        senders = await mailButtons(env).blocked();
      } catch (e) {
        console.error("Loading the blocked senders failed", e);
        await sendMessage(env, actor.chatId, errorMessage("Loading the blocked senders failed. Please try again."));
        return true;
      }
      const list = blockedList(senders);
      await sendMessage(env, actor.chatId, list.text, senders.length > 0 ? list.options : {});
      return true;
    }
    case "invite":
    case "teammember":
      if (actor.member.is_admin !== 1) {
        await sendMessage(env, actor.chatId, ONLY_ADMINS);
        return true;
      }
      // /invite is a shortcut into the invite steps of the team member flow.
      await startFlow(env, store, actor, {
        step: command === "invite" ? "invite_start" : "teammember_menu",
        mode: "teammember",
        ...owner
      });
      return true;
    default:
      return false;
  }
}

async function handleButton(
  env: Env,
  store: SessionStore,
  callback: NonNullable<TelegramUpdate["callback_query"]>
): Promise<UpdateResult> {
  // Shown to the user on the button instead of as a chat message.
  let notice: Notice | undefined;
  try {
    const chatId = callback.message?.chat?.id;
    if (!chatId) return reply("Invalid input");
    // Buttons belong to the session of whoever presses them.
    const userId = String(callback.from.id);
    const member = await env.crmApi.validateUser(userId);
    if (!member) {
      notice = { text: NOT_AUTHORIZED_BUTTON };
      store.deleteSession(userId);
      return reply("Forbidden");
    }
    await syncUsername(env, member, callback.from);
    const data = callback.data ?? "";
    // The spam button under an email that mail-to-tg posted; it belongs to no session.
    if (data.startsWith("spam:")) {
      const answer = await mailButtons(env)
        .press(data, chatId, callback.message.message_id ?? 0)
        .catch((e: unknown): Notice => {
          console.error("Spam button failed", e);
          return { text: SOMETHING_WENT_WRONG, alert: true };
        });
      notice = typeof answer === "string" ? { text: answer } : answer;
      return reply("OK");
    }
    const actor = { chatId, userId, member };
    // ✅ Unblock under /blocked: unblocks the sender and redraws the list in place.
    const unblockId = parseUnblockData(data);
    if (unblockId !== undefined) {
      if (member.is_admin !== 1) {
        notice = { text: ONLY_ADMINS_BLOCKED };
        return reply("Forbidden");
      }
      const address = await mailButtons(env).unblock(unblockId);
      notice = { text: address ? `${address} is no longer blocked.` : "That sender was already unblocked." };
      const list = blockedList(await mailButtons(env).blocked());
      if (callback.message.message_id !== undefined) {
        await editMessage(env, chatId, callback.message.message_id, list.text, list.options);
      }
      return reply("OK");
    }
    // Main menu buttons work like the command, also on an old menu.
    if (data.startsWith("menu:")) {
      if (!(await startCommandFlow(env, store, actor, data.slice("menu:".length)))) notice = { text: STALE_BUTTON };
      return reply("OK");
    }
    // 💬 Log conversation on an organization's card: a conversation with the organization itself.
    const loggedOrg = /^log:o:(\d+)$/.exec(data);
    if (loggedOrg) {
      await startFlow(env, store, actor, {
        step: "log_organization",
        mode: "conversation",
        organization_id: Number(loggedOrg[1]),
        created_by: member.id,
        telegram_id: userId
      });
      return reply("OK");
    }
    // "Log conversation with …" under a saved contact: the conversation steps for that contact.
    if (data.startsWith("log:")) {
      const contactId = Number(data.slice("log:".length));
      await startFlow(env, store, actor, {
        step: "log_contact",
        mode: "conversation",
        contact_id: contactId,
        created_by: member.id,
        telegram_id: userId
      });
      return reply("OK");
    }
    // The buttons of a contact's or organization's card (helpers/record.ts).
    const shown = parseRecordData(data, "show");
    if (shown) {
      const card = await recordCard(env, shown);
      if (card) await sendMessage(env, chatId, card.text, card.options);
      else notice = { text: "This no longer exists." };
      return reply("OK");
    }
    // 📜 Conversations on a card, and ⬅️ Older below a page of them (helpers/history.ts). The
    // pressed Older button goes, so the pages read as one list.
    const history = parseHistoryData(data);
    if (history) {
      const page = await historyPage(env, history.ref, history.position);
      if (!page) {
        notice = { text: "This no longer exists." };
        return reply("OK");
      }
      await sendMessage(env, chatId, page.text, page.options);
      if (history.position > 0 && callback.message.message_id !== undefined) {
        await clearKeyboard(env, chatId, callback.message.message_id);
      }
      return reply("OK");
    }
    // 📊 Status: asks for the new status, then sets it (flows/status.ts).
    const status = parseStatusData(data);
    if (status) {
      if (status.statusId === undefined) {
        const question = await statusQuestion(env, status.organizationId);
        if (question) await sendMessage(env, chatId, question.text, question.options);
        else notice = { text: "This no longer exists." };
        return reply("OK");
      }
      const answer = await setStatus(env, status.organizationId, status.statusId, member.id);
      if (!answer) {
        notice = { text: "Saving the status failed. Please try again.", alert: true };
        return reply("OK");
      }
      const { message } = callback;
      if (message.message_id !== undefined) {
        await markAnswered(
          env,
          chatId,
          { messageId: message.message_id, text: message.text, entities: message.entities },
          answer
        );
      }
      notice = { text: "Status saved." };
      return reply("OK");
    }
    // ⏰ Follow-up: asks for the day, then sets it (flows/followup.ts); Other date asks to type it.
    const followUp = parseFollowUpData(data);
    if (followUp) {
      const { organizationId, choice } = followUp;
      if (choice === undefined) {
        const question = await followUpQuestion(env, organizationId);
        if (question) await sendMessage(env, chatId, question.text, question.options);
        else notice = { text: "This no longer exists." };
        return reply("OK");
      }
      const day = chosenDay(choice);
      if (day === undefined) {
        const org = await env.crmApi.organizationDetails(organizationId, 0);
        if (!org) {
          notice = { text: "This no longer exists." };
          return reply("OK");
        }
        await startFlow(env, store, actor, {
          step: "follow_up_start",
          mode: "followup",
          organization_id: org.id,
          organization: org.name,
          created_by: member.id,
          telegram_id: userId
        });
        return reply("OK");
      }
      const answer = await setFollowUp(env, organizationId, day, member.id);
      if (!answer) {
        notice = { text: "Saving the follow-up failed. Please try again.", alert: true };
        return reply("OK");
      }
      const { message } = callback;
      if (message.message_id !== undefined) {
        await markAnswered(
          env,
          chatId,
          { messageId: message.message_id, text: message.text, entities: message.entities },
          answer
        );
      }
      notice = { text: "Follow-up saved." };
      return reply("OK");
    }
    const edited = parseRecordData(data, "edit");
    if (edited) {
      await startFlow(env, store, actor, {
        step: "edit_start",
        mode: "edit",
        edit_target: edited.kind,
        ...(edited.kind === "contact" ? { contact_id: edited.id } : { organization_id: edited.id }),
        created_by: member.id,
        telegram_id: userId
      });
      return reply("OK");
    }
    const session = store.getSession(userId);
    if (!session) {
      notice = { text: EXPIRED_BUTTON };
      return reply("No active session");
    }
    // An older keyboard, or the same button tapped twice after the flow moved on.
    if (callback.message.message_id === undefined || callback.message.message_id !== session.keyboard_message_id) {
      notice = { text: STALE_BUTTON };
      return reply("Stale button");
    }
    const pressed: Press = {
      messageId: callback.message.message_id,
      text: callback.message.text,
      entities: callback.message.entities,
      reply_markup: callback.message.reply_markup
    };
    pressed.label = pressedLabel(pressed, callback.data);
    if (data === "cancel") {
      store.deleteSession(userId);
      await markAnswered(env, chatId, pressed, "Cancelled");
      notice = { text: "Cancelled." };
      return reply("OK");
    }
    if (session.mode === "teammember" && member.is_admin !== 1) {
      notice = { text: ONLY_ADMINS };
      store.deleteSession(userId);
      return reply("Forbidden");
    }
    session.last_callback_data = callback.data ?? null;
    store.putSession(userId, session);
    await runFlow(env, store, chatId, userId, session, undefined, undefined, pressed);
    return reply("OK");
  } finally {
    // Telegram shows a spinner on the button until this is called.
    await callTelegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      ...(notice ? { text: notice.text, ...(notice.alert ? { show_alert: true } : {}) } : {})
    });
  }
}

async function handleMessage(env: Env, store: SessionStore, message: TelegramUpdate["message"]): Promise<UpdateResult> {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id?.toString();
  // A shared Telegram contact answers "What is the contact name?" with its name; its phone
  // number goes along in the session.
  const shared = message?.contact;
  const text = (
    message?.text ?? (shared ? [shared.first_name, shared.last_name].filter(Boolean).join(" ") : "")
  ).trim();
  // Only proceed if chatId, userId, and text exist to avoid repeated sends on non-user input updates
  if (!message || !chatId || !userId || !text) {
    return reply("Invalid input");
  }
  const user = message.from!;
  const isPrivate = message.chat?.type === "private";

  const command = await parseCommand(env, text);
  if (command?.forOtherBot) return reply("Command for another bot");

  const session = store.getSession(userId);
  const member = await env.crmApi.validateUser(userId);
  // An invite link opened: t.me/<bot>?start=inv_… arrives as /start inv_…
  if (command?.name === "start" && command.args.startsWith("inv_")) {
    if (member) await sendMenu(env, chatId, member.is_admin === 1, "You're already on the team.");
    else await acceptInvite(env, chatId, user, command.args);
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
    const name = profileName(user) || userId;
    const res = await env.crmApi.firstUser({ telegram_id: userId, name });
    if (res.ok) {
      await sendMenu(
        env,
        chatId,
        true,
        `👋 Welcome! You are the first team member, so you are an admin, registered as "${name}".`
      );
    } else {
      await sendMessage(
        env,
        chatId,
        errorMessage("Registering you as the first team member failed. Please try again.")
      );
    }
    return reply("OK");
  }
  await syncUsername(env, member, user);
  const isAdmin = member.is_admin === 1;
  await ensureCommandMenus(env, userId, isAdmin, isPrivate);
  const actor = { chatId, userId, member, replyTo: message.message_id };

  if (command) {
    // The "Open private chat" button of /invite in a group opens t.me/<bot>?start=invite.
    const name = command.name === "start" && command.args === "invite" ? "invite" : command.name;
    if (name === "start" && command.args.startsWith("mc_")) {
      await startContactFromEmail(env, store, actor, Number(command.args.slice("mc_".length)));
      return reply("OK");
    }
    if (name === "start" || name === "help") {
      const greeting = user.first_name ? `👋 Hi ${user.first_name}!` : "👋 Hi!";
      await sendMenu(env, chatId, isAdmin, `${greeting} What do you want to do?`);
      return reply("OK");
    }
    if (name === "cancel") {
      const stopped = await stopFlow(env, store, chatId, userId);
      await sendMessage(
        env,
        chatId,
        stopped ? `Your ${stopped} was cancelled.` : "There is nothing to cancel. Send /help to see what you can do."
      );
      return reply("OK");
    }
    if (await startCommandFlow(env, store, actor, name, command.args)) return reply("OK");
    // Never hand a command to a flow as input, e.g. as the note of a conversation.
    await sendMessage(env, chatId, "Unknown command. Type /help for available commands.");
    return reply("Unknown command");
  }

  if (!session) {
    // In a group, ordinary chat between members is not meant for the bot.
    if (isPrivate) await sendMenu(env, chatId, isAdmin, "What do you want to do?");
    return reply("No active session");
  }
  if (session.mode === "teammember" && !isAdmin) {
    await sendMessage(env, chatId, ONLY_ADMINS);
    store.deleteSession(userId);
    return reply("OK");
  }
  if (shared) {
    if (session.mode !== "contact" || session.step !== "awaiting_name") return reply("Contact ignored");
    session.shared_phone = shared.phone_number;
  }
  // Text answers the current step; a button pressed earlier must not count for it.
  session.last_callback_data = null;
  await runFlow(env, store, chatId, userId, session, text, message.message_id);
  return reply("OK");
}
