import { query } from './db.js';
import { sessionUserId } from './session.js';

// Requires a signed-in user. Sets req.userId.
export function requireUser(req, res, next) {
  const uid = sessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Sign in required' });
  req.userId = uid;
  next();
}

// Requires a signed-in user who belongs to the tenant named in the X-Tenant-Id header
// (or, if they belong to exactly one tenant, that one). Sets req.tenantId and req.roles.
export async function requireTenant(req, res, next) {
  try {
    const { rows } = await query('select tenant_id, role, organization_id, facility_id from user_tenants($1)', [req.userId]);
    const wanted = req.headers['x-tenant-id'] || (new Set(rows.map((r) => r.tenant_id)).size === 1 ? rows[0].tenant_id : null);
    if (!wanted) return res.status(400).json({ error: 'X-Tenant-Id header required' });
    const mine = rows.filter((r) => r.tenant_id === wanted);
    if (!mine.length) return res.status(403).json({ error: 'Not a member of this tenant' });
    req.tenantId = wanted;
    req.roles = mine.map(({ role, organization_id, facility_id }) => ({ role, organizationId: organization_id, facilityId: facility_id }));
    next();
  } catch (err) { next(err); }
}

export const hasRole = (req, ...roles) => req.roles.some((r) => roles.includes(r.role));

// Staff who review requests (admins and approvers).
export const isStaffReq = (req) => hasRole(req, 'tenant_admin', 'approver');
// null = the whole tenant; otherwise the list of facility ids this person's staff roles are limited to.
export function staffScope(req) {
  const staff = req.roles.filter((r) => ['tenant_admin', 'approver'].includes(r.role));
  if (!staff.length || staff.some((r) => !r.facilityId)) return null;
  return [...new Set(staff.map((r) => r.facilityId))];
}
// Who may close fields: staff, and groundskeepers. Returns null (everywhere) or a list of facility ids.
export function closeScope(req) {
  const rs = req.roles.filter((r) => ['tenant_admin', 'approver', 'grounds'].includes(r.role));
  if (!rs.length) return undefined;
  if (rs.some((r) => !r.facilityId)) return null;
  return [...new Set(rs.map((r) => r.facilityId))];
}
