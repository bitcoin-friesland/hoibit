-- /logconversation asks on which day the conversation took place, so "spoke to her
-- yesterday" can be logged today. A calendar day ("YYYY-MM-DD") in the team member's
-- time zone, not a moment. Existing rows keep NULL; the bot then shows the day the
-- conversation was logged (the audit entry's timestamp).
ALTER TABLE conversations ADD COLUMN happened_on TEXT;
