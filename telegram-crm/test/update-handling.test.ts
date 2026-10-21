import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CrmApi from "../../crm-api/src/index";
import { storeFor } from "../src/chat";
import worker from "../src/index";
import { processUpdate } from "../src/update";
import type { TelegramUpdate } from "../src/types";
import {
  addAdmin,
  addMember,
  answerSpamButtons,
  callbackAnswers,
  chatAs,
  groupChat,
  lastKeyboardMessageId,
  memoryKv,
  redeliverLast,
  resetAndStubFetch,
  SECRET,
  sessionOf,
  spamButtonPresses,
  workerEnv,
  type SentMessage
} from "./harness";

const ADMIN = 5001;
const MEMBER = 5002;
let sent: SentMessage[];

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

const lastText = () => sent[sent.length - 1]?.text;
const lastAnswer = () => callbackAnswers()[callbackAnswers().length - 1];

const privateMessage = (updateId: number, text: string) =>
  ({
    update_id: updateId,
    message: { message_id: updateId, from: { id: ADMIN }, chat: { id: ADMIN, type: "private" }, date: 0, text }
  }) as TelegramUpdate;

// /newcontact up to "Which organization is this contact linked to?"
async function toOrganizationStep(chat: ReturnType<typeof chatAs>, name: string) {
  await chat.text("/newcontact");
  await chat.text(name);
  await chat.press("entrepreneur");
}

async function addContact(name: string) {
  return env.DB.prepare("INSERT INTO contacts (name, type) VALUES (?, 'consumer') RETURNING id")
    .bind(name)
    .first<number>("id");
}

describe("input routing", () => {
  it("T1 searches a typed organization name, also after pressing a button that is not on the list", async () => {
    await addAdmin(ADMIN);
    await env.DB.prepare("INSERT INTO organizations (name, status) VALUES ('Cafe Satoshi', 2)").run();
    const nakamoto = await env.DB.prepare(
      "INSERT INTO organizations (name, status) VALUES ('Cafe Nakamoto', 2) RETURNING id"
    ).first<number>("id");
    const chat = chatAs(ADMIN);
    await toOrganizationStep(chat, "Bob");
    await chat.text("cafe"); // lists both
    await chat.text("satoshi"); // new list: only Cafe Satoshi
    await chat.press(`select_org:${nakamoto}`); // not on the current list
    expect(lastText()).toBe("❌ Please choose an organization from the buttons, or type a name to search.");
    await chat.text("nakamoto");
    expect(lastText()).toBe("Select an existing organization or create new:");
  });

  it("T1b ignores a button from an older list", async () => {
    await addAdmin(ADMIN);
    await env.DB.prepare("INSERT INTO organizations (name, status) VALUES ('Cafe Satoshi', 2)").run();
    const nakamoto = await env.DB.prepare(
      "INSERT INTO organizations (name, status) VALUES ('Cafe Nakamoto', 2) RETURNING id"
    ).first<number>("id");
    const chat = chatAs(ADMIN);
    await toOrganizationStep(chat, "Bob");
    await chat.text("cafe");
    const firstList = lastKeyboardMessageId(ADMIN);
    await chat.text("satoshi");
    const before = sent.length;
    await chat.press(`select_org:${nakamoto}`, { messageId: firstList });
    expect(sent).toHaveLength(before);
    expect(lastAnswer()).toMatchObject({ text: "This button is no longer active." });
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_organization" });
  });

  it("T16 a double-tapped button on the community picker does not also save from the card", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toOrganizationStep(chat, "Bob");
    await chat.text("Cafe Satoshi");
    await chat.press("create_org");
    await chat.press("accepts-bitcoin");
    const picker = lastKeyboardMessageId(ADMIN);
    await chat.press("skip", { messageId: picker }); // no community
    await chat.press("skip", { messageId: picker }); // the same button, tapped twice
    const orgs = await env.DB.prepare("SELECT COUNT(*) AS n FROM organizations").first();
    expect(orgs).toEqual({ n: 0 });
    expect(lastAnswer()).toMatchObject({ text: "This button is no longer active." });
  });

  it("T4d never passes an unknown command to a flow", async () => {
    await addAdmin(ADMIN);
    const contactId = await addContact("Alice");
    const chat = chatAs(ADMIN);
    await chat.text("/logconversation");
    await chat.text("ali");
    await chat.press(`select_contact:${contactId}`);
    await chat.press("channel:phone");
    await chat.text("/note met Alice");
    expect(lastText()).toBe("Unknown command. Type /help for available commands.");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_note" });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first();
    expect(count).toEqual({ n: 0 });
  });

  it("X3 /start shows the available commands", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).text("/start");
    expect(lastText()).toContain("Available commands");
  });

  it("asks questions in a private chat without reply request or hint", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).text("/newcontact");
    await chatAs(ADMIN).text("Alice");
    expect(sent.map(m => [m.text, m.reply_parameters])).toEqual([
      ["What is the contact name?", undefined],
      ["Is Alice a consumer or an entrepreneur?", undefined]
    ]);
    expect(sent[0].reply_markup).toBeUndefined();
  });

  it("answers ordinary text without a flow in a private chat with the main menu", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).text("hello");
    expect(lastText()).toMatch(/^What do you want to do\?\n\nAvailable commands:/);
    expect(JSON.parse(sent[sent.length - 1].reply_markup!).inline_keyboard.flat()).toContainEqual({
      text: "➕ New contact",
      callback_data: "menu:newcontact"
    });
  });
});

