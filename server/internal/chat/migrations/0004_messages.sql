-- The messages of each room's chat. IDs are ULIDs assigned under the writer, so
-- they sort in commit order and serve as history cursors. author_name is the
-- author's name when posting. A request key is unique per author, which makes
-- posting again safe.
CREATE TABLE messages (
	id          TEXT NOT NULL PRIMARY KEY,
	room_id     TEXT NOT NULL REFERENCES rooms (id),
	author_id   TEXT NOT NULL,
	author_name TEXT NOT NULL,
	body        TEXT NOT NULL,
	request_key TEXT NOT NULL,
	created_at  TEXT NOT NULL,
	UNIQUE (author_id, request_key)
) STRICT;

CREATE INDEX messages_by_room ON messages (room_id, id);
