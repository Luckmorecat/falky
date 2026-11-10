-- Accounts sign in with a login and a password instead of passkeys, and the
-- server is entered with one shared access password instead of the guest
-- link. Accounts from the passkey era keep their identity and history but have
-- neither until the operator issues them a recovery code. People forgetting
-- their password recover through the operator too, so no recovery phrases.
ALTER TABLE accounts ADD COLUMN login_key TEXT;
ALTER TABLE accounts ADD COLUMN password_hash TEXT;
CREATE UNIQUE INDEX accounts_by_login ON accounts(login_key);

-- The one access password, stored as an Argon2id hash. Changing it starts the
-- next generation, which ends every pass issued under the previous one.
CREATE TABLE access_password (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT    NOT NULL,
    generation    INTEGER NOT NULL CHECK (generation > 0),
    set_at        INTEGER NOT NULL
) STRICT;

-- A browser that gave the access password may sign in or register until its
-- pass expires or the password changes. Only the token's hash is stored.
CREATE TABLE access_passes (
    token_hash BLOB    NOT NULL PRIMARY KEY CHECK (length(token_hash) = 32),
    generation INTEGER NOT NULL CHECK (generation > 0),
    expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX access_passes_by_expiry ON access_passes(expires_at);

DROP TABLE passkeys;
DROP TABLE account_ceremonies;
DROP TABLE account_invitations;
-- Only operator recovery codes remain; recovery phrases and old codes go.
DELETE FROM account_recovery_proofs;
UPDATE sessions SET proof_at = NULL, proof_credential = NULL;
