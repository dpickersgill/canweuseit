import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { toCsv } from './admin.js';
import { nextInvoiceNumber } from './invoicelib.js';
import { KIND_CODES } from '../public/kinds.js';

export const feesRouter = Router();
feesRouter.use(requireUser, requireTenant);
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const requireStaff = (req, res, next) => (isStaff(req) ? next() : res.status(403).json({ error: 'Only staff can do this' }));
const requireAdmin = (req, res, next) => (hasRole(req, 'tenant_admin') ? next() : res.status(403).json({ error: 'Only a tenant admin can do this' }));
const bad = (e) => e.code === '22P02';
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

// ---- hourly rates. The most specific one wins: one space beats a kind of space ("pavilions"), which beats a site;
// a group kind beats "everyone".
feesRouter.get('/fee-rates', requireStaff, async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select r.id, r.cents_per_hour as "centsPerHour", r.org_kind as "orgKind", r.space_kind as "spaceKind", r.note, r.space_id as "spaceId", s.name as space, r.facility_id as "facilityId", f.name as facility
         from fee_rate r left join space s on s.id = r.space_id left join facility f on f.id = r.facility_id order by f.name nulls first, s.name nulls first, r.org_kind nulls first`)).rows);
    res.json({ rates: rows });
  } catch (err) { next(err); }
});
feesRouter.post('/fee-rates', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!Number.isInteger(b.centsPerHour) || b.centsPerHour < 0 || b.centsPerHour > 10000000) return res.status(400).json({ error: 'centsPerHour must be a whole number of cents' });
    if ([b.spaceId, b.facilityId, b.spaceKind].filter(Boolean).length > 1) return res.status(400).json({ error: 'Choose one space, one kind of space or one site, not more' });
    if (b.spaceKind && !KIND_CODES.includes(b.spaceKind)) return res.status(400).json({ error: 'Unknown kind of space' });
    if (b.orgKind && !['club', 'school', 'league', 'other'].includes(b.orgKind)) return res.status(400).json({ error: 'Unknown group kind' });
    const row = await withTenant(req.tenantId, async (c) => (await c.query(
      'insert into fee_rate (tenant_id, facility_id, space_id, org_kind, cents_per_hour, note, space_kind) values ($1,$2,$3,$4,$5,$6,$7) returning id',
      [req.tenantId, b.facilityId || null, b.spaceId || null, b.orgKind || null, b.centsPerHour, b.note ? String(b.note).slice(0, 200) : null, b.spaceKind || null])).rows[0]);
    res.status(201).json(row);
  } catch (err) { if (bad(err) || err.code === '23503') return res.status(400).json({ error: 'Unknown space or site' }); next(err); }
});
feesRouter.delete('/fee-rates/:id', requireAdmin, async (req, res, next) => {
  try {
    const n = await withTenant(req.tenantId, async (c) => (await c.query('delete from fee_rate where id = $1', [req.params.id])).rowCount);
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Not found' }); next(err); }
});

// Price the confirmed dates of a request against the rate table.
async function price(c, requestId) {
  const r = (await c.query('select r.id, r.title, r.organization_id, o.kind, o.name as organization from request r join organization o on o.id = r.organization_id where r.id = $1', [requestId])).rows[0];
  if (!r) return null;
  const { rows: rates } = await c.query('select * from fee_rate');
  const { rows: dates } = await c.query(
    `select bd.space_id, s.name as space, s.facility_id, s.kind, extract(epoch from (bd.ends_at - bd.starts_at)) / 3600 as hours
       from booking_date bd join space s on s.id = bd.space_id where bd.request_id = $1 and bd.status = 'confirmed'`, [requestId]);
  const lines = new Map(); let unpriced = 0;
  for (const d of dates) {
    let best = null, bestScore = -1;
    for (const rt of rates) {
      if (rt.space_id && rt.space_id !== d.space_id) continue;
      if (rt.facility_id && rt.facility_id !== d.facility_id) continue;
      if (rt.space_kind && rt.space_kind !== d.kind) continue;
      if (rt.org_kind && rt.org_kind !== r.kind) continue;
      const score = (rt.space_id ? 8 : 0) + (rt.space_kind ? 4 : 0) + (rt.facility_id ? 2 : 0) + (rt.org_kind ? 1 : 0);
      if (score > bestScore) { best = rt; bestScore = score; }
    }
    if (!best) { unpriced++; continue; }
    const k = `${d.space_id}|${best.id}`;
    const l = lines.get(k) || { space: d.space, rate: best.cents_per_hour, dates: 0, hours: 0 };
    l.dates++; l.hours += Number(d.hours); lines.set(k, l);
  }
  const out = [...lines.values()].map((l) => ({ description: `${l.space}: ${l.dates} date${l.dates === 1 ? '' : 's'}, ${Math.round(l.hours * 100) / 100} h at ${money(l.rate)}/h`, amountCents: Math.round(l.rate * l.hours) }));
  return { request: r, lines: out, totalCents: out.reduce((a, l) => a + l.amountCents, 0), unpriced };
}

// Create an invoice for an approved request. preview:true returns the lines without saving.
feesRouter.post('/requests/:id/invoice', requireStaff, async (req, res, next) => {
  try {
    const dueDays = Number.isInteger(req.body?.dueDays) ? Math.min(Math.max(req.body.dueDays, 0), 365) : 14;
    const out = await withTenant(req.tenantId, async (c) => {
      const p = await price(c, req.params.id);
      if (!p) return { status: 404, body: { error: 'Request not found' } };
      if (!p.lines.length) return { status: 400, body: { error: 'No fees apply. Add a rate for these spaces first', unpriced: p.unpriced } };
      if (req.body?.preview) return { status: 200, body: { preview: true, lines: p.lines, totalCents: p.totalCents, unpriced: p.unpriced } };
      const number = await nextInvoiceNumber(c, req.tenantId);
      const inv = (await c.query(
        "insert into invoice (tenant_id, organization_id, request_id, number, amount_cents, due_on, note, created_by) values ($1,$2,$3,$4,$5, current_date + $6::int, $7, $8) returning id, number",
        [req.tenantId, p.request.organization_id, p.request.id, number, p.totalCents, dueDays, req.body?.note ? String(req.body.note).slice(0, 300) : null, req.userId])).rows[0];
      for (const l of p.lines) await c.query('insert into invoice_line (tenant_id, invoice_id, description, amount_cents) values ($1,$2,$3,$4)', [req.tenantId, inv.id, l.description, l.amountCents]);
      return { status: 201, body: { ...inv, totalCents: p.totalCents, lines: p.lines, unpriced: p.unpriced } };
    });
    res.status(out.status).json(out.body);
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Request not found' }); next(err); }
});

// Staff see every invoice; everyone else only their groups'.
feesRouter.get('/invoices', async (req, res, next) => {
  try {
    const mine = req.roles.map((r) => r.organizationId).filter(Boolean);
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select i.id, i.number, i.status, i.kind, i.refunded_cents as "refundedCents", i.amount_cents as "amountCents", i.due_on::text as "dueOn", i.note, i.created_at as "createdAt", i.paid_at as "paidAt", i.paid_method as "paidMethod", i.paid_ref as "paidRef",
              i.organization_id as "organizationId", o.name as organization, r.title as request,
              (i.status = 'open' and i.due_on < current_date) as overdue,
              (select json_agg(json_build_object('description', l.description, 'amountCents', l.amount_cents)) from invoice_line l where l.invoice_id = i.id) as lines
         from invoice i join organization o on o.id = i.organization_id left join request r on r.id = i.request_id
        where ($1::text is null or i.status = $1) order by i.created_at desc limit 500`, [req.query.status || null])).rows);
    const t = await withTenant(req.tenantId, async (c) => (await c.query('select t.payments_ready, p.online_payments from tenant t join plan p on p.code = t.plan_code where t.id = $1', [req.tenantId])).rows[0]);
    res.json({ invoices: isStaff(req) ? rows : rows.filter((r) => mine.includes(r.organizationId)), payOnline: !!(t.payments_ready && t.online_payments) });
  } catch (err) { next(err); }
});

