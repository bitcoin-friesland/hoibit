-- AUDIT LOGGING ARCHITECTURE (IMPORTANT)
-- 
-- All data mutations (insert, update, delete) across all tables are tracked in the audit_log table.
-- The audit_log includes a change_details JSON column that records, for each mutation:
--   - The fields that were changed
--   - Their old values
--   - Their new values
-- This enables a complete, structured, and queryable audit trail for all changes in the system.
-- When writing code, always log relevant field-level changes in audit_log.change_details as a JSON object.
-- Example for a status change:
--   { "field": "status", "old": "btc-curious", "new": "accepts-bitcoin" }
-- Example for multiple fields:
--   { "fields": { "status": { "old": "btc-curious", "new": "accepts-bitcoin" }, "name": { "old": "Old Name", "new": "New Name" } } }
-- Never log raw SQL queries; always use structured JSON for change_details.
-- This approach ensures robust, future-proof auditing and simplifies reconstructing the full change history for any record.

-- DROP tables in correct order
DROP TABLE IF EXISTS organization_wallets;
DROP TABLE IF EXISTS organization_promos;
DROP TABLE IF EXISTS organizations;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS contact_emails;
DROP TABLE IF EXISTS contact_phones;
DROP TABLE IF EXISTS contact_notes;
DROP TABLE IF EXISTS organization_notes;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS referrals;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS bitcoin_communities;
DROP TABLE IF EXISTS organization_statuses;
DROP TABLE IF EXISTS channels;
DROP TABLE IF EXISTS promo_materials;
DROP TABLE IF EXISTS wallet_types;
DROP TABLE IF EXISTS contact_types;

-- contact types
CREATE TABLE contact_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT INTO contact_types (id, label) VALUES
  ('consumer', 'Consumer'),
  ('entrepreneur', 'Entrepreneur');

-- organization_statuses
CREATE TABLE organization_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL
);

INSERT INTO organization_statuses (id, label) VALUES
  (1, 'Curious about Bitcoin'),
  (2, 'Accepts Bitcoin'),
  (3, 'Not Interested'),
  (4, 'Stopped Accepting Bitcoin');

-- channels
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT INTO channels (id, label) VALUES
  ('in-person', 'In Person'),
  ('email', 'Email'),
  ('whatsapp', 'WhatsApp'),
  ('phone', 'Phone'),
  ('telegram', 'Telegram');

-- promo materials
CREATE TABLE promo_materials (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT INTO promo_materials (id, label) VALUES
  ('btc-sticker', 'Bitcoin Accepted Sticker'),
  ('btc-poster', 'Bitcoin Poster'),
  ('flyer', 'Flyer with Coupons');

-- wallet types
CREATE TABLE wallet_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT INTO wallet_types (id, label) VALUES
  ('wos', 'Wallet of Satoshi'),
  ('coinos', 'Coinos'),
  ('blink', 'Blink'),
  ('albyhub', 'Alby Hub'),
  ('muun', 'Muun'),
  ('phoenix', 'Phoenix');

-- communities
CREATE TABLE bitcoin_communities (
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

INSERT INTO bitcoin_communities (name, region, country, website, telegram, email, x_handle, nostr_npub) VALUES
  ('Hard Money Cafe', 'Amsterdam', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Arnhem Bitcoinstad', 'Arnhem', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Bitcoin Breda', 'Breda', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Bitcoin Brabant', 'Brabant', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Bitcoin Eindhoven', 'Eindhoven', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Bitcoin Friesland', 'Friesland', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Bitcoin Groningen', 'Groningen', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Bitcoin Leiden', 'Leiden', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('EENENTWINTIG Limburg', 'Limburg', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Bitcoin Twente', 'Twente', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('EENENTWINTIG Utrecht (provincie)', 'Utrecht', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Bitcoin Zaandam', 'Zaandam', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Zwolle Bitcoinstad', 'Zwolle', 'Netherlands', NULL, NULL, NULL, NULL, NULL),
  ('Brussels Bitcoin Meetup', 'Brussels', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  ('EENENTWINTIG Dilsen', 'Dilsen', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  ('21 Gierle', 'Gierle', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  ('Le Zoute Vinght-et-un', 'le Zoute', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  ('21 LinkerOever', 'LinkerOever', 'Belgium', NULL, NULL, NULL, NULL, NULL),
  ('Bitcoin Turnhout', 'Turnhout', 'Belgium', NULL, NULL, NULL, NULL, NULL);

-- team members
CREATE TABLE team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT,
  name TEXT,
  time_zone TEXT
);

-- team member communities (many-to-many)
CREATE TABLE team_member_communities (
  team_member_id INTEGER REFERENCES team_members(id),
  community_id INTEGER REFERENCES bitcoin_communities(id),
  PRIMARY KEY (team_member_id, community_id)
);

-- contacts
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT REFERENCES contact_types(id),
  organization_id INTEGER REFERENCES organizations(id),
  nostr_npub TEXT
);

CREATE TABLE contact_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id),
  email TEXT
);

CREATE TABLE contact_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id),
  phone TEXT
);

CREATE TABLE contact_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id),
  note TEXT
);

-- organizations
CREATE TABLE organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  nostr_npub TEXT,
  location_osm_id TEXT,
  status INTEGER REFERENCES organization_statuses(id),
  website TEXT,
  parent_id INTEGER REFERENCES organizations(id)
);

-- organization communities (many-to-many)
CREATE TABLE organization_communities (
  organization_id INTEGER REFERENCES organizations(id),
  community_id INTEGER REFERENCES bitcoin_communities(id),
  PRIMARY KEY (organization_id, community_id)
);

CREATE TABLE organization_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id),
  note TEXT
);

CREATE TABLE organization_wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id),
  wallet_type TEXT REFERENCES wallet_types(id)
);

CREATE TABLE organization_promos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id),
  promo_material TEXT REFERENCES promo_materials(id),
  given_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- referrals
CREATE TABLE referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referred_type TEXT CHECK(referred_type IN ('contact', 'organization')),
  referred_id INTEGER,
  referrer_contact_id INTEGER REFERENCES contacts(id),
  referrer_org_id INTEGER REFERENCES organizations(id)
);

-- conversations
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id),
  channel TEXT REFERENCES channels(id),
  note TEXT
);

-- audit trail
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,                -- e.g., 'insert', 'update', 'delete'
  table_name TEXT NOT NULL,
  record_id TEXT,
  performed_by INTEGER REFERENCES team_members(id),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  change_details JSON                  -- Structured details of the change (see architecture comment above)
);

-- indexes
CREATE INDEX idx_contacts_type ON contacts(type);
CREATE INDEX idx_organizations_status ON organizations(status);
CREATE INDEX idx_conversations_contact_id ON conversations(contact_id);
CREATE INDEX idx_audit_table ON audit_log(table_name);
