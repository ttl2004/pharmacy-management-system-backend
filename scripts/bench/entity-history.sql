-- Lịch sử một đối tượng (entityType + entityId ngẫu nhiên trong 200.000).
\set n random(1, 200000)
SELECT id, "createdAt", action, event, severity, amount, "actorType", "actorRoleCode", "entityType", "entityId", "entityLabel", "branchIds", before, after, metadata, reason, "ipAddress", "requestId" FROM audit_logs WHERE "entityType" = 'orders' AND "entityId" = md5('e' || :n)::uuid ORDER BY "createdAt" DESC, id DESC LIMIT 51;