describe("group chats", () => {
  it("T2 text from another member does not fill in the owner's flow", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    const group = groupChat();
    await group.as(ADMIN).text("/newcontact");
    await group.as(MEMBER).text("Mallory");
    expect(group.sessionOf(ADMIN)).toMatchObject({ step: "awaiting_name", telegram_id: String(ADMIN) });
    expect(group.sessionOf(MEMBER)).toBeUndefined();
  });

  it("T2b /cancel from another member does not end the owner's flow", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    const group = groupChat();
    await group.as(ADMIN).text("/newcontact");
    await group.as(MEMBER).text("/cancel");
    expect(group.sessionOf(ADMIN)).toMatchObject({ mode: "contact", telegram_id: String(ADMIN) });
  });

  it("T2c two members run their own flows side by side", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    const group = groupChat();
    await group.as(ADMIN).text("/newcontact");
    await group.as(MEMBER).text("/neworg");
    await group.as(ADMIN).text("Alice");
    expect(group.sessionOf(ADMIN)).toMatchObject({ mode: "contact", name: "Alice", step: "awaiting_type" });
    expect(group.sessionOf(MEMBER)).toMatchObject({ mode: "org", step: "awaiting_org_name" });
  });

  it("T2d a button pressed by another member does not touch the owner's flow", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    const group = groupChat();
    await group.as(ADMIN).text("/newcontact");
    await group.as(ADMIN).text("Alice"); // consumer or entrepreneur, as buttons
    const before = sent.length;
    await group.as(MEMBER).press("consumer");
    expect(sent).toHaveLength(before);
    expect(lastAnswer()).toMatchObject({ text: "This button has expired. Start again with /help." });
    expect(group.sessionOf(ADMIN)).toMatchObject({ step: "awaiting_type" });
  });

  it("asks a question without buttons as a reply to the member who started the flow", async () => {
    await addAdmin(ADMIN);
    await groupChat().as(ADMIN).text("/newcontact");
    const question = sent[sent.length - 1];
    expect(question.text).toBe("What is the contact name?");
    expect(JSON.parse(question.reply_markup!)).toEqual({ force_reply: true, selective: true });
    expect(question.reply_parameters).toEqual({ message_id: expect.any(Number), allow_sending_without_reply: true });
  });

  it("tells how to type an answer when a question has buttons", async () => {
    await addAdmin(ADMIN);
    const admin = groupChat().as(ADMIN);
    await admin.text("/newcontact");
    await admin.text("Alice");
    await admin.press("consumer");
    await admin.press("card:email");
    const question = sent[sent.length - 1];
    expect(question.text).toBe("What is the email address?\n\n↩️ To type an answer, reply to this message.");
    expect(JSON.parse(question.reply_markup!)).toEqual({
      inline_keyboard: [
        [{ text: "⬅️ Back", callback_data: "card:back" }],
        [{ text: "✖️ Cancel", callback_data: "cancel" }]
      ]
    });
  });

  it("leaves a question with only buttons as it is", async () => {
    await addAdmin(ADMIN);
    const admin = groupChat().as(ADMIN);
    await admin.text("/newcontact");
    await admin.text("Alice");
    expect(lastText()).toBe("Is Alice a consumer or an entrepreneur?");
  });

  it("asks for a reply after a button press, without a message to answer", async () => {
    await addAdmin(ADMIN);
    const contactId = await addContact("Alice");
    const admin = groupChat().as(ADMIN);
    await admin.text("/logconversation");
    await admin.text("ali");
    await admin.press(`select_contact:${contactId}`);
    await admin.press("channel:phone");
    const question = sent[sent.length - 1];
    expect(JSON.parse(question.reply_markup!)).toEqual({ force_reply: true });
    expect(question.reply_parameters).toBeUndefined();
  });

  it("does not ask for a reply once the flow is done", async () => {
    await addAdmin(ADMIN);
    const contactId = await addContact("Alice");
    const group = groupChat();
    const admin = group.as(ADMIN);
    await admin.text("/logconversation");
    await admin.text("ali");
    await admin.press(`select_contact:${contactId}`);
    await admin.press("channel:phone");
    await admin.text("Talked about a Lightning terminal");
    expect(group.sessionOf(ADMIN)).toBeUndefined();
    expect(sent[sent.length - 1].reply_markup).toBeUndefined();
  });

  it("T3 ordinary chatter without an active flow gets no reply", async () => {
    await addAdmin(ADMIN);
    const group = groupChat();
    await group.as(ADMIN).text("Goedemorgen allemaal");
    expect(sent).toHaveLength(0);
  });

  it("T4 /cancel@bot in the note step cancels instead of saving the note", async () => {
    await addAdmin(ADMIN);
    const contactId = await addContact("Alice");
    const group = groupChat();
    const admin = group.as(ADMIN);
    await admin.text("/logconversation");
    await admin.text("ali");
    await admin.press(`select_contact:${contactId}`);
    await admin.press("channel:phone");
    await admin.text("/cancel@HoiBitBot");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first();
    expect({ count, session: group.sessionOf(ADMIN) }).toEqual({ count: { n: 0 }, session: undefined });
  });

  it("T4b /newcontact@bot starts the contact flow", async () => {
    await addAdmin(ADMIN);
    await groupChat().as(ADMIN).text("/newcontact@HoiBitBot");
    expect(lastText()).toBe("What is the contact name?");
  });

  it("T4c ignores a command for another bot, also inside a flow", async () => {
    await addAdmin(ADMIN);
    const group = groupChat();
    await group.as(ADMIN).text("/newcontact");
    await group.as(ADMIN).text("/cancel@OtherBot");
    expect(sent).toHaveLength(1);
    expect(group.sessionOf(ADMIN)).toMatchObject({ step: "awaiting_name" });
  });

  it("T14 registers the first user from a group chat with their own Telegram id and profile name", async () => {
    const admin = groupChat(-1009876).as(ADMIN, { first_name: "Alice", last_name: "Admin" });
    await admin.text("/start"); // no team members yet: the first user becomes admin
    expect(lastText()).toMatch(
      /^👋 Welcome! You are the first team member, so you are an admin, registered as "Alice Admin"\.\n\nAvailable commands:/
    );
    const row = await env.DB.prepare("SELECT telegram_id, name, is_admin FROM team_members").first();
    expect(row).toEqual({ telegram_id: String(ADMIN), name: "Alice Admin", is_admin: 1 });
  });
});

