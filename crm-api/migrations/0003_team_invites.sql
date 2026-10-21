-- New team members join through a one-time invite link (telegram-crm /invite): an admin
-- creates a token, the new member opens t.me/<bot>?start=<token> and is added with the
-- Telegram user id Telegram sends along, so nobody has to type an id.
--
-- team_members.telegram_username is the member's @username as Telegram last reported it.
-- The bot shows it next to the name and keeps it current; NULL when the member has none.
ALTER TABLE team_members ADD COLUMN telegram_username TEXT;

-- id, not token, identifies an invite in audit_log: record_id must contain digits only, and
-- the token is a secret that stays out of the log.
CREATE TABLE IF NOT EXISTS team_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  invited_by INTEGER NOT NULL REFERENCES team_members(id),
  -- JSON array of the bitcoin_communities ids the new member joins
  community_ids TEXT NOT NULL DEFAULT '[]',
  -- Unix time in milliseconds
  expires_at INTEGER NOT NULL,
  used_by INTEGER REFERENCES team_members(id),
  used_at TIMESTAMP
);
