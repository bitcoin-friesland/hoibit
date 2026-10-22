import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

// The default export over a loopback service binding: the same RPC stub telegram-crm gets.
const crm = exports.default;

// Storage is shared between tests, so each test starts without CRM data
// (the reference tables from the baseline migration stay).
const DATA_TABLES = [
  "audit_log",
  "conversations",
  "referrals",
  "organization_promos",
  "organization_wallets",
  "organization_notes",
  "organization_communities",
  "organization_team_members",
  "contact_notes",
  "contact_phones",
  "contact_emails",
  "contacts",
  "organizations",
  "team_invites",
  "team_member_communities",
  "team_members"
];

beforeEach(async () => {
  await env.DB.batch([
    ...DATA_TABLES.map(table => env.DB.prepare(`DELETE FROM ${table}`)),
    env.DB.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${DATA_TABLES.map(() => "?").join(", ")})`).bind(
      ...DATA_TABLES
    )
  ]);
});

async function createFirstUser(telegramId = "1001") {
  const res = await crm.firstUser({ telegram_id: telegramId, name: "Admin" });
  if (!res.ok) throw new Error(res.error);
  return res.id;
}

// Adds a team member through an invite of adminId, as the bot does.
async function addMember(adminId: number, telegramId: string, name: string, communityIds: number[] = []) {
  const invite = await crm.createInvite({ invited_by: adminId, community_ids: communityIds });
  if (!invite.ok) throw new Error(invite.error);
  const res = await crm.acceptInvite({ token: invite.token, telegram_id: telegramId, name });
  if (!res.ok) throw new Error(res.error);
  return res.id;
}

const auditCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n;

async function lastAudit(action: string) {
  const row = await env.DB.prepare(
    "SELECT record_id, performed_by, change_details FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1"
  )
    .bind(action)
    .first<{ record_id: string; performed_by: number | null; change_details: string | null }>();
  return { ...row!, details: row!.change_details === null ? null : JSON.parse(row!.change_details) };
}

describe("firstUser", () => {
  it("creates the first team member as admin, then refuses a second", async () => {
    const id = await createFirstUser();
    const row = await env.DB.prepare(
      "SELECT telegram_id, is_admin, typeof(telegram_id) AS t FROM team_members WHERE id = ?"
    )
      .bind(id)
      .first();
    expect(row).toEqual({ telegram_id: "1001", is_admin: 1, t: "text" });
    const audit = await env.DB.prepare("SELECT record_id, performed_by FROM audit_log").first();
    expect(audit).toEqual({ record_id: String(id), performed_by: null });

    expect(await crm.firstUser({ telegram_id: "1002", name: "Other" })).toMatchObject({ ok: false, status: 409 });
  });

  it("makes only one of two simultaneous first users admin", async () => {
    const results = await Promise.all([
      crm.firstUser({ telegram_id: "1001", name: "A" }),
      crm.firstUser({ telegram_id: "1002", name: "B" })
    ]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toMatchObject([{ status: 409 }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members").first()).toEqual({ n: 1 });
    expect(await auditCount()).toBe(1);
  });
});

describe("validateUser", () => {
  it("returns null for an unknown Telegram user and the member for a known one", async () => {
    expect(await crm.validateUser(42)).toBeNull();
    await createFirstUser("4242");
    expect(await crm.validateUser(4242)).toMatchObject({ name: "Admin", is_admin: 1 });
  });
});

describe("invites", () => {
  async function invite(adminId: number, communityIds: number[] = []) {
    const res = await crm.createInvite({ invited_by: adminId, community_ids: communityIds });
    if (!res.ok) throw new Error(res.error);
    return res.token;
  }

  it("only lets admins create an invite, for known communities", async () => {
    expect(await crm.createInvite({ invited_by: 999 })).toMatchObject({ ok: false, status: 403 });
    expect(await crm.createInvite({ invited_by: null })).toMatchObject({ ok: false, status: 403 });
    const adminId = await createFirstUser();
    expect(await crm.createInvite({ invited_by: adminId, community_ids: [1, 9999] })).toMatchObject({
      ok: false,
      status: 400
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_invites").first()).toEqual({ n: 0 });
  });

  it("creates a one-week token that fits a Telegram start parameter and stays out of the log", async () => {
    const adminId = await createFirstUser();
    const before = Date.now();
    const res = await crm.createInvite({ invited_by: adminId, community_ids: [2, 1] });
    if (!res.ok) throw new Error(res.error);
    expect(res.token).toMatch(/^inv_[A-Za-z0-9_-]{22}$/);
    expect(res.expires_at - before).toBeGreaterThanOrEqual(7 * 24 * 3_600_000);
    expect(res.expires_at - before).toBeLessThan(7 * 24 * 3_600_000 + 60_000);
    const audit = await lastAudit("insert");
    expect(audit).toMatchObject({
      performed_by: adminId,
      details: { fields: { invited_by: { new: adminId }, community_ids: { new: [1, 2] } } }
    });
    expect(JSON.stringify(audit)).not.toContain(res.token.slice(4));
  });

  it("adds the user who opens the link, with the invite's communities, and uses the invite up", async () => {
    const adminId = await createFirstUser();
    const token = await invite(adminId, [6, 7]);
    const res = await crm.acceptInvite({ token, telegram_id: 2001, name: "Bob Smit", telegram_username: "bobsmit" });
    if (!res.ok) throw new Error(res.error);
    expect(res).toMatchObject({ invited_by: { telegram_id: "1001", name: "Admin" } });
    expect(res.existing).toBeUndefined();
    expect([...res.communities].sort()).toEqual(["Bitcoin Friesland", "Bitcoin Groningen"]);
    expect(
      await env.DB.prepare(
        "SELECT telegram_id, typeof(telegram_id) AS t, telegram_username, name, is_admin FROM team_members WHERE id = ?"
      )
        .bind(res.id)
        .first()
    ).toEqual({ telegram_id: "2001", t: "text", telegram_username: "bobsmit", name: "Bob Smit", is_admin: 0 });
    expect(
      await env.DB.prepare("SELECT used_by, used_at IS NOT NULL AS used FROM team_invites WHERE token = ?")
        .bind(token)
        .first()
    ).toEqual({ used_by: res.id, used: 1 });

    const audits = await env.DB.prepare(
      "SELECT action, table_name, record_id, performed_by, change_details FROM audit_log WHERE id > 2 ORDER BY id"
    ).all<{ action: string; table_name: string; record_id: string; performed_by: number; change_details: string }>();
    expect(audits.results.map(a => [a.action, a.table_name, a.performed_by])).toEqual([
      ["insert", "team_members", adminId],
      ["update", "team_invites", adminId]
    ]);
    expect(audits.results[0].record_id).toBe(String(res.id));
    expect(JSON.parse(audits.results[0].change_details).fields).toMatchObject({
      telegram_id: { new: "2001" },
      telegram_username: { new: "bobsmit" },
      community_ids: { new: [6, 7] }
    });
    expect(JSON.parse(audits.results[1].change_details).fields.used_by).toEqual({ old: null, new: res.id });

    // Used up: the next person gets nothing.
    expect(await crm.acceptInvite({ token, telegram_id: 2002, name: "Carol" })).toMatchObject({
      ok: false,
      status: 409
    });
  });

  it("leaves the invite unused for someone who already has access", async () => {
    const adminId = await createFirstUser();
    const token = await invite(adminId);
    const before = await auditCount();
    expect(await crm.acceptInvite({ token, telegram_id: "1001", name: "Admin" })).toEqual({
      ok: true,
      id: adminId,
      existing: true,
      invited_by: { telegram_id: "1001", name: "Admin" },
      communities: []
    });
    expect(await auditCount()).toBe(before);
    expect(await crm.acceptInvite({ token, telegram_id: "2001", name: "Bob" })).toMatchObject({ ok: true });
  });

  it("refuses an unknown, an expired and an incomplete invite", async () => {
    const adminId = await createFirstUser();
    expect(await crm.acceptInvite({ token: "inv_unknown", telegram_id: 2001, name: "Bob" })).toMatchObject({
      ok: false,
      status: 404
    });
    const token = await invite(adminId);
    expect(await crm.acceptInvite({ token, telegram_id: 2001, name: "" })).toMatchObject({ ok: false, status: 400 });
    expect(
      await crm.acceptInvite({ token, telegram_id: 2001, name: "Bob", telegram_username: "not a username" })
    ).toMatchObject({ ok: false, status: 400 });
    await env.DB.prepare("UPDATE team_invites SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    expect(await crm.acceptInvite({ token, telegram_id: 2001, name: "Bob" })).toMatchObject({
      ok: false,
      status: 409
    });
    expect(await crm.validateUser("2001")).toBeNull();
  });

  it("lets only one of two people opening the same link at once in", async () => {
    const adminId = await createFirstUser();
    const token = await invite(adminId, [1]);
    const results = await Promise.all([
      crm.acceptInvite({ token, telegram_id: 2001, name: "Bob" }),
      crm.acceptInvite({ token, telegram_id: 2002, name: "Carol" })
    ]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toMatchObject([{ status: 409 }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members").first()).toEqual({ n: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_member_communities").first()).toEqual({ n: 1 });
  });

  it("does not name an inviter who was removed since", async () => {
    const adminId = await createFirstUser();
    const otherAdmin = await crm.acceptInvite({ token: await invite(adminId), telegram_id: 2001, name: "Bob" });
    if (!otherAdmin.ok) throw new Error(otherAdmin.error);
    await crm.setAdmin({ team_member_id: otherAdmin.id, is_admin: true, updated_by: adminId });
    const token = await invite(otherAdmin.id);
    await crm.deleteTeamMember({ telegram_id: "2001", performed_by: adminId });
    expect(await crm.acceptInvite({ token, telegram_id: 2002, name: "Carol" })).toMatchObject({
      ok: true,
      invited_by: null
    });
  });
});

describe("setTelegramUsername", () => {
  it("stores a changed username with an audit entry by the member, and skips an unchanged one", async () => {
    const adminId = await createFirstUser();
    expect(await crm.setTelegramUsername({ telegram_id: "1001", telegram_username: "admin_nl" })).toEqual({
      ok: true,
      changed: true
    });
    expect(await crm.validateUser("1001")).toMatchObject({ telegram_username: "admin_nl" });
    expect(await lastAudit("update")).toMatchObject({
      record_id: String(adminId),
      performed_by: adminId,
      details: { fields: { telegram_username: { old: null, new: "admin_nl" } } }
    });
    const before = await auditCount();
    expect(await crm.setTelegramUsername({ telegram_id: "1001", telegram_username: "admin_nl" })).toEqual({
      ok: true,
      changed: false
    });
    expect(await auditCount()).toBe(before);
    // A user can remove their username in Telegram.
    expect(await crm.setTelegramUsername({ telegram_id: "1001", telegram_username: null })).toEqual({
      ok: true,
      changed: true
    });
    expect(await crm.validateUser("1001")).toMatchObject({ telegram_username: null });
  });

  it("refuses an unknown member and an invalid username", async () => {
    await createFirstUser();
    expect(await crm.setTelegramUsername({ telegram_id: "4242", telegram_username: "x_y" })).toMatchObject({
      ok: false,
      status: 404
    });
    expect(await crm.setTelegramUsername({ telegram_id: "1001", telegram_username: "@admin" })).toMatchObject({
      ok: false,
      status: 400
    });
  });
});

describe("updateTeamMember", () => {
  it("changes the name and replaces communities in one go", async () => {
    const adminId = await createFirstUser();
    await crm.updateTeamMember({ team_member_id: adminId, community_ids: [1, 2], updated_by: adminId });
    const res = await crm.updateTeamMember({
      team_member_id: adminId,
      name: "Renamed",
      community_ids: [3],
      updated_by: adminId
    });
    expect(res).toEqual({ ok: true });
    expect(await crm.validateUser("1001")).toMatchObject({ name: "Renamed" });
    expect((await crm.teamMemberCommunities("1001")).map(c => c.id)).toEqual([3]);
  });

  it("changes nothing when a community does not exist", async () => {
    const adminId = await createFirstUser();
    await crm.updateTeamMember({ team_member_id: adminId, community_ids: [1], updated_by: adminId });
    const error = await crm
      .updateTeamMember({ team_member_id: adminId, name: "Renamed", community_ids: [9999], updated_by: adminId })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(await crm.validateUser("1001")).toMatchObject({ name: "Admin" });
    expect((await crm.teamMemberCommunities("1001")).map(c => c.id)).toEqual([1]);
  });

  it("logs the old communities in updateTeamMember", async () => {
    const adminId = await createFirstUser();
    await crm.updateTeamMember({ team_member_id: adminId, community_ids: [1], updated_by: adminId });
    // A non-canonical id ("01") must still be logged as the row's id.
    await crm.updateTeamMember({ team_member_id: `0${adminId}`, community_ids: [2], updated_by: adminId });
    const audit = await lastAudit("update");
    expect(audit.details.fields.community_ids).toEqual({ old: [1], new: [2] });
    expect(audit.record_id).toBe(String(adminId));
  });

  it("writes no audit entry when nothing changes", async () => {
    const adminId = await createFirstUser();
    await crm.updateTeamMember({ team_member_id: adminId, community_ids: [1], updated_by: adminId });
    const before = await auditCount();
    const res = await crm.updateTeamMember({
      team_member_id: adminId,
      name: "Admin",
      community_ids: [1],
      updated_by: adminId
    });
    expect(res).toEqual({ ok: true });
    expect(await auditCount()).toBe(before);
  });

  it("lets a member change their own name and communities, but not someone else's", async () => {
    const adminId = await createFirstUser();
    const memberId = await addMember(adminId, "2002", "Member", [1]);
    const own = await crm.updateTeamMember({
      team_member_id: memberId,
      name: "Renamed",
      community_ids: [2],
      updated_by: memberId
    });
    expect(own).toEqual({ ok: true });
    expect(await crm.validateUser("2002")).toMatchObject({ name: "Renamed" });
    expect((await crm.teamMemberCommunities("2002")).map(c => c.id)).toEqual([2]);
    expect(await lastAudit("update")).toMatchObject({ record_id: String(memberId), performed_by: memberId });

    expect(
      await crm.updateTeamMember({ team_member_id: adminId, name: "Hijacked", updated_by: memberId })
    ).toMatchObject({ ok: false, status: 403 });
    expect(await crm.updateTeamMember({ team_member_id: memberId, name: "Nobody", updated_by: null })).toMatchObject({
      ok: false,
      status: 403
    });
    expect(await crm.validateUser("1001")).toMatchObject({ name: "Admin" });
  });
});

describe("setAdmin", () => {
  it("refuses to revoke the last admin", async () => {
    const adminId = await createFirstUser();
    const res = await crm.setAdmin({ team_member_id: adminId, is_admin: false, updated_by: adminId });
    expect(res).toMatchObject({ ok: false, status: 409 });
    // The UPDATE refused, so the audit insert in the same batch did not run (changes() = 0).
    expect(await auditCount()).toBe(1);
  });

  it("grants admin rights with one audit entry", async () => {
    const adminId = await createFirstUser();
    const memberId = await env.DB.prepare(
      "INSERT INTO team_members (telegram_id, name) VALUES ('2001', 'Bob') RETURNING id"
    ).first<number>("id");
    const res = await crm.setAdmin({ team_member_id: memberId!, is_admin: true, updated_by: adminId });
    expect(res).toEqual({ ok: true, id: memberId, is_admin: 1, changed: true });
    expect(await lastAudit("update")).toMatchObject({
      record_id: String(memberId),
      performed_by: adminId,
      details: { fields: { is_admin: { old: 0, new: 1 } } }
    });
  });

  it("keeps no admin change when its audit entry cannot be written", async () => {
    const adminId = await createFirstUser();
    const memberId = await env.DB.prepare(
      "INSERT INTO team_members (telegram_id, name) VALUES ('2001', 'Bob') RETURNING id"
    ).first<number>("id");
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
    try {
      await crm.setAdmin({ team_member_id: memberId!, is_admin: true, updated_by: adminId }).catch(() => undefined);
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
    }
    expect(await env.DB.prepare("SELECT is_admin FROM team_members WHERE id = ?").bind(memberId).first()).toEqual({
      is_admin: 0
    });
  });
});

describe("deleteTeamMember", () => {
  const addBob = (adminId: number) => addMember(adminId, "2001", "Bob", [1]);

  it("removes (deactivates) a member who ever saved something; they lose access", async () => {
    const adminId = await createFirstUser();
    const bobId = await addBob(adminId);
    await crm.setTelegramUsername({ telegram_id: "2001", telegram_username: "bob" });
    await crm.newContact({ name: "Alice", type: "consumer", created_by: bobId });
    expect(await crm.deleteTeamMember({ telegram_id: "2001", performed_by: adminId })).toEqual({
      ok: true,
      deactivated: true
    });
    expect(await crm.validateUser("2001")).toBeNull();
    expect(
      await env.DB.prepare("SELECT telegram_id, telegram_username, is_admin FROM team_members WHERE id = ?")
        .bind(bobId)
        .first()
    ).toEqual({ telegram_id: null, telegram_username: null, is_admin: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM team_member_communities WHERE team_member_id = ?")
        .bind(bobId)
        .first()
    ).toEqual({ n: 0 });
    expect(await lastAudit("update")).toMatchObject({
      record_id: String(bobId),
      performed_by: adminId,
      details: {
        fields: {
          telegram_id: { old: "2001", new: null },
          telegram_username: { old: "bob", new: null },
          community_ids: { old: [1], new: [] }
        }
      }
    });
    // The deactivated row still counts, so first-user registration stays closed.
    expect(await crm.countTeamMembers()).toBe(2);
  });

  it("deactivates a member who joined with an invite link", async () => {
    const adminId = await createFirstUser();
    const bobId = await addBob(adminId);
    expect(await crm.deleteTeamMember({ telegram_id: "2001", performed_by: adminId })).toEqual({
      ok: true,
      deactivated: true
    });
    expect(await env.DB.prepare("SELECT telegram_id FROM team_members WHERE id = ?").bind(bobId).first()).toEqual({
      telegram_id: null
    });
  });

  it("deletes a member without history", async () => {
    const adminId = await createFirstUser();
    // Members without an invite were added before invite links existed.
    const { id: bobId } = (await env.DB.prepare(
      "INSERT INTO team_members (telegram_id, name) VALUES ('2001', 'Bob') RETURNING id"
    ).first<{ id: number }>())!;
    expect(await crm.deleteTeamMember({ telegram_id: "2001", performed_by: adminId })).toEqual({
      ok: true,
      deactivated: false
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE id = ?").bind(bobId).first()).toEqual({
      n: 0
    });
    expect(await lastAudit("delete")).toMatchObject({ record_id: String(bobId), performed_by: adminId });
  });

  it("refuses to remove the last admin, with or without history", async () => {
    const adminId = await createFirstUser();
    expect(await crm.deleteTeamMember({ telegram_id: "1001", performed_by: adminId })).toMatchObject({
      ok: false,
      status: 409
    });
    await crm.newContact({ name: "Alice", type: "consumer", created_by: adminId });
    const before = await auditCount();
    expect(await crm.deleteTeamMember({ telegram_id: "1001", performed_by: adminId })).toMatchObject({
      ok: false,
      status: 409
    });
    expect(await crm.validateUser("1001")).toMatchObject({ id: adminId, is_admin: 1 });
    expect(await auditCount()).toBe(before);
  });
});

describe("newContact", () => {
  it("stores the contact with email, phone and audit entry and returns its id", async () => {
    const adminId = await createFirstUser();
    const res = await crm.newContact({
      name: "Alice",
      type: "entrepreneur",
      email: "alice@example.com",
      phone: "+31612345678",
      created_by: adminId
    });
    if (!res.ok) throw new Error(res.error);
    const { id } = res;

    const contact = await env.DB.prepare("SELECT name, type FROM contacts WHERE id = ?").bind(id).first();
    expect(contact).toEqual({ name: "Alice", type: "entrepreneur" });
    const email = await env.DB.prepare("SELECT email FROM contact_emails WHERE contact_id = ?").bind(id).first();
    expect(email).toEqual({ email: "alice@example.com" });
    const phone = await env.DB.prepare("SELECT phone FROM contact_phones WHERE contact_id = ?").bind(id).first();
    expect(phone).toEqual({ phone: "+31612345678" });
    const audit = await env.DB.prepare("SELECT record_id FROM audit_log WHERE table_name = 'contacts'").first();
    expect(audit).toEqual({ record_id: String(id) });
  });

  it("stores phone numbers in international form and refuses national ones", async () => {
    for (const [input, stored] of [
      ["+31 (0)6-1234 5678", "+31612345678"],
      ["0031 6 12345678", "+31612345678"],
      ["+32 470 12.34.56", "+32470123456"]
    ]) {
      const res = await crm.newContact({ name: "Alice", type: "consumer", phone: input });
      if (!res.ok) throw new Error(res.error);
      expect(
        await env.DB.prepare("SELECT phone FROM contact_phones WHERE contact_id = ?").bind(res.id).first()
      ).toEqual({ phone: stored });
      expect((await lastAudit("insert")).details.fields.phone).toEqual({ old: null, new: stored });
    }
    for (const phone of ["06 12345678", "+31 6", "phone"]) {
      expect(await crm.newContact({ name: "Bob", type: "consumer", phone })).toMatchObject({ ok: false, status: 400 });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE name = 'Bob'").first()).toEqual({ n: 0 });
  });

  it("rejects a contact without type", async () => {
    expect(await crm.newContact({ name: "Alice", type: "" })).toMatchObject({ ok: false, status: 400 });
  });

  it("creates a new organization together with the contact", async () => {
    const adminId = await createFirstUser();
    const res = await crm.newContact({
      name: "Alice",
      type: "entrepreneur",
      email: "alice@cafe.nl",
      created_by: adminId,
      new_organization: { name: "Cafe", status: 2, community_ids: [3], website: "https://cafe.nl" }
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.organization_id).toEqual(expect.any(Number));
    expect(await env.DB.prepare("SELECT organization_id FROM contacts WHERE id = ?").bind(res.id).first()).toEqual({
      organization_id: res.organization_id
    });
    expect(await crm.searchOrganizations({ name: "cafe" })).toMatchObject([
      { id: res.organization_id, community_id: 3 }
    ]);
    const audits = await env.DB.prepare(
      "SELECT table_name, record_id, performed_by, change_details FROM audit_log WHERE table_name IN ('organizations', 'contacts') ORDER BY id"
    ).all<{ table_name: string; record_id: string; performed_by: number; change_details: string }>();
    expect(audits.results.map(a => [a.table_name, a.record_id, a.performed_by])).toEqual([
      ["organizations", String(res.organization_id), adminId],
      ["contacts", String(res.id), adminId]
    ]);
    expect(JSON.parse(audits.results[1].change_details).fields.organization_id).toEqual({
      old: null,
      new: res.organization_id
    });
  });

  it("returns the existing organization id, or null without one", async () => {
    const org = await crm.newOrg({ name: "Cafe", status: 2 });
    if (!org.ok) throw new Error(org.error);
    expect(await crm.newContact({ name: "Alice", type: "consumer", organization_id: org.id })).toMatchObject({
      ok: true,
      organization_id: org.id
    });
    expect(await crm.newContact({ name: "Bob", type: "consumer" })).toMatchObject({ ok: true, organization_id: null });
  });

  it("stores neither organization nor contact when one statement fails", async () => {
    const error = await crm
      .newContact({
        name: "Alice",
        type: "entrepreneur",
        new_organization: { name: "Broken", status: 2, community_ids: [9999] }
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM organizations) AS orgs, (SELECT COUNT(*) FROM contacts) AS contacts, (SELECT COUNT(*) FROM audit_log) AS audits"
    ).first();
    expect(counts).toEqual({ orgs: 0, contacts: 0, audits: 0 });
  });

  it("refuses an organization id together with a new organization, or an incomplete new organization", async () => {
    expect(
      await crm.newContact({
        name: "Alice",
        type: "entrepreneur",
        organization_id: 1,
        new_organization: { name: "Cafe", status: 2 }
      })
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await crm.newContact({ name: "Alice", type: "entrepreneur", new_organization: { name: "", status: 2 } })
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await crm.newContact({ name: "Alice", type: "entrepreneur", new_organization: { name: "Cafe", status: "" } })
    ).toMatchObject({ ok: false, status: 400 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first()).toEqual({ n: 0 });
  });
});

describe("newOrg", () => {
  it("stores the organization with its communities and returns its id", async () => {
    const res = await crm.newOrg({ name: "Cafe Satoshi", status: 2, community_ids: [3], location_osm_id: 12345 });
    if (!res.ok) throw new Error(res.error);
    const org = await env.DB.prepare("SELECT name, status, location_osm_id FROM organizations WHERE id = ?")
      .bind(res.id)
      .first();
    expect(org).toEqual({ name: "Cafe Satoshi", status: 2, location_osm_id: "12345" });
    expect(await crm.searchOrganizations({ name: "satoshi" })).toMatchObject([{ id: res.id, community_id: 3 }]);
  });

  it("stores nothing when one statement fails", async () => {
    const error = await crm.newOrg({ name: "Broken", status: 2, community_ids: [9999] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM organizations").first();
    expect(count).toEqual({ n: 0 });
  });
});

describe("searchOrganizations", () => {
  it("finds an organization by the email of its contact", async () => {
    const a = await crm.newOrg({ name: "Cafe A", status: 2 });
    const b = await crm.newOrg({ name: "Cafe B", status: 2 });
    if (!a.ok || !b.ok) throw new Error("newOrg failed");
    // The contact gets id 1, which is also organization A's id.
    await crm.newContact({ name: "Xander", type: "entrepreneur", organization_id: b.id, email: "x@cafe-b.nl" });
    expect((await crm.searchOrganizations({ email: "x@cafe-b.nl" })).map(r => r.name)).toEqual(["Cafe B"]);
  });

  it("finds an organization whose website has the domain of the email address", async () => {
    await crm.newOrg({ name: "Cafe C", status: 2, website: "https://www.cafe-c.nl" });
    await crm.newOrg({ name: "Cafe D", status: 2, website: "https://cafe-d.nl" });
    expect((await crm.searchOrganizations({ email: "info@cafe-c.nl" })).map(r => r.name)).toEqual(["Cafe C"]);
    expect(await crm.searchOrganizations({ email: "no-at-sign" })).toEqual([]);
  });

  it("ranks an organization by any of its communities", async () => {
    await crm.newOrg({ name: "Zebra", status: 2, community_ids: [1, 3] });
    await crm.newOrg({ name: "Aap", status: 2, community_ids: [2] });
    for (const priority of [1, 3]) {
      expect((await crm.searchOrganizations({ community_id: priority }))[0]).toMatchObject({
        name: "Zebra",
        is_priority_community: 1,
        community_id: priority
      });
    }
    expect(await crm.searchOrganizations({ community_id: 2 })).toMatchObject([
      { name: "Aap", is_priority_community: 1, community_id: 2 },
      { name: "Zebra", is_priority_community: 0, community_id: 1 }
    ]);
  });
});

describe("logConversation", () => {
  async function createContact() {
    const res = await crm.newContact({ name: "Alice", type: "consumer" });
    if (!res.ok) throw new Error(res.error);
    return res.id;
  }

  it("stores the conversation with its team member and an audit entry for it", async () => {
    const adminId = await createFirstUser();
    const contactId = await createContact();
    const res = await crm.logConversation({
      contact_id: String(contactId),
      channel: "phone",
      note: "Interested in a Lightning terminal",
      created_by: adminId
    });
    if (!res.ok) throw new Error(res.error);

    const row = await env.DB.prepare("SELECT contact_id, channel, note, created_by FROM conversations WHERE id = ?")
      .bind(res.id)
      .first();
    expect(row).toEqual({
      contact_id: contactId,
      channel: "phone",
      note: "Interested in a Lightning terminal",
      created_by: adminId
    });
    const audit = await env.DB.prepare(
      "SELECT action, record_id, performed_by, change_details FROM audit_log WHERE table_name = 'conversations'"
    ).first<{ change_details: string }>();
    expect(audit).toMatchObject({ action: "insert", record_id: String(res.id), performed_by: adminId });
    expect(JSON.parse(audit!.change_details)).toEqual({
      fields: {
        contact_id: { old: null, new: contactId },
        channel: { old: null, new: "phone" },
        note: { old: null, new: "Interested in a Lightning terminal" }
      }
    });
  });

  it("refuses a missing or unknown contact and an unknown channel", async () => {
    const contactId = await createContact();
    expect(await crm.logConversation({ contact_id: "", channel: "phone" })).toMatchObject({ ok: false, status: 400 });
    expect(await crm.logConversation({ contact_id: 9999, channel: "phone" })).toMatchObject({
      ok: false,
      status: 404
    });
    expect(await crm.logConversation({ contact_id: contactId, channel: "pigeon" })).toMatchObject({
      ok: false,
      status: 400
    });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first();
    expect(count).toEqual({ n: 0 });
  });

  it("stores the day the conversation took place and logs it", async () => {
    const contactId = await createContact();
    const res = await crm.logConversation({ contact_id: contactId, channel: "phone", happened_on: "2026-10-20" });
    if (!res.ok) throw new Error(res.error);
    const row = await env.DB.prepare("SELECT happened_on FROM conversations WHERE id = ?").bind(res.id).first();
    expect(row).toEqual({ happened_on: "2026-10-20" });
    expect((await lastAudit("insert")).details.fields.happened_on).toEqual({ old: null, new: "2026-10-20" });
  });

  it("refuses a day that does not exist, is in the future or is not YYYY-MM-DD", async () => {
    const contactId = await createContact();
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const happened_on of ["2026-02-30", nextWeek, "20-10-2026", "2026-10-20T10:00"]) {
      expect(await crm.logConversation({ contact_id: contactId, channel: "phone", happened_on })).toMatchObject({
        ok: false,
        status: 400,
        error: "Invalid happened_on"
      });
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first();
    expect(count).toEqual({ n: 0 });
  });
});

describe("searchContacts", () => {
  it("finds contacts by part of the name, ordered by name, with their organization", async () => {
    const org = await crm.newOrg({ name: "Cafe Satoshi", status: 2 });
    if (!org.ok) throw new Error(org.error);
    await crm.newContact({ name: "Johan", type: "consumer" });
    await crm.newContact({ name: "anja", type: "entrepreneur", organization_id: org.id });
    await crm.newContact({ name: "Bob", type: "consumer" });
    expect(await crm.searchContacts("AN")).toMatchObject([
      { name: "anja", organization_name: "Cafe Satoshi" },
      { name: "Johan", organization_name: null }
    ]);
  });
});

describe("recentContacts", () => {
  it("lists the contacts a member added or talked to, most recent first, without duplicates", async () => {
    const adminId = await createFirstUser();
    const bob = await crm.acceptInvite({
      token: ((await crm.createInvite({ invited_by: adminId })) as { token: string }).token,
      telegram_id: 2001,
      name: "Bob"
    });
    if (!bob.ok) throw new Error(bob.error);
    const org = await crm.newOrg({ name: "Cafe Satoshi", status: 2 });
    if (!org.ok) throw new Error(org.error);
    const add = async (name: string, createdBy: number, organizationId?: number) => {
      const res = await crm.newContact({
        name,
        type: "consumer",
        created_by: createdBy,
        organization_id: organizationId
      });
      if (!res.ok) throw new Error(res.error);
      return res.id;
    };
    const anna = await add("Anna", adminId, org.id);
    const bram = await add("Bram", adminId);
    await add("Carla", bob.id);
    await crm.logConversation({ contact_id: anna, channel: "phone", note: "Called again", created_by: adminId });

    expect(await crm.recentContacts(adminId)).toEqual([
      { id: anna, name: "Anna", organization_name: "Cafe Satoshi" },
      { id: bram, name: "Bram", organization_name: null }
    ]);
    expect((await crm.recentContacts(adminId, 1)).map(c => c.name)).toEqual(["Anna"]);
    expect((await crm.recentContacts(bob.id)).map(c => c.name)).toEqual(["Carla"]);
  });
});

describe("getContact", () => {
  it("returns the contact with its organization, or null", async () => {
    const org = await crm.newOrg({ name: "Cafe Satoshi", status: 2 });
    if (!org.ok) throw new Error(org.error);
    const res = await crm.newContact({ name: "Anna", type: "entrepreneur", organization_id: org.id });
    if (!res.ok) throw new Error(res.error);
    expect(await crm.getContact(String(res.id))).toEqual({
      id: res.id,
      name: "Anna",
      organization_name: "Cafe Satoshi"
    });
    expect(await crm.getContact(9999)).toBeNull();
  });
});

describe("contactDetails", () => {
  it("returns the contact's details and its most recent conversations, or null", async () => {
    const adminId = await createFirstUser();
    const org = await crm.newOrg({ name: "Cafe Satoshi", status: 2 });
    if (!org.ok) throw new Error(org.error);
    const res = await crm.newContact({
      name: "Anna",
      type: "entrepreneur",
      organization_id: org.id,
      email: "anna@example.com",
      phone: "+31612345678",
      nostr_npub: "npub1anna"
    });
    if (!res.ok) throw new Error(res.error);
    await env.DB.prepare("INSERT INTO contact_emails (contact_id, email) VALUES (?, ?)")
      .bind(res.id, "anna@satoshi.cafe")
      .run();
    await crm.logConversation({ contact_id: res.id, channel: "phone", note: "First call", created_by: adminId });
    // Logged before conversations had created_by: the team member comes from the audit entry.
    await crm.logConversation({ contact_id: res.id, channel: "in-person", created_by: adminId });
    await env.DB.prepare("UPDATE conversations SET created_by = NULL WHERE note IS NULL").run();

    const details = await crm.contactDetails(String(res.id));
    expect(details).toMatchObject({
      id: res.id,
      name: "Anna",
      type: "entrepreneur",
      type_label: "Entrepreneur",
      organization_id: org.id,
      organization_name: "Cafe Satoshi",
      nostr_npub: "npub1anna",
      emails: ["anna@example.com", "anna@satoshi.cafe"],
      phones: ["+31612345678"],
      conversations: [
        { contact_id: res.id, contact_name: "Anna", channel: "In Person", note: null, logged_by: "Admin" },
        { contact_id: res.id, contact_name: "Anna", channel: "Phone", note: "First call", logged_by: "Admin" }
      ]
    });
    expect(details!.conversations[0].logged_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect((await crm.contactDetails(res.id, 1))!.conversations).toHaveLength(1);
    expect(await crm.contactDetails(9999)).toBeNull();
  });

  it("puts the conversations in the order they took place, not the order they were logged", async () => {
    const res = await crm.newContact({ name: "Anna", type: "consumer" });
    if (!res.ok) throw new Error(res.error);
    await crm.logConversation({ contact_id: res.id, channel: "phone", note: "Today" });
    await crm.logConversation({ contact_id: res.id, channel: "phone", note: "Last week", happened_on: "2026-10-14" });
    await crm.logConversation({ contact_id: res.id, channel: "phone", note: "Yesterday", happened_on: "2026-10-20" });
    // Without happened_on, the day it was logged counts.
    await env.DB.prepare(
      "UPDATE audit_log SET timestamp = '2026-10-21 09:00:00' WHERE table_name = 'conversations'"
    ).run();

    const details = await crm.contactDetails(res.id);
    expect(details!.conversations.map(c => [c.note, c.happened_on])).toEqual([
      ["Today", null],
      ["Yesterday", "2026-10-20"],
      ["Last week", "2026-10-14"]
    ]);
  });
});

describe("organizationDetails", () => {
  it("returns the organization with status, communities, contacts and their conversations, or null", async () => {
    const org = await crm.newOrg({ name: "Cafe Satoshi", status: 2, website: "satoshi.cafe", community_ids: [1] });
    if (!org.ok) throw new Error(org.error);
    const add = async (name: string) => {
      const res = await crm.newContact({ name, type: "entrepreneur", organization_id: org.id });
      if (!res.ok) throw new Error(res.error);
      return res.id;
    };
    const bram = await add("Bram");
    const anna = await add("Anna");
    await crm.newContact({ name: "Elsewhere", type: "consumer" });
    await crm.logConversation({ contact_id: bram, channel: "phone" });
    await crm.logConversation({ contact_id: anna, channel: "email", note: "Sent the brochure" });

    const community = await env.DB.prepare("SELECT name FROM bitcoin_communities WHERE id = 1").first<{
      name: string;
    }>();
    expect(await crm.organizationDetails(String(org.id))).toEqual({
      id: org.id,
      name: "Cafe Satoshi",
      status: 2,
      status_label: "Accepts Bitcoin",
      website: "satoshi.cafe",
      nostr_npub: null,
      location_osm_id: null,
      address: null,
      category: null,
      phone: null,
      email: null,
      follow_up_on: null,
      communities: [community!.name],
      handled_by: [],
      notes: [],
      contacts: [
        { id: anna, name: "Anna" },
        { id: bram, name: "Bram" }
      ],
      conversations: [
        expect.objectContaining({ contact_name: "Anna", channel: "Email", note: "Sent the brochure", logged_by: null }),
        expect.objectContaining({ contact_name: "Bram", channel: "Phone", note: null })
      ]
    });
    expect(await crm.organizationDetails(9999)).toBeNull();
  });
});

describe("updateContact", () => {
  async function createAnna() {
    const res = await crm.newContact({
      name: "Anna",
      type: "consumer",
      email: "anna@example.com",
      nostr_npub: "npub1anna"
    });
    if (!res.ok) throw new Error(res.error);
    return res.id;
  }

  it("changes only the given details, in one audited update", async () => {
    const adminId = await createFirstUser();
    const id = await createAnna();
    const before = await auditCount();
    const res = await crm.updateContact({
      contact_id: String(id),
      name: " Anna de Vries ",
      email: "anna@devries.nl",
      phone: "0031 6 12345678",
      nostr_npub: null,
      updated_by: adminId
    });
    expect(res).toEqual({ ok: true, changed: true });
    expect(await crm.contactDetails(id)).toMatchObject({
      name: "Anna de Vries",
      type: "consumer",
      emails: ["anna@devries.nl"],
      phones: ["+31612345678"],
      nostr_npub: null
    });
    expect(await auditCount()).toBe(before + 1);
    expect(await lastAudit("update")).toEqual({
      record_id: String(id),
      performed_by: adminId,
      change_details: expect.any(String),
      details: {
        fields: {
          name: { old: "Anna", new: "Anna de Vries" },
          nostr_npub: { old: "npub1anna", new: null },
          email: { old: "anna@example.com", new: "anna@devries.nl" },
          phone: { old: null, new: "+31612345678" }
        }
      }
    });
  });

  it("removes the first email address and keeps the others", async () => {
    const id = await createAnna();
    await env.DB.prepare("INSERT INTO contact_emails (contact_id, email) VALUES (?, ?)")
      .bind(id, "second@example.com")
      .run();
    expect(await crm.updateContact({ contact_id: id, email: "" })).toEqual({ ok: true, changed: true });
    expect((await crm.contactDetails(id))!.emails).toEqual(["second@example.com"]);
  });

  it("writes nothing when nothing changes", async () => {
    const id = await createAnna();
    const before = await auditCount();
    expect(await crm.updateContact({ contact_id: id, name: "Anna", email: "anna@example.com" })).toEqual({
      ok: true,
      changed: false
    });
    expect(await crm.updateContact({ contact_id: id })).toEqual({ ok: true, changed: false });
    expect(await auditCount()).toBe(before);
  });

  it("refuses an empty name, a national phone number and an unknown contact", async () => {
    const id = await createAnna();
    expect(await crm.updateContact({ contact_id: id, name: " " })).toMatchObject({ ok: false, status: 400 });
    expect(await crm.updateContact({ contact_id: id, phone: "06 12345678" })).toMatchObject({ ok: false, status: 400 });
    expect(await crm.updateContact({ contact_id: 9999, name: "Bob" })).toMatchObject({ ok: false, status: 404 });
    expect((await crm.contactDetails(id))!.phones).toEqual([]);
  });

  it("changes the type and the organization, and unlinks the organization", async () => {
    const id = await createAnna();
    const org = await crm.newOrg({ name: "Cafe Satoshi", status: 2 });
    if (!org.ok) throw new Error(org.error);
    expect(await crm.updateContact({ contact_id: id, type: "entrepreneur", organization_id: String(org.id) })).toEqual({
      ok: true,
      changed: true
    });
    expect(await crm.contactDetails(id)).toMatchObject({
      type: "entrepreneur",
      organization_id: org.id,
      organization_name: "Cafe Satoshi"
    });
    expect((await lastAudit("update"))!.details).toEqual({
      fields: {
        type: { old: "consumer", new: "entrepreneur" },
        organization_id: { old: null, new: org.id }
      }
    });
    expect(await crm.updateContact({ contact_id: id, organization_id: org.id })).toEqual({ ok: true, changed: false });
    expect(await crm.updateContact({ contact_id: id, organization_id: null })).toEqual({ ok: true, changed: true });
    expect(await crm.contactDetails(id)).toMatchObject({ organization_id: null, organization_name: null });
  });

  it("refuses an unknown type or organization", async () => {
    const id = await createAnna();
    expect(await crm.updateContact({ contact_id: id, type: "robot" })).toMatchObject({ ok: false, status: 400 });
    expect(await crm.updateContact({ contact_id: id, organization_id: 9999 })).toMatchObject({
      ok: false,
      status: 404
    });
    expect(await crm.contactDetails(id)).toMatchObject({ type: "consumer", organization_id: null });
  });
});

describe("updateOrg", () => {
  async function createCafe() {
    const res = await crm.newOrg({ name: "Cafe Satoshi", status: 1, website: "satoshi.cafe" });
    if (!res.ok) throw new Error(res.error);
    return res.id;
  }

  it("changes the status and other details, in one audited update", async () => {
    const adminId = await createFirstUser();
    const id = await createCafe();
    const res = await crm.updateOrg({
      organization_id: String(id),
      status: "2",
      website: null,
      nostr_npub: "npub1cafe",
      updated_by: adminId
    });
    expect(res).toEqual({ ok: true, changed: true });
    expect(await crm.organizationDetails(id)).toMatchObject({
      name: "Cafe Satoshi",
      status: 2,
      status_label: "Accepts Bitcoin",
      website: null,
      nostr_npub: "npub1cafe"
    });
    expect(await lastAudit("update")).toMatchObject({
      record_id: String(id),
      performed_by: adminId,
      details: {
        fields: {
          status: { old: 1, new: 2 },
          website: { old: "satoshi.cafe", new: null },
          nostr_npub: { old: null, new: "npub1cafe" }
        }
      }
    });
  });

  it("writes nothing when nothing changes", async () => {
    const id = await createCafe();
    const before = await auditCount();
    expect(await crm.updateOrg({ organization_id: id, status: 1, name: "Cafe Satoshi" })).toEqual({
      ok: true,
      changed: false
    });
    expect(await auditCount()).toBe(before);
  });

  it("refuses an unknown status, an empty name and an unknown organization", async () => {
    const id = await createCafe();
    expect(await crm.updateOrg({ organization_id: id, status: 99 })).toMatchObject({ ok: false, status: 400 });
    expect(await crm.updateOrg({ organization_id: id, name: "" })).toMatchObject({ ok: false, status: 400 });
    expect(await crm.updateOrg({ organization_id: 9999, status: 2 })).toMatchObject({ ok: false, status: 404 });
    expect((await crm.organizationDetails(id))!.status).toBe(1);
  });

  it("replaces the communities and changes or removes the location", async () => {
    const id = await createCafe();
    await env.DB.prepare("INSERT INTO organization_communities (organization_id, community_id) VALUES (?, 1)")
      .bind(id)
      .run();
    expect(
      await crm.updateOrg({ organization_id: id, community_ids: ["3", 2, 2], location_osm_id: "node/42" })
    ).toEqual({ ok: true, changed: true });
    expect((await crm.organizationCommunities(id)).map(c => c.id).sort()).toEqual([2, 3]);
    expect((await crm.organizationDetails(id))!.location_osm_id).toBe("node/42");
    expect((await lastAudit("update"))!.details).toEqual({
      fields: {
        location_osm_id: { old: null, new: "node/42" },
        community_ids: { old: [1], new: [2, 3] }
      }
    });
    expect(await crm.updateOrg({ organization_id: id, community_ids: [3, 2] })).toEqual({ ok: true, changed: false });
    expect(await crm.updateOrg({ organization_id: id, community_ids: [], location_osm_id: null })).toEqual({
      ok: true,
      changed: true
    });
    expect(await crm.organizationCommunities(id)).toEqual([]);
    expect((await crm.organizationDetails(id))!.location_osm_id).toBeNull();
  });

  it("refuses an unknown community", async () => {
    const id = await createCafe();
    expect(await crm.updateOrg({ organization_id: id, community_ids: [1, 9999] })).toMatchObject({
      ok: false,
      status: 400
    });
    expect(await crm.organizationCommunities(id)).toEqual([]);
  });
});

describe("organization details from Baserow", () => {
  it("stores address, category, phone, email, follow-up day and handlers of a new organization", async () => {
    const adminId = await createFirstUser();
    const bobId = await addMember(adminId, "2001", "Bob");
    const res = await crm.newOrg({
      name: "Smuk Espressobar",
      status: 7,
      address: "Kleinzand 1, Sneek",
      category: "Restaurant - Lunch",
      phone: "+31 515 123 456",
      email: "info@smuk.nl",
      follow_up_on: "2027-01-12",
      team_member_ids: [bobId, adminId, bobId],
      created_by: adminId
    });
    if (!res.ok) throw new Error(res.error);
    expect(await crm.organizationDetails(res.id)).toMatchObject({
      status_label: "Hesitant",
      address: "Kleinzand 1, Sneek",
      category: "Restaurant - Lunch",
      phone: "+31515123456",
      email: "info@smuk.nl",
      follow_up_on: "2027-01-12",
      handled_by: [
        { id: adminId, name: "Admin", telegram_id: "1001" },
        { id: bobId, name: "Bob", telegram_id: "2001" }
      ]
    });
    expect((await lastAudit("insert")).details.fields).toMatchObject({
      phone: { old: null, new: "+31515123456" },
      follow_up_on: { old: null, new: "2027-01-12" },
      team_member_ids: { old: null, new: [adminId, bobId] }
    });
  });

  it("refuses a national phone number or an invalid follow-up day, also for a new organization of a contact", async () => {
    expect(await crm.newOrg({ name: "A", status: 1, phone: "0515123456" })).toMatchObject({ ok: false, status: 400 });
    expect(await crm.newOrg({ name: "A", status: 1, follow_up_on: "2027-02-30" })).toMatchObject({
      ok: false,
      status: 400,
      error: "Invalid follow_up_on"
    });
    expect(
      await crm.newContact({
        name: "Anna",
        type: "entrepreneur",
        new_organization: { name: "A", status: 1, follow_up_on: "12-01-2027" }
      })
    ).toMatchObject({ ok: false, status: 400 });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM organizations").first();
    expect(count).toEqual({ n: 0 });
  });

  it("changes the details and replaces the handlers, only with team members who have access", async () => {
    const adminId = await createFirstUser();
    const bobId = await addMember(adminId, "2001", "Bob");
    const org = await crm.newOrg({ name: "Cafe", status: 1, team_member_ids: [adminId] });
    if (!org.ok) throw new Error(org.error);
    expect(
      await crm.updateOrg({
        organization_id: org.id,
        address: "Grootzand 2, Sneek",
        phone: "0031 6 1234 5678",
        follow_up_on: "2027-03-01",
        team_member_ids: [bobId],
        updated_by: adminId
      })
    ).toEqual({ ok: true, changed: true });
    expect((await lastAudit("update")).details.fields).toEqual({
      address: { old: null, new: "Grootzand 2, Sneek" },
      phone: { old: null, new: "+31612345678" },
      follow_up_on: { old: null, new: "2027-03-01" },
      team_member_ids: { old: [adminId], new: [bobId] }
    });
    expect(await crm.updateOrg({ organization_id: org.id, team_member_ids: [9999] })).toMatchObject({
      ok: false,
      status: 400,
      error: "Unknown team member"
    });
    expect(await crm.updateOrg({ organization_id: org.id, phone: "06 1234 5678" })).toMatchObject({
      ok: false,
      status: 400
    });
    expect(await crm.updateOrg({ organization_id: org.id, follow_up_on: null, phone: "" })).toEqual({
      ok: true,
      changed: true
    });
    expect(await crm.organizationDetails(org.id)).toMatchObject({
      follow_up_on: null,
      phone: null,
      handled_by: [{ id: bobId, name: "Bob" }]
    });
  });

  it("shows notes, and conversations with the organization itself next to those with its contacts", async () => {
    const adminId = await createFirstUser();
    const org = await crm.newOrg({ name: "Cafe", status: 1 });
    if (!org.ok) throw new Error(org.error);
    const anna = await crm.newContact({ name: "Anna", type: "entrepreneur", organization_id: org.id });
    if (!anna.ok) throw new Error(anna.error);
    await env.DB.prepare("INSERT INTO organization_notes (organization_id, note) VALUES (?, ?), (?, ?)")
      .bind(org.id, "First note", org.id, "Second note")
      .run();
    await crm.logConversation({ contact_id: anna.id, channel: "phone", happened_on: "2026-10-01" });
    const res = await crm.logConversation({
      organization_id: org.id,
      channel: "in-person",
      note: "Spoke to staff",
      happened_on: "2026-10-05",
      created_by: adminId
    });
    if (!res.ok) throw new Error(res.error);
    expect((await lastAudit("insert")).details.fields.organization_id).toEqual({ old: null, new: org.id });
    const details = await crm.organizationDetails(org.id);
    expect(details!.notes).toEqual(["First note", "Second note"]);
    expect(details!.conversations).toMatchObject([
      { contact_id: null, contact_name: null, note: "Spoke to staff", logged_by: "Admin" },
      { contact_id: anna.id, contact_name: "Anna" }
    ]);
    expect((await crm.contactDetails(anna.id))!.conversations).toHaveLength(1);
  });

  it("refuses a conversation with both, neither or an unknown organization", async () => {
    const org = await crm.newOrg({ name: "Cafe", status: 1 });
    const anna = await crm.newContact({ name: "Anna", type: "consumer" });
    if (!org.ok || !anna.ok) throw new Error("setup failed");
    for (const [input, status] of [
      [{ contact_id: anna.id, organization_id: org.id }, 400],
      [{}, 400],
      [{ organization_id: 9999 }, 404]
    ] as const) {
      expect(await crm.logConversation({ ...input, channel: "phone" })).toMatchObject({ ok: false, status });
    }
  });

  it("lists follow-ups up to a day, the earliest first, mine and those nobody handles", async () => {
    const adminId = await createFirstUser();
    const bobId = await addMember(adminId, "2001", "Bob");
    const add = async (name: string, follow_up_on: string | null, team_member_ids: number[]) => {
      const res = await crm.newOrg({ name, status: 1, follow_up_on, team_member_ids });
      if (!res.ok) throw new Error(res.error);
      return res.id;
    };
    await add("Later", "2027-05-01", [adminId]);
    const bobs = await add("Bob's", "2026-11-02", [bobId]);
    const mine = await add("Mine", "2026-11-03", [adminId]);
    const nobody = await add("Nobody", "2026-11-01", []);
    await add("No day", null, [adminId]);

    expect((await crm.followUps({ until: "2026-12-31" })).map(f => f.id)).toEqual([nobody, bobs, mine]);
    expect(await crm.followUps({ until: "2026-12-31", team_member_id: adminId })).toEqual([
      { id: nobody, name: "Nobody", follow_up_on: "2026-11-01", status_label: "Curious about Bitcoin", handled_by: [] },
      {
        id: mine,
        name: "Mine",
        follow_up_on: "2026-11-03",
        status_label: "Curious about Bitcoin",
        handled_by: [{ id: adminId, name: "Admin", telegram_id: "1001" }]
      }
    ]);
    await expect(crm.followUps({ until: "31-12-2026" })).rejects.toThrow();
  });

  it("stops a removed team member handling organizations", async () => {
    const adminId = await createFirstUser();
    const bobId = await addMember(adminId, "2001", "Bob");
    const carlaId = await addMember(adminId, "3001", "Carla");
    const org = await crm.newOrg({ name: "Cafe", status: 1, team_member_ids: [bobId, carlaId] });
    if (!org.ok) throw new Error(org.error);
    // Bob has history (he joined with an invite) and is deactivated; Carla too.
    await crm.deleteTeamMember({ telegram_id: "2001", performed_by: adminId });
    expect((await lastAudit("update")).details.fields.handled_organization_ids).toEqual({ old: [org.id], new: [] });
    expect((await crm.organizationDetails(org.id))!.handled_by.map(h => h.name)).toEqual(["Carla"]);
    // A member without any history is deleted, which the handler row must not block.
    await env.DB.prepare("DELETE FROM team_invites").run();
    await env.DB.prepare("DELETE FROM audit_log WHERE performed_by = ?").bind(carlaId).run();
    expect(await crm.deleteTeamMember({ telegram_id: "3001", performed_by: adminId })).toEqual({
      ok: true,
      deactivated: false
    });
    expect((await crm.organizationDetails(org.id))!.handled_by).toEqual([]);
  });
});

describe("listTeamMembers", () => {
  it("includes the Telegram username", async () => {
    await createFirstUser();
    await crm.setTelegramUsername({ telegram_id: "1001", telegram_username: "admin_nl" });
    expect(await crm.listTeamMembers()).toEqual([
      { id: 1, telegram_id: "1001", telegram_username: "admin_nl", name: "Admin", is_admin: 1 }
    ]);
  });

  it("leaves out deactivated members", async () => {
    const adminId = await createFirstUser();
    const bobId = await addMember(adminId, "2001", "Bob");
    expect((await crm.listTeamMembers()).map(m => m.name)).toEqual(["Admin", "Bob"]);
    await crm.newContact({ name: "Alice", type: "consumer", created_by: bobId });
    await crm.deleteTeamMember({ telegram_id: "2001", performed_by: adminId });
    expect((await crm.listTeamMembers()).map(m => m.name)).toEqual(["Admin"]);
  });
});

describe("lookups", () => {
  it("lists countries and communities per country", async () => {
    expect(await crm.communityCountries()).toEqual(expect.arrayContaining(["Netherlands", "Belgium"]));
    const belgian = await crm.communities("Belgium");
    expect(belgian.length).toBeGreaterThan(0);
    expect(belgian.every(c => c.country === "Belgium")).toBe(true);
  });
});

describe("HTTP", () => {
  it("serves no HTTP API", async () => {
    const res = await crm.fetch("https://crm-api/validate-user", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});
