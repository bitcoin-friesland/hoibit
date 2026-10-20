import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

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

function post(path, body) {
  return exports.default.fetch(`https://crm-api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function createFirstUser(telegramId = "1001") {
  const res = await post("/first-user", { telegram_id: telegramId, name: "Admin" });
  expect(res.status).toBe(200);
  return (await res.json()).id;
}

describe("/first-user", () => {
  it("creates the first team member as admin, then refuses a second", async () => {
    const id = await createFirstUser();
    const row = await env.DB.prepare(
      "SELECT telegram_id, is_admin, typeof(telegram_id) AS t FROM team_members WHERE id = ?"
    )
      .bind(id)
      .first();
    expect(row).toEqual({ telegram_id: "1001", is_admin: 1, t: "text" });

    const again = await post("/first-user", { telegram_id: "1002", name: "Other" });
    expect(again.status).toBe(409);
  });
});

describe("/validate-user", () => {
  it("returns 404 for an unknown Telegram user and the member for a known one", async () => {
    expect((await post("/validate-user", { telegram_id: 42 })).status).toBe(404);
    await createFirstUser("4242");
    const res = await post("/validate-user", { telegram_id: 4242 });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Admin");
  });
});

describe("/team_member", () => {
  it("only lets admins add members", async () => {
    const res = await post("/team_member", { telegram_id: "2001", name: "Bob", invited_by: 999 });
    expect(res.status).toBe(403);
  });

  it("adds a member with communities and a digits-only audit record_id", async () => {
    const adminId = await createFirstUser();
    const res = await post("/team_member", {
      telegram_id: 2001,
      name: "Bob",
      community_ids: [1, 2],
      invited_by: adminId
    });
    expect(res.status).toBe(200);
    const { id, created } = await res.json();
    expect(created).toBe(true);

    const communities = await env.DB.prepare(
      "SELECT community_id FROM team_member_communities WHERE team_member_id = ? ORDER BY community_id"
    )
      .bind(id)
      .all();
    expect(communities.results.map(r => r.community_id)).toEqual([1, 2]);

    const audit = await env.DB.prepare(
      "SELECT record_id FROM audit_log WHERE table_name = 'team_members' AND action = 'insert' ORDER BY id DESC LIMIT 1"
    ).first();
    expect(audit.record_id).toBe(String(id));
  });
});

describe("/team_member/admin", () => {
  it("refuses to revoke the last admin", async () => {
    const adminId = await createFirstUser();
    const res = await post("/team_member/admin", { team_member_id: adminId, is_admin: false, updated_by: adminId });
    expect(res.status).toBe(409);
  });
});

describe("/newcontact", () => {
  it("stores the contact with email, phone and audit entry and returns its id", async () => {
    const adminId = await createFirstUser();
    const res = await post("/newcontact", {
      name: "Alice",
      type: "entrepreneur",
      email: "alice@example.com",
      phone: "+31612345678",
      created_by: adminId
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();

    const contact = await env.DB.prepare("SELECT name, type FROM contacts WHERE id = ?").bind(id).first();
    expect(contact).toEqual({ name: "Alice", type: "entrepreneur" });
    const email = await env.DB.prepare("SELECT email FROM contact_emails WHERE contact_id = ?").bind(id).first();
    expect(email.email).toBe("alice@example.com");
    const phone = await env.DB.prepare("SELECT phone FROM contact_phones WHERE contact_id = ?").bind(id).first();
    expect(phone.phone).toBe("+31612345678");
    const audit = await env.DB.prepare("SELECT record_id FROM audit_log WHERE table_name = 'contacts'").first();
    expect(audit.record_id).toBe(String(id));
  });

  it("rejects a contact without type", async () => {
    expect((await post("/newcontact", { name: "Alice" })).status).toBe(400);
  });
});

describe("/neworg", () => {
  it("stores the organization with its communities and returns its id", async () => {
    const res = await post("/neworg", { name: "Cafe Satoshi", status: 2, community_ids: [3], location_osm_id: 12345 });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const org = await env.DB.prepare("SELECT name, status, location_osm_id FROM organizations WHERE id = ?")
      .bind(id)
      .first();
    expect(org).toEqual({ name: "Cafe Satoshi", status: 2, location_osm_id: "12345" });
    const link = await env.DB.prepare("SELECT community_id FROM organization_communities WHERE organization_id = ?")
      .bind(id)
      .first();
    expect(link.community_id).toBe(3);
  });

  it("stores nothing when one statement fails", async () => {
    const res = await post("/neworg", { name: "Broken", status: 2, community_ids: [9999] });
    expect(res.status).toBe(500);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM organizations").first();
    expect(count.n).toBe(0);
  });
});
