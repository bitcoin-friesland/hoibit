import PostalMime, { type Address, type Email } from "postal-mime";
import { htmlToText } from "./html-to-text";

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
const MAX_RETRY_WAIT_SECONDS = 30;
const ATTACHED_NOTE = "📄 Full text attached as email.txt";

// Telegram HTML parse mode: only <, > and & in text need escaping.
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

function buildHeader(parsed: Email) {
  const lines = ["📩 New Email", `👤 From: ${formatAddresses(parsed.from) || "(unknown)"}`];
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
}

// Calls the Bot API and throws unless Telegram confirms with ok: true. Waits out 429s
// (up to MAX_RETRY_WAIT_SECONDS in total) and retries a 5xx or network error once.
async function callTelegram(env: Env, method: string, body: string | FormData) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`;
  const init: RequestInit = { method: "POST", body };
  if (typeof body === "string") init.headers = { "Content-Type": "application/json" };

  let waited = 0;
  let retried = false;
  for (;;) {
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      if (retried) throw new Error(`Telegram ${method} failed: ${err}`, { cause: err });
      console.warn(`Telegram ${method} network error, retrying once:`, err);
      retried = true;
      await sleep(1000);
      continue;
    }

    const data = (await resp.json().catch(() => ({}))) as TelegramResponse;
    if (resp.ok && data.ok) return;

    const reason = `${resp.status} ${data.description ?? resp.statusText}`;
    if (resp.status === 429) {
      const wait = Math.max(1, data.parameters?.retry_after ?? 1);
      if (waited + wait <= MAX_RETRY_WAIT_SECONDS) {
        console.warn(`Telegram ${method} rate limited, retrying after ${wait}s`);
        waited += wait;
        await sleep(wait * 1000);
        continue;
      }
    } else if (resp.status >= 500 && !retried) {
      console.warn(`Telegram ${method} failed with ${reason}, retrying once`);
      retried = true;
      await sleep(1000);
      continue;
    }
    throw new Error(`Telegram ${method} failed: ${reason}`);
  }
}

async function sendMessage(env: Env, text: string, first: boolean) {
  const html = escapeHtml(text);
  await callTelegram(
    env,
    "sendMessage",
    JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: first ? html.replace("📩 New Email", "📩 <b>New Email</b>") : html,
      parse_mode: "HTML"
    })
  );
}

async function sendDocument(env: Env, text: string) {
  const form = new FormData();
  form.append("chat_id", String(env.TELEGRAM_CHAT_ID));
  form.append("document", new File([text], "email.txt", { type: "text/plain;charset=utf-8" }));
  await callTelegram(env, "sendDocument", form);
}

async function forwardToTelegram(message: ForwardableEmailMessage, env: Env) {
  const parsed = await PostalMime.parse(message.raw);
  // Splitting happens before escaping, so no entity is cut in half.
  const full = buildHeader(parsed) + bodyText(parsed);
  // Telegram refuses a message that is only whitespace.
  const parts = splitText(full, MAX_MESSAGE_LENGTH).filter(part => part.trim());

  if (parts.length > MAX_PARTS) {
    const [start] = splitText(full, MAX_MESSAGE_LENGTH - ATTACHED_NOTE.length - 4);
    await sendMessage(env, `${start.trimEnd()}\n…\n\n${ATTACHED_NOTE}`, true);
    await sendDocument(env, full);
    console.log(`Forwarded email to Telegram as 1 message plus email.txt (${full.length} characters)`);
    return;
  }

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(100);
    await sendMessage(env, parts[i], i === 0);
  }
  console.log(`Forwarded email to Telegram in ${parts.length} message(s)`);
}

export default {
  async email(message, env) {
    try {
      await forwardToTelegram(message, env);
    } catch (err) {
      console.error("Failed to forward email to Telegram:", err);
      // No setReject: that bounces the email permanently. Without a fallback mailbox the
      // error is rethrown so the failure shows up in Workers Logs and Email Routing.
      if (!env.FALLBACK_EMAIL) throw err;
      await message.forward(env.FALLBACK_EMAIL);
      console.log("Forwarded email to FALLBACK_EMAIL instead");
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
