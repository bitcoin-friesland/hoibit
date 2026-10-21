// Letters in any script ("José", "Gerbrân"), spaces, straight and curly apostrophes (iOS types
// "D’Angelo"), hyphens and dots ("Dr. Anna Smit"); at least 3 letters. Digits and "@" are refused,
// so a phone number or email address is not taken for a name.
export function isValidName(name: string | undefined): name is string {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  return /^[\p{L}\p{M}\s'’.-]+$/u.test(trimmed) && (trimmed.match(/\p{L}/gu) ?? []).length >= 3;
}

// Any name with at least one letter, in any script, with common punctuation ("’t Hoekje",
// "Café (Leeuwarden)"). The letter keeps out phone numbers, "@" keeps out email addresses.
export function isValidOrganizationName(name: string | undefined): name is string {
  return !!name && /\p{L}/u.test(name) && !name.includes("@") && !/\p{Cc}/u.test(name);
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

export function isValidNote(note: string | undefined): note is string {
  return typeof note === "string" && note.trim().length >= 5;
}

// Bech32 npub: "npub1" and 58 data characters (the bech32 alphabet has no 1, b, i or o).
export function isValidNpub(npub: string | undefined): npub is string {
  return typeof npub === "string" && /^npub1[02-9ac-hj-np-z]{58}$/.test(npub.trim());
}

// A web address with or without "http(s)://", e.g. "example.com" or "https://www.example.com/shop".
export function isValidWebsite(website: string | undefined): website is string {
  if (typeof website !== "string") return false;
  const trimmed = website.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return (url.protocol === "https:" || url.protocol === "http:") && /^[^.]+(\.[^.]+)+$/.test(url.hostname);
  } catch {
    return false;
  }
}
