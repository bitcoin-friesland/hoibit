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
});

describe("setAdmin", () => {
  it("refuses to revoke the last admin", async () => {
    const adminId = await createFirstUser();
    const res = await crm.setAdmin({ team_member_id: adminId, is_admin: false, updated_by: adminId });
    expect(res).toMatchObject({ ok: false, status: 409 });
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
