import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addAdmin, addMember, chatAs, lastKeyboardMessage, resetAndStubFetch, type SentMessage } from "./harness";

const ADMIN = 5001;
const MEMBER = 7001;
let sent: SentMessage[];

beforeEach(async () => {
  sent = await resetAndStubFetch();
});

const lastText = () => sent[sent.length - 1]?.text;

// Button texts of the member's newest message with buttons, without the Cancel row.
function lastButtons(): string[] {
  const keyboard = lastKeyboardMessage(MEMBER)?.reply_markup?.inline_keyboard ?? [];
  return keyboard.filter(row => row[0].callback_data !== "cancel").map(row => row.map(b => b.text).join(" | "));
}

async function communityIds(memberId: number) {
  const { results } = await env.DB.prepare(
    "SELECT community_id FROM team_member_communities WHERE team_member_id = ? ORDER BY community_id"
  )
    .bind(memberId)
    .all<{ community_id: number }>();
  return results.map(r => r.community_id);
}

describe("/me", () => {
  it("shows the member's own name and communities, also to members who are no admin", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    await env.DB.prepare("INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, 1)")
      .bind(memberId)
      .run();
    await chatAs(MEMBER).text("/me");
    expect(lastText()).toBe("🙋 Erin\n👥 Hard Money Cafe");
    expect(lastButtons()).toEqual(["✏️ Name | 👥 Communities"]);

    await chatAs(ADMIN).text("/me");
    expect(lastText()).toBe("🙋 Admin\n👥 No communities\n🔑 Admin");
  });

  it("changes the member's own name", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    const chat = chatAs(MEMBER);
    await chat.text("/me");
    await chat.press("me:name");
    expect(lastText()).toBe("What is your name?");
    await chat.text("4");
    expect(lastText()).toBe("❌ Please enter a name of at least 2 letters, without digits or @.");
    await chat.text("Erin de Vries");
    expect(lastText()).toBe('✅ Your name is now "Erin de Vries".');
    const row = await env.DB.prepare("SELECT name FROM team_members WHERE id = ?").bind(memberId).first();
    expect(row).toEqual({ name: "Erin de Vries" });
    const audit = await env.DB.prepare(
      "SELECT record_id, performed_by FROM audit_log WHERE action = 'update' AND table_name = 'team_members'"
    ).first();
    expect(audit).toEqual({ record_id: String(memberId), performed_by: memberId });
  });

  it("replaces the member's own communities, starting from the current ones", async () => {
    await addAdmin(ADMIN);
    const memberId = (await addMember(MEMBER, "Erin"))!;
    await env.DB.prepare("INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, 1)")
      .bind(memberId)
      .run();
    const chat = chatAs(MEMBER);
    await chat.text("/me");
    await chat.press("me:communities");
    expect(lastText()).toBe("Select your Bitcoin communities:");
    expect(lastButtons()[0]).toBe("✅ Hard Money Cafe");
    await chat.press("community:1");
    await chat.press("choose_other");
    await chat.press("country:0");
    await chat.press("community:2");
    await chat.press("done");
    expect(lastText()).toBe("✅ Your communities are now: Arnhem Bitcoinstad.");
    expect(await communityIds(memberId)).toEqual([2]);
  });

  it("is in the main menu for every member", async () => {
    await addAdmin(ADMIN);
    await addMember(MEMBER, "Erin");
    const chat = chatAs(MEMBER);
    await chat.text("/help");
    expect(lastText()).toContain("/me - Your name and communities");
    expect(lastButtons()).toContain("⏰ Follow-ups | 🙋 Me");
    await chat.press("menu:me");
    expect(lastText()).toBe("🙋 Erin\n👥 No communities");
  });
});
