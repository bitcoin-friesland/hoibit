// Letters in any script ("José", "Gerbrân"), spaces, straight and curly apostrophes (iOS types
// "D’Angelo"), hyphens and dots ("Dr. Anna Smit"); at least 2 letters ("Bo"). Digits and "@" are
// refused, so a phone number or email address is not taken for a name.
export function isValidName(name: string | undefined): name is string {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  return /^[\p{L}\p{M}\s'’.-]+$/u.test(trimmed) && (trimmed.match(/\p{L}/gu) ?? []).length >= 2;
}

// What isValidName asks for, to tell the user.
export const NAME_RULE = "Please enter a name of at least 2 letters, without digits or @.";

// Any name with at least one letter, in any script, with common punctuation ("’t Hoekje",
// "Café (Leeuwarden)"). The letter keeps out phone numbers, "@" keeps out email addresses.
export function isValidOrganizationName(name: string | undefined): name is string {
  return !!name && /\p{L}/u.test(name) && !name.includes("@") && !/\p{Cc}/u.test(name);
}

// What isValidOrganizationName asks for, to tell the user.
export const INVALID_ORGANIZATION_NAME =
  "Please enter a valid organization name (organization names should be words, not a phone number or symbols).";

export function isValidEmail(email: string | undefined): email is string {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// A phone number without spaces, dashes, dots, slashes and brackets. "(0)" goes first: in
// "+31 (0)6 …" it is the national prefix, which an international number leaves out.
const compactPhone = (phone: string) =>
  phone
    .trim()
    .replaceAll("(0)", "")
    .replace(/[\s\-./()]/g, "");

// Whether phone is written nationally ("06 12345678"), so it needs a country code.
export const isNationalPhone = (phone: string) => /^0[1-9]/.test(compactPhone(phone));

/**
 * The phone number in international (E.164) form, e.g. "+31612345678", as the CRM stores it and
 * OpenStreetMap is searched with; undefined when it is no phone number. "00" counts as "+", and
 * a national number gets countryCode ("31" for "06 12345678").
 */
export function toInternationalPhone(phone: string, countryCode: string): string | undefined {
  let number = compactPhone(phone);
  if (number.startsWith("00")) number = `+${number.slice(2)}`;
  else if (/^0[1-9]/.test(number)) number = `+${countryCode}${number.slice(1)}`;
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : undefined;
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
