-- Search phổ biến ('huy hang', ~1,5% dòng), 90 ngày, ADMIN.

SELECT quote_literal(coalesce(array_agg(id), '{}')::text) AS ids FROM (
  SELECT id FROM audit_logs
  WHERE "searchText" LIKE '%huy hang%'
    AND "createdAt" >= now() - interval '90 days' AND "createdAt" < now()
  ORDER BY "createdAt" DESC, id DESC LIMIT 51) x
\gset
SELECT id, "createdAt", action, event, severity, amount, "actorType", "actorRoleCode", "entityType", "entityId", "entityLabel", "branchIds", before, after, metadata, reason, "ipAddress", "requestId" FROM audit_logs WHERE id = ANY (:ids::uuid[]) ORDER BY "createdAt" DESC, id DESC;
