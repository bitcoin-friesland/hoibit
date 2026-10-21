import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AddTeamMemberInput,
  Community,
  ContactSearchRow,
  DeleteTeamMemberInput,
  FirstUserInput,
  LogConversationInput,
  Lookup,
  NewContactInput,
  NewOrgInput,
  OrganizationSearch,
  OrganizationSearchRow,
  Refusal,
  Result,
  RowId,
  SetAdminInput,
  SetOrganizationCommunitiesInput,
  TeamMember,
  TeamMemberSummary,
  TelegramId,
  UpdateTeamMemberInput
} from "./types";

export type * from "./types";

// Declared here rather than taken from the generated global Env, so that callers that
// import this class for its RPC types (telegram-crm) type-check it against the right bindings.
export interface CrmEnv {
  DB: D1Database;
}

// Bind types must match the D1 column types (see .crm-rules.md): INTEGER columns get a number,
// TEXT columns that hold ids (team_members.telegram_id, audit_log.record_id) get a string.
const toInt = (value: RowId) => parseInt(String(value), 10);
const toIntOrNull = (value: RowId | null | undefined) => (value ? toInt(value) : null);

const refuse = (status: Refusal["status"], error: string): Refusal => ({ ok: false, status, error });

// The id of the row just inserted into an AUTOINCREMENT table, usable inside the same batch.
const lastIdSql = (table: string) => `(SELECT seq FROM sqlite_sequence WHERE name = '${table}')`;

// record_id is bound (`?`), or taken from the row inserted earlier in the same batch.
const auditSql = (recordId = "?") =>
  `INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES (?, ?, ${recordId}, ?, ?)`;
const insertedIdText = (table: string) => `CAST(${lastIdSql(table)} AS TEXT)`;

type Change = { old: unknown; new: unknown };
const created = (value: unknown): Change => ({ old: null, new: value });

/**
 * The CRM data API. telegram-crm calls these methods over its crmApi service binding (RPC).
 * crm-api has no public URL and no authentication of its own; admin-only methods check
 * team_members.is_admin of the acting team member.
 */
export default class CrmApi extends WorkerEntrypoint<CrmEnv> {
  // RPC only; there is no HTTP API.
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  private get db() {
    return this.env.DB;
  }

  // Only admins (team_members.is_admin = 1) may add team members or change admin rights.
  private async isAdmin(teamMemberId: RowId | null | undefined): Promise<boolean> {
    if (!teamMemberId) return false;
    const row = await this.db
      .prepare(`SELECT is_admin FROM team_members WHERE id = ?`)
      .bind(toInt(teamMemberId))
      .first<{ is_admin: number }>();
    return !!row && row.is_admin === 1;
  }

  async validateUser(telegramId: TelegramId): Promise<TeamMember | null> {
    return this.db
      .prepare(`SELECT * FROM team_members WHERE telegram_id = ?`)
      .bind(String(telegramId))
      .first<TeamMember>();
  }

  async countTeamMembers(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM team_members").first<{ count: number }>();
    return row?.count ?? 0;
  }

  async listTeamMembers(): Promise<TeamMemberSummary[]> {
    const { results } = await this.db
      .prepare(`SELECT id, telegram_id, name, is_admin FROM team_members ORDER BY name`)
      .all<TeamMemberSummary>();
    return results;
  }

  // First user registration: only allowed while there are no team members; the first user is admin.
  async firstUser(data: FirstUserInput): Promise<Result<{ id: number }>> {
    if (!data.telegram_id || !data.name) return refuse(400, "Missing telegram_id or name");
    if ((await this.countTeamMembers()) > 0) {
      return refuse(409, "First user registration not allowed: team members already exist");
    }
    const timeZone = data.time_zone || null;
    const results = await this.db.batch([
      this.db
        .prepare(`INSERT INTO team_members (telegram_id, name, time_zone, is_admin) VALUES (?, ?, ?, 1)`)
        .bind(String(data.telegram_id), data.name, timeZone),
      this.db.prepare(auditSql(insertedIdText("team_members"))).bind(
        "insert",
        "team_members",
        null,
        JSON.stringify({
          fields: {
            telegram_id: created(data.telegram_id),
            name: created(data.name),
            ...(timeZone ? { time_zone: created(timeZone) } : {}),
            is_admin: created(1)
          }
        })
      ),
      this.db.prepare(`SELECT seq AS id FROM sqlite_sequence WHERE name = 'team_members'`)
    ]);
    return { ok: true, id: lastId(results) };
  }

