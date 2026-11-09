ALTER TABLE visitors RENAME TO identities;
ALTER TABLE visitor_colours RENAME TO profiles;

ALTER TABLE profiles RENAME COLUMN visitor_id TO identity_id;
ALTER TABLE visitor_tokens RENAME COLUMN visitor_id TO identity_id;
ALTER TABLE accounts RENAME COLUMN visitor_id TO identity_id;
ALTER TABLE account_sessions RENAME COLUMN visitor_id TO identity_id;
ALTER TABLE passkeys RENAME COLUMN visitor_id TO identity_id;
ALTER TABLE account_recovery_proofs RENAME COLUMN visitor_id TO identity_id;
ALTER TABLE account_ceremonies RENAME COLUMN visitor_id TO identity_id;

DROP INDEX visitor_tokens_by_visitor;
CREATE INDEX visitor_tokens_by_identity ON visitor_tokens(identity_id);
