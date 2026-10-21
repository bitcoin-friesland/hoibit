import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addAdmin, addMember, chatAs, resetAndStubFetch, type SentMessage } from "./harness";

const ADMIN = 5001;
const MEMBER = 7001;
let sent: SentMessage[];

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

const lastText = () => sent[sent.length - 1]?.text;

// Button texts of the last message with a keyboard, row by row.
function lastButtons(): string[] {
  const withKeyboard = [...sent].reverse().find(m => m.reply_markup);
  if (!withKeyboard) return [];
  const keyboard: { text: string }[][] = JSON.parse(withKeyboard.reply_markup!).inline_keyboard;
  return keyboard.map(row => row.map(b => b.text).join(" | "));
}

async function memberRow(id: number) {
  return env.DB.prepare("SELECT telegram_id, name, time_zone, is_admin FROM team_members WHERE id = ?")
    .bind(id)
    .first();
}

async function communityIds(memberId: number) {
  const { results } = await env.DB.prepare(
    "SELECT community_id FROM team_member_communities WHERE team_member_id = ? ORDER BY community_id"
  )
    .bind(memberId)
    .all<{ community_id: number }>();
  return results.map(r => r.community_id);
}

// A member without a name, as rows from before names were required can be.
async function addNamelessMember(telegramId: number) {
  return env.DB.prepare("INSERT INTO team_members (telegram_id) VALUES (?) RETURNING id")
    .bind(String(telegramId))
    .first<number>("id");
}

describe("/teammember: remove team member", () => {
  it("deletes a member without history; they are no longer authorized", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("remove_member");
    expect(lastText()).toBe("Which team member do you want to remove?");
    expect(lastButtons()).toContain(`Erin (${MEMBER})`);
    await chat.press(`member:${memberId}`);
    expect(lastText()).toBe("Remove Erin from the team? They will lose access to the bot.");
    await chat.press("confirm_remove");
    expect(lastText()).toBe("✅ Erin deleted.");
    expect(await memberRow(memberId)).toBeNull();

    await chatAs(MEMBER).text("/help");
    expect(lastText()).toContain("You are not authorized to use this bot.");
  });

  it("deactivates a member with history and keeps the row", async () => {
    const adminId = await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    await env.DB.prepare(
      "INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES ('insert', 'contacts', '1', ?, '{}')"
    )
      .bind(memberId)
      .run();
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("remove_member");
    await chat.press(`member:${memberId}`);
    await chat.press("confirm_remove");
    expect(lastText()).toBe("✅ Erin removed (history kept).");
    expect(await memberRow(memberId)).toEqual({ telegram_id: null, name: "Erin", time_zone: null, is_admin: 0 });
    const audit = await env.DB.prepare(
      "SELECT performed_by FROM audit_log WHERE table_name = 'team_members' AND record_id = ?"
    )
      .bind(String(memberId))
      .first();
    expect(audit).toEqual({ performed_by: adminId });

    await chatAs(MEMBER).text("/help");
    expect(lastText()).toContain("You are not authorized to use this bot.");
  });

  it("refuses to remove the last admin", async () => {
    const adminId = await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("remove_member");
    await chat.press(`member:${adminId}`);
    await chat.press("confirm_remove");
    expect(lastText()).toBe("❌ Cannot remove the last admin.");
    expect(await memberRow(adminId)).toEqual({
      telegram_id: String(ADMIN),
      name: "Admin",
      time_zone: null,
      is_admin: 1
    });
  });

  it("keeps the member when the removal is cancelled", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("remove_member");
    await chat.press(`member:${memberId}`);
    await chat.press("cancel_remove");
    expect(lastText()).toBe("❌ Removal cancelled.");
    expect(await memberRow(memberId)).toMatchObject({ telegram_id: String(MEMBER) });
  });
});