describe("buttons", () => {
  it("X2 a button pressed after the session expired says that it expired", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).press("skip");
    expect(sent).toHaveLength(0);
    expect(lastAnswer()).toMatchObject({ text: "This button has expired. Start again with /help." });
  });

  it("refuses a button from someone who is no longer a team member and ends their flow", async () => {
    await addAdmin(ADMIN);
    const memberId = await addMember(MEMBER);
    const chat = chatAs(MEMBER);
    await chat.text("/newcontact");
    await chat.text("Alice"); // email prompt with a Skip button
    await env.DB.prepare("DELETE FROM team_members WHERE id = ?").bind(memberId).run();
    const before = sent.length;
    await chat.press("skip");
    expect(sent).toHaveLength(before);
    expect(lastAnswer()?.text).toContain("not authorized");
    expect(sessionOf(MEMBER)).toBeUndefined();
  });

  it("answers the button press also when handling it fails", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Alice");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(CrmApi.prototype, "validateUser").mockRejectedValue(new Error("D1_ERROR: unavailable"));
    try {
      const res = await chat.press("skip");
      expect(res.status).toBe(200);
      expect(callbackAnswers()).toHaveLength(1);
      expect(lastText()).toBe("Something went wrong. Please try again later.");
      expect(error).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      error.mockRestore();
    }
  });
});

