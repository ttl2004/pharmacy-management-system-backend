-- ADMIN: danh sách 50 dòng mới nhất, không lọc.
SELECT id, "createdAt", action, event, severity, amount, "actorType", "actorRoleCode", "entityType", "entityId", "entityLabel", "branchIds", before, after, metadata, reason, "ipAddress", "requestId" FROM audit_logs ORDER BY "createdAt" DESC, id DESC LIMIT 51;