feesRouter.post('/invoices/:id/pay', requireStaff, async (req, res, next) => {
  try {
    const method = String(req.body?.method || 'check').slice(0, 40), ref = req.body?.reference ? String(req.body.reference).slice(0, 80) : null;
    const n = await withTenant(req.tenantId, async (c) => {
      const k = (await c.query("update invoice set status = 'paid', paid_at = now(), paid_method = $2, paid_ref = $3 where id = $1 and status = 'open'", [req.params.id, method, ref])).rowCount;
      if (k) await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'invoice.paid','invoice',$3,$4)", [req.tenantId, req.userId, req.params.id, JSON.stringify({ method, ref })]);
      return k;
    });
    n ? res.json({ ok: true }) : res.status(409).json({ error: 'Invoice not found or not open' });
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Not found' }); next(err); }
});
feesRouter.post('/invoices/:id/void', requireStaff, async (req, res, next) => {
  try {
    const n = await withTenant(req.tenantId, async (c) => {
      const k = (await c.query("update invoice set status = 'void' where id = $1 and status = 'open'", [req.params.id])).rowCount;
      if (k) await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id) values ($1,$2,'invoice.void','invoice',$3)", [req.tenantId, req.userId, req.params.id]);
      return k;
    });
    n ? res.json({ ok: true }) : res.status(409).json({ error: 'Invoice not found or not open' });
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Not found' }); next(err); }
});

feesRouter.get('/export/invoices.csv', requireStaff, async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select i.number, i.kind, o.name as organization, r.title as request, i.status, round(i.amount_cents / 100.0, 2) as amount, round(i.refunded_cents / 100.0, 2) as refunded, i.due_on::text as due, i.paid_at::date::text as paid, i.paid_method as method, i.paid_ref as reference
         from invoice i join organization o on o.id = i.organization_id left join request r on r.id = i.request_id order by i.created_at`)).rows);
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="invoices.csv"').send(toCsv(['number', 'kind', 'organization', 'request', 'status', 'amount', 'refunded', 'due', 'paid', 'method', 'reference'], rows));
  } catch (err) { next(err); }
});
