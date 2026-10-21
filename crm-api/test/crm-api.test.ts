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
  "contact_notes",
  "contact_phones",
  "contact_emails",
  "contacts",
  "organizations",
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

describe("addTeamMember", () => {
  it("only lets admins add members", async () => {
    const res = await crm.addTeamMember({ telegram_id: "2001", name: "Bob", invited_by: 999 });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it("adds a member with communities and a digits-only audit record_id", async () => {
    const adminId = await createFirstUser();
    const res = await crm.addTeamMember({ telegram_id: 2001, name: "Bob", community_ids: [1, 2], invited_by: adminId });
    if (!res.ok) throw new Error(res.error);
    expect(res.created).toBe(true);

    const communities = await env.DB.prepare(
      "SELECT community_id FROM team_member_communities WHERE team_member_id = ? ORDER BY community_id"
    )
      .bind(res.id)
      .all<{ community_id: number }>();
    expect(communities.results.map(r => r.community_id)).toEqual([1, 2]);

    const audit = await env.DB.prepare(
      "SELECT record_id, performed_by FROM audit_log WHERE table_name = 'team_members' ORDER BY id DESC LIMIT 1"
    ).first();
    expect(audit).toEqual({ record_id: String(res.id), performed_by: adminId });
  });

  it("adds communities to an existing member without a second row", async () => {
    const adminId = await createFirstUser();
    const res = await crm.addTeamMember({
      telegram_id: "1001",
      name: "Admin",
      community_ids: [3],
      invited_by: adminId
    });
    expect(res).toEqual({ ok: true, id: adminId, existing: true });
    expect(await crm.teamMemberCommunities("1001")).toMatchObject([{ id: 3 }]);
  });

  it("audits adding communities to an existing member", async () => {
    const adminId = await createFirstUser();
    const before = await auditCount();
    await crm.addTeamMember({
      telegram_id: "1001",
      name: "Admin",
      community_ids: [3],
      time_zone: "Europe/Amsterdam",
      invited_by: adminId
    });
    expect(await auditCount()).toBe(before + 1);
    expect(await lastAudit("update")).toMatchObject({
      record_id: String(adminId),
      performed_by: adminId,
      details: {
        fields: {
          time_zone: { old: null, new: "Europe/Amsterdam" },
          community_ids: { old: [], new: [3] }
        }
      }
    });
  });

  it("writes no audit entry when an existing member does not change", async () => {
    const adminId = await createFirstUser();
    await crm.addTeamMember({ telegram_id: "1001", name: "Admin", community_ids: [3], invited_by: adminId });
    const before = await auditCount();
    const res = await crm.addTeamMember({
      telegram_id: "1001",
      name: "Admin",
      community_ids: [3],
      invited_by: adminId
    });
    expect(res).toEqual({ ok: true, id: adminId, existing: true });
    expect(await auditCount()).toBe(before);
  });

  it("logs the communities of a new member", async () => {
    const adminId = await createFirstUser();
    await crm.addTeamMember({ telegram_id: "2001", name: "Bob", community_ids: [2, 1], invited_by: adminId });
    expect((await lastAudit("insert")).details.fields.community_ids).toEqual({ old: null, new: [2, 1] });
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
  async function addBob(adminId: number) {
    const added = await crm.addTeamMember({
      telegram_id: "2001",
      name: "Bob",
      community_ids: [1],
      invited_by: adminId
    });
    if (!added.ok) throw new Error(added.error);
    return added.id;
  }

  it("removes (deactivates) a member who ever saved something; they lose access", async () => {
    const adminId = await createFirstUser();
    const bobId = await addBob(adminId);
    await crm.newContact({ name: "Alice", type: "consumer", created_by: bobId });
    expect(await crm.deleteTeamMember({ telegram_id: "2001", performed_by: adminId })).toEqual({
      ok: true,
      deactivated: true
    });
    expect(await crm.validateUser("2001")).toBeNull();
    expect(
      await env.DB.prepare("SELECT telegram_id, is_admin FROM team_members WHERE id = ?").bind(bobId).first()
    ).toEqual({ telegram_id: null, is_admin: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM team_member_communities WHERE team_member_id = ?")
        .bind(bobId)
        .first()
    ).toEqual({ n: 0 });
    expect(await lastAudit("update")).toMatchObject({
      record_id: String(bobId),
      performed_by: adminId,
      details: { fields: { telegram_id: { old: "2001", new: null }, community_ids: { old: [1], new: [] } } }
    });
    // The deactivated row still counts, so first-user registration stays closed.
    expect(await crm.countTeamMembers()).toBe(2);
  });

  it("deletes a member without history", async () => {
    const adminId = await createFirstUser();
    const bobId = await addBob(adminId);
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

describe("listTeamMembers", () => {
  it("leaves out deactivated members", async () => {
    const adminId = await createFirstUser();
    const added = await crm.addTeamMember({ telegram_id: "2001", name: "Bob", invited_by: adminId });
    if (!added.ok) throw new Error(added.error);
    expect((await crm.listTeamMembers()).map(m => m.name)).toEqual(["Admin", "Bob"]);
    await crm.newContact({ name: "Alice", type: "consumer", created_by: added.id });
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
