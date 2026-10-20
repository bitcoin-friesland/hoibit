-- Baseline: the live schema of D1 `crm` as of 2026-10-21, plus its reference data.
-- Idempotent (IF NOT EXISTS / INSERT OR IGNORE), so applying it to the live
-- database only records it in d1_migrations. Never put DROP statements in a migration.
--
-- AUDIT LOGGING: every insert/update/delete writes a row to audit_log with
-- change_details as structured JSON, e.g.
--   { "fields": { "status": { "old": "btc-curious", "new": "accepts-bitcoin" } } }
-- Never log raw SQL.

CREATE TABLE IF NOT EXISTS contact_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_materials (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bitcoin_communities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  region TEXT,
  country TEXT NOT NULL,
  website TEXT,
  telegram TEXT,
  email TEXT,
  x_handle TEXT,
  nostr_npub TEXT
);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT,
  name TEXT,
  time_zone TEXT
, is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)));

CREATE TABLE IF NOT EXISTS team_member_communities (
  team_member_id INTEGER REFERENCES team_members(id),
  community_id INTEGER REFERENCES bitcoin_communities(id),
  PRIMARY KEY (team_member_id, community_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT REFERENCES contact_types(id),
  organization_id INTEGER REFERENCES organizations(id),
  nostr_npub TEXT
);

CREATE TABLE IF NOT EXISTS contact_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id),
  email TEXT
);

CREATE TABLE IF NOT EXISTS contact_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id),
  phone TEXT
);

CREATE TABLE IF NOT EXISTS contact_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id),
  note TEXT
);

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  nostr_npub TEXT,
  location_osm_id TEXT,
  status INTEGER REFERENCES organization_statuses(id),
  website TEXT,
  parent_id INTEGER REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS organization_communities (
  organization_id INTEGER REFERENCES organizations(id),
  community_id INTEGER REFERENCES bitcoin_communities(id),
  PRIMARY KEY (organization_id, community_id)
);

CREATE TABLE IF NOT EXISTS organization_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id),
  note TEXT
);

CREATE TABLE IF NOT EXISTS organization_wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id),
  wallet_type TEXT REFERENCES wallet_types(id)
);

CREATE TABLE IF NOT EXISTS organization_promos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id),
  promo_material TEXT REFERENCES promo_materials(id),
  given_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referred_type TEXT CHECK(referred_type IN ('contact', 'organization')),
  referred_id INTEGER,
  referrer_contact_id INTEGER REFERENCES contacts(id),
  referrer_org_id INTEGER REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id),
  channel TEXT REFERENCES channels(id),
  note TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,                -- e.g., 'insert', 'update', 'delete'
  table_name TEXT NOT NULL,
  record_id TEXT,
  performed_by INTEGER REFERENCES team_members(id),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  change_details JSON                  -- Structured details of the change (see the AUDIT LOGGING note at the top)
);

CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(type);

CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);

CREATE INDEX IF NOT EXISTS idx_conversations_contact_id ON conversations(contact_id);

CREATE INDEX IF NOT EXISTS idx_audit_table ON audit_log(table_name);

CREATE TRIGGER IF NOT EXISTS team_members_telegram_id_digits_insert
BEFORE INSERT ON team_members
WHEN NEW.telegram_id IS NOT NULL
  AND (CAST(NEW.telegram_id AS TEXT) = '' OR CAST(NEW.telegram_id AS TEXT) GLOB '*[^0-9]*')
BEGIN
  SELECT RAISE(ABORT, 'team_members.telegram_id must contain digits only; bind it as a string');
END;

CREATE TRIGGER IF NOT EXISTS team_members_telegram_id_digits_update
BEFORE UPDATE OF telegram_id ON team_members
WHEN NEW.telegram_id IS NOT NULL
  AND (CAST(NEW.telegram_id AS TEXT) = '' OR CAST(NEW.telegram_id AS TEXT) GLOB '*[^0-9]*')
BEGIN
  SELECT RAISE(ABORT, 'team_members.telegram_id must contain digits only; bind it as a string');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_record_id_digits_insert
BEFORE INSERT ON audit_log
WHEN NEW.record_id IS NOT NULL
  AND (CAST(NEW.record_id AS TEXT) = '' OR CAST(NEW.record_id AS TEXT) GLOB '*[^0-9]*')
BEGIN
  SELECT RAISE(ABORT, 'audit_log.record_id must contain digits only; bind it as a string');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_record_id_digits_update
BEFORE UPDATE OF record_id ON audit_log
WHEN NEW.record_id IS NOT NULL
  AND (CAST(NEW.record_id AS TEXT) = '' OR CAST(NEW.record_id AS TEXT) GLOB '*[^0-9]*')
BEGIN
  SELECT RAISE(ABORT, 'audit_log.record_id must contain digits only; bind it as a string');
END;

INSERT OR IGNORE INTO contact_types (id, label) VALUES
  ('consumer', 'Consumer'),
  ('entrepreneur', 'Entrepreneur');

INSERT OR IGNORE INTO organization_statuses (id, label) VALUES
  (1, 'Curious about Bitcoin'),
  (2, 'Accepts Bitcoin'),
  (3, 'Not Interested'),
  (4, 'Stopped Accepting Bitcoin');

INSERT OR IGNORE INTO channels (id, label) VALUES
  ('email', 'Email'),
  ('in-person', 'In Person'),
  ('phone', 'Phone'),
  ('telegram', 'Telegram'),
  ('whatsapp', 'WhatsApp');

INSERT OR IGNORE INTO promo_materials (id, label) VALUES
  ('btc-poster', 'Bitcoin Poster'),
  ('btc-sticker', 'Bitcoin Accepted Sticker'),
  ('flyer', 'Flyer with Coupons');

INSERT OR IGNORE INTO wallet_types (id, label) VALUES
  ('albyhub', 'Alby Hub'),
  ('blink', 'Blink'),
  ('coinos', 'Coinos'),
  ('muun', 'Muun'),
  ('phoenix', 'Phoenix'),
  ('wos', 'Wallet of Satoshi');

INSERT OR IGNORE INTO bitcoin_communities (id, name, region, country, website, telegram, email, x_handle, nostr_npub) VALUES
  (1, 'Hard Money Cafe', 'Amsterdam', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (2, 'Arnhem Bitcoinstad', 'Arnhem', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (3, 'Bitcoin Breda', 'Breda', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (4, 'Bitcoin Brabant', 'Brabant', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (5, 'Bitcoin Eindhoven', 'Eindhoven', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (6, 'Bitcoin Friesland', 'Friesland', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (7, 'Bitcoin Groningen', 'Groningen', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (8, 'Bitcoin Leiden', 'Leiden', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (9, 'EENENTWINTIG Limburg', 'Limburg', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (10, 'Bitcoin Twente', 'Twente', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (11, 'EENENTWINTIG Utrecht (provincie)', 'Utrecht', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (12, 'Bitcoin Zaandam', 'Zaandam', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (13, 'Zwolle Bitcoinstad', 'Zwolle', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  (14, 'Brussels Bitcoin Meetup', 'Brussels', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  (15, 'EENENTWINTIG Dilsen', 'Dilsen', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  (16, '21 Gierle', 'Gierle', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  (17, 'Le Zoute Vinght-et-un', 'le Zoute', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  (18, '21 LinkerOever', 'LinkerOever', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  (19, 'Bitcoin Turnhout', 'Turnhout', 'Belgium', NULL, NULL, NULL, NULL, NULL);
