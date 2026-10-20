export function isValidName(name: string | undefined): name is string {
  return (
    typeof name === "string" &&
    name.trim().length >= 3 &&
    !/^\d+$/.test(name) &&
    !/@/.test(name) &&
    /^[a-zA-Z\s'-]+$/.test(name.trim())
  );
}

export function isValidEmail(email: string | undefined): email is string {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function isValidPhone(phone: string | undefined): phone is string {
  if (typeof phone !== "string") return false;
  const trimmed = phone.trim();
  // Must start with + or 00, and only contain allowed characters
  return /^(?:\+|00)/.test(trimmed) && /^[\d\s()+-]+$/.test(trimmed);
}

export function isValidTelegramId(id: string | undefined): id is string {
  return typeof id === "string" && /^\d+$/.test(id.trim());
}

export function isValidNote(note: string | undefined): note is string {
  return typeof note === "string" && note.trim().length >= 5;
}
