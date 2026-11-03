-- Visitors, and the tokens their cookies hold. A token is stored only as its
-- SHA-256 hash, with the link generation it was issued under; it gives access
-- only while that generation is the current one.
CREATE TABLE visitors (
	id         TEXT NOT NULL PRIMARY KEY,
	name       TEXT NOT NULL,
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE visitor_tokens (
	token_hash BLOB    NOT NULL PRIMARY KEY,
	visitor_id TEXT    NOT NULL REFERENCES visitors (id),
	generation INTEGER NOT NULL CHECK (generation >= 1),
	created_at TEXT    NOT NULL
) STRICT;

CREATE INDEX visitor_tokens_by_visitor ON visitor_tokens (visitor_id);
