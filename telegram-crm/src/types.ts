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

/**
 * Per-chat state of the flow in progress, stored as JSON in KV (SESSIONS).
 * Each flow uses its own subset of the optional fields.
 */
export interface Session {
  mode?: "contact" | "org" | "conversation" | "first_user" | "teammember";
  step?: string;
  telegram_id?: string;
  // team_members.id of the user running the flow
  created_by?: number | null;
  last_callback_data?: string | null;

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
  contact_name?: string;
  note?: string;

  // team member flow
  invite_id?: string;
  invite_name?: string;
  invite_timezone?: string;
  invite_picker?: CommunityPicker;
  invite_communities?: PickedCommunity[];
  admin_action?: "grant" | "revoke";
  admin_candidates?: Record<string, string | null>;
}

/**
 * A flow step handler. text is undefined when the update is a button press;
 * the pressed button is then in session.last_callback_data.
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
  message?: {
    chat?: { id: number; type: string };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message: { chat: { id: number } };
  };
}

// What the webhook answers Telegram for one update.
export interface UpdateResult {
  status: number;
  body: string;
}

/**
 * State of one chat: the session of the flow in progress, and whether the
 * "not authorized" message was sent recently. Kept in the chat's Durable Object.
 */
export interface SessionStore {
  getSession(): Session | undefined;
  putSession(session: Session): void;
  deleteSession(): void;
  wasUnauthorizedNotified(): boolean;
  markUnauthorizedNotified(): void;
}
