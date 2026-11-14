CREATE INDEX account_signin_requests_qr_browser ON account_signin_requests(browser_token_hash)
WHERE type = 'qr' AND browser_token_hash IS NOT NULL;
CREATE INDEX account_signin_requests_by_link ON account_signin_requests(link_id);
CREATE INDEX account_signin_requests_outstanding ON account_signin_requests(expires_at)
WHERE state IN ('pending','approved') OR browser_token_hash IS NOT NULL OR code IS NOT NULL OR qr_token_hash IS NOT NULL OR delivery_ciphertext IS NOT NULL;
CREATE INDEX account_signin_requests_purge ON account_signin_requests(qr_token_hash,expires_at)
WHERE state IN ('denied','cancelled') AND browser_token_hash IS NULL AND code IS NULL AND qr_token_hash IS NULL AND delivery_ciphertext IS NULL;
CREATE INDEX account_signin_links_active_expiry ON account_signin_links(expires_at)
WHERE state IN ('open','approved');
CREATE INDEX account_signin_links_secret_expiry ON account_signin_links(expires_at)
WHERE token_hash IS NOT NULL;
