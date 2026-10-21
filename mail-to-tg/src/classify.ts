import type { Address, Email } from "postal-mime";

// Supports JSON mode (developers.cloudflare.com/workers-ai/features/json-mode/). A few emails a
// day stay far within the free daily allocation.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_BODY_LENGTH = 6000;
const MAX_REASON_LENGTH = 120;
// An email waits for the verdict before it goes to Telegram.
const TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `You sort the email that arrives at the public addresses of Bitcoin Friesland, a volunteer \
Bitcoin community in Friesland, the Netherlands. The team reads every email that is not spam in Telegram.

Spam is: unsolicited sales or marketing pitches (web, app or software development, design, SEO, \
marketing, lead generation, guest posts, link building, "would you like a quote"), follow-ups to such \
pitches, phishing, scams, fake invoices, crypto investment offers and bulk mail sent to many recipients.

Not spam is: questions or messages from people and businesses, for example about Bitcoin, meetups, \
accepting Bitcoin or working together; press; invitations; replies in a real conversation; \
notifications from services the community uses (domains, hosting, Cloudflare, GitHub).

When unsure, answer spam: false; a missed spam email costs less than a hidden real one. \
Give the reason in at most ten English words.`;

const SCHEMA = {
  type: "object",
  properties: { spam: { type: "boolean" }, reason: { type: "string" } },
  required: ["spam", "reason"]
};

const addresses = (list: Address[] | undefined): string[] =>
  (list ?? []).flatMap(a => (a.group ? addresses(a.group) : a.address ? [a.address.toLowerCase()] : []));

const show = (list: Address[] | Address | undefined) =>
  (Array.isArray(list) ? list : list ? [list] : []).map(a => a.address ?? a.name).join(", ") || "(none)";

// Facts a model is bad at noticing on its own; both are typical of cold outreach.
function hints(parsed: Email, recipient: string | undefined) {
  const lines: string[] = [];
  if (recipient && !addresses([...(parsed.to ?? []), ...(parsed.cc ?? [])]).includes(recipient.toLowerCase())) {
    lines.push(`Our address ${recipient} is not in To or Cc: the email was sent as Bcc.`);
  }
  if (/^\s*re\s*:/i.test(parsed.subject ?? "") && !parsed.inReplyTo && !parsed.references) {
    lines.push('The subject starts with "Re:", but the email is not a reply to anything.');
  }
  return lines;
}

function verdict(response: unknown): { spam: boolean; reason: string } | undefined {
  const value = typeof response === "string" ? JSON.parse(response) : response;
  if (typeof value?.spam !== "boolean") return undefined;
  return { spam: value.spam, reason: String(value.reason ?? "").trim() };
}

/**
 * Asks Workers AI whether an email is spam. Returns the reason when it is, undefined when it is
 * not or when the model fails or takes too long: then the email goes out as usual.
 */
export async function spamReason(env: Env, parsed: Email, text: string, recipient: string | undefined) {
  const email = [
    `From: ${show(parsed.from)}`,
    `Reply-To: ${show(parsed.replyTo)}`,
    `To: ${show(parsed.to)}`,
    `Cc: ${show(parsed.cc)}`,
    `Subject: ${parsed.subject ?? ""}`,
    ...hints(parsed, recipient),
    "",
    text.slice(0, MAX_BODY_LENGTH)
  ].join("\n");

  try {
    const result = await env.AI.run(
      MODEL,
      {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: email }
        ],
        response_format: { type: "json_schema", json_schema: SCHEMA },
        max_tokens: 100
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    const answer = verdict((result as { response?: unknown }).response);
    if (!answer) throw new Error(`unexpected answer ${JSON.stringify(result)}`);
    console.log(`Spam check: ${answer.spam ? "spam" : "not spam"} (${answer.reason})`);
    if (!answer.spam) return undefined;
    return answer.reason.slice(0, MAX_REASON_LENGTH) || "no reason given";
  } catch (err) {
    console.error("Spam check failed, sending the email as usual:", err);
    return undefined;
  }
}
