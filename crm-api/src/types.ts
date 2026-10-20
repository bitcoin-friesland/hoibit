// Shapes exchanged with callers of the CrmApi RPC entrypoint (telegram-crm).

// Methods that can be refused for an expected reason (validation, permission, conflict)
// return a Result; the HTTP status says which kind of refusal it is.
// Unexpected failures, such as a D1 error, are thrown.
export type Refusal = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type Result<T extends object = object> = ({ ok: true } & T) | Refusal;

// Telegram user ids are TEXT in D1; team member and other row ids are INTEGER.
export type TelegramId = string | number;
export type RowId = string | number;

export interface TeamMember {
  id: number;
  telegram_id: string;
  name: string | null;
  time_zone: string | null;
  is_admin: 0 | 1;
}

export type TeamMemberSummary = Pick<TeamMember, "id" | "telegram_id" | "name" | "is_admin">;

export interface Community {
  id: number;
  name: string;
  country: string;
  region: string | null;
}

export interface Lookup {
  id: string;
  label: string;
}

export interface OrganizationSearchRow {
  id: number;
  name: string;
  website: string | null;
  location_osm_id: string | null;
  status: number | null;
  nostr_npub: string | null;
  community_id: number | null;
  community_name: string | null;
  region: string | null;
  country: string | null;
  is_priority_community: 0 | 1;
}

export interface ContactSearchRow {
  id: number;
  name: string;
  organization_name: string | null;
}

export interface FirstUserInput {
  telegram_id: TelegramId;
  name: string;
  time_zone?: string | null;
}

export interface AddTeamMemberInput extends FirstUserInput {
  community_ids?: RowId[];
  invited_by: RowId | null;
}

export interface UpdateTeamMemberInput {
  team_member_id: RowId;
  name?: string | null;
  time_zone?: string | null;
  community_ids?: RowId[];
  updated_by: RowId | null;
}

export interface SetAdminInput {
  team_member_id: RowId;
  is_admin: boolean;
  updated_by: RowId | null;
}

export interface DeleteTeamMemberInput {
  telegram_id: TelegramId;
  performed_by: RowId | null;
}

export interface NewContactInput {
  name: string;
  type: string;
  organization_id?: RowId | null;
  email?: string | null;
  phone?: string | null;
  nostr_npub?: string | null;
  created_by?: RowId | null;
}

export interface NewOrgInput {
  name: string;
  status: RowId;
  location_osm_id?: string | number | null;
  website?: string | null;
  nostr_npub?: string | null;
  community_ids?: RowId[];
  created_by?: RowId | null;
}

export interface LogConversationInput {
  contact_id: RowId;
  channel: string;
  note?: string | null;
  created_by?: RowId | null;
}

export interface OrganizationSearch {
  name?: string | null;
  domain?: string | null;
  email?: string | null;
  community_id?: RowId | null;
}

export interface SetOrganizationCommunitiesInput {
  organization_id: RowId;
  community_ids: RowId[];
}
