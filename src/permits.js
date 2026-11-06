import { Router } from 'express';
import { query, withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { ensurePermit } from './permitlib.js';
import { config } from './config.js';

// ---- public: anyone holding the permit code can check it (the page is printable and shown on site)
export const permitsPublic = Router();
permitsPublic.get('/permit-api/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code);
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(code)) return res.status(404).json({ error: 'Not found' });
    const { rows: [r] } = await query('select permit_lookup($1) as p', [code]);
    r?.p ? res.json(r.p) : res.status(404).json({ error: 'Not found' });
  } catch (err) { next(err); }
});

export const permitsRouter = Router();
permitsRouter.use(requireUser, requireTenant);
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const canSee = (req, orgId, requestedBy) => isStaff(req) || requestedBy === req.userId || req.roles.some((r) => ['org_admin', 'booker'].includes(r.role) && r.organizationId === orgId);
const bad = (e) => e.code === '22P02';

permitsRouter.get('/requests/:id/permit', async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const r = (await c.query('select organization_id, requested_by from request where id = $1', [req.params.id])).rows[0];
      if (!r) return { status: 404, body: { error: 'Request not found' } };
      if (!canSee(req, r.organization_id, r.requested_by)) return { status: 403, body: { error: 'Not allowed' } };
      const p = (await c.query('select id, number, code, issued_at as "issuedAt", revoked_at as "revokedAt" from permit where request_id = $1 order by issued_at desc limit 1', [req.params.id])).rows[0];
      return { status: 200, body: p ? { ...p, url: `${config.appUrl}/permit/${p.code}` } : { permit: null } };
    });
    res.status(out.status).json(out.body);
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Request not found' }); next(err); }
});

// Issue (or reissue after a revoke) a permit for an approved request.
permitsRouter.post('/requests/:id/permit', async (req, res, next) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ error: 'Only staff can issue permits' });
    const out = await withTenant(req.tenantId, async (c) => {
      const r = (await c.query('select status from request where id = $1', [req.params.id])).rows[0];
      if (!r) return { status: 404, body: { error: 'Request not found' } };
      if (r.status !== 'approved') return { status: 409, body: { error: 'Only approved requests get a permit' } };
      const id = await ensurePermit(c, { tenantId: req.tenantId, requestId: req.params.id, userId: req.userId });
      const p = (await c.query('select number, code from permit where id = $1', [id])).rows[0];
      return { status: 201, body: { ...p, url: `${config.appUrl}/permit/${p.code}` } };
    });
    res.status(out.status).json(out.body);
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Request not found' }); next(err); }
});

permitsRouter.post('/requests/:id/permit/revoke', async (req, res, next) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ error: 'Only staff can revoke permits' });
    const n = await withTenant(req.tenantId, async (c) => {
      const k = (await c.query('update permit set revoked_at = now() where request_id = $1 and revoked_at is null', [req.params.id])).rowCount;
      if (k) await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id) values ($1,$2,'permit.revoke','request',$3)", [req.tenantId, req.userId, req.params.id]);
      return k;
    });
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'No active permit' });
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Request not found' }); next(err); }
});
