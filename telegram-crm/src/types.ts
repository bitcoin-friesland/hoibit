import type { Community } from "../../crm-api/src/types";
import type { CommunityPicker } from "./helpers/community";

export type { Community };

export type ChatId = number | string;

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendOptions {
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  parse_mode?: "HTML";
}

export type SendMessage = (env: Env, chatId: ChatId, text: string, options?: SendOptions) => Promise<void>;

export type PickedCommunity = Pick<Community, "id" | "name"> & { region: string | null };

// A Telegram user id; in a private chat it equals the chat id.
export type UserId = number | string;

/**
 * State of the flow one user has in progress in one chat. Kept in the chat's
 * Durable Object (ChatSession) under that user's id, so in a group every member
 * has their own flow. Each flow uses its own subset of the optional fields.
 */
export interface Session {
  mode?: "contact" | "org" | "conversation" | "first_user" | "teammember";
  step?: string;
  // Telegram user id of the user running the flow
  telegram_id?: string;
  // team_members.id of the user running the flow
  created_by?: number | null;
  // Data of the button just pressed; processUpdate clears it for text updates.
  last_callback_data?: string | null;
  // message_id of the last message with buttons sent in this flow; only its buttons count.
  keyboard_message_id?: number;

  // contact flow
  name?: string;
  email?: string | null;
  phone?: string | null;
  nostr_npub?: string | null;
  type?: "consumer" | "entrepreneur";
  pending_org?: string;
  org_choices?: Record<string, string>;
  organization?: string;
  organization_status?: string;
  organization_website?: string | null;
  organization_nostr_npub?: string | null;
  org_picker?: CommunityPicker;
  organization_communities?: PickedCommunity[];
  osm_options?: string[];

  // first user flow
  time_zone?: string;

  // conversation flow
  contact_choices?: Record<string, string>;
  contact_id?: number;
  contact_label?: string;
  channel_choices?: Record<string, string>;
  channel?: string;

  // team member flow
  invite_id?: string;
  invite_name?: string;
  invite_timezone?: string;
  invite_picker?: CommunityPicker;
  invite_communities?: PickedCommunity[];
  admin_action?: "grant" | "revoke";
  // team_members.id -> label (name, or Telegram ID when the member has no name)
  admin_candidates?: Record<string, string | null>;
  // edit or remove an existing team member
  member_action?: "edit" | "remove";
  member_choices?: Record<string, { telegram_id: string; label: string }>;
  member_id?: string;
  member_telegram_id?: string;
  member_label?: string;
  edit_picker?: CommunityPicker;
}

/**
 * A flow step handler, called by processUpdate for the user whose session it is.
 * - text is undefined when the update is a button press; the pressed button is then
 *   in session.last_callback_data. For text, last_callback_data is always null.
 * - Only buttons of the last message sent with a reply_markup reach the flow; older
 *   or double-tapped buttons are answered "no longer active" before the flow runs.
 *   A message without buttons (e.g. an error) leaves the earlier buttons valid.
 * - Commands (/cancel, /help, unknown /words) never reach a flow as text.
 * - persistSession stores the session; removeSession ends the flow.
 */
export type FlowHandler = (
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  text: string | undefined,
  session: Session,
  persistSession?: () => Promise<void>,
  removeSession?: () => Promise<void>
) => Promise<void>;

// The parts of a Telegram Update this bot reads.
export interface TelegramUpdate {
  // Unique per bot; Telegram sends the same id again when it redelivers an update.
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id: number; type: string };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    // The message the pressed button belongs to.
    message: { message_id?: number; chat: { id: number } };
  };
}

// What the webhook answers Telegram for one update.
export interface UpdateResult {
  status: number;
  body: string;
}

/**
 * State of one chat, kept in the chat's Durable Object: per user the session of
 * the flow in progress, whether the "not authorized" message was sent recently
 * (per chat), and the ids of recently handled updates.
 */
export interface SessionStore {
  getSession(userId: UserId): Session | undefined;
  putSession(userId: UserId, session: Session): void;
  deleteSession(userId: UserId): void;
  wasUnauthorizedNotified(): boolean;
  markUnauthorizedNotified(): void;
  // Records updateId; false when it was already recorded (a redelivery).
  markUpdateSeen(updateId: number): boolean;
}
