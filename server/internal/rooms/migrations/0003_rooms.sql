-- The rooms visitors talk in. Names are unique as written; the rooms module
-- also refuses names that differ only in case or surrounding white space.
CREATE TABLE rooms (
	id         TEXT NOT NULL PRIMARY KEY,
	name       TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
) STRICT;
