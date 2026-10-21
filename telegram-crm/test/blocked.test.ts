import { beforeEach, describe, expect, it } from "vitest";
import {
  addAdmin,
  addMember,
  blockSender,
  callbackAnswers,
  chatAs,
  lastKeyboardMessage,
  messageById,
  resetAndStubFetch,
  type SentMessage
} from "./harness";

const ADMIN = 5001;
const MEMBER = 5002;
let sent: SentMessage[];

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

const lastText = () => sent[sent.length - 1]?.text;
const DAY = 24 * 3_600_000;

describe("/blocked", () => {
  it("lists the blocked senders, the most recent first, and unblocks one in place", async () => {
    await addAdmin(ADMIN);
    blockSender(1, "old@example.org", Date.UTC(2026, 9, 1));
    blockSender(2, "pitch@example.net", Date.UTC(2026, 9, 21));
    const chat = chatAs(ADMIN);
    await chat.text("/blocked");
    expect(lastText()).toBe(
      [
        "🚫 Blocked email senders: 2. Their emails are dropped. Tap one to let them through again.",
        "",
        "• pitch@example.net, since 2026-10-21",
        "• old@example.org, since 2026-10-01"
      ].join("\n")
    );
    const listId = lastKeyboardMessage(ADMIN)!.message_id;
    expect(messageById(listId)!.reply_markup!.inline_keyboard).toEqual([
      [{ text: "✅ Unblock pitch@example.net", callback_data: "unblock:2" }],
      [{ text: "✅ Unblock old@example.org", callback_data: "unblock:1" }]
    ]);

    const before = sent.length;
    await chat.press("unblock:2");
    expect(sent).toHaveLength(before);
    expect(callbackAnswers().at(-1)).toMatchObject({ text: "pitch@example.net is no longer blocked." });
    expect(messageById(listId)!.text).toMatch(/^🚫 Blocked email senders: 1\./);
    expect(messageById(listId)!.reply_markup!.inline_keyboard).toEqual([
      [{ text: "✅ Unblock old@example.org", callback_data: "unblock:1" }]
    ]);

    await chat.press("unblock:1", { messageId: listId });
    expect(messageById(listId)!.text).toBe("No email senders are blocked.");
    expect(messageById(listId)!.reply_markup!.inline_keyboard).toEqual([]);
    await chat.press("unblock:1", { messageId: listId });
    expect(callbackAnswers().at(-1)).toMatchObject({ text: "That sender was already unblocked." });
  });

  it("says so when nobody is blocked, and shows at most 20", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/blocked");
    expect(lastText()).toBe("No email senders are blocked.");
    expect(sent.at(-1)?.reply_markup).toBeUndefined();
    for (let i = 1; i <= 25; i++) blockSender(i, `s${i}@example.org`, i * DAY);
    await chat.text("/blocked");
    expect(lastText()).toMatch(
      /^🚫 Blocked email senders: 25\.[^\n]*\nShowing the 20 blocked most recently\.\n\n• s25@/
    );
  });

  it("is for admins only", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    blockSender(1, "old@example.org", DAY);
    const chat = chatAs(MEMBER);
    await chat.text("/blocked");
    expect(lastText()).toBe("Only admins can see and unblock blocked email senders.");
    await chat.press("unblock:1");
    expect(callbackAnswers().at(-1)).toMatchObject({ text: "Only admins can see and unblock blocked email senders." });
    await chatAs(ADMIN).text("/blocked");
    expect(lastText()).toContain("old@example.org");
  });
});
