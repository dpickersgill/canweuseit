import crypto from 'node:crypto';

// One live permit per approved request. Numbers run P-2027-0001, P-2027-0002, ... per tenant.
export async function ensurePermit(c, { tenantId, requestId, userId }) {
  const have = (await c.query('select id from permit where request_id = $1 and revoked_at is null', [requestId])).rows[0];
  if (have) return have.id;
  await c.query('select pg_advisory_xact_lock(hashtext($1))', [`permit:${tenantId}`]);
  const n = (await c.query('select count(*)::int n from permit')).rows[0].n + 1;
  const number = `P-${new Date().getUTCFullYear()}-${String(n).padStart(4, '0')}`;
  const code = crypto.randomBytes(9).toString('base64url');
  return (await c.query('insert into permit (tenant_id, request_id, number, code, issued_by) values ($1,$2,$3,$4,$5) returning id', [tenantId, requestId, number, code, userId])).rows[0].id;
}
