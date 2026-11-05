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
    const { rows } = await query('select tenant_id, role, organization_id from user_tenants($1)', [req.userId]);
    const wanted = req.headers['x-tenant-id'] || (new Set(rows.map((r) => r.tenant_id)).size === 1 ? rows[0].tenant_id : null);
    if (!wanted) return res.status(400).json({ error: 'X-Tenant-Id header required' });
    const mine = rows.filter((r) => r.tenant_id === wanted);
    if (!mine.length) return res.status(403).json({ error: 'Not a member of this tenant' });
    req.tenantId = wanted;
    req.roles = mine.map(({ role, organization_id }) => ({ role, organizationId: organization_id }));
    next();
  } catch (err) { next(err); }
}

export const hasRole = (req, ...roles) => req.roles.some((r) => roles.includes(r.role));