  // Adds a team member, or adds communities (and time zone) to an existing one.
  async addTeamMember(data: AddTeamMemberInput): Promise<Result<{ id: number; created?: true; existing?: true }>> {
    if (!data.telegram_id || !data.name) return refuse(400, "Missing telegram_id or name");
    if (!(await this.isAdmin(data.invited_by))) return refuse(403, "Only admins can add team members");
    const communityIds = (data.community_ids ?? []).map(toInt);
    const existing = await this.db
      .prepare(`SELECT id FROM team_members WHERE telegram_id = ?`)
      .bind(String(data.telegram_id))
      .first<{ id: number }>();
    if (existing) {
      const statements = communityIds.map(communityId =>
        this.db
          .prepare(`INSERT OR IGNORE INTO team_member_communities (team_member_id, community_id) VALUES (?, ?)`)
          .bind(existing.id, communityId)
      );
      if (data.time_zone) {
        statements.push(
          this.db.prepare(`UPDATE team_members SET time_zone = ? WHERE id = ?`).bind(data.time_zone, existing.id)
        );
      }
      if (statements.length > 0) await this.db.batch(statements);
      return { ok: true, id: existing.id, existing: true };
    }
    const memberIdSql = lastIdSql("team_members");
    const timeZone = data.time_zone || null;
    const results = await this.db.batch([
      this.db
        .prepare(`INSERT INTO team_members (telegram_id, name, time_zone) VALUES (?, ?, ?)`)
        .bind(String(data.telegram_id), data.name, timeZone),
      ...communityIds.map(communityId =>
        this.db
          .prepare(`INSERT INTO team_member_communities (team_member_id, community_id) VALUES (${memberIdSql}, ?)`)
          .bind(communityId)
      ),
      this.db.prepare(auditSql(insertedIdText("team_members"))).bind(
        "insert",
        "team_members",
        toIntOrNull(data.invited_by),
        JSON.stringify({
          fields: {
            telegram_id: created(data.telegram_id),
            name: created(data.name),
            ...(timeZone ? { time_zone: created(timeZone) } : {})
          }
        })
      ),
      this.db.prepare(`SELECT seq AS id FROM sqlite_sequence WHERE name = 'team_members'`)
    ]);
    return { ok: true, id: lastId(results), created: true };
  }

  // Changes name and/or time zone, and replaces the communities when community_ids is given.
  async updateTeamMember(data: UpdateTeamMemberInput): Promise<Result> {
    if (!data.team_member_id) return refuse(400, "Missing team_member_id");
    if (!(await this.isAdmin(data.updated_by))) return refuse(403, "Only admins can update team members");
    const memberId = toInt(data.team_member_id);
    const oldMember = await this.db
      .prepare(`SELECT name, time_zone FROM team_members WHERE id = ?`)
      .bind(memberId)
      .first<{ name: string | null; time_zone: string | null }>();
    if (!oldMember) return refuse(404, "Team member not found");

    const statements: D1PreparedStatement[] = [];
    const changedFields: Record<string, Change> = {};
    const setParts: string[] = [];
    const params: string[] = [];
    if (data.name) {
      setParts.push("name = ?");
      params.push(data.name);
      if (oldMember.name !== data.name) changedFields.name = { old: oldMember.name, new: data.name };
    }
    if (data.time_zone) {
      setParts.push("time_zone = ?");
      params.push(data.time_zone);
      if (oldMember.time_zone !== data.time_zone) {
        changedFields.time_zone = { old: oldMember.time_zone, new: data.time_zone };
      }
    }
    if (setParts.length > 0) {
      statements.push(
        this.db.prepare(`UPDATE team_members SET ${setParts.join(", ")} WHERE id = ?`).bind(...params, memberId)
      );
    }
    if (Array.isArray(data.community_ids)) {
      statements.push(
        this.db.prepare(`DELETE FROM team_member_communities WHERE team_member_id = ?`).bind(memberId),
        ...data.community_ids.map(communityId =>
          this.db
            .prepare(`INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, ?)`)
            .bind(memberId, toInt(communityId))
        )
      );
      changedFields.community_ids = { old: "replaced", new: data.community_ids };
    }
    statements.push(
      this.db
        .prepare(auditSql())
        .bind(
          "update",
          "team_members",
          String(data.team_member_id),
          toIntOrNull(data.updated_by),
          Object.keys(changedFields).length > 0 ? JSON.stringify({ fields: changedFields }) : null
        )
    );
    await this.db.batch(statements);
    return { ok: true };
  }

