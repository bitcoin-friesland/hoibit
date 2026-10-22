import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CrmApi from "../../crm-api/src/index";
import { teamDay } from "../src/helpers/day";
import { escapeForOverpass } from "../src/helpers/osm";
import {
  addAdmin,
  callbackAnswers,
  chatAs,
  groupChat,
  lastKeyboardMessage,
  resetAndStubFetch,
  type SentMessage
} from "./harness";

const ADMIN = 5001;
let sent: SentMessage[];

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

  it("tells an unknown user how to join, without asking for their Telegram ID", async () => {
    await addAdmin(ADMIN);
    const res = await chatAs(6001).text("/help");
    // Any other status makes Telegram redeliver the update.
    expect(res.status).toBe(200);
    expect(lastText()).toBe("You're not on the team yet. To join, ask an admin for an invite link.");
  });

  it("tells each newcomer in a group once, not at every command", async () => {
    await addAdmin(ADMIN);
    const group = groupChat();
    await group.as(6001).text("/help");
    await group.as(6001).text("/newcontact");
    await group.as(6002).text("/help");
    expect(sent.map(m => m.text)).toEqual([
      "You're not on the team yet. To join, ask an admin for an invite link.",
      "You're not on the team yet. To join, ask an admin for an invite link."
    ]);
  });
});

