import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAdmin,
  addMember,
  callbackAnswers,
  chatAs,
  groupChat,
  lastKeyboardMessage,
  resetAndStubFetch,
  sessionOf,
  workerEnv,
  type SentMessage
} from "./harness";

const ADMIN = 5001;
const MEMBER = 5002;
let sent: SentMessage[];
const crm = workerEnv.crmApi;

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

const lastText = () => sent[sent.length - 1]?.text;
const buttonsOf = (message: SentMessage | undefined) =>
  message?.reply_markup
    ? (JSON.parse(message.reply_markup).inline_keyboard as { text: string; callback_data?: string }[][]).flat()
    : [];
const lastButtons = () => buttonsOf(sent[sent.length - 1]);

// Cafe Satoshi (accepts Bitcoin) with Anna, who has an email address and one conversation.
async function seed(adminId: number) {
  const org = await crm.newOrg({
    name: "Cafe Satoshi",
    status: 2,
    website: "satoshi.cafe",
    created_by: adminId,
    team_member_ids: [adminId]
  });
  if (!org.ok) throw new Error(org.error);
  const anna = await crm.newContact({
    name: "Anna",
    type: "entrepreneur",
    organization_id: org.id,
    email: "anna@satoshi.cafe",
    created_by: adminId
  });
  if (!anna.ok) throw new Error(anna.error);
  await crm.logConversation({ contact_id: anna.id, channel: "phone", note: "Wants a terminal", created_by: adminId });
  return { orgId: org.id, annaId: anna.id };
}

describe("/find", () => {
  it("asks for a name, lists what matches and opens a contact's card", async () => {
    const adminId = await addAdmin(ADMIN);
    const { orgId, annaId } = await seed(adminId);
    await crm.newContact({ name: "Hannah", type: "consumer" });
    const chat = chatAs(ADMIN);

    await chat.text("/find");
    expect(lastText()).toMatch(/Who or what are you looking for/);
    await chat.text("an");
    expect(lastText()).toBe('Found for "an":');
    expect(lastButtons()).toEqual([
      { text: "👤 Anna (Cafe Satoshi)", callback_data: `show:c:${annaId}` },
      { text: "👤 Hannah", callback_data: expect.stringMatching(/^show:c:\d+$/) }
    ]);
    expect(sessionOf(ADMIN)).toBeUndefined();

    await chat.press(`show:c:${annaId}`);
    const card = lastText();
    expect(card).toContain("👤 Anna\n🏷️ Entrepreneur · 🏢 Cafe Satoshi\n📧 anna@satoshi.cafe");
    expect(card).toMatch(/Recent conversations:\n• \d{4}-\d\d-\d\d · Phone \(Admin\): Wants a terminal/);
    expect(lastButtons()).toEqual([
      { text: "✏️ Edit", callback_data: `edit:c:${annaId}` },
      { text: "💬 Log conversation", callback_data: `log:${annaId}` },
      { text: "🏢 Cafe Satoshi", callback_data: `show:o:${orgId}` }
    ]);
  });

  it("shows the only match right away, also for the name typed after /find", async () => {
    const adminId = await addAdmin(ADMIN);
    const { orgId, annaId } = await seed(adminId);
    await chatAs(ADMIN).text("/find satoshi");
    expect(lastText()).toMatch(
      /^🏢 Cafe Satoshi\n🏷️ Accepts Bitcoin\n🌐 satoshi\.cafe\n🤝 Admin\n👤 Anna\n\nRecent conversations:\n• \d{4}-\d\d-\d\d · Anna · Phone \(Admin\): Wants a terminal$/u
    );
    expect(lastButtons()).toEqual([
      { text: "✏️ Edit", callback_data: `edit:o:${orgId}` },
      { text: "📊 Status", callback_data: `status:${orgId}` },
      { text: "💬 Log conversation", callback_data: `log:o:${orgId}` },
      { text: "⏰ Follow-up", callback_data: `fu:${orgId}` },
      { text: "👤 Anna", callback_data: `show:c:${annaId}` }
    ]);
    expect(sessionOf(ADMIN)).toBeUndefined();
  });

  it("keeps asking when nothing matches", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/find Zed");
    expect(lastText()).toBe('Nothing found for "Zed". Type another name.');
    expect(sessionOf(ADMIN)?.step).toBe("find_query");
    await chat.text("x");
    expect(lastText()).toBe("❌ Please type at least 2 letters of the name.");
  });

  it("is in the main menu and the command list", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/help");
    expect(lastText()).toContain("/find - Look up a contact or organization");
    expect(lastButtons()).toContainEqual({ text: "🔎 Find", callback_data: "menu:find" });
    await chat.press("menu:find");
    expect(lastText()).toMatch(/Who or what are you looking for/);
  });

  it("card buttons work for any member, also on an old card in a group", async () => {
    const adminId = await addAdmin(ADMIN);
    await addMember(MEMBER);
    const { annaId } = await seed(adminId);
    const group = groupChat();
    await group.as(ADMIN).text("/find Anna");
    const cardId = lastKeyboardMessage(group.id)!.message_id;
    await group.as(MEMBER).press(`show:c:${annaId}`, { messageId: cardId });
    expect(lastText()).toMatch(/^👤 Anna\n/);
    await group.as(MEMBER).press(`show:c:9999`, { messageId: cardId });
    expect(callbackAnswers().at(-1)?.text).toBe("This no longer exists.");
  });
});

