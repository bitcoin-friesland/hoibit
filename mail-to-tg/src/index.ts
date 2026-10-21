import PostalMime, { type Address, type Email } from "postal-mime";
import { blocklist, remember } from "./blocklist";
import { spamReason } from "./classify";
import { htmlToText } from "./html-to-text";
import { enqueue, retrySoon } from "./outbox";
import { deliver, sleep, type Send } from "./telegram";

export { Blocklist } from "./blocklist";
export { SpamButtons } from "./buttons";
export { Outbox } from "./outbox";

// Telegram counts the 4096 limit after entity parsing, so the escaping below does not count.
const MAX_MESSAGE_LENGTH = 4096;
// A group accepts about 20 messages per minute (Telegram bots FAQ); longer emails go out as a file.
const MAX_PARTS = 3;
// Always below half a message, so a split never lands inside the header.
const MAX_HEADER_LENGTH = 1800;
const MAX_LISTED = 10;
const MAX_ADDRESS_LENGTH = 200;
const MAX_FILENAME_LENGTH = 100;
const MAX_SUBJECT_LENGTH = 300;
const ATTACHED_NOTE = "📄 Full text attached as email.txt";

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// Shortens text to at most max characters, without cutting a surrogate pair in half.
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  let cut = max - 1;
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut--;
  return text.slice(0, cut) + "…";
}

// Splits text into parts of at most max characters without losing any. Prefers the last line
// end, then the last space, and never cuts between the two halves of a surrogate pair (emoji).
function splitText(text: string, max: number) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max - 1) + 1;
    if (cut < max / 2) {
      const space = rest.lastIndexOf(" ", max - 1) + 1;
      cut = space >= max / 2 ? space : max;
    }
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function listWithMore(items: string[]) {
  const shown = items.slice(0, MAX_LISTED);
  if (items.length > MAX_LISTED) shown[shown.length - 1] += ` … and ${items.length - MAX_LISTED} more`;
  return shown.join(", ");
}

function formatAddress(a: Address): string {
  if (a.group) {
    // A group such as "undisclosed-recipients:;" has a name and members, no address.
    const members = formatAddresses(a.group);
    return members ? `${a.name}: ${members}` : a.name || "(group)";
  }
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address || a.name || "(unknown)";
}

function formatAddresses(list: Address[] | Address | undefined) {
  const addresses = (Array.isArray(list) ? list : [list]).filter((a): a is Address => Boolean(a));
  return listWithMore(addresses.map(a => clip(formatAddress(a), MAX_ADDRESS_LENGTH)));
}

function addressKey(list: Address[] | Address | undefined): string {
  const addresses = (Array.isArray(list) ? list : [list]).filter((a): a is Address => Boolean(a));
  return addresses
    .flatMap(a => (a.group ? a.group : [a]))
    .map(a => a.address?.toLowerCase() ?? "")
    .sort()
    .join(",");
}

function buildHeader(parsed: Email, spam: string | undefined) {
  const lines = ["📩 New Email"];
  if (spam) lines.push(`⚠️ Likely spam: ${spam}`);
  lines.push(`👤 From: ${formatAddresses(parsed.from) || "(unknown)"}`);
  if (parsed.replyTo?.length && addressKey(parsed.replyTo) !== addressKey(parsed.from)) {
    lines.push(`↩️ Reply-To: ${formatAddresses(parsed.replyTo)}`);
  }
  lines.push(`📬 To: ${formatAddresses(parsed.to)}`);
  const cc = formatAddresses(parsed.cc);
  if (cc) lines.push(`🟡 CC: ${cc}`);
  lines.push(`📝 Subject: ${clip(parsed.subject || "(No subject)", MAX_SUBJECT_LENGTH)}`);
  if (parsed.attachments.length) {
    const names = parsed.attachments.map(a => clip(a.filename || "(unnamed)", MAX_FILENAME_LENGTH));
    lines.push(`📎 Attachments: ${listWithMore(names)}`);
  }
  return clip(lines.join("\n"), MAX_HEADER_LENGTH) + "\n\n";
}

function bodyText(parsed: Email) {
  if (parsed.text?.trim()) return parsed.text;
  // postal-mime leaves text empty for an email that only has an HTML part.
  if (parsed.html) return htmlToText(parsed.html) || "(No content)";
  return "(No content)";
}

/**
 * The Bot API calls that carry an email, in order. spam: why the email is likely spam; it then
 * goes out without a notification. email: its id in the blocklist; the last call then carries
 * the spam button.
 */
