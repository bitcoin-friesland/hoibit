import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAdmin,
  addMember,
  callbackAnswers,
  chatAs,
  groupChat,
  lastKeyboardMessage,
  messageById,
  resetAndStubFetch,
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
const lastButtons = () =>
  sent.at(-1)?.reply_markup
    ? (JSON.parse(sent.at(-1)!.reply_markup!).inline_keyboard as { text: string; callback_data: string }[][]).flat()
    : [];
const statusOf = async (orgId: number) => (await crm.organizationDetails(orgId, 0))?.status;

// Cafe Satoshi, curious about Bitcoin, with entrepreneur Anna.
async function seed() {
  const org = await crm.newOrg({ name: "Cafe Satoshi", status: 1 });
  if (!org.ok) throw new Error(org.error);
  const anna = await crm.newContact({ name: "Anna", type: "entrepreneur", organization_id: org.id });
  if (!anna.ok) throw new Error(anna.error);
  return { orgId: org.id, annaId: anna.id };
}

describe("organization status", () => {
  it("is changed from the organization's card", async () => {
    const adminId = await addAdmin(ADMIN);
    const { orgId } = await seed();
    const chat = chatAs(ADMIN);
    await chat.text("/find Cafe");
    await chat.press(`status:${orgId}`);
    expect(lastText()).toBe('What is the Bitcoin status of "Cafe Satoshi"? It is now: Curious about Bitcoin.');
    expect(lastButtons()).toEqual([
      { text: "✓ Curious about Bitcoin", callback_data: `status:${orgId}:1` },
      { text: "Accepts Bitcoin", callback_data: `status:${orgId}:2` },
      { text: "Not Interested", callback_data: `status:${orgId}:3` },
      { text: "Stopped Accepting Bitcoin", callback_data: `status:${orgId}:4` }
    ]);
    const questionId = lastKeyboardMessage(ADMIN)!.message_id;
    const before = sent.length;
    await chat.press(`status:${orgId}:2`);
    expect(sent).toHaveLength(before);
    expect(callbackAnswers().at(-1)).toMatchObject({ text: "Status saved." });
    expect(await statusOf(orgId)).toBe(2);
    const question = messageById(questionId);
    expect(question?.text).toMatch(/It is now: Curious about Bitcoin\.\n\n➡️ Accepts Bitcoin$/);
    expect(question?.reply_markup?.inline_keyboard.flat() ?? []).toEqual([]);

    const audit = await env.DB.prepare(
      "SELECT performed_by, change_details FROM audit_log WHERE table_name = 'organizations' AND action = 'update'"
    ).first<{ performed_by: number; change_details: string }>();
    expect(audit!.performed_by).toBe(adminId);
    expect(JSON.parse(audit!.change_details)).toEqual({ fields: { status: { old: 1, new: 2 } } });
  });

  it("says when the chosen status is the current one", async () => {
    await addAdmin(ADMIN);
    const { orgId } = await seed();
    const chat = chatAs(ADMIN);
    await chat.press(`status:${orgId}`);
    const questionId = lastKeyboardMessage(ADMIN)!.message_id;
    await chat.press(`status:${orgId}:1`);
    expect(callbackAnswers().at(-1)).toMatchObject({ text: "Status saved." });
    expect(messageById(questionId)?.text).toMatch(/➡️ Curious about Bitcoin \(unchanged\)$/);
    const updates = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'update'").first();
    expect(updates).toEqual({ n: 0 });
  });

  it("can be set by any member in a group", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    const { orgId } = await seed();
    const group = groupChat();
    await group.as(ADMIN).press(`status:${orgId}`);
    await group.as(MEMBER).press(`status:${orgId}:3`);
    expect(await statusOf(orgId)).toBe(3);
  });

  it("is offered after a conversation with an entrepreneur, not with a consumer", async () => {
    await addAdmin(ADMIN);
    const { orgId, annaId } = await seed();
    const chat = chatAs(ADMIN);
    await chat.press(`log:${annaId}`);
    await chat.press("channel:in-person");
    await chat.press("date:today");
    await chat.text("Will try Lightning next month");
    expect(lastText()).toBe("✅ Conversation with Anna (Cafe Satoshi) (In Person, today) logged.");
    expect(lastButtons()).toEqual([{ text: "📊 Update status of Cafe Satoshi", callback_data: `status:${orgId}` }]);

    const bob = await crm.newContact({ name: "Bob", type: "consumer" });
    if (!bob.ok) throw new Error(bob.error);
    await chat.press(`log:${bob.id}`);
    await chat.press("channel:phone");
    await chat.press("date:today");
    await chat.text("Asked about wallets");
    expect(lastText()).toBe("✅ Conversation with Bob (Phone, today) logged.");
    expect(lastButtons()).toEqual([]);
  });

  it("tells when the organization no longer exists", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).press("status:9999");
    expect(callbackAnswers().at(-1)).toMatchObject({ text: "This no longer exists." });
    await chatAs(ADMIN).press("status:9999:2");
    expect(callbackAnswers().at(-1)).toMatchObject({ show_alert: true });
  });
});
