import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addAdmin, addMember, BOT_USERNAME, chatAs, groupChat, resetAndStubFetch, type SentMessage } from "./harness";

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

// The buttons of a message, with what they do.
const buttonsOf = (message: SentMessage): { text: string; url?: string; callback_data?: string }[] =>
  JSON.parse(message.reply_markup!).inline_keyboard.flat();

// The texts the bot sent to one chat.
// A chat id can go out as a string: Telegram takes both.
const textsTo = (chatId: number) => sent.filter(m => String(m.chat_id) === String(chatId)).map(m => m.text);

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
    expect(lastButtons()).toContain("Erin");
    await chat.press(`member:${memberId}`);
    expect(lastText()).toBe("Remove Erin from the team? They will lose access to the bot.");
    await chat.press("confirm_remove");
    expect(lastText()).toBe("✅ Erin deleted.");
    expect(await memberRow(memberId)).toBeNull();

    await chatAs(MEMBER).text("/help");
    expect(lastText()).toBe("You're not on the team yet. To join, ask an admin for an invite link.");
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
    expect(lastText()).toContain("You're not on the team yet.");
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
    expect(lastButtons()).toEqual(["Name", "Communities"]);
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

describe("invite links", () => {
  const INVITE_LINK = new RegExp(
    String.raw`^🔗 Invite link for a new team member:\nhttps://t\.me/${BOT_USERNAME}\?start=(inv_[\w-]+)\n`
  );

  // Runs /invite as the admin with their own communities preselected; returns the start parameter.
  async function createInvite() {
    const chat = chatAs(ADMIN);
    await chat.text("/invite");
    await chat.press("done");
    const token = INVITE_LINK.exec(lastText())?.[1];
    if (!token) throw new Error(`No invite link in: ${lastText()}`);
    return token;
  }

  it("gives the admin a one-time link; whoever opens it joins with the chosen communities", async () => {
    const adminId = await addAdmin(ADMIN);
    await env.DB.prepare("INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, 6)")
      .bind(adminId)
      .run();
    const chat = chatAs(ADMIN);
    await chat.text("/invite");
    expect(lastText()).toBe("Which Bitcoin communities will the new team member join?");
    // The admin's own community starts selected.
    expect(lastButtons()[0]).toBe("✅ Bitcoin Friesland");
    await chat.press("done");
    const message = sent[sent.length - 1];
    expect(message.text).toMatch(INVITE_LINK);
    expect(message.text).toMatch(
      /Send it only to the person you want to add\. They will join Bitcoin Friesland\. It works once, until \d+ \w+\.$/
    );
    const link = message.text.split("\n")[1];
    expect(buttonsOf(message)).toEqual([
      {
        text: "📤 Share link",
        url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Open this link to join our team in the CRM bot.")}`
      }
    ]);
    const token = INVITE_LINK.exec(message.text)![1];

    await chatAs(MEMBER, { first_name: "Erin", last_name: "de Boer", username: "erin_db" }).text(`/start ${token}`);
    expect(textsTo(MEMBER)[0]).toMatch(
      /^👋 Welcome to the team, Erin de Boer!\nAdmin invited you\.\nYour communities: Bitcoin Friesland\.\n\nAvailable commands:/
    );
    expect(textsTo(ADMIN).at(-1)).toBe("✅ Erin de Boer (@erin_db) joined the team with your invite link.");
    const member = await env.DB.prepare(
      "SELECT id, telegram_id, telegram_username, name, is_admin FROM team_members WHERE telegram_id = ?"
    )
      .bind(String(MEMBER))
      .first<{ id: number }>();
    expect(member).toMatchObject({
      telegram_id: String(MEMBER),
      telegram_username: "erin_db",
      name: "Erin de Boer",
      is_admin: 0
    });
    expect(await communityIds(member!.id)).toEqual([6]);

    await chatAs(MEMBER).text("/help");
    expect(lastText()).toContain("Available commands");

    // The link works once.
    await chatAs(7002).text(`/start ${token}`);
    expect(lastText()).toBe(
      "This invite link is no longer valid: it was used already or it expired. Ask an admin for a new one."
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members").first()).toEqual({ n: 2 });
  });

  it("tells someone on the team that they already are, and keeps the link usable", async () => {
    await addAdmin(ADMIN);
    const token = await createInvite();
    await chatAs(ADMIN).text(`/start ${token}`);
    expect(lastText()).toMatch(/^You're already on the team\.\n\nAvailable commands:/);
    await chatAs(MEMBER).text(`/start ${token}`);
    expect(textsTo(MEMBER)[0]).toMatch(/^👋 Welcome to the team, Test!/);
  });

  it("refuses an unknown link", async () => {
    await addAdmin(ADMIN);
    await chatAs(MEMBER).text("/start inv_doesnotexist");
    expect(lastText()).toMatch(/^This invite link is no longer valid/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members").first()).toEqual({ n: 1 });
  });

  it("makes no link in a group, but points the admin to a private chat", async () => {
    await addAdmin(ADMIN);
    const group = groupChat();
    await group.as(ADMIN).text("/invite");
    const message = sent[sent.length - 1];
    expect(message.text).toBe(
      "Invite links are made in a private chat with me, so nobody else in this group can use them."
    );
    expect(buttonsOf(message)).toEqual([
      { text: "Open private chat", url: `https://t.me/${BOT_USERNAME}?start=invite` }
    ]);
    expect(group.sessionOf(ADMIN)).toBeUndefined();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_invites").first()).toEqual({ n: 0 });

    // That button opens the private chat with /start invite.
    await chatAs(ADMIN).text("/start invite");
    expect(lastText()).toBe("Which Bitcoin communities will the new team member join?");
  });

  it("is only for admins, also through the private chat button", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER);
    await chatAs(MEMBER).text("/start invite");
    expect(lastText()).toBe("Only admins can manage team members.");
  });

  it("can also be made from the /teammember menu, without communities", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("invite_new");
    await chat.press("skip");
    expect(lastText()).toMatch(INVITE_LINK);
    expect(lastText()).not.toContain("They will join");
  });
});

describe("/teammember: show team", () => {
  it("lists the members with their username and admin rights", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER, "Erin");
    await env.DB.prepare("UPDATE team_members SET telegram_username = 'erin_db' WHERE telegram_id = ?")
      .bind(String(MEMBER))
      .run();
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("show_team");
    expect(lastText()).toBe("👥 Team (2):\n• Admin · admin\n• Erin (@erin_db)");
  });
});

describe("Telegram usernames", () => {
  it("are kept current from what Telegram reports", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    await chatAs(MEMBER, { username: "erin_db" }).text("/help");
    const username = () =>
      env.DB.prepare("SELECT telegram_username FROM team_members WHERE id = ?")
        .bind(memberId)
        .first("telegram_username");
    expect(await username()).toBe("erin_db");
    await chatAs(MEMBER).text("/help");
    expect(await username()).toBeNull();
  });

  it("tell members apart in the member buttons", async () => {
    await addAdmin(ADMIN);
    const erin = (await addMember(MEMBER, "Erin"))!;
    await addMember(7002, "Erin");
    await env.DB.prepare("UPDATE team_members SET telegram_username = 'erin_db' WHERE id = ?").bind(erin).run();
    const chat = chatAs(ADMIN);
    await chat.text("/teammember");
    await chat.press("remove_member");
    expect(lastButtons()).toEqual(["Admin", "Erin (@erin_db)", "Erin (7002)"]);
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
