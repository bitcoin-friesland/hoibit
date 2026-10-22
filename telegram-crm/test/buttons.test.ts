import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAdmin,
  addMember,
  callbackAnswers,
  chatAs,
  lastKeyboardMessage,
  messageById,
  resetAndStubFetch,
  sessionOf,
  telegramCalls,
  type SentMessage
} from "./harness";

const ADMIN = 5001;
const MEMBER = 7001;
let sent: SentMessage[];

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

const lastText = () => sent[sent.length - 1]?.text;
const buttonsOf = (messageId: number) =>
  messageById(messageId)
    ?.reply_markup?.inline_keyboard.flat()
    .map(b => b.text) ?? [];

// /newcontact for consumer Alice, up to the question for her email address.
async function toEmailQuestion(chat: ReturnType<typeof chatAs>) {
  await chat.text("/newcontact");
  await chat.text("Alice");
  await chat.press("consumer");
  await chat.press("card:email");
  return lastKeyboardMessage(ADMIN)!.message_id;
}

describe("answered questions", () => {
  it("show the pressed button below the question and lose their buttons", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Alice");
    const question = lastKeyboardMessage(ADMIN)!.message_id;
    await chat.press("consumer");
    expect(messageById(question)).toMatchObject({ text: "Is Alice a consumer or an entrepreneur?\n\n➡️ Consumer" });
    expect(buttonsOf(question)).toEqual([]);
    expect(lastText()).toMatch(/^New contact:/);
  });

  it("lose their buttons when answered by text", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    const question = await toEmailQuestion(chat);
    await chat.text("alice@example.com");
    expect(messageById(question)?.text).toBe("What is the email address?");
    expect(buttonsOf(question)).toEqual([]);
  });

  it("keep their buttons when the answer is refused", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    const question = await toEmailQuestion(chat);
    await chat.text("not an email");
    expect(lastText()).toMatch(/^❌ /);
    expect(buttonsOf(question)).toEqual(["⬅️ Back", "✖️ Cancel"]);
    await chat.press("card:back", { messageId: question });
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_card" });
  });
});

describe("community picker", () => {
  it("changes in place and shows the chosen communities when done", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/neworg");
    await chat.text("Cafe Satoshi");
    await chat.press("accepts-bitcoin");
    const picker = lastKeyboardMessage(ADMIN)!.message_id;
    const before = sent.length;
    await chat.press("choose_other");
    expect(messageById(picker)?.text).toBe("Choose a country:");
    await chat.press("country:0");
    const first = messageById(picker)!.reply_markup!.inline_keyboard[0][0];
    await chat.press(first.callback_data!);
    expect(buttonsOf(picker)[0]).toBe(`✅ ${first.text}`);
    expect(sent).toHaveLength(before);
    await chat.press("done");
    expect(messageById(picker)?.text).toBe(`Select communities in Netherlands:\n\n➡️ ${first.text}`);
    expect(buttonsOf(picker)).toEqual([]);
  });
});

describe("cancel", () => {
  it("is a button on every question with buttons, and ends the flow", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    const question = await toEmailQuestion(chat);
    await chat.press("cancel");
    expect(sessionOf(ADMIN)).toBeUndefined();
    expect(messageById(question)?.text).toMatch(/\n\n➡️ Cancelled$/);
    expect(callbackAnswers().at(-1)).toMatchObject({ text: "Cancelled." });
  });

  it("as a command names what it stopped and takes the buttons away", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/cancel");
    expect(lastText()).toBe("There is nothing to cancel. Send /help to see what you can do.");
    await chat.text("/newcontact");
    await chat.text("Alice");
    const question = lastKeyboardMessage(ADMIN)!.message_id;
    await chat.text("/cancel");
    expect(lastText()).toBe("Your /newcontact was cancelled.");
    expect(buttonsOf(question)).toEqual([]);
  });
});

describe("starting something new", () => {
  it("says which unfinished flow it stopped", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Alice");
    const question = lastKeyboardMessage(ADMIN)!.message_id;
    await chat.text("/neworg");
    expect(lastText()).toBe("ℹ️ Your unfinished /newcontact was stopped.\n\nWhat is the name of the organization?");
    expect(buttonsOf(question)).toEqual([]);
    expect(sessionOf(ADMIN)).toMatchObject({ mode: "org" });
  });
});

