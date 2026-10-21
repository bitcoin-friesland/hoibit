/**
 * /blocked, for admins: the email senders that the spam button blocked (mail-to-tg's Blocklist),
 * each with an Unblock button. Like the record card buttons, unblock:<id> belongs to no session.
 */
import type { InlineKeyboardButton, SendOptions } from "../types";

// A blocked sender as mail-to-tg lists it; since is in milliseconds since 1970.
export interface BlockedSender {
  id: number;
  address: string;
  since: number;
}

// Senders listed, at most: the most recently blocked, the likeliest mistakes.
const BLOCKED_MAX = 20;

// The id of an unblock:<id> button; undefined for other data.
export function parseUnblockData(data: string) {
  const match = /^unblock:(\d+)$/.exec(data);
  return match ? Number(match[1]) : undefined;
}

// The list as text with its buttons; reply_markup has no buttons when nobody is blocked.
export function blockedList(senders: BlockedSender[]): {
  text: string;
  options: Required<Pick<SendOptions, "reply_markup">>;
} {
  if (senders.length === 0) {
    return { text: "No email senders are blocked.", options: { reply_markup: { inline_keyboard: [] } } };
  }
  const shown = senders.slice(0, BLOCKED_MAX);
  const lines = [
    `🚫 Blocked email senders: ${senders.length}. Their emails are dropped. Tap one to let them through again.`,
    ...(senders.length > shown.length ? [`Showing the ${shown.length} blocked most recently.`] : []),
    "",
    ...shown.map(s => `• ${s.address}, since ${new Date(s.since).toISOString().slice(0, 10)}`)
  ];
  const keyboard: InlineKeyboardButton[][] = shown.map(s => [
    { text: `✅ Unblock ${s.address}`, callback_data: `unblock:${s.id}` }
  ]);
  return { text: lines.join("\n"), options: { reply_markup: { inline_keyboard: keyboard } } };
}
