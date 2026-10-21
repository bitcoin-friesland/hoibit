import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

interface SentMessage {
  chat_id: string;
  text: string;
  parse_mode: string;
}

interface SentDocument {
  chat_id: string;
  name: string;
  type: string;
  text: string;
}

const env = { TELEGRAM_TOKEN: "test-token", TELEGRAM_CHAT_ID: "-100123" } as unknown as Env;
const envWithFallback = { ...env, FALLBACK_EMAIL: "backup@example.org" } as Env;
let sent: SentMessage[];
let documents: SentDocument[];
let calls: number;

function stubTelegram(respond: () => Response | Promise<Response> = () => Response.json({ ok: true, result: {} })) {
  sent = [];
  documents = [];
  calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.telegram.org/bottest-token/")) throw new Error(`Unexpected fetch: ${url}`);
    calls++;
    if (url.endsWith("/sendMessage")) {
      sent.push(JSON.parse(String(init?.body)));
    } else if (url.endsWith("/sendDocument")) {
      const form = init?.body as FormData;
      const file = form.get("document") as File;
      documents.push({
        chat_id: String(form.get("chat_id")),
        name: file.name,
        type: file.type,
        text: await file.text()
      });
    } else {
      throw new Error(`Unexpected Telegram method: ${url}`);
    }
    return respond();
  });
}

// Waits run instantly; the requested delays are recorded so the retry budget can be checked.
let waits: number[];
function instantTimers() {
  waits = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    waits.push(ms ?? 0);
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
}

beforeEach(() => stubTelegram());
afterEach(() => vi.restoreAllMocks());

function mail(headers: string[], body: string) {
  return {
    raw: new Blob([[...headers, "", body].join("\r\n")]).stream(),
    forward: vi.fn(async () => {}),
    setReject: vi.fn()
  } as unknown as ForwardableEmailMessage & {
    forward: ReturnType<typeof vi.fn>;
    setReject: ReturnType<typeof vi.fn>;
  };
}

function email({ subject, body, cc }: { subject: string; body: string; cc?: string }) {
  return mail(
    [
      'From: "Alice Example" <alice@example.com>',
      "To: info@hoibit.nl, Bob <bob@example.com>",
      ...(cc ? [`Cc: ${cc}`] : []),
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8"
    ],
    body
  );
}

const PLAIN = [
  'From: "Alice Example" <alice@example.com>',
  "To: info@hoibit.nl",
  "Subject: Test",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8"
];

