import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

interface SentMessage {
  chat_id: string;
  text: string;
  parse_mode: string;
}

const env = { TELEGRAM_TOKEN: "test-token", TELEGRAM_CHAT_ID: "-100123" } as unknown as Env;
let sent: SentMessage[];

beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://api.telegram.org/bottest-token/sendMessage") throw new Error(`Unexpected fetch: ${url}`);
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  });
});

// Only raw is read by the handler.
function email({ subject, body, cc }: { subject: string; body: string; cc?: string }) {
  const lines = [
    'From: "Alice Example" <alice@example.com>',
    "To: info@hoibit.nl, Bob <bob@example.com>",
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ];
  return { raw: new Blob([lines.join("\r\n")]).stream() } as unknown as ForwardableEmailMessage;
}

const unescape = (text: string) =>
  text
    .replace(/<\/?b>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("email handler", () => {
  it("forwards a short email as one HTML message with escaped content", async () => {
    await worker.email(
      email({ subject: "Price <today> & tomorrow", body: "Hi <there> & bye", cc: "carol@example.com" }),
      env
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      chat_id: "-100123",
      parse_mode: "HTML",
      text:
        "📩 <b>New Email</b>\n" +
        "👤 From: Alice Example &lt;alice@example.com&gt;\n" +
        "📬 To: info@hoibit.nl, Bob &lt;bob@example.com&gt;\n" +
        "🟡 CC: carol@example.com\n" +
        "📝 Subject: Price &lt;today&gt; &amp; tomorrow\n\n" +
        "Hi &lt;there&gt; &amp; bye\n"
    });
  });

  it("splits a long email into parts of at most 4096 characters without losing text", async () => {
    const body = Array.from({ length: 900 }, (_, i) => `line ${i} <x> &`).join("\n");
    await worker.email(email({ subject: "Long", body }), env);
    expect(sent.length).toBeGreaterThan(1);
    const parts = sent.map(m => unescape(m.text));
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);
    const joined = parts.join("");
    expect(joined.startsWith("📩 New Email\n👤 From: Alice Example <alice@example.com>")).toBe(true);
    expect(joined.endsWith(body.split("\n").at(-1) + "\n")).toBe(true);
    expect(joined.replace(/\n$/, "")).toContain(body);
  });
});

describe("fetch handler", () => {
  it("refuses HTTP traffic", async () => {
    const res = await worker.fetch();
    expect(res.status).toBe(403);
  });
});
