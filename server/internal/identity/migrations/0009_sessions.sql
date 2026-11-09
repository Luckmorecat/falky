CREATE TABLE sessions (
    id               TEXT NOT NULL PRIMARY KEY,
    token_hash       BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    identity_id      TEXT NOT NULL REFERENCES identities(id),
    account_id       TEXT REFERENCES accounts(identity_id),
    generation       INTEGER NOT NULL CHECK (generation > 0),
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL CHECK (expires_at > created_at),
    proof_at         INTEGER,
    proof_credential BLOB,

    CHECK (account_id IS NULL OR account_id = identity_id),
    CHECK (
        (proof_at IS NULL AND proof_credential IS NULL)
        OR
        (account_id IS NOT NULL AND proof_at IS NOT NULL
         AND proof_credential IS NOT NULL)
    )
) STRICT;

CREATE INDEX sessions_by_identity ON sessions(identity_id);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

-- Keep issuance deadlines when converting existing sessions: 90 days for
-- accounts and 400 days for guests, rather than granting a new lifetime.
INSERT INTO sessions(id,token_hash,identity_id,account_id,generation,created_at,expires_at,proof_at,proof_credential)
SELECT id,token_hash,identity_id,identity_id,generation,
       expires_at - 7776000,expires_at,
       CASE WHEN proof_at > 0 AND proof_credential IS NOT NULL THEN proof_at END,
       CASE WHEN proof_at > 0 AND proof_credential IS NOT NULL THEN proof_credential END
FROM account_sessions;

INSERT INTO sessions(id,token_hash,identity_id,generation,created_at,expires_at)
SELECT lower(hex(randomblob(32))),token_hash,identity_id,generation,
       unixepoch(created_at),unixepoch(created_at) + 34560000
FROM visitor_tokens;

DROP TABLE account_sessions;
DROP TABLE visitor_tokens;
