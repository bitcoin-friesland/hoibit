import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AcceptedInvite,
  AcceptInviteInput,
  AddTeamMemberInput,
  Community,
  ContactSearchRow,
  CreateInviteInput,
  DeleteTeamMemberInput,
  FirstUserInput,
  Invite,
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
  SetTelegramUsernameInput,
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
// change_details is bound, or an SQL expression around the bound JSON.
// afterChange: written only when the previous statement of the batch changed exactly one row,
// so a refused (0 rows) UPDATE or DELETE in the same batch leaves no audit entry.
const auditSql = (recordId = "?", { details = "?", afterChange = false } = {}) =>
  `INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) SELECT ?, ?, ${recordId}, ?, ${details}` +
  (afterChange ? " WHERE changes() = 1" : "");
const insertedIdText = (table: string) => `CAST(${lastIdSql(table)} AS TEXT)`;

type Change = { old: unknown; new: unknown };
const created = (value: unknown): Change => ({ old: null, new: value });

const sortedIds = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b);
const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((id, i) => id === b[i]);

// A team member may be removed (or lose admin rights) unless they are the last admin. Used in
// the WHERE of the statement itself, so two concurrent requests cannot both pass the check.
const NOT_LAST_ADMIN = `(is_admin = 0 OR (SELECT COUNT(*) FROM team_members WHERE is_admin = 1) > 1)`;

