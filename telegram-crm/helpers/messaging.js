export function errorMessage(text) {
  return `❌ ${text}`;
}

export function successMessage(text) {
  return `✅ ${text}`;
}

export function promptWithSkip(text) {
  return {
    text,
    reply_markup: { inline_keyboard: [[{ text: "Skip", callback_data: "skip" }]] }
  };
}

export function promptWithOptions(text, options) {
  return {
    text,
    reply_markup: { inline_keyboard: options.map(opt => [{ text: opt.label, callback_data: opt.value }]) }
  };
}
