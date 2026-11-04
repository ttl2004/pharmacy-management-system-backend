-- Lọc event (2 loại) + severity >= 1, ADMIN.
SELECT id, "createdAt", action, event, severity, amount, "actorType", "actorRoleCode", "entityType", "entityId", "entityLabel", "branchIds", before, after, metadata, reason, "ipAddress", "requestId" FROM audit_logs WHERE event = ANY (ARRAY['ORDER.VOID_PAID', 'PAYMENT.REFUNDED']) AND severity >= 1 ORDER BY "createdAt" DESC, id DESC LIMIT 51;
