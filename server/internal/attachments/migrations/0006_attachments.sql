CREATE TABLE attachments (
 id TEXT NOT NULL PRIMARY KEY,
 owner_id TEXT NOT NULL,
 room_id TEXT NOT NULL REFERENCES rooms (id),
 filename TEXT NOT NULL,
 content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
 size INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
 inline INTEGER NOT NULL DEFAULT 0,
 width INTEGER NOT NULL DEFAULT 0,
 height INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK (state IN ('incoming','ready','posted','expired','cancelled')),
 expires_at INTEGER NOT NULL DEFAULT 0,
 allocation TEXT NOT NULL CHECK (allocation IN ('staging','posted','none')),
 reserved INTEGER NOT NULL CHECK (reserved >= 0),
 cleanup INTEGER NOT NULL DEFAULT 0,
 message_id TEXT REFERENCES messages (id),
 position INTEGER,
 UNIQUE(message_id,position)
) STRICT;
CREATE INDEX attachments_by_owner ON attachments(owner_id,state);
CREATE INDEX attachments_by_expiry ON attachments(state,expires_at);
CREATE INDEX attachments_by_publication ON attachments(message_id,position) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_by_cleanup ON attachments(cleanup,allocation);
