-- The one access link: its secret, stored as is so the operator can print the
-- link again, and the generation that visitor access is bound to.
CREATE TABLE access (
	id          INTEGER PRIMARY KEY CHECK (id = 1),
	link_secret TEXT    NOT NULL,
	generation  INTEGER NOT NULL CHECK (generation >= 1),
	rotated_at  TEXT    NOT NULL
) STRICT;