function plan(parsed: Email, spam?: string, email?: number): Send[] {
  const sends = splitIntoCalls(buildHeader(parsed, spam) + bodyText(parsed));
  return sends.map((send, i) => ({
    ...send,
    ...(spam ? { silent: true } : {}),
    ...(email !== undefined ? { email, button: i === sends.length - 1 } : {})
  }));
}

function splitIntoCalls(full: string): Send[] {
  // Splitting happens before escaping, so no entity is cut in half.
  // Telegram refuses a message that is only whitespace.
  const parts = splitText(full, MAX_MESSAGE_LENGTH).filter(part => part.trim());

  if (parts.length > MAX_PARTS) {
    const [start] = splitText(full, MAX_MESSAGE_LENGTH - ATTACHED_NOTE.length - 4);
    return [
      { kind: "message", text: `${start.trimEnd()}\n…\n\n${ATTACHED_NOTE}`, first: true },
      { kind: "document", text: full }
    ];
  }
  return parts.map((text, i) => ({ kind: "message", text, first: i === 0 }));
}

// Sends every call in turn; returns how many went through before one failed, and the error.
async function deliverAll(env: Env, sends: Send[]) {
  for (let i = 0; i < sends.length; i++) {
    if (i > 0) await sleep(100);
    let messageId: number | undefined;
    try {
      messageId = await deliver(env, sends[i]);
    } catch (err) {
      return { delivered: i, err };
    }
    await remember(env, sends[i], messageId);
  }
  return { delivered: sends.length };
}

// Runs fn; logs a failure and returns otherwise instead.
async function orElse<T>(fn: () => Promise<T>, otherwise: T, what: string) {
  try {
    return await fn();
  } catch (err) {
    console.error(what, err);
    return otherwise;
  }
}

// Last resort when the email can be neither read nor stored. No setReject: that bounces the
// email permanently. Without a fallback mailbox the error is rethrown so the failure shows up
// in Workers Logs and Email Routing.
async function fallback(message: ForwardableEmailMessage, env: Env, err: unknown) {
  if (!env.FALLBACK_EMAIL) throw err;
  await message.forward(env.FALLBACK_EMAIL);
  console.log("Forwarded email to FALLBACK_EMAIL instead");
}

export default {
  async email(message, env) {
    const receivedAt = new Date();
    let parsed: Email;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (err) {
      console.error("Could not read the email:", err);
      return fallback(message, env, err);
    }

    const sender = parsed.from?.address?.toLowerCase() || message.from?.toLowerCase() || "";
    const senders = [sender, message.from?.toLowerCase()].filter((a): a is string => Boolean(a));
    // When the blocklist cannot be reached the email goes out as usual, without a spam button.
    if (await orElse(() => blocklist(env).isBlocked(senders), false, "Could not check the blocklist:")) {
      console.log("Dropped an email from a blocked sender");
      return;
    }
    const spam = await spamReason(env, parsed, bodyText(parsed), message.to);
    const email = await orElse(
      () => blocklist(env).addEmail(sender),
      undefined,
      "Could not add the email to the blocklist:"
    );

    let sends: Send[];
    try {
      sends = plan(parsed, spam, email);
    } catch (err) {
      console.error("Could not read the email:", err);
      return fallback(message, env, err);
    }

    const { delivered, err } = await deliverAll(env, sends);
    if (!err) {
      console.log(`Forwarded email to Telegram in ${sends.length} call(s)`);
      // Telegram works again, so emails waiting in the outbox need not wait for their retry.
      await retrySoon(env).catch(e => console.error("Could not wake the outbox:", e));
      return;
    }
    console.error(`Failed to forward email to Telegram after ${delivered} of ${sends.length} call(s):`, err);
    try {
      // There is no mailbox behind the address, so the email waits in Cloudflare until Telegram takes it.
      await enqueue(env, receivedAt, sends.slice(delivered), delivered > 0);
      console.log("Stored the email in the outbox");
    } catch (e) {
      console.error("Could not store the email in the outbox:", e);
      return fallback(message, env, e);
    }
  },

  async fetch() {
    return new Response("403 Forbidden: This worker only accepts email traffic via Cloudflare Email Routing.", {
      status: 403,
      headers: {
        "Content-Type": "text/plain",
        "X-Robots-Tag": "noindex, nofollow"
      }
    });
  }
} satisfies ExportedHandler<Env>;
