-- PM chi nhánh lớn (1, ~40%).
SELECT id, "createdAt", action, event, severity, amount, "actorType", "actorRoleCode", "entityType", "entityId", "entityLabel", "branchIds", before, after, metadata, reason, "ipAddress", "requestId" FROM audit_logs WHERE "branchIds" @> ARRAY[md5('branch1')::uuid] ORDER BY "createdAt" DESC, id DESC LIMIT 51;
