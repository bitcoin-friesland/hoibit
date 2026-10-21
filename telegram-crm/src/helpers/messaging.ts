import type { SendOptions } from "../types";

export function errorMessage(text: string) {
  return `❌ ${text}`;
}

// Whether text was made by errorMessage: the input was refused, the question still stands.
export const isErrorMessage = (text: string) => text.startsWith("❌ ");

export function successMessage(text: string) {
  return `✅ ${text}`;
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
