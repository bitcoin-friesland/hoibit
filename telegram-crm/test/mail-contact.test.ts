import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addAdmin, chatAs, emailFrom, resetAndStubFetch, sessionOf, type SentMessage } from "./harness";

const ADMIN = 5001;
let sent: SentMessage[];

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

const lastText = () => sent[sent.length - 1]?.text;

describe("➕ Contact under an email", () => {
  it("starts /newcontact with the sender's name and email address", async () => {
    await addAdmin(ADMIN);
    emailFrom(7, { address: "anna@example.com", name: "Anna de Vries" });
    const chat = chatAs(ADMIN);
    await chat.text("/start mc_7");
    expect(sent.at(-2)?.text).toBe("➕ New contact from email: Anna de Vries <anna@example.com>");
    expect(lastText()).toBe("Is Anna de Vries a consumer or an entrepreneur?");
    await chat.press("consumer");
    expect(lastText()).toContain("📧 Email: anna@example.com");
    await chat.press("card:save");
    expect(lastText()).toBe('✅ Contact "Anna de Vries" added.');
    const email = await env.DB.prepare(
      "SELECT e.email FROM contact_emails e JOIN contacts c ON c.id = e.contact_id WHERE c.name = 'Anna de Vries'"
    ).first();
    expect(email).toEqual({ email: "anna@example.com" });
  });

  it("asks for the name when the email's name is no contact name", async () => {
    await addAdmin(ADMIN);
    emailFrom(8, { address: "info@acme.example", name: "ACME B.V. | Sales 24/7" });
    const chat = chatAs(ADMIN);
    await chat.text("/start mc_8");
    expect(sent.at(-2)?.text).toBe("➕ New contact from email: ACME B.V. | Sales 24/7 <info@acme.example>");
    expect(lastText()).toBe("What is the contact name?");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_name", email: "info@acme.example" });
    await chat.text("Piet Jansen");
    expect(lastText()).toBe("Is Piet Jansen a consumer or an entrepreneur?");
  });

  it("starts a plain /newcontact when the sender is no longer known", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).text("/start mc_9");
    expect(sent.at(-2)?.text).toBe("ℹ️ The sender of that email is no longer known.");
    expect(lastText()).toBe("What is the contact name?");
    expect(sessionOf(ADMIN)?.email).toBeUndefined();
  });

  it("tells someone outside the team to ask for an invite", async () => {
    await addAdmin(ADMIN);
    emailFrom(7, { address: "anna@example.com", name: "Anna" });
    await chatAs(6001).text("/start mc_7");
    expect(lastText()).toBe("You're not on the team yet. To join, ask an admin for an invite link.");
  });
});
