-- Search hiếm (cụm 'sai lech kiem ke quy iv', ~0,02% dòng), 90 ngày, ADMIN.

SELECT quote_literal(coalesce(array_agg(id), '{}')::text) AS ids FROM (
  SELECT id FROM audit_logs
  WHERE "searchText" LIKE '%sai lech kiem ke quy iv%'
    AND "createdAt" >= now() - interval '90 days' AND "createdAt" < now()
  ORDER BY "createdAt" DESC, id DESC LIMIT 51) x
\gset
SELECT id, "createdAt", action, event, severity, amount, "actorType", "actorRoleCode", "entityType", "entityId", "entityLabel", "branchIds", before, after, metadata, reason, "ipAddress", "requestId" FROM audit_logs WHERE id = ANY (:ids::uuid[]) ORDER BY "createdAt" DESC, id DESC;