// An invite link adds one team member and expires after a week.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// "inv_" and 16 random bytes in base64url, 26 characters: unguessable, and within the 64 that
// Telegram allows in a start parameter. The prefix tells the bot the parameter is an invite.
function inviteToken() {
  const base64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return `inv_${base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

// Telegram usernames are letters, digits and underscores; collectible ones can be short.
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{1,32}$/;

/**
 * The phone number in international (E.164) form, e.g. "+31612345678", or undefined when it is
 * not one. Contact phones are stored like this, so OpenStreetMap lookups and comparisons see one
 * notation. Accepts "00" for "+", spaces, dashes, dots, slashes and brackets, and the "(0)" that
 * Dutch and Belgian numbers often carry after the country code. National numbers ("06 …") are
 * refused: the country they belong to is for telegram-crm to decide.
 */
function normalizePhone(phone: string): string | undefined {
  let number = phone
    .trim()
    .replaceAll("(0)", "")
    .replace(/[\s\-./()]/g, "");
  if (number.startsWith("00")) number = `+${number.slice(2)}`;
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : undefined;
}

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

  private async memberCommunityIds(memberId: number): Promise<number[]> {
    const { results } = await this.db
      .prepare(`SELECT community_id FROM team_member_communities WHERE team_member_id = ? ORDER BY community_id`)
      .bind(memberId)
      .all<{ community_id: number }>();
    return results.map(r => r.community_id);
  }

  async validateUser(telegramId: TelegramId): Promise<TeamMember | null> {
    return this.db
      .prepare(`SELECT * FROM team_members WHERE telegram_id = ?`)
      .bind(String(telegramId))
      .first<TeamMember>();
  }

  // Counts deactivated members too, so first-user registration never reopens.
  async countTeamMembers(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM team_members").first<{ count: number }>();
    return row?.count ?? 0;
  }

  // Active members only: a deactivated member has no telegram_id.
  async listTeamMembers(): Promise<TeamMemberSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, telegram_id, telegram_username, name, is_admin FROM team_members
         WHERE telegram_id IS NOT NULL ORDER BY name`
      )
      .all<TeamMemberSummary>();
    return results;
  }

  // First user registration: only allowed while there are no team members; the first user is admin.
  // The check is part of the INSERT, so of two simultaneous first users only one gets in.
  async firstUser(data: FirstUserInput): Promise<Result<{ id: number }>> {
    if (!data.telegram_id || !data.name) return refuse(400, "Missing telegram_id or name");
    const timeZone = data.time_zone || null;
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO team_members (telegram_id, name, time_zone, is_admin)
           SELECT ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM team_members)`
        )
        .bind(String(data.telegram_id), data.name, timeZone),
      this.db.prepare(auditSql(insertedIdText("team_members"), { afterChange: true })).bind(
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
      // Only meaningful after an insert; otherwise it holds an older id and is not used.
      this.db.prepare(`SELECT seq AS id FROM sqlite_sequence WHERE name = 'team_members'`)
    ]);
    if (results[0].meta.changes !== 1) {
      return refuse(409, "First user registration not allowed: team members already exist");
    }
    return { ok: true, id: lastId(results) };
  }

  // Adds a team member, or adds communities (and time zone) to an existing one.
  async addTeamMember(data: AddTeamMemberInput): Promise<Result<{ id: number; created?: true; existing?: true }>> {
    if (!data.telegram_id || !data.name) return refuse(400, "Missing telegram_id or name");
    if (!(await this.isAdmin(data.invited_by))) return refuse(403, "Only admins can add team members");
    const communityIds = (data.community_ids ?? []).map(toInt);
    const existing = await this.db
      .prepare(`SELECT id, time_zone FROM team_members WHERE telegram_id = ?`)
      .bind(String(data.telegram_id))
      .first<{ id: number; time_zone: string | null }>();
    if (existing) {
      // One transaction: only the real changes, and an audit entry for them.
      const oldIds = await this.memberCommunityIds(existing.id);
      const addedIds = sortedIds(communityIds).filter(id => !oldIds.includes(id));
      const changedFields: Record<string, Change> = {};
      const statements = addedIds.map(communityId =>
        this.db
          .prepare(`INSERT OR IGNORE INTO team_member_communities (team_member_id, community_id) VALUES (?, ?)`)
          .bind(existing.id, communityId)
      );
      if (addedIds.length > 0) changedFields.community_ids = { old: oldIds, new: sortedIds([...oldIds, ...addedIds]) };
      if (data.time_zone && data.time_zone !== existing.time_zone) {
        statements.push(
          this.db.prepare(`UPDATE team_members SET time_zone = ? WHERE id = ?`).bind(data.time_zone, existing.id)
        );
        changedFields.time_zone = { old: existing.time_zone, new: data.time_zone };
      }
      if (statements.length > 0) {
        statements.push(
          this.db
            .prepare(auditSql())
            .bind(
              "update",
              "team_members",
              String(existing.id),
              toIntOrNull(data.invited_by),
              JSON.stringify({ fields: changedFields })
            )
        );
        await this.db.batch(statements);
      }
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
            ...(timeZone ? { time_zone: created(timeZone) } : {}),
            ...(communityIds.length > 0 ? { community_ids: created(communityIds) } : {})
          }
        })
      ),
      this.db.prepare(`SELECT seq AS id FROM sqlite_sequence WHERE name = 'team_members'`)
    ]);
    return { ok: true, id: lastId(results), created: true };
  }

  // Creates a one-time invite link for a new team member, who will join the given communities.
  async createInvite(data: CreateInviteInput): Promise<Result<Invite>> {
    const invitedBy = data.invited_by;
    if (!invitedBy || !(await this.isAdmin(invitedBy))) return refuse(403, "Only admins can invite team members");
    const communityIds = sortedIds((data.community_ids ?? []).map(toInt));
    // Checked now: an unknown community would otherwise only fail when the new member opens the link.
    if (communityIds.length > 0) {
      const known = await this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM bitcoin_communities WHERE id IN (${communityIds.map(() => "?").join(", ")})`
        )
        .bind(...communityIds)
        .first<{ n: number }>();
      if (known?.n !== communityIds.length) return refuse(400, "Unknown community");
    }
    const token = inviteToken();
    const expiresAt = Date.now() + INVITE_TTL_MS;
    const performedBy = toInt(invitedBy);
    await this.db.batch([
      this.db
        .prepare(`INSERT INTO team_invites (token, invited_by, community_ids, expires_at) VALUES (?, ?, ?, ?)`)
        .bind(token, performedBy, JSON.stringify(communityIds), expiresAt),
      // Without the token: whoever can read the log must not be able to use the link.
      this.db.prepare(auditSql(insertedIdText("team_invites"))).bind(
        "insert",
        "team_invites",
        performedBy,
        JSON.stringify({
          fields: {
            invited_by: created(performedBy),
            community_ids: created(communityIds),
            expires_at: created(expiresAt)
          }
        })
      )
    ]);
    return { ok: true, token, expires_at: expiresAt };
  }

  /**
   * Adds the Telegram user who opened an invite link as a team member, in the invite's
   * communities; the invite is then used up. A user who already has access gets existing: true
   * and leaves the invite unused, so it can still reach the person it was meant for.
   */
  async acceptInvite(data: AcceptInviteInput): Promise<Result<AcceptedInvite>> {
    if (!data.token || !data.telegram_id || !data.name) return refuse(400, "Missing token, telegram_id or name");
    const username = data.telegram_username || null;
    if (username && !TELEGRAM_USERNAME.test(username)) return refuse(400, "Invalid telegram_username");
    const invite = await this.db
      .prepare(
        `SELECT i.id, i.invited_by, i.community_ids, i.expires_at, i.used_by,
                m.telegram_id AS inviter_telegram_id, m.name AS inviter_name
         FROM team_invites i LEFT JOIN team_members m ON m.id = i.invited_by
         WHERE i.token = ?`
      )
      .bind(data.token)
      .first<{
        id: number;
        invited_by: number;
        community_ids: string;
        expires_at: number;
        used_by: number | null;
        inviter_telegram_id: string | null;
        inviter_name: string | null;
      }>();
    if (!invite) return refuse(404, "Unknown invite");
    // A removed inviter keeps their row without telegram_id and can no longer be told.
    const invitedBy = invite.inviter_telegram_id
      ? { telegram_id: invite.inviter_telegram_id, name: invite.inviter_name }
      : null;
    const telegramId = String(data.telegram_id);
    const existing = await this.validateUser(telegramId);
    if (existing) return { ok: true, id: existing.id, existing: true, invited_by: invitedBy, communities: [] };
    const now = Date.now();
    const usedUp = refuse(409, "Invite already used or expired");
    if (invite.used_by !== null || invite.expires_at <= now) return usedUp;

    const communityIds = JSON.parse(invite.community_ids) as number[];
    const memberIdSql = lastIdSql("team_members");
    // One transaction in which every statement only changes something when the one before it
    // changed exactly one row (changes() = 1). The first, the INSERT, checks that the invite is
    // still unused and unexpired, so of two people opening the same link only one gets in.
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO team_members (telegram_id, telegram_username, name)
           SELECT ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM team_invites WHERE id = ? AND used_by IS NULL AND expires_at > ?)
             AND NOT EXISTS (SELECT 1 FROM team_members WHERE telegram_id = ?)`
        )
        .bind(telegramId, username, data.name, invite.id, now, telegramId),
      // The admin who created the invite is the one who let the member in.
      this.db.prepare(auditSql(insertedIdText("team_members"), { afterChange: true })).bind(
        "insert",
        "team_members",
        invite.invited_by,
        JSON.stringify({
          fields: {
            telegram_id: created(telegramId),
            ...(username ? { telegram_username: created(username) } : {}),
            name: created(data.name),
            ...(communityIds.length > 0 ? { community_ids: created(communityIds) } : {})
          }
        })
      ),
      this.db
        .prepare(
          `UPDATE team_invites SET used_by = ${memberIdSql}, used_at = CURRENT_TIMESTAMP WHERE id = ? AND changes() = 1`
        )
        .bind(invite.id),
      this.db
        .prepare(auditSql("?", { details: `json_set(?, '$.fields.used_by.new', ${memberIdSql})`, afterChange: true }))
        .bind(
          "update",
          "team_invites",
          String(invite.id),
          invite.invited_by,
          JSON.stringify({ fields: { used_by: { old: null, new: null } } })
        ),
      this.db
        .prepare(
          `INSERT INTO team_member_communities (team_member_id, community_id)
           SELECT ${memberIdSql}, value FROM json_each(?) WHERE changes() = 1`
        )
        .bind(invite.community_ids),
      // Only meaningful after an insert; otherwise it holds an older id and is not used.
      this.db.prepare(`SELECT seq AS id FROM sqlite_sequence WHERE name = 'team_members'`)
    ]);
    if (results[0].meta.changes !== 1) {
      // Since the checks above, someone else used the invite, or this user got access.
      const member = await this.validateUser(telegramId);
      if (member) return { ok: true, id: member.id, existing: true, invited_by: invitedBy, communities: [] };
      return usedUp;
    }
    const communities = await this.teamMemberCommunities(telegramId);
    return { ok: true, id: lastId(results), invited_by: invitedBy, communities: communities.map(c => c.name) };
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

    // One transaction with only the real changes and their audit entry; nothing when nothing changes.
    const statements: D1PreparedStatement[] = [];
    const changedFields: Record<string, Change> = {};
    const setParts: string[] = [];
    const params: string[] = [];
    if (data.name && oldMember.name !== data.name) {
      setParts.push("name = ?");
      params.push(data.name);
      changedFields.name = { old: oldMember.name, new: data.name };
    }
    if (data.time_zone && oldMember.time_zone !== data.time_zone) {
      setParts.push("time_zone = ?");
      params.push(data.time_zone);
      changedFields.time_zone = { old: oldMember.time_zone, new: data.time_zone };
    }
    if (setParts.length > 0) {
      statements.push(
        this.db.prepare(`UPDATE team_members SET ${setParts.join(", ")} WHERE id = ?`).bind(...params, memberId)
      );
    }
    if (Array.isArray(data.community_ids)) {
      const oldIds = await this.memberCommunityIds(memberId);
      const newIds = sortedIds(data.community_ids.map(toInt));
      if (!sameIds(oldIds, newIds)) {
        statements.push(
          this.db.prepare(`DELETE FROM team_member_communities WHERE team_member_id = ?`).bind(memberId),
          ...newIds.map(communityId =>
            this.db
              .prepare(`INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, ?)`)
              .bind(memberId, communityId)
          )
        );
        changedFields.community_ids = { old: oldIds, new: newIds };
      }
    }
    if (statements.length === 0) return { ok: true };
    statements.push(
      this.db
        .prepare(auditSql())
        .bind(
          "update",
          "team_members",
          String(memberId),
          toIntOrNull(data.updated_by),
          JSON.stringify({ fields: changedFields })
        )
    );
    await this.db.batch(statements);
    return { ok: true };
  }

  // Keeps a member's @username current; telegram-crm calls this when Telegram reports another one.
  async setTelegramUsername(data: SetTelegramUsernameInput): Promise<Result<{ changed: boolean }>> {
    if (!data.telegram_id) return refuse(400, "Missing telegram_id");
    const username = data.telegram_username || null;
    if (username && !TELEGRAM_USERNAME.test(username)) return refuse(400, "Invalid telegram_username");
    const member = await this.db
      .prepare(`SELECT id, telegram_username FROM team_members WHERE telegram_id = ?`)
      .bind(String(data.telegram_id))
      .first<{ id: number; telegram_username: string | null }>();
    if (!member) return refuse(404, "Team member not found");
    if (member.telegram_username === username) return { ok: true, changed: false };
    // The member changed it in Telegram themselves, so the audit entry is theirs.
    await this.db.batch([
      this.db.prepare(`UPDATE team_members SET telegram_username = ? WHERE id = ?`).bind(username, member.id),
      this.db
        .prepare(auditSql())
        .bind(
          "update",
          "team_members",
          String(member.id),
          member.id,
          JSON.stringify({ fields: { telegram_username: { old: member.telegram_username, new: username } } })
        )
    ]);
    return { ok: true, changed: true };
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
    // One transaction: the change and its audit entry. Revoking only succeeds while another
    // admin remains, checked in the same statement; the audit entry follows only a real change.
    const [update] = await this.db.batch([
      this.db
        .prepare(
          newValue === 1
            ? `UPDATE team_members SET is_admin = 1 WHERE id = ?`
            : `UPDATE team_members SET is_admin = 0 WHERE id = ? AND (SELECT COUNT(*) FROM team_members WHERE is_admin = 1) > 1`
        )
        .bind(member.id),
      this.db
        .prepare(auditSql("?", { afterChange: true }))
        .bind(
          "update",
          "team_members",
          String(member.id),
          toIntOrNull(data.updated_by),
          JSON.stringify({ fields: { is_admin: { old: member.is_admin, new: newValue } } })
        )
    ]);
    if (update.meta.changes !== 1) return refuse(409, "Cannot revoke the last admin");
    return { ok: true, id: member.id, is_admin: newValue, changed: true };
  }

  // Removes a team member's access. A member with history is deactivated, one without is deleted.
  async deleteTeamMember(data: DeleteTeamMemberInput): Promise<Result<{ deactivated: boolean }>> {
    if (!data.telegram_id) return refuse(400, "Missing telegram_id");
    if (!(await this.isAdmin(data.performed_by))) return refuse(403, "Only admins can delete team members");
    const oldMember = await this.db
      .prepare(
        `SELECT id, telegram_id, telegram_username, name, time_zone, is_admin FROM team_members WHERE telegram_id = ?`
      )
      .bind(String(data.telegram_id))
      .first<TeamMember>();
    if (!oldMember) return refuse(404, "Team member not found");
    // Like telegram_id, the username identifies the Telegram account, so it goes when access does.
    const usernameChange = oldMember.telegram_username
      ? { telegram_username: { old: oldMember.telegram_username, new: null } }
      : {};
    const memberId = oldMember.id;
    const performedBy = toIntOrNull(data.performed_by);
    const oldIds = await this.memberCommunityIds(memberId);
    const lastAdmin = refuse(409, "Cannot delete the last admin");

    // audit_log.performed_by and conversations.created_by reference team_members(id) and the
    // history is kept, so such a member cannot be deleted. Clearing telegram_id ends their
    // access (validateUser no longer finds them) while the row keeps the history readable.
    const history = await this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM audit_log WHERE performed_by = ?)
             OR EXISTS (SELECT 1 FROM conversations WHERE created_by = ?) AS found`
      )
      .bind(memberId, memberId)
      .first<{ found: 0 | 1 }>();
    if (history?.found) {
      // One transaction: deactivate unless last admin, audit only that change, then drop the
      // communities only if the member was deactivated (telegram_id now NULL).
      const [update] = await this.db.batch([
        this.db
          .prepare(
            `UPDATE team_members SET telegram_id = NULL, telegram_username = NULL, is_admin = 0
             WHERE id = ? AND ${NOT_LAST_ADMIN}`
          )
          .bind(memberId),
        this.db.prepare(auditSql("?", { afterChange: true })).bind(
          "update",
          "team_members",
          String(memberId),
          performedBy,
          JSON.stringify({
            fields: {
              telegram_id: { old: oldMember.telegram_id, new: null },
              ...usernameChange,
              ...(oldMember.is_admin === 1 ? { is_admin: { old: 1, new: 0 } } : {}),
              ...(oldIds.length > 0 ? { community_ids: { old: oldIds, new: [] } } : {})
            }
          })
        ),
        this.db
          .prepare(
            `DELETE FROM team_member_communities
             WHERE team_member_id = ? AND (SELECT telegram_id FROM team_members WHERE id = ?) IS NULL`
          )
          .bind(memberId, memberId)
      ]);
      if (update.meta.changes !== 1) return lastAdmin;
      return { ok: true, deactivated: true };
    }

    // One transaction: community links, the member and the audit entry, each only if the
    // member is not the last admin.
    const [, deletion] = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM team_member_communities
           WHERE team_member_id = ? AND EXISTS (SELECT 1 FROM team_members WHERE id = ? AND ${NOT_LAST_ADMIN})`
        )
        .bind(memberId, memberId),
      this.db.prepare(`DELETE FROM team_members WHERE id = ? AND ${NOT_LAST_ADMIN}`).bind(memberId),
      this.db.prepare(auditSql("?", { afterChange: true })).bind(
        "delete",
        "team_members",
        String(memberId),
        performedBy,
        JSON.stringify({
          fields: {
            telegram_id: { old: oldMember.telegram_id, new: null },
            ...usernameChange,
            name: { old: oldMember.name, new: null },
            time_zone: { old: oldMember.time_zone, new: null },
            is_admin: { old: oldMember.is_admin, new: null },
            ...(oldIds.length > 0 ? { community_ids: { old: oldIds, new: [] } } : {})
          }
        })
      )
    ]);
    if (deletion.meta.changes !== 1) return lastAdmin;
    return { ok: true, deactivated: false };
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

  // Organizations matching all given filters; those in community_id come first. One row per
  // organization: its community columns show community_id if it belongs to it, else its
  // community with the lowest id.
  async searchOrganizations(search: OrganizationSearch): Promise<OrganizationSearchRow[]> {
    const priority = toIntOrNull(search.community_id);
    const filters: string[] = [];
    const params: (string | number | null)[] = [priority, priority];
    if (search.domain) {
      filters.push("o.website LIKE ?");
      params.push(`%${search.domain}%`);
    }
    if (search.name) {
      filters.push("o.name LIKE ? COLLATE NOCASE");
      params.push(`%${search.name}%`);
    }
    if (search.email) {
      // An email address of one of its contacts, or a website on the address's domain.
      const domain = search.email.includes("@") ? search.email.slice(search.email.lastIndexOf("@") + 1) : "";
      const byContact = `EXISTS (SELECT 1 FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
                                 WHERE c.organization_id = o.id AND ce.email LIKE ?)`;
      if (domain) {
        filters.push(`(${byContact} OR o.website LIKE ?)`);
        params.push(`%${search.email}%`, `%${domain}%`);
      } else {
        filters.push(byContact);
        params.push(`%${search.email}%`);
      }
    }
    const query = `
      SELECT o.id, o.name, o.website, o.location_osm_id, o.status, o.nostr_npub,
             bc.id AS community_id, bc.name AS community_name, bc.region, bc.country,
             m.is_priority_community
      FROM (
        SELECT o.id,
               MAX(CASE WHEN oc.community_id = ? THEN 1 ELSE 0 END) AS is_priority_community,
               COALESCE(MAX(CASE WHEN oc.community_id = ? THEN oc.community_id END), MIN(oc.community_id))
                 AS community_id
        FROM organizations o
        LEFT JOIN organization_communities oc ON oc.organization_id = o.id
        ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
        GROUP BY o.id
      ) m
      JOIN organizations o ON o.id = m.id
      LEFT JOIN bitcoin_communities bc ON bc.id = m.community_id
      ORDER BY m.is_priority_community DESC, o.name ASC
    `;
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

  // The contacts a team member added or logged a conversation with, most recent first. Read from
  // audit_log: contacts have no created_by, and its ids put both kinds of entry in one order.
  async recentContacts(teamMemberId: RowId, limit = 5): Promise<ContactSearchRow[]> {
    const memberId = toInt(teamMemberId);
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.name, o.name AS organization_name
         FROM (
           SELECT CAST(record_id AS INTEGER) AS contact_id, id AS seen FROM audit_log
           WHERE table_name = 'contacts' AND action = 'insert' AND performed_by = ?
           UNION ALL
           SELECT conv.contact_id, a.id FROM audit_log a
           JOIN conversations conv ON conv.id = CAST(a.record_id AS INTEGER)
           WHERE a.table_name = 'conversations' AND a.action = 'insert' AND a.performed_by = ?
         ) r
         JOIN contacts c ON c.id = r.contact_id
         LEFT JOIN organizations o ON o.id = c.organization_id
         GROUP BY c.id
         ORDER BY MAX(r.seen) DESC
         LIMIT ?`
      )
      .bind(memberId, memberId, limit)
      .all<ContactSearchRow>();
    return results;
  }

  async getContact(id: RowId): Promise<ContactSearchRow | null> {
    return this.db
      .prepare(
        `SELECT contacts.id, contacts.name, organizations.name AS organization_name
         FROM contacts LEFT JOIN organizations ON contacts.organization_id = organizations.id
         WHERE contacts.id = ?`
      )
      .bind(toInt(id))
      .first<ContactSearchRow>();
  }

  // One transaction: the new organization (if given), contact, email, phone and audit entries.
  async newContact(data: NewContactInput): Promise<Result<{ id: number; organization_id: number | null }>> {
    if (!data.name || !data.type) return refuse(400, "Missing required fields: name or type");
    const newOrganization = data.new_organization;
    if (newOrganization && data.organization_id) {
      return refuse(400, "Give either organization_id or new_organization, not both");
    }
    if (newOrganization && (!newOrganization.name || !newOrganization.status)) {
      return refuse(400, "Missing required fields for new_organization: name or status");
    }
    const phone = data.phone ? normalizePhone(data.phone) : null;
    if (phone === undefined) return refuse(400, "Phone number must be international, e.g. +31612345678");
    const contactIdSql = lastIdSql("contacts");
    const createdBy = toIntOrNull(data.created_by);
    const organizationId = toIntOrNull(data.organization_id);
    const statements = newOrganization ? this.newOrgStatements(newOrganization, createdBy) : [];
    // A new organization's id is only known inside the batch: taken from sqlite_sequence.
    statements.push(
      newOrganization
        ? this.db
            .prepare(
              `INSERT INTO contacts (name, type, organization_id, nostr_npub) VALUES (?, ?, ${lastIdSql("organizations")}, ?)`
            )
            .bind(data.name, data.type, data.nostr_npub || null)
        : this.db
            .prepare(`INSERT INTO contacts (name, type, organization_id, nostr_npub) VALUES (?, ?, ?, ?)`)
            .bind(data.name, data.type, organizationId, data.nostr_npub || null)
    );
    if (data.email) {
      statements.push(
        this.db.prepare(`INSERT INTO contact_emails (contact_id, email) VALUES (${contactIdSql}, ?)`).bind(data.email)
      );
    }
    if (phone) {
      statements.push(
        this.db.prepare(`INSERT INTO contact_phones (contact_id, phone) VALUES (${contactIdSql}, ?)`).bind(phone)
      );
    }
    const details = newOrganization
      ? `json_set(?, '$.fields.organization_id.new', ${lastIdSql("organizations")})`
      : "?";
    statements.push(
      this.db.prepare(auditSql(insertedIdText("contacts"), { details })).bind(
        "insert",
        "contacts",
        createdBy,
        JSON.stringify({
          fields: {
            name: created(data.name),
            type: created(data.type),
            organization_id: created(organizationId),
            ...(data.nostr_npub ? { nostr_npub: created(data.nostr_npub) } : {}),
            ...(data.email ? { email: created(data.email) } : {}),
            ...(phone ? { phone: created(phone) } : {})
          }
        })
      ),
      this.db.prepare(`SELECT id, organization_id FROM contacts WHERE id = ${contactIdSql}`)
    );
    const contact = lastRow<{ id: number; organization_id: number | null }>(await this.db.batch(statements));
    return { ok: true, id: contact.id, organization_id: contact.organization_id };
  }

  // One transaction: organization, its communities and the audit entry.
  async newOrg(data: NewOrgInput): Promise<Result<{ id: number }>> {
    if (!data.name || !data.status) return refuse(400, "Missing required fields: name or status");
    const results = await this.db.batch([
      ...this.newOrgStatements(data, toIntOrNull(data.created_by)),
      this.db.prepare(`SELECT seq AS id FROM sqlite_sequence WHERE name = 'organizations'`)
    ]);
    return { ok: true, id: lastId(results) };
  }

  // Inserts an organization, its communities and its audit entry, for use in a batch; later
  // statements of the batch get the new id as lastIdSql("organizations"). name and status are
  // checked by the caller.
  private newOrgStatements(data: Omit<NewOrgInput, "created_by">, createdBy: number | null): D1PreparedStatement[] {
    const orgIdSql = lastIdSql("organizations");
    const status = toInt(data.status);
    const osmId = data.location_osm_id ? String(data.location_osm_id) : null;
    const communityIds = (data.community_ids ?? []).map(toInt);
    return [
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
        createdBy,
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
      )
    ];
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
}

// The first row of the batch's last statement.
function lastRow<T>(results: D1Result[]): T {
  return results[results.length - 1].results[0] as T;
}

// The batches above end with `SELECT seq AS id FROM sqlite_sequence ...`.
function lastId(results: D1Result[]): number {
  return lastRow<{ id: number }>(results).id;
}
