import { Router } from 'express';
import { query, withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isDate, localToUtc } from './time.js';
import { sendMail } from './mail.js';
import { addPerson, findOrCreateUser } from './people.js';
import { issueLoginLink } from './auth.js';

// ---- public group application form (no session) ----
export const applyPublic = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
applyPublic.get('/apply-api/:slug', async (req, res, next) => {
  try {
    const { rows: [t] } = await query('select name from public_tenant($1)', [String(req.params.slug).slice(0, 80)]);
    t ? res.json({ name: t.name }) : res.status(404).json({ error: 'Not found' });
  } catch (err) { next(err); }
});
applyPublic.post('/apply-api/:slug', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim(), contact = String(b.contactName || '').trim(), email = String(b.email || '').trim().toLowerCase();
    const kind = ['club', 'school', 'league', 'other'].includes(b.kind) ? b.kind : 'club';
    if (!name || name.length > 120 || !contact || contact.length > 120 || !EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Group name, your name and a valid email are required' });
    try {
      await query('select apply_for_group($1,$2,$3,$4,$5,$6)', [String(req.params.slug).slice(0, 80), name, kind, contact, email, String(b.notes || '').slice(0, 1000)]);
    } catch (e) {
      if (e.code === 'P0002') return res.status(404).json({ error: 'Not found' });
      if (e.code === 'P0001') return res.status(429).json({ error: 'Too many applications from this email today. Please try again tomorrow' });
      throw e;
    }
    res.status(201).json({ ok: true, message: 'Thanks. The group will review your application and email you.' });
  } catch (err) { next(err); }
});

// ---- everything below needs a session ----
export const adminRouter = Router();
adminRouter.use(requireUser, requireTenant);
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const requireStaff = (req, res, next) => (isStaff(req) ? next() : res.status(403).json({ error: 'Only staff can do this' }));
const requireAdmin = (req, res, next) => (hasRole(req, 'tenant_admin') ? next() : res.status(403).json({ error: 'Only a tenant admin can do this' }));
const badUuid = (e) => e.code === '22P02';

// Group applications
adminRouter.get('/applications', requireStaff, async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select id, name, kind, contact_name as "contactName", contact_email as "contactEmail", notes, status, created_at as "createdAt"
         from group_application where ($1::text = 'all' or status = $1) order by created_at desc limit 200`, [status])).rows);
    res.json({ applications: rows });
  } catch (err) { next(err); }
});

// Approve creates the group and invites the contact as its manager. Decline emails them with an optional reason.
adminRouter.post('/applications/:id/decision', requireAdmin, async (req, res, next) => {
  try {
    const { decision } = req.body || {};
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    if (!['approve', 'decline'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or decline' });
    const tier = Number.isInteger(req.body?.tier) && req.body.tier >= 1 && req.body.tier <= 5 ? req.body.tier : 3;
    const out = await withTenant(req.tenantId, async (c) => {
      const a = (await c.query('select * from group_application where id = $1 for update', [req.params.id])).rows[0];
      if (!a) return { status: 404, body: { error: 'Application not found' } };
      if (a.status !== 'pending') return { status: 409, body: { error: `Already ${a.status}` } };
      let orgId = null;
      if (decision === 'approve') {
        const dup = (await c.query('select id from organization where lower(name) = lower($1)', [a.name])).rows[0];
        if (dup) return { status: 409, body: { error: 'A group with that name already exists. Rename the application or merge by hand' } };
        orgId = (await c.query('insert into organization (tenant_id, name, kind, tier) values ($1,$2,$3,$4) returning id', [req.tenantId, a.name, a.kind, tier])).rows[0].id;
      }
      await c.query("update group_application set status = $2, decided_by = $3, decided_at = now(), organization_id = $4 where id = $1", [a.id, decision === 'approve' ? 'approved' : 'declined', req.userId, orgId]);
      return { status: 200, body: { status: decision === 'approve' ? 'approved' : 'declined', organizationId: orgId }, a, orgId };
    });
    res.status(out.status).json(out.body);
    if (out.status === 200) {
      const tenantName = (await withTenant(req.tenantId, (c) => c.query('select name from tenant where id = $1', [req.tenantId]))).rows[0].name;
      if (decision === 'approve') await addPerson(req, { email: out.a.contact_email.toLowerCase(), fullName: out.a.contact_name, role: 'org_admin', organizationId: out.orgId }).catch((e) => console.error('invite failed', e.message));
      else await sendMail({ to: out.a.contact_email, subject: `Your application to ${tenantName}`, text: `${tenantName} could not approve ${out.a.name} at this time.${note ? `\n\n${note}` : ''}` }).catch((e) => console.error(e.message));
    }
  } catch (err) { if (badUuid(err)) return res.status(404).json({ error: 'Application not found' }); next(err); }
});

// Add many people at once: rows of { organization, name, email, role }. preview:true only checks.
adminRouter.post('/import/members', requireAdmin, async (req, res, next) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows is required' });
    if (rows.length > 500) return res.status(400).json({ error: 'At most 500 rows at a time' });
    const orgs = new Map((await withTenant(req.tenantId, (c) => c.query('select id, name from organization'))).rows.map((o) => [o.name.toLowerCase(), o.id]));
    const have = new Set((await withTenant(req.tenantId, (c) => c.query('select u.email, ra.organization_id from role_assignment ra join app_user u on u.id = ra.user_id where ra.organization_id is not null'))).rows.map((r) => `${r.email.toLowerCase()}|${r.organization_id}`));
    const errors = [], todo = [];
    rows.forEach((r, i) => {
      const email = String(r.email || '').trim().toLowerCase(), name = String(r.name || '').trim(), org = orgs.get(String(r.organization || '').trim().toLowerCase());
      const role = String(r.role || 'booker').trim().toLowerCase() === 'manager' || String(r.role).trim().toLowerCase() === 'org_admin' ? 'org_admin' : 'booker';
      if (!org) return errors.push({ row: i + 1, message: `Unknown group "${String(r.organization || '').trim()}"` });
      if (!EMAIL_RE.test(email) || !name || name.length > 120) return errors.push({ row: i + 1, message: 'A name and a valid email are required' });
      if (have.has(`${email}|${org}`) || todo.some((t) => t.email === email && t.organizationId === org)) return;
      todo.push({ email, fullName: name, organizationId: org, role });
    });
    if (req.body.preview) return res.json({ preview: true, created: { people: todo.length }, errors });
    for (const t of todo) await addPerson(req, { ...t, quiet: true });
    res.json({ preview: false, created: { people: todo.length }, errors });
    // emails go out after the answer so a long list does not make the page wait
    const { rows: [tn] } = await withTenant(req.tenantId, (c) => c.query('select name from tenant where id = $1', [req.tenantId]));
    for (const t of [...new Set(todo.map((x) => x.email))]) {
      await issueLoginLink(t, { subject: `You've been added to ${tn.name} on CanWeUseIt`, intro: `${tn.name} added you to CanWeUseIt. Click to sign in (valid for 15 minutes, works once):` }).catch((e) => console.error(e.message));
    }
  } catch (err) { if (err.code === '23505') return res.status(409).json({ error: 'Some people already have that role' }); next(err); }
});

