CREATE TABLE sessions_new (
    id TEXT NOT NULL PRIMARY KEY,
    token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    identity_id TEXT NOT NULL REFERENCES identities(id),
    account_id TEXT REFERENCES accounts(identity_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    CHECK (account_id IS NULL OR account_id = identity_id)
) STRICT;

-- A guest cannot sign back in to its existing identity; retain its exact access.
INSERT INTO sessions_new SELECT id,token_hash,identity_id,account_id,generation,created_at,expires_at
FROM sessions WHERE account_id IS NULL;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_by_identity ON sessions(identity_id);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

CREATE TABLE account_signin_links (
    id TEXT NOT NULL PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES accounts(identity_id),
    issuer_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    token_hash BLOB UNIQUE CHECK (token_hash IS NULL OR length(token_hash) = 32),
    state TEXT NOT NULL CHECK (state IN ('open','approved','consumed','revoked')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    failed_code_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_code_attempts BETWEEN 0 AND 5),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 300),
    consumed_at INTEGER,
    revoked_at INTEGER,
    last_notified_at INTEGER,
    CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
    CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at AND consumed_at < expires_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    CHECK (last_notified_at IS NULL OR last_notified_at >= created_at AND last_notified_at < expires_at)
) STRICT;
CREATE INDEX account_signin_links_by_issuer ON account_signin_links(issuer_session_id,state);
CREATE INDEX account_signin_links_by_expiry ON account_signin_links(expires_at);

CREATE TABLE account_signin_requests (
    id TEXT NOT NULL PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('link','qr')),
    state TEXT NOT NULL CHECK (state IN ('pending','approved','consumed','denied','cancelled')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    browser_token_hash BLOB CHECK (browser_token_hash IS NULL OR length(browser_token_hash) = 32),
    link_id TEXT REFERENCES account_signin_links(id),
    code TEXT CHECK (code IS NULL OR length(code) = 4 AND code NOT GLOB '*[^0-9]*'),
    qr_token_hash BLOB UNIQUE CHECK (qr_token_hash IS NULL OR length(qr_token_hash) = 32),
    requester_user_agent TEXT NOT NULL DEFAULT '' CHECK (length(requester_user_agent) <= 256),
    approved_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    approver_recent_proof INTEGER NOT NULL DEFAULT 0 CHECK (approver_recent_proof IN (0,1)),
    origin_passkey_credential_id BLOB REFERENCES passkeys(credential_id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    approved_at INTEGER,
    consumed_at INTEGER,
    created_session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    delivery_ciphertext BLOB,
    CHECK (type = 'link' AND link_id IS NOT NULL AND qr_token_hash IS NULL
        OR type = 'qr' AND link_id IS NULL AND code IS NULL AND expires_at = created_at + 300),
    CHECK (approved_at IS NULL OR approved_at >= created_at AND approved_at < expires_at),
    CHECK (consumed_at IS NULL OR approved_at IS NOT NULL AND consumed_at >= approved_at AND consumed_at < expires_at),
    CHECK ((state = 'consumed') = (consumed_at IS NOT NULL AND created_session_id IS NOT NULL)),
    CHECK (state = 'consumed' OR consumed_at IS NULL AND created_session_id IS NULL AND delivery_ciphertext IS NULL),
    CHECK (state != 'approved' OR approved_at IS NOT NULL),
    CHECK (state NOT IN ('pending','denied') OR approved_at IS NULL AND approved_by_session_id IS NULL AND origin_passkey_credential_id IS NULL AND approver_recent_proof = 0),
    CHECK (approved_at IS NOT NULL OR approved_by_session_id IS NULL AND origin_passkey_credential_id IS NULL AND approver_recent_proof = 0)
) STRICT;
CREATE UNIQUE INDEX account_signin_requests_by_code ON account_signin_requests(link_id,code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX account_signin_requests_by_browser ON account_signin_requests(link_id,browser_token_hash) WHERE link_id IS NOT NULL AND browser_token_hash IS NOT NULL;
CREATE UNIQUE INDEX account_signin_requests_one_winner ON account_signin_requests(link_id) WHERE state IN ('approved','consumed');
CREATE UNIQUE INDEX account_signin_requests_live_qr ON account_signin_requests(browser_token_hash) WHERE type = 'qr' AND state IN ('pending','approved') AND browser_token_hash IS NOT NULL;
CREATE INDEX account_signin_requests_by_expiry ON account_signin_requests(expires_at);
CREATE INDEX account_signin_requests_by_approver ON account_signin_requests(approved_by_session_id,state);
CREATE INDEX account_signin_requests_by_origin ON account_signin_requests(origin_passkey_credential_id,state);

CREATE TABLE session_authentications (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    method TEXT NOT NULL CHECK (method IN ('guest_link','passkey','device_approval')),
    purpose TEXT NOT NULL CHECK (purpose IN ('sign_in','reauthentication')),
    authenticated_at INTEGER NOT NULL,
    passkey_credential_id BLOB REFERENCES passkeys(credential_id) ON DELETE SET NULL,
    device_approval_request_id TEXT UNIQUE REFERENCES account_signin_requests(id) ON DELETE SET NULL,
    origin_passkey_credential_id BLOB REFERENCES passkeys(credential_id) ON DELETE SET NULL,
    recent_proof INTEGER NOT NULL CHECK (recent_proof IN (0,1)),
    CHECK (method = 'guest_link' AND purpose = 'sign_in' AND recent_proof = 0 AND passkey_credential_id IS NULL AND device_approval_request_id IS NULL AND origin_passkey_credential_id IS NULL
        OR method = 'passkey' AND recent_proof = 1 AND device_approval_request_id IS NULL AND origin_passkey_credential_id IS NULL
        OR method = 'device_approval' AND purpose = 'sign_in' AND passkey_credential_id IS NULL)
) STRICT;
CREATE UNIQUE INDEX session_authentications_initial ON session_authentications(session_id) WHERE purpose = 'sign_in';
CREATE INDEX session_authentications_latest ON session_authentications(session_id,id DESC);
CREATE INDEX session_authentications_initial_passkey ON session_authentications(passkey_credential_id) WHERE purpose = 'sign_in';
CREATE INDEX session_authentications_initial_origin ON session_authentications(origin_passkey_credential_id) WHERE purpose = 'sign_in';
INSERT INTO session_authentications(session_id,method,purpose,authenticated_at,recent_proof)
SELECT id,'guest_link','sign_in',created_at,0 FROM sessions;
