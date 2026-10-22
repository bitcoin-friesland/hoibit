-- An invite can be for a team member who is already in the database without a Telegram account:
-- a placeholder (such as Edwin and Sjoerd-Jan in the Baserow import, who handle organizations
-- and wrote conversations before they joined) or a member whose access was removed. Opening the
-- link then gives that member access, with their history and organizations. NULL: a new member.
ALTER TABLE team_invites ADD COLUMN member_id INTEGER REFERENCES team_members(id);