// Audit log, newest first (admins).
adminRouter.get('/audit', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select a.id, a."at" as "at", u.full_name as actor, a.action, a.entity, a.entity_id as "entityId", a.detail
         from audit_log a left join app_user u on u.id = a.actor_id where ($1::text is null or a.action like $1 || '%') order by a."at" desc limit ${limit}`, [req.query.action || null])).rows);
    res.json({ entries: rows });
  } catch (err) { next(err); }
});

// ---- CSV exports (staff) ----
const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (head, rows) => [head.join(','), ...rows.map((r) => head.map((h) => cell(r[h])).join(','))].join('\r\n') + '\r\n';
const sendCsv = (res, name, text) => res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send(text);

adminRouter.get('/export/bookings.csv', requireStaff, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'from and to must be dates' });
    const rows = await withTenant(req.tenantId, async (c) => {
      const tz = (await c.query('select timezone from tenant where id = $1', [req.tenantId])).rows[0].timezone;
      const f = from ? localToUtc(from, '00:00', tz) : null;
      const t = to ? localToUtc(new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), '00:00', tz) : null;
      const r = (await c.query(
        `select o.name as organization, r.title, bd.label as team, f.name as facility, s.name as field, bd.starts_at, bd.ends_at, bd.status, bd.warning, p.number as permit
           from booking_date bd join request r on r.id = bd.request_id join organization o on o.id = r.organization_id join space s on s.id = bd.space_id join facility f on f.id = s.facility_id
           left join permit p on p.request_id = r.id and p.revoked_at is null
          where ($1::timestamptz is null or bd.ends_at > $1) and ($2::timestamptz is null or bd.starts_at < $2) order by bd.starts_at limit 20000`, [f, t])).rows;
      const fd = (d, o) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format(d);
      return r.map((x) => ({ ...x, date: fd(x.starts_at, { year: 'numeric', month: '2-digit', day: '2-digit' }),
        start: fd(x.starts_at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), end: fd(x.ends_at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }));
    });
    sendCsv(res, 'bookings.csv', toCsv(['organization', 'title', 'team', 'facility', 'field', 'date', 'start', 'end', 'status', 'permit', 'warning'], rows));
  } catch (err) { next(err); }
});

adminRouter.get('/export/usage.csv', requireStaff, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to) || to < from) return res.status(400).json({ error: 'from and to must be dates' });
    const rows = await withTenant(req.tenantId, async (c) => {
      const tz = (await c.query('select timezone from tenant where id = $1', [req.tenantId])).rows[0].timezone;
      const f = localToUtc(from, '00:00', tz), t = localToUtc(new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), '00:00', tz);
      return (await c.query(
        `select o.name as organization, s.name as field,
                count(*) filter (where bd.status = 'confirmed')::int as bookings,
                round((sum(extract(epoch from (least(bd.ends_at, $2) - greatest(bd.starts_at, $1))) / 3600) filter (where bd.status = 'confirmed'))::numeric, 1) as hours,
                count(*) filter (where bd.status = 'cancelled')::int as cancelled,
                count(*) filter (where bd.late_cancel)::int as late_cancellations
           from booking_date bd join request r on r.id = bd.request_id join organization o on o.id = r.organization_id join space s on s.id = bd.space_id
          where bd.starts_at < $2 and bd.ends_at > $1 group by o.name, s.name order by o.name, s.name`, [f, t])).rows;
    });
    sendCsv(res, 'usage.csv', toCsv(['organization', 'field', 'bookings', 'hours', 'cancelled', 'late_cancellations'], rows));
  } catch (err) { next(err); }
});