const unescape = (text: string) =>
  text
    .replace(/<\/?b>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const isBroken = (part: string) => /[\uD800-\uDBFF]$/.test(part) || /^[\uDC00-\uDFFF]/.test(part);

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

  it("splits an email of up to three messages at line ends without losing text", async () => {
    const body = Array.from({ length: 600 }, (_, i) => `line ${i} <x> &`).join("\n");
    await worker.email(email({ subject: "Long", body }), env);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(documents).toHaveLength(0);
    const parts = sent.map(m => unescape(m.text));
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.endsWith("\n")).toBe(true);
    }
    const joined = parts.join("");
    expect(joined.startsWith("📩 New Email\n👤 From: Alice Example <alice@example.com>")).toBe(true);
    expect(joined.replace(/\n$/, "")).toContain(body);
  });

  it("E1 forwards the content of an HTML-only email as readable text", async () => {
    await worker.email(
      mail(
        [
          "From: Form <noreply@example.com>",
          "To: info@hoibit.nl",
          "Subject: Contact",
          "MIME-Version: 1.0",
          "Content-Type: text/html; charset=utf-8"
        ],
        "<html><head><title>T</title><style>p { color: red }</style></head><body>" +
          "<script>alert(1)</script><p>Please call me back</p><div>Fish &amp; chips &euro;5 &#8364;6 &#x41;</div>" +
          "<ul><li>one</li><li>two</li></ul>line<br>break<p></p><p></p><p></p><p></p><p></p><p>end</p></body></html>"
      ),
      env
    );
    expect(sent).toHaveLength(1);
    const text = unescape(sent[0].text);
    const body = text.slice(text.indexOf("\n\n") + 2);
    expect(body).toBe("Please call me back\nFish & chips €5 €6 A\none\ntwo\nline\nbreak\n\n\nend");
  });

  it("converts hostile HTML with unclosed tags and blocks in linear time", async () => {
    const html =
      "<P>Before İ</P><!-- open comment --><SCRIPT>x</SCRIPT>after" + "<x".repeat(50_000) + "<style>".repeat(50_000);
    // Quadratic regexes would run far past the test timeout on this input.
    await worker.email(
      mail(["From: a@example.com", "To: info@hoibit.nl", "Subject: X", "Content-Type: text/html; charset=utf-8"], html),
      env
    );
    expect(unescape(sent[0].text)).toContain("\n\nBefore İ\nafter");
  });

  it("E2 forwards the email to FALLBACK_EMAIL when Telegram keeps refusing it", async () => {
    instantTimers();
    stubTelegram(() =>
      Response.json(
        { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } },
        { status: 429 }
      )
    );
    const message = mail(PLAIN, "Hello");
    await worker.email(message, envWithFallback);
    expect(calls).toBeGreaterThan(1);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
    expect(message.forward).toHaveBeenCalledWith("backup@example.org");
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it("E2 fails loudly without FALLBACK_EMAIL when Telegram keeps refusing it", async () => {
    instantTimers();
    stubTelegram(() =>
      Response.json(
        { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } },
        { status: 429 }
      )
    );
    const message = mail(PLAIN, "Hello");
    await expect(worker.email(message, env)).rejects.toThrow(/429/);
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it("waits retry_after and delivers when Telegram accepts the retry", async () => {
    instantTimers();
    let n = 0;
    stubTelegram(() =>
      n++ === 0
        ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, { status: 429 })
        : Response.json({ ok: true, result: {} })
    );
    const message = mail(PLAIN, "Hello");
    await worker.email(message, envWithFallback);
    expect(calls).toBe(2);
    expect(waits).toContain(3000);
    expect(message.forward).not.toHaveBeenCalled();
  });

  it("retries a 5xx answer once", async () => {
    instantTimers();
    let n = 0;
    stubTelegram(() =>
      n++ === 0 ? new Response("Bad Gateway", { status: 502 }) : Response.json({ ok: true, result: {} })
    );
    const message = mail(PLAIN, "Hello");
    await worker.email(message, env);
    expect(calls).toBe(2);
  });

  it("retries a network error once, then falls back", async () => {
    instantTimers();
    stubTelegram(() => {
      throw new TypeError("Network connection lost");
    });
    const message = mail(PLAIN, "Hello");
    await worker.email(message, envWithFallback);
    expect(calls).toBe(2);
    expect(message.forward).toHaveBeenCalledWith("backup@example.org");
  });

  it("treats a 200 answer with ok: false as a failure", async () => {
    stubTelegram(() => Response.json({ ok: false, description: "Bad Request: chat not found" }));
    await expect(worker.email(mail(PLAIN, "Hello"), env)).rejects.toThrow(/chat not found/);
  });

  it("E3 sends a long email as one message plus the full text as email.txt", async () => {
    const body = Array.from({ length: 2500 }, (_, i) => `line ${i} of a very long newsletter text`).join("\n");
    await worker.email(mail(PLAIN, body), env);
    expect(sent).toHaveLength(1);
    expect(documents).toHaveLength(1);
    const first = unescape(sent[0].text);
    expect(first.length).toBeLessThanOrEqual(4096);
    expect(first).toContain("📝 Subject: Test");
    expect(first).toContain("line 0 of a very long newsletter text");
    expect(first).toContain("Full text attached as email.txt");
    expect(documents[0]).toMatchObject({ chat_id: "-100123", name: "email.txt" });
    expect(documents[0].type).toMatch(/^text\/plain/);
    expect(documents[0].text).toContain("👤 From: Alice Example <alice@example.com>");
    expect(documents[0].text).toContain(body);
  });

  it("E4 keeps the first message within 4096 characters when the To list is long", async () => {
    const to = Array.from({ length: 200 }, (_, i) => `person${i}@example.com`).join(",\r\n ");
    await worker.email(
      mail(
        [
          "From: alice@example.com",
          `To: ${to}`,
          `Subject: ${"x".repeat(1000)}`,
          "Content-Type: text/plain; charset=utf-8"
        ],
        "Hi"
      ),
      env
    );
    const first = unescape(sent[0].text);
    expect(first.length).toBeLessThanOrEqual(4096);
    expect(first).toContain("👤 From: alice@example.com");
    expect(first).toContain("person9@example.com … and 190 more");
    expect(first).not.toContain("person10@example.com");
    expect(first).toContain("📝 Subject: " + "x".repeat(299) + "…\n");
    expect(first).toContain("\n\nHi");
  });

  it("E5 never splits an emoji across two messages", async () => {
    const broken: string[] = [];
    for (const pad of ["", "a"]) {
      stubTelegram();
      await worker.email(mail(PLAIN, pad + "😀".repeat(3000)), env);
      expect(sent.length).toBeGreaterThan(1);
      for (const part of sent.map(m => unescape(m.text))) if (isBroken(part)) broken.push(`pad "${pad}"`);
    }
    expect(broken).toEqual([]);
  });

  it("E6 shows the Reply-To address of a contact-form email", async () => {
    await worker.email(
      mail(
        [
          "From: Website <noreply@hoibit.nl>",
          "Reply-To: Visitor <visitor@example.org>",
          "To: info@hoibit.nl",
          "Subject: Contact form",
          "Content-Type: text/plain; charset=utf-8"
        ],
        "Please call me"
      ),
      env
    );
    expect(unescape(sent[0].text)).toContain(
      "👤 From: Website <noreply@hoibit.nl>\n↩️ Reply-To: Visitor <visitor@example.org>\n"
    );
  });

  it("leaves Reply-To out when it equals From", async () => {
    await worker.email(
      mail(
        [
          "From: alice@example.com",
          "Reply-To: Alice@Example.com",
          "To: info@hoibit.nl",
          "Subject: Same",
          "Content-Type: text/plain; charset=utf-8"
        ],
        "Hi"
      ),
      env
    );
    expect(sent[0].text).not.toContain("Reply-To");
  });

  it("E7 mentions attachments by name", async () => {
    const body = [
      "--XYZ",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See the attached quote",
      "--XYZ",
      "Content-Type: application/pdf; name=offerte.pdf",
      "Content-Disposition: attachment; filename=offerte.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
      "--XYZ",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment",
      "Content-Transfer-Encoding: base64",
      "",
      "AAAA",
      "--XYZ--"
    ].join("\r\n");
    await worker.email(
      mail(
        [
          "From: alice@example.com",
          "To: info@hoibit.nl",
          "Subject: Quote",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="XYZ"'
        ],
        body
      ),
      env
    );
    expect(unescape(sent[0].text)).toContain("📝 Subject: Quote\n📎 Attachments: offerte.pdf, (unnamed)\n\n");
    expect(sent[0].text).toContain("See the attached quote");
  });

  it("E8 shows undisclosed recipients without 'undefined'", async () => {
    await worker.email(
      mail(
        [
          "From: alice@example.com",
          "To: undisclosed-recipients:;",
          "Subject: Bcc",
          "Content-Type: text/plain; charset=utf-8"
        ],
        "Hi"
      ),
      env
    );
    expect(sent[0].text).not.toContain("undefined");
    expect(sent[0].text).toContain("📬 To: undisclosed-recipients\n");
  });

  it("shows a group with its members", async () => {
    await worker.email(
      mail(
        [
          "From: alice@example.com",
          "To: Board: Bob <bob@example.com>, carol@example.com;",
          "Subject: Group",
          "Content-Type: text/plain; charset=utf-8"
        ],
        "Hi"
      ),
      env
    );
    expect(unescape(sent[0].text)).toContain("📬 To: Board: Bob <bob@example.com>, carol@example.com\n");
  });
});

describe("fetch handler", () => {
  it("refuses HTTP traffic", async () => {
    const res = await worker.fetch();
    expect(res.status).toBe(403);
  });
});
