import { createScheduledController, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { NewOrgInput } from "../../crm-api/src/types";
import { teamDay, teamDayIn } from "../src/helpers/day";
import worker from "../src/index";
import {
  addAdmin,
  addMember,
  callbackAnswers,
  chatAs,
  lastKeyboardMessage,
  messageById,
  resetAndStubFetch,
  sessionOf,
  workerEnv,
  type SentMessage
} from "./harness";

const ADMIN = 6001;
const MEMBER = 6002;
let sent: SentMessage[];
const crm = workerEnv.crmApi;

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

const lastText = () => sent[sent.length - 1]?.text;
const buttonsOf = (message: SentMessage | undefined) =>
  message?.reply_markup
    ? (JSON.parse(message.reply_markup).inline_keyboard as { text: string; callback_data: string }[][]).flat()
    : [];
const lastButtons = () => buttonsOf(sent.at(-1));
const followUpOf = async (orgId: number) => (await crm.organizationDetails(orgId, 0))?.follow_up_on;
// "12-01-2027" for "2027-01-12".
const shown = (day: string) => day.split("-").reverse().join("-");

async function newOrg(name: string, extra: Partial<NewOrgInput>) {
  const res = await crm.newOrg({ name, status: 7, ...extra });
  if (!res.ok) throw new Error(res.error);
  return res.id;
}

describe("organization card", () => {
  it("shows the details from Baserow, who handles it, the follow-up day and the notes", async () => {
    const adminId = await addAdmin(ADMIN);
    const orgId = await newOrg("Smuk Espressobar", {
      category: "Restaurant - Lunch",
      address: "Kleinzand 1, Sneek",
      phone: "+31515123456",
      email: "info@smuk.nl",
      follow_up_on: "2026-01-12",
      team_member_ids: [adminId]
    });
    await env.DB.prepare("INSERT INTO organization_notes (organization_id, note) VALUES (?, ?)")
      .bind(orgId, "Edwin: wants to start in January")
      .run();
    await chatAs(ADMIN).press(`show:o:${orgId}`);
    expect(lastText()).toBe(
      [
        "🏢 Smuk Espressobar",
        "🏷️ Hesitant",
        "🏪 Restaurant - Lunch",
        "🏠 Kleinzand 1, Sneek",
        "📞 +31515123456",
        "📧 info@smuk.nl",
        "🤝 Admin",
        "⏰ Follow up: 12-01-2026 (overdue)",
        "👤 No contacts yet",
        "",
        "📝 Notes:",
        "• Edwin: wants to start in January",
        "",
        "No conversations logged yet."
      ].join("\n")
    );
    expect(lastButtons().map(b => b.callback_data)).toEqual([
      `edit:o:${orgId}`,
      `status:${orgId}`,
      `log:o:${orgId}`,
      `fu:${orgId}`,
      `hist:o:${orgId}:0`
    ]);
  });
});

describe("follow-up day", () => {
  it("is set from the card's buttons and removed again", async () => {
    await addAdmin(ADMIN);
    const orgId = await newOrg("Cafe", {});
    const chat = chatAs(ADMIN);
    await chat.press(`fu:${orgId}`);
    expect(lastText()).toBe('When should "Cafe" be followed up?');
    expect(lastButtons().map(b => b.text)).toEqual([
      "Tomorrow",
      "In a week",
      "In 2 weeks",
      "In a month",
      "📅 Other date"
    ]);
    const questionId = lastKeyboardMessage(ADMIN)!.message_id;
    await chat.press(`fu:${orgId}:7`);
    expect(await followUpOf(orgId)).toBe(teamDayIn(7));
    expect(callbackAnswers().at(-1)).toMatchObject({ text: "Follow-up saved." });
    expect(messageById(questionId)?.text).toMatch(new RegExp(`➡️ ${shown(teamDayIn(7))}$`));

    await chat.press(`fu:${orgId}`);
    expect(lastText()).toBe(`When should "Cafe" be followed up? It is now: ${shown(teamDayIn(7))}.`);
    expect(lastButtons().at(-1)).toEqual({ text: "🗑️ No follow-up", callback_data: `fu:${orgId}:x` });
    await chat.press(`fu:${orgId}:x`);
    expect(await followUpOf(orgId)).toBeNull();
  });

  it("takes a typed day after Other date, but not one that has passed", async () => {
    await addAdmin(ADMIN);
    const orgId = await newOrg("Cafe", {});
    const chat = chatAs(ADMIN);
    await chat.press(`fu:${orgId}:date`);
    expect(lastText()).toBe('When should "Cafe" be followed up? Type the day, like 12-01 or 12-01-2027.');
    await chat.text(shown(teamDay(3)));
    expect(lastText()).toMatch(/is not today or a day to come/);
    await chat.text(shown(teamDayIn(40)));
    expect(lastText()).toBe(`✅ "Cafe" will be followed up on ${shown(teamDayIn(40))}.`);
    expect(await followUpOf(orgId)).toBe(teamDayIn(40));
    expect(sessionOf(ADMIN)).toBeUndefined();
  });
});

describe("/followups", () => {
  it("lists what I handle and what nobody handles, due within a week, the earliest first", async () => {
    const adminId = await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    const overdue = await newOrg("Overdue", { follow_up_on: teamDay(10), team_member_ids: [adminId] });
    const nobody = await newOrg("Nobody's", { follow_up_on: teamDayIn(2) });
    await newOrg("Erin's", { follow_up_on: teamDayIn(1), team_member_ids: [memberId] });
    await newOrg("Next month", { follow_up_on: teamDayIn(30), team_member_ids: [adminId] });
    await chatAs(ADMIN).text("/followups");
    expect(lastText()).toBe(
      [
        `⏰ To follow up until ${shown(teamDayIn(7))}:`,
        `• ${shown(teamDay(10))} (overdue) · Overdue · Hesitant · Admin`,
        `• ${shown(teamDayIn(2))} · Nobody's · Hesitant · nobody`
      ].join("\n")
    );
    expect(lastButtons()).toEqual([
      { text: "🏢 Overdue", callback_data: `show:o:${overdue}` },
      { text: "🏢 Nobody's", callback_data: `show:o:${nobody}` }
    ]);
  });

  it("says when there is nothing to follow up, also from the main menu", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).press("menu:followups");
    expect(lastText()).toBe(`Nothing to follow up until ${shown(teamDayIn(7))}. 🎉`);
  });
});

