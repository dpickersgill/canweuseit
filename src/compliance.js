import express, { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isDate } from './time.js';

export const complianceRouter = Router();
complianceRouter.use(requireUser, requireTenant);
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const memberOf = (req, id) => req.roles.some((r) => ['org_admin', 'booker'].includes(r.role) && r.organizationId === id);
const orgAdminOf = (req, id) => req.roles.some((r) => r.role === 'org_admin' && r.organizationId === id);
const KINDS = ['insurance', 'permit', 'waiver', 'background_check', 'other'];
const bad = (err) => err.code === '22P02';

complianceRouter.get('/organizations/:id/documents', async (req, res, next) => {
  try {
    if (!isStaff(req) && !memberOf(req, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      'select id, kind, expires_on::text as "expiresOn", note, coverage_amount as "coverageAmount", additional_insured as "additionalInsured", file_name as "fileName", file_data is not null as "hasFile" from compliance_document where organization_id = $1 order by kind, expires_on desc nulls first', [req.params.id])).rows);
    res.json({ documents: rows });
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Organization not found' }); next(err); }
});

complianceRouter.post('/organizations/:id/documents', async (req, res, next) => {
  try {
    if (!isStaff(req) && !orgAdminOf(req, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
    const { kind, expiresOn, note } = req.body || {};
    const coverage = req.body?.coverageAmount == null || req.body.coverageAmount === '' ? null : Number(req.body.coverageAmount);
    if (coverage !== null && !(Number.isInteger(coverage) && coverage >= 0)) return res.status(400).json({ error: 'coverageAmount must be a whole number of dollars' });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    if (expiresOn != null && expiresOn !== '' && !isDate(expiresOn)) return res.status(400).json({ error: 'expiresOn must be a date like 2027-08-31' });
    const row = await withTenant(req.tenantId, async (c) => {
      const o = (await c.query('select 1 from organization where id = $1', [req.params.id])).rowCount;
      if (!o) return null;
      return (await c.query('insert into compliance_document (tenant_id, organization_id, kind, expires_on, note, coverage_amount, additional_insured) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [req.tenantId, req.params.id, kind, expiresOn || null, note ? String(note).slice(0, 300) : null, coverage, req.body?.additionalInsured === true])).rows[0];
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

// Attach the certificate itself (PDF, PNG or JPEG, up to 3 MB). Stored with the record; only staff and the group can open it.
const MAGIC = [['application/pdf', [0x25, 0x50, 0x44, 0x46]], ['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]]];
complianceRouter.post('/documents/:id/file', express.raw({ type: MAGIC.map((m) => m[0]), limit: '3mb' }), async (req, res, next) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(415).json({ error: 'Send a PDF, PNG or JPEG file up to 3 MB' });
    const type = MAGIC.find(([, sig]) => sig.every((b, i) => buf[i] === b))?.[0];
    if (!type) return res.status(415).json({ error: 'That does not look like a PDF, PNG or JPEG' });
    const name = String(req.headers['x-file-name'] || 'certificate').replace(/[^\w.\- ]/g, '').slice(0, 80) || 'certificate';
    const out = await withTenant(req.tenantId, async (c) => {
      const d = (await c.query('select organization_id from compliance_document where id = $1', [req.params.id])).rows[0];
      if (!d) return { status: 404, body: { error: 'Not found' } };
      if (!isStaff(req) && !orgAdminOf(req, d.organization_id)) return { status: 403, body: { error: 'Not allowed' } };
      await c.query('update compliance_document set file_name = $2, file_type = $3, file_data = $4 where id = $1', [req.params.id, name, type, buf]);
      return { status: 200, body: { ok: true, fileName: name } };
    });
    res.status(out.status).json(out.body);
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Not found' }); next(err); }
});

complianceRouter.get('/documents/:id/file', async (req, res, next) => {
  try {
    const d = await withTenant(req.tenantId, async (c) => (await c.query('select organization_id, file_name, file_type, file_data from compliance_document where id = $1', [req.params.id])).rows[0]);
    if (!d || !d.file_data) return res.status(404).json({ error: 'No file' });
    if (!isStaff(req) && !memberOf(req, d.organization_id)) return res.status(403).json({ error: 'Not allowed' });
    res.set({ 'Content-Type': d.file_type, 'Content-Disposition': `attachment; filename="${d.file_name}"`, 'X-Content-Type-Options': 'nosniff' }).send(d.file_data);
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Not found' }); next(err); }
});
