-- A message may answer an earlier one in its room, be edited by its author,
-- or be deleted by them: deleted_at is set and body cleared, while the row
-- stays because IDs are history cursors and replies point at it.
ALTER TABLE messages ADD COLUMN reply_to TEXT REFERENCES messages (id);
ALTER TABLE messages ADD COLUMN edited_at TEXT;
ALTER TABLE messages ADD COLUMN deleted_at TEXT;

-- One row per message, identity and reaction from the fixed list; pressing
-- the same reaction again removes the row.
CREATE TABLE message_reactions (
	message_id TEXT NOT NULL REFERENCES messages (id),
	visitor_id TEXT NOT NULL,
	reaction   TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (message_id, visitor_id, reaction)
) STRICT;
