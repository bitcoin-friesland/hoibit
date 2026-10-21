/**
 * What the bot offers a team member: the command list of /help, the main menu buttons and the
 * command menu Telegram shows behind the "/" button.
 */
import { callTelegram } from "./telegram";
import type { InlineKeyboardButton } from "../types";

interface BotCommand {
  command: string;
  description: string;
}

const HELP: BotCommand = { command: "help", description: "Show what this bot can do" };
const MEMBER_COMMANDS: BotCommand[] = [
  { command: "newcontact", description: "Add a contact" },
  { command: "neworg", description: "Add an organization" },
  { command: "logconversation", description: "Log a conversation" },
  { command: "find", description: "Look up a contact or organization" },
  { command: "cancel", description: "Stop what you are entering" },
  HELP
];
const ADMIN_COMMANDS: BotCommand[] = [
  { command: "invite", description: "Make an invite link for a new team member" },
  { command: "teammember", description: "Manage team members" }
];

const commandsOf = (isAdmin: boolean) => (isAdmin ? [...MEMBER_COMMANDS, ...ADMIN_COMMANDS] : MEMBER_COMMANDS);

export function helpText(isAdmin: boolean) {
  return `Available commands:\n${commandsOf(isAdmin)
    .map(c => `/${c.command} - ${c.description}`)
    .join("\n")}`;
}

// The main menu: the flows a member starts most, as buttons (menu:<command>).
export function menuKeyboard(isAdmin: boolean): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: "➕ New contact", callback_data: "menu:newcontact" },
        { text: "🏢 New organization", callback_data: "menu:neworg" }
      ],
      [
        { text: "💬 Log conversation", callback_data: "menu:logconversation" },
        { text: "🔎 Find", callback_data: "menu:find" }
      ],
      ...(isAdmin ? [[{ text: "👥 Team", callback_data: "menu:teammember" }]] : [])
    ]
  };
}

// Whether the menus for everyone are set in this isolate, and per member whether theirs were
// set for an admin; a member's menu is set again when their admin rights changed.
let defaultMenusSet = false;
const memberMenus = new Map<string, boolean>();

/**
 * Sets the command menus once per isolate: /help for everyone, the member commands in groups
 * (where the team works), and in a member's private chat their own commands.
 */
export async function ensureCommandMenus(env: Env, userId: string, isAdmin: boolean, isPrivate: boolean) {
  if (!defaultMenusSet) {
    defaultMenusSet =
      (await callTelegram(env, "setMyCommands", { commands: [HELP], scope: { type: "default" } })) !== undefined &&
      (await callTelegram(env, "setMyCommands", {
        commands: MEMBER_COMMANDS,
        scope: { type: "all_group_chats" }
      })) !== undefined;
  }
  if (isPrivate && memberMenus.get(userId) !== isAdmin) {
    const set = await callTelegram(env, "setMyCommands", {
      commands: commandsOf(isAdmin),
      scope: { type: "chat", chat_id: Number(userId) }
    });
    if (set !== undefined) memberMenus.set(userId, isAdmin);
  }
}

// For tests, which start every case with nothing set.
export function forgetCommandMenus() {
  defaultMenusSet = false;
  memberMenus.clear();
}
