CREATE TABLE accounts (
    visitor_id TEXT PRIMARY KEY REFERENCES visitors(id),
    name_key TEXT NOT NULL UNIQUE,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE account_sessions (
    id TEXT PRIMARY KEY,
    token_hash BLOB NOT NULL UNIQUE,
    visitor_id TEXT NOT NULL REFERENCES accounts(visitor_id),
    generation INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    proof_at INTEGER NOT NULL DEFAULT 0,
    proof_credential BLOB
) STRICT;
CREATE INDEX account_sessions_by_account ON account_sessions(visitor_id);

CREATE TABLE passkeys (
    credential_id BLOB PRIMARY KEY,
    visitor_id TEXT NOT NULL REFERENCES accounts(visitor_id),
    label TEXT NOT NULL,
    credential TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX passkeys_by_account ON passkeys(visitor_id);

CREATE TABLE account_invitations (
    id TEXT PRIMARY KEY,
    token_hash BLOB NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER,
    revoked_at INTEGER
) STRICT;

CREATE TABLE account_recovery_proofs (
    token_hash BLOB PRIMARY KEY,
    visitor_id TEXT NOT NULL REFERENCES accounts(visitor_id),
    kind TEXT NOT NULL CHECK(kind IN ('code','operator')),
    generation INTEGER NOT NULL,
    expires_at INTEGER
) STRICT;
CREATE INDEX account_recovery_by_account ON account_recovery_proofs(visitor_id);

CREATE TABLE account_ceremonies (
    id TEXT PRIMARY KEY,
    context_hash BLOB NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('register','authenticate','reauthenticate','add','recover')),
    visitor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    proof_hash BLOB,
    session_data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX account_ceremonies_by_account ON account_ceremonies(visitor_id);
