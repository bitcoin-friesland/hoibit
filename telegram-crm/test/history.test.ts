import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAdmin,
  callbackAnswers,
  chatAs,
  lastKeyboardMessage,
  messageById,
  resetAndStubFetch,
  workerEnv,
  type SentMessage
} from "./harness";

const ADMIN = 5001;
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

// Cafe Satoshi with Anna; count conversations with Anna, one a day from 2026-01-01 on, each
// with a note of noteLength characters that says which one it is.
async function seed(adminId: number, count: number, noteLength = 40) {
  const org = await crm.newOrg({ name: "Cafe Satoshi", status: 1, created_by: adminId });
  if (!org.ok) throw new Error(org.error);
  const anna = await crm.newContact({ name: "Anna", type: "entrepreneur", organization_id: org.id });
  if (!anna.ok) throw new Error(anna.error);
  for (let i = 1; i <= count; i++) {
    const day = new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10);
    const note = `Talk ${i} `.padEnd(noteLength, "x");
    const res = await crm.logConversation({
      contact_id: anna.id,
      channel: "phone",
      note,
      happened_on: day,
      created_by: adminId
    });
    if (!res.ok) throw new Error(res.error);
  }
  return { orgId: org.id, annaId: anna.id };
}

const addNotes = (orgId: number, notes: string[]) =>
  env.DB.batch(
    notes.map(note =>
      env.DB.prepare("INSERT INTO organization_notes (organization_id, note) VALUES (?, ?)").bind(orgId, note)
    )
  );

// The numbers of the talks on a page, in the order shown.
const talks = (text: string) => [...text.matchAll(/Talk (\d+) /g)].map(m => Number(m[1]));

describe("📜 Conversations", () => {
  it("shows the notes and all conversations in full, the most recent first", async () => {
    const adminId = await addAdmin(ADMIN);
    const { orgId } = await seed(adminId, 7, 200);
    const longNote = `Owner wants to think about it. ${"y".repeat(200)}`;
    await addNotes(orgId, ["First note", longNote]);
    const chat = chatAs(ADMIN);

    await chat.press(`show:o:${orgId}`);
    expect(lastText()).toContain("…");
    expect(lastButtons()).toContainEqual({ text: "📜 Conversations", callback_data: `hist:o:${orgId}:0` });

    await chat.press(`hist:o:${orgId}:0`);
    const page = lastText();
    expect(page).toMatch(/^📜 🏢 Cafe Satoshi\n\n📝 Notes:\n• First note\n• Owner wants/u);
    expect(page).toContain(`• ${longNote}\n\n💬 Conversations:\n• 2026-01-07 · Anna · Phone (Admin): Talk 7 `);
    expect(talks(page)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(page).toContain(`Talk 1 ${"x".repeat(193)}`);
    expect(page).not.toContain("…");
    expect(lastButtons()).toEqual([]);
  });

  it("spreads a long history over messages under Telegram's limit, with ⬅️ Older", async () => {
    const adminId = await addAdmin(ADMIN);
    const { annaId } = await seed(adminId, 30, 400);
    const chat = chatAs(ADMIN);

    await chat.press(`show:c:${annaId}`);
    expect(lastButtons()).toContainEqual({ text: "📜 Conversations", callback_data: `hist:c:${annaId}:0` });
    await chat.press(`hist:c:${annaId}:0`);
    const shown: number[] = [];
    let pages = 0;
    for (;;) {
      const page = lastText();
      expect(page.length).toBeLessThanOrEqual(4096);
      expect(page).toMatch(
        pages === 0 ? /^📜 👤 Anna\n\n💬 Conversations:\n/u : /^📜 👤 Anna, older\n\n💬 Conversations:\n/u
      );
      shown.push(...talks(page));
      pages++;
      const older = lastButtons();
      if (older.length === 0) break;
      expect(older).toEqual([{ text: "⬅️ Older", callback_data: `hist:c:${annaId}:${shown.length}` }]);
      const pressed = lastKeyboardMessage(ADMIN)!.message_id;
      await chat.press(older[0].callback_data!, { messageId: pressed });
      // The pressed Older button goes once the next page is there.
      expect(messageById(pressed)?.reply_markup?.inline_keyboard.flat() ?? []).toEqual([]);
    }
    expect(pages).toBeGreaterThan(2);
    expect(shown).toEqual(Array.from({ length: 30 }, (_, i) => 30 - i));
  });

  it("cuts a note too long for one message, and goes on with the rest", async () => {
    const adminId = await addAdmin(ADMIN);
    const { orgId } = await seed(adminId, 1);
    await addNotes(orgId, ["z".repeat(5000), "Second note"]);
    const chat = chatAs(ADMIN);

    await chat.press(`hist:o:${orgId}:0`);
    expect(lastText()).toHaveLength(4096);
    expect(lastText()).toMatch(/z…$/);
    expect(lastButtons()).toEqual([{ text: "⬅️ Older", callback_data: `hist:o:${orgId}:1` }]);
    await chat.press(`hist:o:${orgId}:1`);
    expect(lastText()).toMatch(
      /^📜 🏢 Cafe Satoshi, older\n\n📝 Notes:\n• Second note\n\n💬 Conversations:\n• 2026-01-01 /u
    );
    expect(lastButtons()).toEqual([]);
  });

  it("is not on a card without conversations or notes, and says so for a deleted record", async () => {
    await addAdmin(ADMIN);
    const org = await crm.newOrg({ name: "Empty Shop", status: 1 });
    if (!org.ok) throw new Error(org.error);
    const chat = chatAs(ADMIN);
    await chat.press(`show:o:${org.id}`);
    expect(lastButtons().map(b => b.text)).not.toContain("📜 Conversations");
    await chat.press(`hist:o:${org.id}:0`);
    expect(lastText()).toBe("📜 🏢 Empty Shop\n\nNo conversations logged yet.");
    await chat.press("hist:c:9999:0");
    expect(callbackAnswers().at(-1)?.text).toBe("This no longer exists.");
  });
});
