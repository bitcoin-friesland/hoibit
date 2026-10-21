-- /logconversation records which team member logged the conversation, like the
-- audit entry does. The live table had no rows when this was added, so existing
-- rows keep NULL; SQLite only allows ADD COLUMN with a REFERENCES clause when the
-- default is NULL.
ALTER TABLE conversations ADD COLUMN created_by INTEGER REFERENCES team_members(id);