describe("main menu", () => {
  it("greets on /start and starts a flow from a button", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN, { first_name: "Jan" });
    await chat.text("/start");
    expect(lastText()).toMatch(/^👋 Hi Jan! What do you want to do\?\n\nAvailable commands:/);
    expect(buttonsOf(lastKeyboardMessage(ADMIN)!.message_id)).toEqual([
      "➕ New contact",
      "🏢 New organization",
      "💬 Log conversation",
      "🔎 Find",
      "⏰ Follow-ups",
      "🙋 Me",
      "👥 Team",
      "🚫 Blocked senders"
    ]);
    await chat.press("menu:newcontact");
    expect(lastText()).toBe("What is the contact name?");
    expect(sessionOf(ADMIN)).toMatchObject({ mode: "contact", step: "awaiting_name" });
  });

  it("offers members no team button, and refuses team management to them", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    const chat = chatAs(MEMBER);
    await chat.text("/help");
    expect(buttonsOf(lastKeyboardMessage(MEMBER)!.message_id)).not.toContain("👥 Team");
    expect(lastText()).not.toContain("/teammember");
    await chat.press("menu:teammember", { messageId: lastKeyboardMessage(MEMBER)!.message_id });
    expect(lastText()).toBe("Only admins can manage team members.");
  });
});

describe("log conversation button", () => {
  it("under a new contact starts logging a conversation with them", async () => {
    const adminId = await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Alice");
    await chat.press("consumer");
    await chat.press("card:save");
    expect(lastText()).toBe('✅ Contact "Alice" added.');
    expect(buttonsOf(lastKeyboardMessage(ADMIN)!.message_id)).toEqual(["💬 Log conversation with Alice"]);
    await chat.press(JSON.parse(sent[sent.length - 1].reply_markup!).inline_keyboard[0][0].callback_data);
    expect(lastText()).toBe("How did you talk to Alice?");
    await chat.press("channel:in-person");
    await chat.press("date:today");
    await chat.text("Met at the meetup");
    expect(lastText()).toBe("✅ Conversation with Alice (In Person, today) logged.");
    expect(await env.DB.prepare("SELECT channel, created_by FROM conversations").first()).toEqual({
      channel: "in-person",
      created_by: adminId
    });
  });

  it("says so when the contact no longer exists", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).press("log:999");
    expect(lastText()).toBe("❌ This contact no longer exists.");
    expect(sessionOf(ADMIN)).toBeUndefined();
  });
});

describe("command menu", () => {
  it("is set once: /help for everyone, member commands in groups, and per member in private", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    await chatAs(ADMIN).text("/help");
    await chatAs(ADMIN).text("/help");
    await chatAs(MEMBER).text("/help");
    const menus = telegramCalls("setMyCommands").map(c => ({
      scope: c.body.scope,
      commands: (c.body.commands as { command: string }[]).map(m => m.command)
    }));
    const member = ["newcontact", "neworg", "logconversation", "find", "followups", "me", "cancel", "help"];
    expect(menus).toEqual([
      { scope: { type: "default" }, commands: ["help"] },
      { scope: { type: "all_group_chats" }, commands: member },
      { scope: { type: "chat", chat_id: ADMIN }, commands: [...member, "invite", "teammember", "blocked"] },
      { scope: { type: "chat", chat_id: MEMBER }, commands: member }
    ]);
  });

  it("is set again for a member whose admin rights changed", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER))!;
    await chatAs(MEMBER).text("/help");
    await env.DB.prepare("UPDATE team_members SET is_admin = 1 WHERE id = ?").bind(memberId).run();
    await chatAs(MEMBER).text("/help");
    const scopes = telegramCalls("setMyCommands").filter(c => (c.body.scope as { type: string }).type === "chat");
    expect(scopes.map(c => (c.body.commands as unknown[]).length)).toEqual([8, 11]);
  });
});