describe("webhook handling", () => {
  it("T5 answers Telegram with 200 for an unknown user, so Telegram does not redeliver", async () => {
    await addAdmin(ADMIN);
    const res = await chatAs(6001).text("/help");
    expect(res.status).toBe(200);
    expect(lastText()).toContain("You're not on the team yet.");
  });

  it("T6 sends no stack trace to the chat when crm-api fails, and answers 200", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(CrmApi.prototype, "validateUser").mockRejectedValue(new Error("D1_ERROR: unavailable"));
    try {
      const res = await chatAs(6001).text("hello");
      expect({ status: res.status, text: lastText() }).toEqual({
        status: 200,
        text: "Something went wrong. Please try again later."
      });
      expect(error).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      error.mockRestore();
    }
  });

  it("answers 200 to a valid request whose body is not JSON", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const request = new Request<unknown, IncomingRequestCfProperties>("https://telegram-crm.example/", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
        body: "{"
      });
      const res = await worker.fetch(request, workerEnv);
      expect(res.status).toBe(200);
    } finally {
      error.mockRestore();
    }
  });

  it("T7 the same update delivered twice is handled once", async () => {
    await addAdmin(ADMIN);
    const store = storeFor(memoryKv());
    await processUpdate(workerEnv, store, privateMessage(1, "/newcontact"));
    await processUpdate(workerEnv, store, privateMessage(2, "Alice"));
    const type = privateMessage(3, "entrepreneur");
    await processUpdate(workerEnv, store, type);
    await processUpdate(workerEnv, store, type); // Telegram redelivers after a non-2xx or slow response
    // Handled twice, "entrepreneur" would also have been searched as the organization's name.
    const session = store.getSession(ADMIN);
    expect(session?.step).toBe("awaiting_organization");
    expect(session?.pending_org).toBeUndefined();
  });

  it("T7b a redelivered webhook request sends nothing again", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).text("/help");
    const res = await redeliverLast();
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("T8 logs a sendMessage that Telegram rejects, without the bot token", async () => {
    await addAdmin(ADMIN);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 })
      );
      await chatAs(ADMIN).text("/help");
      expect(error).toHaveBeenCalled();
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain("sendMessage");
      expect(logged).toContain("can't parse entities");
      expect(logged).not.toContain("test-token");
    } finally {
      error.mockRestore();
    }
  });
});

describe("spam button", () => {
  const MAIL_GROUP = -1002557433889;

  it("passes a team member's press to mail-to-tg and shows its answer", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    const group = groupChat(MAIL_GROUP);
    await group.as(ADMIN).text("/newcontact");
    await group.as(MEMBER).press("spam:7", { messageId: 321 });
    expect(spamButtonPresses()).toEqual([{ data: "spam:7", chatId: MAIL_GROUP, messageId: 321 }]);
    expect(lastAnswer().text).toBe("Delete this email and block its sender?");
    // Not part of any flow: the admin's /newcontact goes on.
    expect(group.sessionOf(ADMIN)?.mode).toBe("contact");
    expect(sent).toHaveLength(1);
  });

  it("does not pass on a press of someone outside the team", async () => {
    await addAdmin(ADMIN);
    await groupChat(MAIL_GROUP).as(9999).press("spam:7:yes", { messageId: 321 });
    expect(spamButtonPresses()).toEqual([]);
    expect(lastAnswer().text).toBe("You are not authorized to use this bot.");
  });

  it("answers on the button, not in the group, when mail-to-tg fails", async () => {
    await addAdmin(ADMIN);
    answerSpamButtons(async () => {
      throw new Error("mail-to-tg down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await groupChat(MAIL_GROUP).as(ADMIN).press("spam:7:yes", { messageId: 321 });
    expect(lastAnswer()).toMatchObject({ text: "Something went wrong. Please try again later.", show_alert: true });
    expect(sent).toEqual([]);
  });

  it("shows a notice mail-to-tg marks as important in a box the user closes", async () => {
    await addAdmin(ADMIN);
    answerSpamButtons(async () => ({ text: "Delete it by hand.", alert: true }));
    await groupChat(MAIL_GROUP).as(ADMIN).press("spam:7:yes", { messageId: 321 });
    expect(lastAnswer()).toMatchObject({ text: "Delete it by hand.", show_alert: true });
  });
});
