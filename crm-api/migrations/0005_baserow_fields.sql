-- What the team kept per business in Baserow, so it can move into this database and the bot.
-- Only additions: existing rows keep NULL and older code keeps working.

-- address: street and number with the place, as people read it ("Kleinzand 1, Sneek");
-- location_osm_id stays the place on OpenStreetMap.
-- category: the kind of business in the team's words ("Restaurant - Lunch").
-- phone and email: the business's own number and address (info@...), for a business without a
-- contact person or details that are no person's. phone is E.164, like contact_phones.
-- follow_up_on: the day ("YYYY-MM-DD") the business should next be contacted.
ALTER TABLE organizations ADD COLUMN address TEXT;
ALTER TABLE organizations ADD COLUMN category TEXT;
ALTER TABLE organizations ADD COLUMN phone TEXT;
ALTER TABLE organizations ADD COLUMN email TEXT;
ALTER TABLE organizations ADD COLUMN follow_up_on TEXT;

-- The team members who handle an organization: they follow it up when follow_up_on comes.
CREATE TABLE IF NOT EXISTS organization_team_members (
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  team_member_id INTEGER NOT NULL REFERENCES team_members(id),
  PRIMARY KEY (organization_id, team_member_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_team_members_member ON organization_team_members(team_member_id);

-- A conversation is with a contact (contact_id) or with the organization itself
-- (organization_id, contact_id NULL), e.g. with staff whose name nobody noted.
ALTER TABLE conversations ADD COLUMN organization_id INTEGER REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS idx_conversations_organization_id ON conversations(organization_id);

-- The stages the team uses besides the first four, in Baserow "1ste keer te bezoeken",
-- "Personeel > eigenaar", "Twijfelt" and "Op lange termijn interesse".
INSERT OR IGNORE INTO organization_statuses (id, label) VALUES
  (5, 'To visit'),
  (6, 'Talked to staff, not owner'),
  (7, 'Hesitant'),
  (8, 'Interested later');
