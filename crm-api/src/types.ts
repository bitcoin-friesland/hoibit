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
  // The member's @username without "@", as Telegram last reported it; null without one.
  telegram_username: string | null;
  name: string | null;
  time_zone: string | null;
  is_admin: 0 | 1;
}

export type TeamMemberSummary = Pick<TeamMember, "id" | "telegram_id" | "telegram_username" | "name" | "is_admin">;

// A team member who handles an organization (organization_team_members).
export type Handler = Pick<TeamMember, "id" | "telegram_id" | "name">;

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

export interface CreateInviteInput {
  // The communities the new member joins.
  community_ids?: RowId[];
  // A team member without access (see inactiveTeamMembers) whom the link gives access; leave it
  // out for a new member.
  member_id?: RowId | null;
  invited_by: RowId | null;
}

export interface Invite {
  // The start parameter of the invite link: t.me/<bot>?start=<token>
  token: string;
  // Unix time in milliseconds
  expires_at: number;
}

// The Telegram user who opened an invite link, as Telegram describes them.
export interface AcceptInviteInput {
  token: string;
  telegram_id: TelegramId;
  name: string;
  telegram_username?: string | null;
}

export interface AcceptedInvite {
  // team_members.id of the new member, or of the member who already had access.
  id: number;
  // The member's name on the team: for an invite for an existing member, the name they had.
  name: string | null;
  // The Telegram user already was a team member; the invite stays unused.
  existing?: true;
  // Who created the invite, to tell them the member joined; null when they have no access anymore.
  invited_by: Pick<TeamMember, "telegram_id" | "name"> | null;
  // Names of the communities the new member joined.
  communities: string[];
}

export interface SetTelegramUsernameInput {
  telegram_id: TelegramId;
  telegram_username: string | null;
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

// A member with audit history is deactivated (telegram_id and admin rights cleared, communities
// removed; the row stays for the history), one without is deleted. Both lose access to the bot.
export interface DeleteTeamMemberInput {
  telegram_id: TelegramId;
  performed_by: RowId | null;
}

export interface NewContactInput {
  name: string;
  type: string;
  // An existing organization. Leave it out when new_organization is given.
  organization_id?: RowId | null;
  // Creates this organization (with its communities and audit entry) in the same transaction
  // as the contact, which then belongs to it; nothing is stored if any part fails.
  // name and status are required; created_by of the contact is also used for the organization.
  new_organization?: Omit<NewOrgInput, "created_by"> | null;
  email?: string | null;
  // International, e.g. "+31 6 1234 5678" or "0031612345678"; stored as "+31612345678" (E.164).
  // Anything else, such as a national number, is refused.
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
  // Street and number with the place, e.g. "Kleinzand 1, Sneek".
  address?: string | null;
  // The kind of business, e.g. "Restaurant - Lunch".
  category?: string | null;
  // The business's own number, international as for newContact.
  phone?: string | null;
  email?: string | null;
  // The day it should next be contacted, "YYYY-MM-DD".
  follow_up_on?: string | null;
  community_ids?: RowId[];
  // The team members who handle it.
  team_member_ids?: RowId[];
  created_by?: RowId | null;
}

// A conversation is with a contact or with an organization itself; give one of the two.
export interface LogConversationInput {
  contact_id?: RowId | null;
  organization_id?: RowId | null;
  channel: string;
  note?: string | null;
  // The day it took place, "YYYY-MM-DD" in the team member's time zone; not in the future.
  happened_on?: string | null;
  created_by?: RowId | null;
}

// For updateContact and updateOrg: a field that is left out stays as it is; null or "" removes
// an optional detail. The name cannot be removed.
export interface UpdateContactInput {
  contact_id: RowId;
  name?: string;
  // Replaces the contact's first email address (or adds one); null removes it.
  email?: string | null;
  // Replaces the contact's first phone number (or adds one); null removes it. International,
  // as for newContact.
  phone?: string | null;
  nostr_npub?: string | null;
  // A contact_types id; it cannot be removed.
  type?: string;
  // The organization the contact belongs to; null unlinks the contact from its organization.
  organization_id?: RowId | null;
  updated_by?: RowId | null;
}

export interface UpdateOrgInput {
  organization_id: RowId;
  name?: string;
  // An organization_statuses id; it cannot be removed.
  status?: RowId;
  website?: string | null;
  nostr_npub?: string | null;
  // The place on OpenStreetMap, e.g. "node/123"; null removes it.
  location_osm_id?: string | null;
  address?: string | null;
  category?: string | null;
  // International, as for newContact; null removes it.
  phone?: string | null;
  email?: string | null;
  // "YYYY-MM-DD", also a day to come; null removes it.
  follow_up_on?: string | null;
  // Replaces the organization's communities; [] removes them all.
  community_ids?: RowId[];
  // Replaces the team members who handle it; [] removes them all.
  team_member_ids?: RowId[];
  updated_by?: RowId | null;
}

export interface ConversationSummary {
  id: number;
  // Both null for a conversation with the organization itself.
  contact_id: number | null;
  contact_name: string | null;
  // The channel's label, e.g. "In Person".
  channel: string;
  note: string | null;
  // The day it took place, "YYYY-MM-DD"; null for conversations logged before this was asked.
  happened_on: string | null;
  // When it was logged, "YYYY-MM-DD HH:MM:SS" in UTC; null when that is not known.
  logged_at: string | null;
  // The name of the team member who logged it; null when that is not known.
  logged_by: string | null;
}

export interface ContactDetails {
  id: number;
  name: string;
  type: string | null;
  type_label: string | null;
  organization_id: number | null;
  organization_name: string | null;
  nostr_npub: string | null;
  // In the order they were added; updateContact changes the first.
  emails: string[];
  phones: string[];
  // The most recent first.
  conversations: ConversationSummary[];
}

export interface OrganizationDetails {
  id: number;
  name: string;
  status: number | null;
  status_label: string | null;
  website: string | null;
  nostr_npub: string | null;
  location_osm_id: string | null;
  address: string | null;
  category: string | null;
  phone: string | null;
  email: string | null;
  follow_up_on: string | null;
  communities: string[];
  // By name.
  handled_by: Handler[];
  // In the order they were added.
  notes: string[];
  contacts: { id: number; name: string }[];
  // With the organization itself or any of its contacts, the most recent first.
  conversations: ConversationSummary[];
}

// An organization whose follow-up day has come or is near (followUps).
export interface FollowUp {
  id: number;
  name: string;
  follow_up_on: string;
  status_label: string | null;
  // By name; empty when nobody handles it.
  handled_by: Handler[];
}

export interface FollowUpSearch {
  // Up to and including this day, "YYYY-MM-DD".
  until: string;
  // Only the organizations this team member handles, and those nobody with access handles.
  team_member_id?: RowId | null;
}

export interface OrganizationSearch {
  name?: string | null;
  domain?: string | null;
  email?: string | null;
  community_id?: RowId | null;
}
