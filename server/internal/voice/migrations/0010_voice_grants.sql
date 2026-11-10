-- Cleanup must survive deletion of the browser session and identity.
CREATE TABLE voice_grants (
    transport TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    session_kind TEXT NOT NULL CHECK (session_kind IN ('guest', 'account')),
    generation INTEGER NOT NULL,
    room_id TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE UNIQUE INDEX voice_grants_active_identity ON voice_grants(identity_id) WHERE revoked = 0;