  async setAdmin(data: SetAdminInput): Promise<Result<{ id: number; is_admin: 0 | 1; changed: boolean }>> {
    if (!data.team_member_id || typeof data.is_admin !== "boolean") {
      return refuse(400, "Missing team_member_id or is_admin");
    }
    if (!(await this.isAdmin(data.updated_by))) return refuse(403, "Only admins can change admin rights");
    const member = await this.db
      .prepare(`SELECT id, is_admin FROM team_members WHERE id = ?`)
      .bind(toInt(data.team_member_id))
      .first<{ id: number; is_admin: 0 | 1 }>();
    if (!member) return refuse(404, "Team member not found");
    const newValue = data.is_admin ? 1 : 0;
    if (member.is_admin === newValue) return { ok: true, id: member.id, is_admin: newValue, changed: false };
    // Revoking only succeeds while another admin remains, checked in the same statement.
    const res = await this.db
      .prepare(
        newValue === 1
          ? `UPDATE team_members SET is_admin = 1 WHERE id = ?`
          : `UPDATE team_members SET is_admin = 0 WHERE id = ? AND (SELECT COUNT(*) FROM team_members WHERE is_admin = 1) > 1`
      )
      .bind(member.id)
      .run();
    if (res.meta.changes !== 1) return refuse(409, "Cannot revoke the last admin");
    await this.db
      .prepare(auditSql())
      .bind(
        "update",
        "team_members",
        String(member.id),
        toIntOrNull(data.updated_by),
        JSON.stringify({ fields: { is_admin: { old: member.is_admin, new: newValue } } })
      )
      .run();
    return { ok: true, id: member.id, is_admin: newValue, changed: true };
  }

  async deleteTeamMember(data: DeleteTeamMemberInput): Promise<Result> {
    if (!data.telegram_id) return refuse(400, "Missing telegram_id");
    if (!(await this.isAdmin(data.performed_by))) return refuse(403, "Only admins can delete team members");
    const oldMember = await this.db
      .prepare(`SELECT id, telegram_id, name, time_zone, is_admin FROM team_members WHERE telegram_id = ?`)
      .bind(String(data.telegram_id))
      .first<TeamMember>();
    if (!oldMember) return refuse(404, "Team member not found");
    if (oldMember.is_admin === 1) {
      const admins = await this.db
        .prepare(`SELECT COUNT(*) AS count FROM team_members WHERE is_admin = 1`)
        .first<{ count: number }>();
      if (!admins || admins.count <= 1) return refuse(409, "Cannot delete the last admin");
    }
    // audit_log.performed_by references team_members(id); history is kept, so a member
    // who performed audited actions cannot be deleted (foreign key violation).
    const history = await this.db
      .prepare(`SELECT COUNT(*) AS count FROM audit_log WHERE performed_by = ?`)
      .bind(oldMember.id)
      .first<{ count: number }>();
    if (history && history.count > 0) return refuse(409, "Team member has audit history and cannot be deleted");
    // One transaction: community links, the member and the audit entry together.
    await this.db.batch([
      this.db.prepare(`DELETE FROM team_member_communities WHERE team_member_id = ?`).bind(oldMember.id),
      this.db.prepare(`DELETE FROM team_members WHERE id = ?`).bind(oldMember.id),
      this.db.prepare(auditSql()).bind(
        "delete",
        "team_members",
        String(oldMember.id),
        toIntOrNull(data.performed_by),
        JSON.stringify({
          fields: {
            telegram_id: { old: oldMember.telegram_id, new: null },
            name: { old: oldMember.name, new: null },
            time_zone: { old: oldMember.time_zone, new: null },
            is_admin: { old: oldMember.is_admin, new: null }
          }
        })
      )
    ]);
    return { ok: true };
  }