describe("morning reminder", () => {
  const ADMIN2 = 6003;
  const remind = () => worker.scheduled(createScheduledController(), workerEnv);
  const textsTo = (telegramId: number) => sent.filter(m => String(m.chat_id) === String(telegramId)).map(m => m.text);

  it("tells each member what they handle that is due today or overdue, and the admins what nobody handles", async () => {
    const adminId = await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    const admin2Id = (await env.DB.prepare(
      "INSERT INTO team_members (telegram_id, name, is_admin) VALUES (?, 'Finn', 1) RETURNING id"
    )
      .bind(String(ADMIN2))
      .first<number>("id"))!;
    const placeholder = (await env.DB.prepare(
      "INSERT INTO team_members (name) VALUES ('Gwen') RETURNING id"
    ).first<number>("id"))!;
    const today = await newOrg("Today", { follow_up_on: teamDay(0), team_member_ids: [memberId] });
    const late = await newOrg("Late", { follow_up_on: teamDay(3), team_member_ids: [memberId, adminId] });
    await newOrg("Tomorrow", { follow_up_on: teamDayIn(1), team_member_ids: [memberId] });
    await newOrg("No day", { team_member_ids: [admin2Id] });
    const nobody = await newOrg("Nobody's", { follow_up_on: teamDay(0) });
    await newOrg("Gwen's", { follow_up_on: teamDay(1), team_member_ids: [placeholder] });

    await remind();
    expect(textsTo(MEMBER)).toEqual([
      [
        "☀️ Good morning! To follow up today:",
        `• ${shown(teamDay(3))} (overdue) · Late · Hesitant · Admin, Erin`,
        "• today · Today · Hesitant · Erin"
      ].join("\n")
    ]);
    expect(buttonsOf(sent.find(m => String(m.chat_id) === String(MEMBER)))).toEqual([
      { text: "🏢 Late", callback_data: `show:o:${late}` },
      { text: "🏢 Today", callback_data: `show:o:${today}` }
    ]);
    const forAdmins = [
      "☀️ Good morning! To follow up today:",
      `• ${shown(teamDay(1))} (overdue) · Gwen's · Hesitant · Gwen`,
      "• today · Nobody's · Hesitant · nobody"
    ];
    expect(textsTo(ADMIN2)).toEqual([forAdmins.join("\n")]);
    expect(textsTo(ADMIN)).toEqual([
      [forAdmins[0], `• ${shown(teamDay(3))} (overdue) · Late · Hesitant · Admin, Erin`, ...forAdmins.slice(1)].join(
        "\n"
      )
    ]);
    expect(buttonsOf(sent.find(m => String(m.chat_id) === String(ADMIN2)))).toContainEqual({
      text: "🏢 Nobody's",
      callback_data: `show:o:${nobody}`
    });
    expect(sent).toHaveLength(3);
  });

  it("sends nothing when nothing is due", async () => {
    const adminId = await addAdmin(ADMIN);
    await newOrg("Tomorrow", { follow_up_on: teamDayIn(1), team_member_ids: [adminId] });
    await remind();
    expect(sent).toEqual([]);
  });
});

