-- SecurityAuditEvent is an append-only security ledger. Row triggers do not
-- cover TRUNCATE, so protect that statement explicitly with the same rejector.
DROP TRIGGER IF EXISTS "security_audit_events_reject_truncate"
ON "security_audit_events";

CREATE TRIGGER "security_audit_events_reject_truncate"
BEFORE TRUNCATE ON "security_audit_events"
FOR EACH STATEMENT
EXECUTE FUNCTION "security_audit_events_append_only"();