describe("/newcontact", () => {
  it("saves a consumer with email and phone", async () => {
    const adminId = await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Alice");
    await chat.press("consumer");
    await chat.press("card:email");
    await chat.text("alice@example.com");
    await chat.press("card:phone");
    await chat.text("06 12345678");
    await chat.press("card:save");
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
    await chat.press("entrepreneur");
    await chat.text("Cafe Satoshi");
    expect(lastText()).toBe('No organization found with the name "Cafe Satoshi".');
    await chat.press("create_org");
    await chat.press("accepts-bitcoin");
    await chat.press("choose_other");
    await chat.press("country:0");
    // The picker shows the country in the same message; press its first community.
    const keyboard = lastKeyboardMessage(ADMIN)!.reply_markup!.inline_keyboard;
    await chat.press(keyboard[0][0].callback_data!);
    await chat.press("done");
    await chat.press("card:organization_website");
    await chat.text("https://cafe.example");
    await chat.press("card:save");
    expect(lastText()).toMatch(/^✅ Organization "Cafe Satoshi" and contact "Bob" added\. \(communities: .+\)\n/);

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

  it("links an entrepreneur to an existing organization", async () => {
    await addAdmin(ADMIN);
    const orgId = await env.DB.prepare(
      "INSERT INTO organizations (name, status) VALUES ('Cafe Satoshi', 2) RETURNING id"
    ).first<number>("id");
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Carol");
    await chat.press("entrepreneur");
    await chat.text("satoshi");
    expect(lastText()).toBe("Select an existing organization or create new:");
    await chat.press(`select_org:${orgId}`);
    expect(lastText()).toContain("🏢 Cafe Satoshi");
    await chat.press("card:save");
    expect(lastText()).toBe('✅ Contact "Carol" added to "Cafe Satoshi".');
    const contact = await env.DB.prepare("SELECT organization_id FROM contacts WHERE name = 'Carol'").first();
    expect(contact).toEqual({ organization_id: orgId });
  });

  it("stores the OpenStreetMap location the user picks", async () => {
    sent = await resetAndStubFetch({
      nominatim: [
        {
          osm_type: "node",
          osm_id: 42,
          class: "amenity",
          type: "cafe",
          display_name: "Cafe Satoshi, Leeuwarden",
          address: { road: "Nieuwestad", city: "Leeuwarden" },
          extratags: { amenity: "cafe", website: "https://cafe.example" }
        }
      ]
    });
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Dave");
    await chat.press("entrepreneur");
    await chat.text("Cafe Satoshi");
    await chat.press("create_org");
    await chat.press("accepts-bitcoin");
    await chat.press("skip");
    await chat.press("card:save");
    const choice = sent[sent.length - 1];
    expect(choice.parse_mode).toBe("HTML");
    expect(choice.text).toContain("<b>1. Cafe Satoshi</b>\ncafe · Nieuwestad, Leeuwarden");
    await chat.press("osmnode:node/42");
    expect(lastText()).toBe('✅ Organization "Cafe Satoshi" and contact "Dave" added. (📍 location linked)');
    const org = await env.DB.prepare("SELECT location_osm_id FROM organizations").first();
    expect(org).toEqual({ location_osm_id: "node/42" });
  });
});

describe("/logconversation", () => {
  async function addContact(name: string) {
    return env.DB.prepare("INSERT INTO contacts (name, type) VALUES (?, 'consumer') RETURNING id")
      .bind(name)
      .first<number>("id");
  }

  it("logs a conversation with the chosen contact and channel", async () => {
    const adminId = await addAdmin(ADMIN);
    const contactId = await addContact("Alice");
    await addContact("Bob");
    const chat = chatAs(ADMIN);
    await chat.text("/logconversation");
    expect(lastText()).toBe("Which contact did you talk to? Type part of the name.");
    await chat.text("ali");
    expect(lastText()).toBe("Select the contact:");
    expect(JSON.parse(sent[sent.length - 1].reply_markup!).inline_keyboard).toEqual([
      [{ text: "Alice", callback_data: `select_contact:${contactId}` }],
      [{ text: "✖️ Cancel", callback_data: "cancel" }]
    ]);
    await chat.press(`select_contact:${contactId}`);
    expect(lastText()).toBe("How did you talk to Alice?");
    await chat.press("channel:phone");
    expect(lastText()).toBe("When did you talk to Alice?");
    expect(
      JSON.parse(sent[sent.length - 1].reply_markup!)
        .inline_keyboard.flat()
        .map((b: { text: string }) => b.text)
    ).toEqual(["Today", "Yesterday", "📅 Other date", "✖️ Cancel"]);
    await chat.press("date:today");
    expect(lastText()).toBe("What was discussed? (minimum 5 characters)");
    await chat.text("Wants to accept Lightning payments");
    expect(lastText()).toBe("✅ Conversation with Alice (Phone, today) logged.");

    const row = await env.DB.prepare(
      `SELECT c.contact_id, c.channel, c.note, c.created_by, a.performed_by
       FROM conversations c
       JOIN audit_log a ON a.table_name = 'conversations' AND a.record_id = CAST(c.id AS TEXT)`
    ).first();
    expect(row).toEqual({
      contact_id: contactId,
      channel: "phone",
      note: "Wants to accept Lightning payments",
      created_by: adminId,
      performed_by: adminId
    });
    expect(await env.DB.prepare("SELECT happened_on FROM conversations").first()).toEqual({ happened_on: teamDay() });
  });

  it("logs a conversation of yesterday or of a typed date, and shows that day on the card", async () => {
    await addAdmin(ADMIN);
    const contactId = await addContact("Alice");
    const chat = chatAs(ADMIN);
    await chat.text("/logconversation");
    await chat.text("ali");
    await chat.press(`select_contact:${contactId}`);
    await chat.press("channel:phone");
    await chat.press("date:yesterday");
    await chat.text("Called back about the terminal");
    expect(lastText()).toBe("✅ Conversation with Alice (Phone, yesterday) logged.");

    await chat.text("/logconversation");
    await chat.text("ali");
    await chat.press(`select_contact:${contactId}`);
    await chat.press("channel:in-person");
    await chat.press("date:other");
    expect(lastText()).toBe("Type the date, like 14-10 or 14-10-2026.");
    await chat.text("31-12-2999");
    expect(lastText()).toBe('❌ "31-12-2999" is not a date that has passed. Type the date, like 14-10 or 14-10-2026.');
    // Typed straight away, without Other date, works as well.
    await chat.text("1-3-2025");
    await chat.text("Met at the meetup");
    expect(lastText()).toBe("✅ Conversation with Alice (In Person, 01-03-2025) logged.");

    const days = await env.DB.prepare("SELECT happened_on FROM conversations ORDER BY id").all();
    expect(days.results).toEqual([{ happened_on: teamDay(1) }, { happened_on: "2025-03-01" }]);
    await chat.text("/find alice");
    const card = sent.find(m => m.text?.startsWith("👤 Alice"));
    expect(card?.text).toContain(`• ${teamDay(1)} · Phone (Admin): Called back about the terminal`);
    expect(card?.text).toContain("• 2025-03-01 · In Person (Admin): Met at the meetup");
  });

  it("asks again when no contact matches or a button is not from the list", async () => {
    await addAdmin(ADMIN);
    const contactId = await addContact("Alice");
    const chat = chatAs(ADMIN);
    await chat.text("/logconversation");
    await chat.text("zed");
    expect(lastText()).toBe('No contact found with the name "zed". Type another name, or add them:');
    // A contact button of an older message no longer counts.
    const before = sent.length;
    await chat.press(`select_contact:${contactId}`, { messageId: 1 });
    expect(sent).toHaveLength(before);
    expect(callbackAnswers().at(-1)).toMatchObject({ text: "This button is no longer active." });
    await chat.text("alice");
    await chat.press("select_contact:999999");
    expect(lastText()).toBe("❌ Please choose a contact from the buttons, or type a name.");
    await chat.press(`select_contact:${contactId}`);
    await chat.press("channel:pigeon");
    expect(lastText()).toBe("❌ Please choose a channel from the buttons.");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first();
    expect(count).toEqual({ n: 0 });
  });
});

describe("/logconversation, quicker", () => {
  async function addContact(name: string, createdBy: number) {
    const res = await env.DB.prepare("INSERT INTO contacts (name, type) VALUES (?, 'consumer') RETURNING id")
      .bind(name)
      .first<number>("id");
    await env.DB.prepare(
      "INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES ('insert', 'contacts', ?, ?, '{}')"
    )
      .bind(String(res), createdBy)
      .run();
    return res!;
  }

  it("offers the contacts the member added recently, most recent first", async () => {
    const adminId = await addAdmin(ADMIN);
    await addContact("Anna", adminId);
    const bram = await addContact("Bram", adminId);
    const chat = chatAs(ADMIN);
    await chat.text("/logconversation");
    expect(lastText()).toBe(
      "Which contact did you talk to? Type part of the name.\nOr tap one you added or talked to recently:"
    );
    expect(
      lastKeyboardMessage(ADMIN)!
        .reply_markup!.inline_keyboard.slice(0, 2)
        .map(row => row[0].text)
    ).toEqual(["Bram", "Anna"]);
    await chat.press(`select_contact:${bram}`);
    expect(lastText()).toBe("How did you talk to Bram?");
  });

  it("adds a contact that was not found, then offers to log the conversation", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/logconversation");
    await chat.text("Zoë");
    await chat.press("add_contact");
    expect(lastText()).toBe("Is Zoë a consumer or an entrepreneur?");
    await chat.press("consumer");
    await chat.press("card:save");
    expect(lastText()).toBe('✅ Contact "Zoë" added.');
    expect(
      lastKeyboardMessage(ADMIN)!
        .reply_markup!.inline_keyboard.flat()
        .map(b => b.text)
    ).toEqual(["💬 Log conversation with Zoë"]);
  });

  it("keeps the note when saving fails, for Try again", async () => {
    const adminId = await addAdmin(ADMIN);
    const contactId = await addContact("Anna", adminId);
    const chat = chatAs(ADMIN);
    await chat.text("/logconversation");
    await chat.press(`select_contact:${contactId}`);
    await chat.press("channel:phone");
    await chat.press("date:today");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(CrmApi.prototype, "logConversation").mockRejectedValue(new Error("D1_ERROR: unavailable"));
    try {
      await chat.text("Wants a Lightning terminal");
      expect(lastText()).toBe("❌ Saving failed, nothing was saved. Your note is kept.");
    } finally {
      spy.mockRestore();
      error.mockRestore();
    }
    await chat.press("retry");
    expect(lastText()).toBe("✅ Conversation with Anna (Phone, today) logged.");
    expect(await env.DB.prepare("SELECT note FROM conversations").first()).toEqual({
      note: "Wants a Lightning terminal"
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

describe("/teammember", () => {
  it("grants admin rights to a team member", async () => {
    await addAdmin(ADMIN);
    const memberId = await env.DB.prepare(
      "INSERT INTO team_members (telegram_id, name) VALUES ('7001', 'Erin') RETURNING id"
    ).first<number>("id");
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("grant_admin");
    expect(lastText()).toBe("Who should get admin rights?");
    await chat.press(`member:${memberId}`);
    expect(lastText()).toBe("✅ Erin is now an admin.");
    const member = await env.DB.prepare("SELECT is_admin FROM team_members WHERE id = ?").bind(memberId).first();
    expect(member).toEqual({ is_admin: 1 });
  });
});

describe("escapeForOverpass", () => {
  it("matches the value literally inside a quoted Overpass regex", () => {
    expect(escapeForOverpass("cafe.example")).toBe("cafe\\\\.example");
    expect(escapeForOverpass('a"b')).toBe('a\\"b');
  });
});