describe("conversation with an organization itself", () => {
  it("is logged from the organization's card and shown there without a contact", async () => {
    const adminId = await addAdmin(ADMIN);
    const orgId = await newOrg("Pizzeria Pompeï", {});
    const chat = chatAs(ADMIN);
    await chat.press(`log:o:${orgId}`);
    expect(lastText()).toBe("How did you talk to Pizzeria Pompeï?");
    await chat.press("channel:in-person");
    await chat.press("date:today");
    await chat.text("Spoke to the manager, left a flyer");
    expect(lastText()).toBe("✅ Conversation with Pizzeria Pompeï (In Person, today) logged.");
    expect(lastButtons()).toEqual([
      { text: "📊 Update status of Pizzeria Pompeï", callback_data: `status:${orgId}` },
      { text: "⏰ Set follow-up of Pizzeria Pompeï", callback_data: `fu:${orgId}` }
    ]);
    const row = await env.DB.prepare("SELECT contact_id, organization_id, created_by FROM conversations").first();
    expect(row).toEqual({ contact_id: null, organization_id: orgId, created_by: adminId });
    await chat.press(`show:o:${orgId}`);
    expect(lastText()).toContain(`• ${teamDay(0)} · In Person (Admin): Spoke to the manager, left a flyer`);
  });
});

describe("editing an organization", () => {
  it("changes its own details, who handles it and the follow-up day", async () => {
    const adminId = await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    const orgId = await newOrg("Cafe", { team_member_ids: [adminId] });
    const chat = chatAs(ADMIN);
    await chat.press(`edit:o:${orgId}`);
    await chat.press("card:organization_address");
    await chat.text("Kleinzand 1, Sneek");
    await chat.press("card:organization_phone");
    await chat.text("0515 123456");
    await chat.press("card:organization_follow_up_on");
    await chat.text(shown(teamDayIn(5)));
    expect(lastText()).toContain(`⏰ Follow up: ${shown(teamDayIn(5))}`);

    await chat.press("card:handlers");
    expect(lastText()).toBe('Who handles "Cafe"? They follow it up.');
    expect(lastButtons().map(b => b.text)).toEqual(["✅ Admin", "Erin", "Done", "⬅️ Back", "✖️ Cancel"]);
    await chat.press(`handler:${memberId}`);
    await chat.press(`handler:${adminId}`);
    // The picker is redrawn in place.
    const picker = lastKeyboardMessage(ADMIN)!
      .reply_markup!.inline_keyboard.flat()
      .map(b => b.text);
    expect(picker.slice(0, 2)).toEqual(["Admin", "✅ Erin"]);
    await chat.press("handlers:done");
    expect(lastText()).toContain("🤝 Handled by: Erin");
    await chat.press("card:save");
    expect(sent.at(-2)?.text).toBe('✅ "Cafe" updated.');
    expect(await crm.organizationDetails(orgId)).toMatchObject({
      address: "Kleinzand 1, Sneek",
      phone: "+31515123456",
      follow_up_on: teamDayIn(5),
      handled_by: [{ id: memberId, name: "Erin" }]
    });
  });
});
