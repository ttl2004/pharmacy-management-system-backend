-- Trang cursor thứ 50, PM chi nhánh lớn.
\set s random(39000, 40500)
SELECT id, "createdAt", action, event, severity, amount, "actorType", "actorRoleCode", "entityType", "entityId", "entityLabel", "branchIds", before, after, metadata, reason, "ipAddress", "requestId" FROM audit_logs
WHERE "branchIds" @> ARRAY[md5('branch1')::uuid]
  AND ("createdAt" < now() - :s * interval '1 second' OR ("createdAt" = now() - :s * interval '1 second' AND id < 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid))
ORDER BY "createdAt" DESC, id DESC LIMIT 51;
