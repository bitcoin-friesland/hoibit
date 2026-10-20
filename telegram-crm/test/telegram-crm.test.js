import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addAdmin, chatAs, resetAndStubFetch } from "./harness.js";

const ADMIN = 5001;
let sent;

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

const lastText = () => sent[sent.length - 1].text;

describe("webhook", () => {
  it("rejects updates without the webhook secret", async () => {
    const res = await chatAs(ADMIN).text("/help", { secret: null });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("tells an unknown user they are not authorized", async () => {
    await addAdmin(ADMIN);
    const res = await chatAs(6001).text("/help");
    expect(res.status).toBe(403);
    expect(lastText()).toContain("not authorized");
  });
});

describe("/newcontact", () => {
  it("saves a consumer with email and phone", async () => {
    const adminId = await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Alice");
    await chat.text("alice@example.com");
    await chat.text("+31612345678");
    await chat.press("skip");
    await chat.press("consumer");
    expect(lastText()).toBe('✅ Contact "Alice" added.');

    const contact = await env.DB.prepare(
      `SELECT c.name, c.type, c.organization_id, e.email, p.phone, a.performed_by
       FROM contacts c
       JOIN contact_emails e ON e.contact_id = c.id
       JOIN contact_phones p ON p.contact_id = c.id
       JOIN audit_log a ON a.table_name = 'contacts' AND a.record_id = CAST(c.id AS TEXT)`
    ).first();
    expect(contact).toEqual({
      name: "Alice",
      type: "consumer",
      organization_id: null,
      email: "alice@example.com",
      phone: "+31612345678",
      performed_by: adminId
    });
  });

  it("creates a new organization with a community and links the entrepreneur to it", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Bob");
    await chat.press("skip");
    await chat.press("skip");
    await chat.press("skip");
    await chat.press("entrepreneur");
    await chat.text("Cafe Satoshi");
    expect(lastText()).toBe('No organization found with the name "Cafe Satoshi".');
    await chat.press("create_org");
    await chat.press("accepts-bitcoin");
    await chat.text("https://cafe.example");
    await chat.press("skip");
    await chat.press("choose_other");
    await chat.press("country:0");
    // sendMessage serializes reply_markup; press the first community of the country
    const keyboard = JSON.parse(sent[sent.length - 1].reply_markup).inline_keyboard;
    await chat.press(keyboard[0][0].callback_data);
    await chat.press("done");
    expect(lastText()).toMatch(/^✅ Organization "Cafe Satoshi" and contact "Bob" added\. \(communities: .+\)$/);

    const row = await env.DB.prepare(
      `SELECT o.name, o.status, o.website, c.name AS contact, COUNT(oc.community_id) AS communities
       FROM organizations o
       JOIN contacts c ON c.organization_id = o.id
       LEFT JOIN organization_communities oc ON oc.organization_id = o.id`
    ).first();
    expect(row).toEqual({
      name: "Cafe Satoshi",
      status: 2,
      website: "https://cafe.example",
      contact: "Bob",
      communities: 1
    });
  });
});

describe("/invite", () => {
  it("is refused for non-admins", async () => {
    await addAdmin(ADMIN);
    await env.DB.prepare("INSERT INTO team_members (telegram_id, name) VALUES (?, ?)").bind("7001", "Member").run();
    await chatAs(7001).text("/invite");
    expect(lastText()).toBe("Only admins can manage team members.");
  });
});
