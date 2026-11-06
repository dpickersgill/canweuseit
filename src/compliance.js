import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isDate } from './time.js';

export const complianceRouter = Router();
complianceRouter.use(requireUser, requireTenant);
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const memberOf = (req, id) => req.roles.some((r) => ['org_admin', 'booker'].includes(r.role) && r.organizationId === id);
const orgAdminOf = (req, id) => req.roles.some((r) => r.role === 'org_admin' && r.organizationId === id);
const KINDS = ['insurance', 'permit', 'waiver', 'other'];
const bad = (err) => err.code === '22P02';

complianceRouter.get('/organizations/:id/documents', async (req, res, next) => {
  try {
    if (!isStaff(req) && !memberOf(req, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      'select id, kind, expires_on::text as "expiresOn", note from compliance_document where organization_id = $1 order by kind, expires_on desc nulls first', [req.params.id])).rows);
    res.json({ documents: rows });
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Organization not found' }); next(err); }
});

complianceRouter.post('/organizations/:id/documents', async (req, res, next) => {
  try {
    if (!isStaff(req) && !orgAdminOf(req, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
    const { kind, expiresOn, note } = req.body || {};
    if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    if (expiresOn != null && expiresOn !== '' && !isDate(expiresOn)) return res.status(400).json({ error: 'expiresOn must be a date like 2027-08-31' });
    const row = await withTenant(req.tenantId, async (c) => {
      const o = (await c.query('select 1 from organization where id = $1', [req.params.id])).rowCount;
      if (!o) return null;
      return (await c.query('insert into compliance_document (tenant_id, organization_id, kind, expires_on, note) values ($1,$2,$3,$4,$5) returning id',
        [req.tenantId, req.params.id, kind, expiresOn || null, note ? String(note).slice(0, 300) : null])).rows[0];
    });
    row ? res.status(201).json(row) : res.status(404).json({ error: 'Organization not found' });
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Organization not found' }); next(err); }
});

complianceRouter.delete('/documents/:id', async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const d = (await c.query('select organization_id from compliance_document where id = $1', [req.params.id])).rows[0];
      if (!d) return { status: 404, body: { error: 'Not found' } };
      if (!isStaff(req) && !orgAdminOf(req, d.organization_id)) return { status: 403, body: { error: 'Not allowed' } };
      await c.query('delete from compliance_document where id = $1', [req.params.id]);
      return { status: 200, body: { ok: true } };
    });
    res.status(out.status).json(out.body);
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Not found' }); next(err); }
});

// Insurance status per organization: ok, expiring (30 days), expired or missing. Staff see all; others their own.
complianceRouter.get('/compliance', async (req, res, next) => {
  try {
    const mine = req.roles.map((r) => r.organizationId).filter(Boolean);
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select o.id, o.name, max(d.expires_on)::text as "expiresOn", bool_or(d.id is not null and d.expires_on is null) as "noExpiry", count(d.id)::int as docs,
              case when count(d.id) = 0 then 'missing'
                   when bool_or(d.expires_on is null or d.expires_on >= current_date + 30) then 'ok'
                   when bool_or(d.expires_on >= current_date) then 'expiring' else 'expired' end as status
         from organization o left join compliance_document d on d.organization_id = o.id and d.kind = 'insurance'
        group by o.id order by o.name`)).rows);
    res.json({ organizations: isStaff(req) ? rows : rows.filter((r) => mine.includes(r.id)) });
  } catch (err) { next(err); }
});