describe("/teammember: edit existing team member", () => {
  it("T19 'Edit existing team member' lets an admin edit a member", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("edit_existing");
    expect(lastText()).not.toBe("❌ Editing existing team members is not implemented yet.");
  });

  it("changes the name", async () => {
    const adminId = await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("edit_existing");
    expect(lastText()).toBe("Which team member do you want to edit?");
    await chat.press(`member:${memberId}`);
    expect(lastText()).toBe("What do you want to change for Erin?");
    expect(lastButtons()).toEqual(["Name", "Time zone", "Communities"]);
    await chat.press("edit_field:name");
    expect(lastText()).toBe("Please enter the new name for Erin:");
    await chat.text("x");
    expect(lastText()).toMatch(/^❌ Please enter a valid name/);
    await chat.text("Erin Østergaard");
    expect(lastText()).toBe('✅ Name of Erin changed to "Erin Østergaard".');
    expect(await memberRow(memberId)).toMatchObject({ name: "Erin Østergaard" });
    const audit = await env.DB.prepare(
      "SELECT performed_by FROM audit_log WHERE table_name = 'team_members' AND record_id = ?"
    )
      .bind(String(memberId))
      .first();
    expect(audit).toEqual({ performed_by: adminId });
  });

  it("changes the time zone", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("edit_existing");
    await chat.press(`member:${memberId}`);
    await chat.press("edit_field:time_zone");
    expect(lastText()).toBe("Please enter the new time zone for Erin (e.g. Europe/Amsterdam):");
    await chat.text("Europe/Lisbon");
    expect(lastText()).toBe("✅ Time zone of Erin changed to Europe/Lisbon.");
    expect(await memberRow(memberId)).toMatchObject({ time_zone: "Europe/Lisbon" });
  });

  it("replaces the communities, starting from the member's current ones", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    await env.DB.prepare("INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, 1)")
      .bind(memberId)
      .run();
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("edit_existing");
    await chat.press(`member:${memberId}`);
    await chat.press("edit_field:communities");
    expect(lastText()).toBe("Select the Bitcoin communities of Erin:");
    expect(lastButtons()[0]).toBe("✅ Hard Money Cafe");
    // Deselect the current community and pick another one from the country list.
    await chat.press("community:1");
    await chat.press("choose_other");
    await chat.press("country:0");
    await chat.press("community:2");
    await chat.press("done");
    expect(lastText()).toBe("✅ Communities of Erin changed to: Arnhem Bitcoinstad.");
    expect(await communityIds(memberId)).toEqual([2]);
  });

  it("leaves the communities unchanged on Skip", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    await env.DB.prepare("INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, 1)")
      .bind(memberId)
      .run();
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("edit_existing");
    await chat.press(`member:${memberId}`);
    await chat.press("edit_field:communities");
    await chat.press("community:1");
    await chat.press("skip");
    expect(lastText()).toBe("Communities of Erin unchanged.");
    expect(await communityIds(memberId)).toEqual([1]);
  });
});

describe("/invite result message", () => {
  it("X1 inviting someone who already is a team member does not claim an invitation was sent", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/invite");
    await chat.text(String(ADMIN));
    await chat.text("Admin Again");
    await chat.text("Europe/Amsterdam");
    await chat.press("skip");
    await chat.text("confirm");
    expect(lastText()).not.toMatch(/Invitation sent/);
    expect(lastText()).toBe(`✅ Telegram ID ${ADMIN} is already a team member; communities/time zone updated.`);
  });

  it("tells the admin to ask a new member to open the bot", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/invite");
    await chat.text(String(MEMBER));
    await chat.text("Erin");
    await chat.text("Europe/Amsterdam");
    await chat.press("skip");
    await chat.text("confirm");
    expect(lastText()).toBe('✅ "Erin" added as team member. Ask them to open the bot and send /help.');
  });
});

describe("team member without a name", () => {
  it("can be chosen for admin rights, labelled by Telegram ID", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addNamelessMember(MEMBER))!;
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("grant_admin");
    expect(lastButtons()).toEqual([String(MEMBER)]);
    await chat.press(`member:${memberId}`);
    expect(lastText()).toBe(`✅ ${MEMBER} is now an admin.`);
    expect(await memberRow(memberId)).toMatchObject({ is_admin: 1 });
  });

  it("can be removed", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addNamelessMember(MEMBER))!;
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("remove_member");
    expect(lastButtons()).toContain(String(MEMBER));
    await chat.press(`member:${memberId}`);
    await chat.press("confirm_remove");
    expect(lastText()).toBe(`✅ ${MEMBER} deleted.`);
  });

  it("can be given a name", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addNamelessMember(MEMBER))!;
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("edit_existing");
    await chat.press(`member:${memberId}`);
    await chat.press("edit_field:name");
    await chat.text("Frank");
    expect(lastText()).toBe(`✅ Name of ${MEMBER} changed to "Frank".`);
    expect(await memberRow(memberId)).toMatchObject({ name: "Frank" });
  });
});

describe("/help", () => {
  it("lists the team member actions for admins", async () => {
    await addAdmin(ADMIN);
    await chatAs(ADMIN).text("/help");
    expect(lastText()).toContain("/teammember - Manage team members (invite, edit, remove, admin rights)");
  });
});
