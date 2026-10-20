import type { SendOptions } from "../types";

export function errorMessage(text: string) {
  return `❌ ${text}`;
}

export function successMessage(text: string) {
  return `✅ ${text}`;
}

export function promptWithSkip(text: string): { text: string } & Required<Pick<SendOptions, "reply_markup">> {
  return {
    text,
    reply_markup: { inline_keyboard: [[{ text: "Skip", callback_data: "skip" }]] }
  };
}

export function promptWithOptions(
  text: string,
  options: { label: string; value: string }[]
): { text: string } & Required<Pick<SendOptions, "reply_markup">> {
  return {
    text,
    reply_markup: { inline_keyboard: options.map(opt => [{ text: opt.label, callback_data: opt.value }]) }
  };
}

// For messages sent with parse_mode "HTML": only <, > and & in text need escaping.
export function escapeHtml(text: unknown) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
