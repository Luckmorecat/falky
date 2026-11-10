-- UTC Unix nanoseconds, distinct from session timestamps stored in seconds.
-- NULL means no established absence; preserve pre-upgrade grants until observed.
ALTER TABLE voice_grants ADD COLUMN disconnected_since INTEGER;
