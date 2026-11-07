-- Search phổ biến, 90 ngày, PM chi nhánh 1%.

SELECT quote_literal(coalesce(array_agg(id), '{}')::text) AS ids FROM (
  SELECT id FROM audit_logs
  WHERE "searchText" LIKE '%huy hang%'
    AND "createdAt" >= now() - interval '90 days' AND "createdAt" < now()
    AND "branchIds" @> ARRAY[md5('branch7')::uuid]
  ORDER BY "createdAt" DESC, id DESC LIMIT 51) x
\gset
SELECT id, "createdAt", action, event, severity, amount, "actorType", "actorRoleCode", "entityType", "entityId", "entityLabel", "branchIds", before, after, metadata, reason, "ipAddress", "requestId" FROM audit_logs WHERE id = ANY (:ids::uuid[]) ORDER BY "createdAt" DESC, id DESC;