  async teamMemberCommunities(telegramId: TelegramId): Promise<Community[]> {
    const member = await this.db
      .prepare("SELECT id FROM team_members WHERE telegram_id = ?")
      .bind(String(telegramId))
      .first<{ id: number }>();
    if (!member) return [];
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.name, c.country, c.region
         FROM team_member_communities tmc
         JOIN bitcoin_communities c ON tmc.community_id = c.id
         WHERE tmc.team_member_id = ?`
      )
      .bind(member.id)
      .all<Community>();
    return results;
  }

  async communityCountries(): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT country FROM bitcoin_communities")
      .all<{ country: string }>();
    return results.map(r => r.country);
  }

  async communities(country?: string | null): Promise<Community[]> {
    const statement = country
      ? this.db.prepare("SELECT id, name, country, region FROM bitcoin_communities WHERE country = ?").bind(country)
      : this.db.prepare("SELECT id, name, country, region FROM bitcoin_communities");
    const { results } = await statement.all<Community>();
    return results;
  }

  async channels(): Promise<Lookup[]> {
    const { results } = await this.db.prepare("SELECT id, label FROM channels").all<Lookup>();
    return results;
  }

  async contactTypes(): Promise<Lookup[]> {
    const { results } = await this.db.prepare("SELECT id, label FROM contact_types").all<Lookup>();
    return results;
  }

  // Organizations matching all given filters; those in community_id come first.
  async searchOrganizations(search: OrganizationSearch): Promise<OrganizationSearchRow[]> {
    let query = `
      SELECT o.id, o.name, o.website, o.location_osm_id, o.status, o.nostr_npub,
             bc.id AS community_id, bc.name AS community_name, bc.region, bc.country,
             CASE WHEN oc.community_id = ? THEN 1 ELSE 0 END AS is_priority_community
      FROM organizations o
      LEFT JOIN organization_communities oc ON o.id = oc.organization_id
      LEFT JOIN bitcoin_communities bc ON oc.community_id = bc.id
      LEFT JOIN contact_emails ce ON o.id = ce.contact_id
      WHERE 1=1
    `;
    const params: (string | number | null)[] = [toIntOrNull(search.community_id)];
    if (search.domain) {
      query += " AND o.website LIKE ?";
      params.push(`%${search.domain}%`);
    }
    if (search.name) {
      query += " AND o.name LIKE ? COLLATE NOCASE";
      params.push(`%${search.name}%`);
    }
    if (search.email) {
      query += " AND (ce.email LIKE ? OR o.website LIKE ?)";
      params.push(`%${search.email}%`, `%${search.email}%`);
    }
    query += " GROUP BY o.id ORDER BY is_priority_community DESC, o.name ASC";
    const { results } = await this.db
      .prepare(query)
      .bind(...params)
      .all<OrganizationSearchRow>();
    return results;
  }

  async searchContacts(name?: string | null): Promise<ContactSearchRow[]> {
    let query = `
      SELECT contacts.id, contacts.name, organizations.name AS organization_name
      FROM contacts
      LEFT JOIN organizations ON contacts.organization_id = organizations.id
      WHERE 1=1
    `;
    const params: string[] = [];
    if (name) {
      query += " AND contacts.name LIKE ? COLLATE NOCASE";
      params.push(`%${name}%`);
    }
    query += " ORDER BY contacts.name COLLATE NOCASE, contacts.id";
    const { results } = await this.db
      .prepare(query)
      .bind(...params)
      .all<ContactSearchRow>();
    return results;
  }

  // One transaction: contact, email, phone and audit entry.
  async newContact(data: NewContactInput): Promise<Result<{ id: number }>> {
    if (!data.name || !data.type) return refuse(400, "Missing required fields: name or type");
    const contactIdSql = lastIdSql("contacts");
    const organizationId = toIntOrNull(data.organization_id);
    const statements = [
      this.db
        .prepare(`INSERT INTO contacts (name, type, organization_id, nostr_npub) VALUES (?, ?, ?, ?)`)
        .bind(data.name, data.type, organizationId, data.nostr_npub || null)
    ];
    if (data.email) {
      statements.push(
        this.db.prepare(`INSERT INTO contact_emails (contact_id, email) VALUES (${contactIdSql}, ?)`).bind(data.email)
      );
    }
    if (data.phone) {
      statements.push(
        this.db.prepare(`INSERT INTO contact_phones (contact_id, phone) VALUES (${contactIdSql}, ?)`).bind(data.phone)
      );
    }
    statements.push(
      this.db.prepare(auditSql(insertedIdText("contacts"))).bind(
        "insert",
        "contacts",
        toIntOrNull(data.created_by),
        JSON.stringify({
          fields: {
            name: created(data.name),
            type: created(data.type),
            organization_id: created(organizationId),
            ...(data.nostr_npub ? { nostr_npub: created(data.nostr_npub) } : {}),
            ...(data.email ? { email: created(data.email) } : {}),
            ...(data.phone ? { phone: created(data.phone) } : {})
          }
        })
      ),
      this.db.prepare(`SELECT seq AS id FROM sqlite_sequence WHERE name = 'contacts'`)
    );
    return { ok: true, id: lastId(await this.db.batch(statements)) };
  }

  // One transaction: organization, its communities and the audit entry.
  async newOrg(data: NewOrgInput): Promise<Result<{ id: number }>> {
    if (!data.name || !data.status) return refuse(400, "Missing required fields: name or status");
    const orgIdSql = lastIdSql("organizations");
    const status = toInt(data.status);
    const osmId = data.location_osm_id ? String(data.location_osm_id) : null;
    const communityIds = (data.community_ids ?? []).map(toInt);
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO organizations (name, status, location_osm_id, website, nostr_npub) VALUES (?, ?, ?, ?, ?)`
        )
        .bind(data.name, status, osmId, data.website || null, data.nostr_npub || null),
      ...communityIds.map(communityId =>
        this.db
          .prepare(`INSERT INTO organization_communities (organization_id, community_id) VALUES (${orgIdSql}, ?)`)
          .bind(communityId)
      ),
      this.db.prepare(auditSql(insertedIdText("organizations"))).bind(
        "insert",
        "organizations",
        toIntOrNull(data.created_by),
        JSON.stringify({
          fields: {
            name: created(data.name),
            status: created(status),
            ...(osmId ? { location_osm_id: created(osmId) } : {}),
            ...(data.website ? { website: created(data.website) } : {}),
            ...(data.nostr_npub ? { nostr_npub: created(data.nostr_npub) } : {}),
            ...(communityIds.length > 0 ? { community_ids: created(communityIds) } : {})
          }
        })
      ),
      this.db.prepare(`SELECT seq AS id FROM sqlite_sequence WHERE name = 'organizations'`)
    ]);
    return { ok: true, id: lastId(results) };
  }

  // One transaction: the conversation and its audit entry.
  async logConversation(data: LogConversationInput): Promise<Result<{ id: number }>> {
    if (!data.contact_id) return refuse(400, "Missing contact_id (must be unique, selected from UI)");
    if (!data.channel) return refuse(400, "Missing channel");
    const contactId = toInt(data.contact_id);
    const known = await this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM contacts WHERE id = ?) AS contact,
                EXISTS (SELECT 1 FROM channels WHERE id = ?) AS channel`
      )
      .bind(contactId, data.channel)
      .first<{ contact: 0 | 1; channel: 0 | 1 }>();
    if (!known?.contact) return refuse(404, "Contact not found");
    if (!known.channel) return refuse(400, "Unknown channel");
    const createdBy = toIntOrNull(data.created_by);
    const note = data.note || null;
    const results = await this.db.batch([
      this.db
        .prepare(`INSERT INTO conversations (contact_id, channel, note, created_by) VALUES (?, ?, ?, ?)`)
        .bind(contactId, data.channel, note, createdBy),
      this.db.prepare(auditSql(insertedIdText("conversations"))).bind(
        "insert",
        "conversations",
        createdBy,
        JSON.stringify({
          fields: {
            contact_id: created(contactId),
            channel: created(data.channel),
            ...(note ? { note: created(note) } : {})
          }
        })
      ),
      this.db.prepare(`SELECT seq AS id FROM sqlite_sequence WHERE name = 'conversations'`)
    ]);
    return { ok: true, id: lastId(results) };
  }

  // Replaces the communities of an organization.
  async setOrganizationCommunities(data: SetOrganizationCommunitiesInput): Promise<Result> {
    if (!data.organization_id || !Array.isArray(data.community_ids)) {
      return refuse(400, "Missing organization_id or community_ids");
    }
    const orgId = toInt(data.organization_id);
    await this.db.batch([
      this.db.prepare(`DELETE FROM organization_communities WHERE organization_id = ?`).bind(orgId),
      ...data.community_ids.map(communityId =>
        this.db
          .prepare(`INSERT INTO organization_communities (organization_id, community_id) VALUES (?, ?)`)
          .bind(orgId, toInt(communityId))
      )
    ]);
    return { ok: true };
  }
}

// The batches above end with `SELECT seq AS id FROM sqlite_sequence ...`.
function lastId(results: D1Result[]): number {
  return (results[results.length - 1].results[0] as { id: number }).id;
}
