export function isValidName(name) {
  return typeof name === "string" && name.trim().length >= 3 && !/^\d+$/.test(name) && !/@/.test(name) && /^[a-zA-Z\s'-]+$/.test(name.trim());
}

export function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function isValidPhone(phone) {
  if (typeof phone !== "string") return false;
  const trimmed = phone.trim();
  // Must start with + or 00, and only contain allowed characters
  return (/^(?:\+|00)/.test(trimmed)) && /^[\d\s()+-]+$/.test(trimmed);
}

export function isValidTelegramId(id) {
  return typeof id === "string" && /^\d+$/.test(id.trim());
}

export function isValidNote(note) {
  return typeof note === "string" && note.trim().length >= 5;
}