describe("editing from a card", () => {
  it("changes a contact's details and saves only what changed", async () => {
    const adminId = await addAdmin(ADMIN);
    const { annaId } = await seed(adminId);
    const chat = chatAs(ADMIN);
    await chat.press(`edit:c:${annaId}`);
    expect(lastText()).toBe(
      [
        "✏️ Edit contact",
        "",
        "👤 Name: Anna",
        "📧 Email: anna@satoshi.cafe",
        "📞 Phone: —",
        "🟣 Nostr: —",
        "🏷️ Type: Entrepreneur",
        "🏢 Organization: Cafe Satoshi",
        "",
        "Tap a detail to change it, then Save."
      ].join("\n")
    );
    await chat.press("card:name");
    // A name can be changed, not removed.
    expect(lastButtons().map(b => b.text)).toEqual(["⬅️ Back", "✖️ Cancel"]);
    await chat.text("Anna de Vries");
    await chat.press("card:phone");
    await chat.text("06 12345678");
    await chat.press("card:save");
    expect(sent.at(-2)?.text).toBe('✅ "Anna de Vries" updated.');
    expect(lastText()).toContain(
      "👤 Anna de Vries\n🏷️ Entrepreneur · 🏢 Cafe Satoshi\n📧 anna@satoshi.cafe\n📞 +31612345678"
    );
    expect(sessionOf(ADMIN)).toBeUndefined();

    const audit = await env.DB.prepare(
      "SELECT performed_by, change_details FROM audit_log WHERE table_name = 'contacts' AND action = 'update'"
    ).first<{ performed_by: number; change_details: string }>();
    expect(audit!.performed_by).toBe(adminId);
    expect(JSON.parse(audit!.change_details)).toEqual({
      fields: {
        name: { old: "Anna", new: "Anna de Vries" },
        phone: { old: null, new: "+31612345678" }
      }
    });
  });

  it("changes an organization's name and removes its website", async () => {
    const adminId = await addAdmin(ADMIN);
    const { orgId } = await seed(adminId);
    const chat = chatAs(ADMIN);
    await chat.press(`edit:o:${orgId}`);
    expect(lastText()).toContain(
      "✏️ Edit organization\n\n🏢 Name: Cafe Satoshi\n🏪 Kind of business: —\n🏠 Address: —\n📞 Phone: —\n📧 Email: —\n🌐 Website: satoshi.cafe\n🟣 Nostr: —"
    );
    await chat.press("card:organization");
    await chat.text("Café Satoshi");
    await chat.press("card:organization_website");
    await chat.press("card:remove");
    await chat.press("card:save");
    expect(sent.at(-2)?.text).toBe('✅ "Café Satoshi" updated.');
    expect(await crm.organizationDetails(orgId)).toMatchObject({ name: "Café Satoshi", website: null, status: 2 });
  });

  it("changes a contact's type and organization, and unlinks it", async () => {
    const adminId = await addAdmin(ADMIN);
    const { annaId } = await seed(adminId);
    const other = await crm.newOrg({ name: "Bitcoin Bakery", status: 1, created_by: adminId });
    if (!other.ok) throw new Error(other.error);
    const chat = chatAs(ADMIN);
    await chat.press(`edit:c:${annaId}`);
    await chat.press("card:type");
    expect(lastText()).toBe("Is Anna a consumer or an entrepreneur?");
    await chat.press("type:consumer");
    expect(lastText()).toContain("🏷️ Type: Consumer\n🏢 Organization: Cafe Satoshi");
    await chat.press("card:contact_organization");
    expect(lastButtons().map(b => b.text)).toEqual(["⬅️ Back", "🗑️ Unlink", "✖️ Cancel"]);
    await chat.text("Nothing like it");
    expect(lastText()).toContain('No organization found with the name "Nothing like it".');
    await chat.text("bakery");
    expect(lastButtons().map(b => b.callback_data)).toEqual([`select_org:${other.id}`, "card:back", "cancel"]);
    await chat.press(`select_org:${other.id}`);
    expect(lastText()).toContain("🏷️ Type: Consumer\n🏢 Organization: Bitcoin Bakery");
    await chat.press("card:save");
    expect(sent.at(-2)?.text).toBe('✅ "Anna" updated.');
    expect(await crm.contactDetails(annaId)).toMatchObject({ type: "consumer", organization_id: other.id });
    const audit = await env.DB.prepare(
      "SELECT change_details FROM audit_log WHERE table_name = 'contacts' AND action = 'update'"
    ).first<{ change_details: string }>();
    expect(JSON.parse(audit!.change_details)).toEqual({
      fields: {
        type: { old: "entrepreneur", new: "consumer" },
        organization_id: { old: expect.any(Number), new: other.id }
      }
    });

    await chat.press(`edit:c:${annaId}`);
    await chat.press("card:contact_organization");
    await chat.press("card:remove");
    expect(lastText()).toContain("🏢 Organization: —");
    await chat.press("card:save");
    expect(await crm.contactDetails(annaId)).toMatchObject({ organization_id: null });
  });

  it("changes an organization's communities and location", async () => {
    sent = await resetAndStubFetch({
      nominatim: [
        {
          osm_type: "node",
          osm_id: 42,
          class: "amenity",
          type: "cafe",
          display_name: "Cafe Satoshi, Leeuwarden",
          address: { road: "Nieuwestad", city: "Leeuwarden" }
        }
      ]
    });
    const adminId = await addAdmin(ADMIN);
    const { orgId } = await seed(adminId);
    await env.DB.prepare("INSERT INTO organization_communities (organization_id, community_id) VALUES (?, 1)")
      .bind(orgId)
      .run();
    const chat = chatAs(ADMIN);
    await chat.press(`edit:o:${orgId}`);
    expect(lastText()).toContain("👥 Communities: Hard Money Cafe\n🤝 Handled by: Admin\n📍 Location: —");

    await chat.press("card:communities");
    expect(lastText()).toBe("Select Bitcoin communities for this organization:");
    expect(lastButtons()[0].text).toBe("✅ Hard Money Cafe");
    await chat.press("community:1");
    await chat.press("choose_other");
    await chat.press("country:0");
    await chat.press("community:2");
    await chat.press("done");
    expect(lastText()).toContain("👥 Communities: Arnhem Bitcoinstad");

    await chat.press("card:location");
    expect(lastText()).toContain('Which place on OpenStreetMap is "Cafe Satoshi"?');
    expect(lastButtons().map(b => b.text)).toEqual([
      "1. Cafe Satoshi – Nieuwestad, Leeuwarden",
      "🔍 Search another name",
      "⬅️ Back",
      "✖️ Cancel"
    ]);
    await chat.press("osmnode:node/42");
    expect(lastText()).toContain("📍 Location: Cafe Satoshi – Nieuwestad, Leeuwarden");
    await chat.press("card:save");
    expect(sent.at(-2)?.text).toBe('✅ "Cafe Satoshi" updated.');
    expect(await crm.organizationDetails(orgId)).toMatchObject({
      location_osm_id: "node/42",
      communities: ["Arnhem Bitcoinstad"]
    });

    await chat.press(`edit:o:${orgId}`);
    expect(lastText()).toContain("📍 Location: https://www.openstreetmap.org/node/42");
    await chat.press("card:location");
    await chat.press("card:remove");
    expect(lastText()).toContain("📍 Location: —");
    await chat.press("card:save");
    expect((await crm.organizationDetails(orgId))!.location_osm_id).toBeNull();
  });

  it("goes back to the card without changes", async () => {
    const adminId = await addAdmin(ADMIN);
    const { orgId } = await seed(adminId);
    const chat = chatAs(ADMIN);
    await chat.press(`edit:o:${orgId}`);
    await chat.press("card:communities");
    await chat.press("skip");
    await chat.press("card:location");
    expect(lastText()).toBe('Nothing found on OpenStreetMap for "Cafe Satoshi".');
    await chat.press("osm:search");
    await chat.press("card:back");
    await chat.press("card:save");
    expect(sent.at(-2)?.text).toBe("Nothing changed.");
  });

  it("saves nothing when nothing changed", async () => {
    const adminId = await addAdmin(ADMIN);
    const { annaId } = await seed(adminId);
    const chat = chatAs(ADMIN);
    await chat.press(`edit:c:${annaId}`);
    await chat.press("card:save");
    expect(sent.at(-2)?.text).toBe("Nothing changed.");
    const updates = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'update'").first();
    expect(updates).toEqual({ n: 0 });
  });

  it("says so when the contact no longer exists", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).press("edit:c:9999");
    expect(lastText()).toBe("❌ This no longer exists.");
    expect(sessionOf(ADMIN)).toBeUndefined();
  });
});
