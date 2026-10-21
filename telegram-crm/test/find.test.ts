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
  const org = await crm.newOrg({ name: "Cafe Satoshi", status: 2, website: "satoshi.cafe", created_by: adminId });
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
      /^🏢 Cafe Satoshi\n🏷️ Accepts Bitcoin\n🌐 satoshi\.cafe\n👤 Anna\n\nRecent conversations:\n• \d{4}-\d\d-\d\d · Anna · Phone \(Admin\): Wants a terminal$/u
    );
    expect(lastButtons()).toEqual([
      { text: "✏️ Edit", callback_data: `edit:o:${orgId}` },
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
      "✏️ Edit organization\n\n🏢 Name: Cafe Satoshi\n🌐 Website: satoshi.cafe\n🟣 Nostr: —"
    );
    await chat.press("card:organization");
    await chat.text("Café Satoshi");
    await chat.press("card:organization_website");
    await chat.press("card:remove");
    await chat.press("card:save");
    expect(sent.at(-2)?.text).toBe('✅ "Café Satoshi" updated.');
    expect(await crm.organizationDetails(orgId)).toMatchObject({ name: "Café Satoshi", website: null, status: 2 });
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
