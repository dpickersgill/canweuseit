import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isDate, isTime, localToUtc } from './time.js';
import { decideRequest } from './requests.js';

export const importRouter = Router();
importRouter.use(requireUser, requireTenant, (req, res, next) =>
  hasRole(req, 'tenant_admin') ? next() : res.status(403).json({ error: 'Only a tenant admin can import' }));

const MAX_ROWS = 500;
const yes = (v) => ['yes', 'y', 'true', '1', 'x', 'lights'].includes(String(v ?? '').trim().toLowerCase());
const text = (v) => String(v ?? '').trim();
const key = (v) => text(v).toLowerCase();
const KINDS = ['club', 'school', 'league', 'other'];

// Every import runs inside one transaction. With preview:true it is rolled back, so you see exactly what would happen.
async function run(req, res, next, work) {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows is required' });
    if (rows.length > MAX_ROWS) return res.status(400).json({ error: `At most ${MAX_ROWS} rows at a time` });
    const preview = !!req.body.preview;
    class Undo extends Error {}
    let result;
    try {
      await withTenant(req.tenantId, async (c) => {
        result = await work(c, rows);
        if (preview) throw new Undo();
      });
    } catch (e) { if (!(e instanceof Undo)) throw e; }
    res.json({ preview, ...result });
  } catch (err) { next(err); }
}

// Columns: facility, field, section (optional), lights (optional)
importRouter.post('/import/spaces', (req, res, next) => run(req, res, next, async (c, rows) => {
  const errors = []; let facilities = 0, spaces = 0;
  const fac = new Map((await c.query('select id, name from facility')).rows.map((f) => [key(f.name), f.id]));
  const sp = new Map((await c.query('select id, facility_id, parent_id, name from space')).rows.map((s) => [`${s.facility_id}|${s.parent_id || ''}|${key(s.name)}`, s.id]));
  for (const [i, r] of rows.entries()) {
    const facility = text(r.facility), field = text(r.field), section = text(r.section);
    if (!facility || !field) { errors.push({ row: i + 1, message: 'facility and field are required' }); continue; }
    if (facility.length > 120 || field.length > 120 || section.length > 120) { errors.push({ row: i + 1, message: 'Names must be 120 characters or fewer' }); continue; }
    let fid = fac.get(key(facility));
    if (!fid) { fid = (await c.query('insert into facility (tenant_id, name) values ($1,$2) returning id', [req.tenantId, facility])).rows[0].id; fac.set(key(facility), fid); facilities++; }
    const lights = yes(r.lights);
    let pid = sp.get(`${fid}||${key(field)}`);
    if (!pid) { pid = (await c.query('insert into space (tenant_id, facility_id, name, has_lights) values ($1,$2,$3,$4) returning id', [req.tenantId, fid, field, !section && lights])).rows[0].id; sp.set(`${fid}||${key(field)}`, pid); spaces++; }
    if (section && !sp.get(`${fid}|${pid}|${key(section)}`)) {
      sp.set(`${fid}|${pid}|${key(section)}`, (await c.query('insert into space (tenant_id, facility_id, parent_id, name, has_lights) values ($1,$2,$3,$4,$5) returning id', [req.tenantId, fid, pid, section, lights])).rows[0].id); spaces++;
    }
  }
  return { created: { facilities, spaces }, errors };
}));

// Columns: name, kind (optional)
importRouter.post('/import/organizations', (req, res, next) => run(req, res, next, async (c, rows) => {
  const errors = []; let created = 0;
  const have = new Set((await c.query('select name from organization')).rows.map((o) => key(o.name)));
  for (const [i, r] of rows.entries()) {
    const name = text(r.name), kind = key(r.kind) || 'club';
    if (!name || name.length > 120) { errors.push({ row: i + 1, message: 'name is required (120 characters or fewer)' }); continue; }
    if (!KINDS.includes(kind)) { errors.push({ row: i + 1, message: `kind must be one of ${KINDS.join(', ')}` }); continue; }
    if (have.has(key(name))) continue;
    await c.query('insert into organization (tenant_id, name, kind) values ($1,$2,$3)', [req.tenantId, name, kind]);
    have.add(key(name)); created++;
  }
  return { created: { organizations: created }, errors };
}));

// Columns: organization, space, title, date (YYYY-MM-DD), start (HH:MM), end (HH:MM). Imported bookings are confirmed right away.
importRouter.post('/import/bookings', (req, res, next) => run(req, res, next, async (c, rows) => {
  const tz = (await c.query('select timezone from tenant where id = $1', [req.tenantId])).rows[0].timezone;
  const orgs = new Map((await c.query('select id, name from organization')).rows.map((o) => [key(o.name), o.id]));
  const spaces = new Map(); const dupes = new Set();
  for (const s of (await c.query('select id, name from space where active')).rows) { const k = key(s.name); if (spaces.has(k)) dupes.add(k); spaces.set(k, s.id); }
  const errors = [], groups = new Map();
  for (const [i, r] of rows.entries()) {
    const n = i + 1, org = orgs.get(key(r.organization)), space = spaces.get(key(r.space)), title = text(r.title);
    if (!org) { errors.push({ row: n, message: `Unknown organization "${text(r.organization)}"` }); continue; }
    if (!space || dupes.has(key(r.space))) { errors.push({ row: n, message: space ? `More than one space is named "${text(r.space)}"` : `Unknown space "${text(r.space)}"` }); continue; }
    if (!title || title.length > 200) { errors.push({ row: n, message: 'title is required' }); continue; }
    if (!isDate(text(r.date)) || !isTime(text(r.start)) || !isTime(text(r.end)) || text(r.end) <= text(r.start)) { errors.push({ row: n, message: 'date (YYYY-MM-DD), start and end (HH:MM, end after start) are required' }); continue; }
    const k = `${org}|${space}|${title}`;
    if (!groups.has(k)) groups.set(k, { org, space, title, dates: [] });
    groups.get(k).dates.push({ startsAt: localToUtc(text(r.date), text(r.start), tz), endsAt: localToUtc(text(r.date), text(r.end), tz) });
  }
  let confirmed = 0, flagged = 0;
  for (const g of groups.values()) {
    const { rows: [rq] } = await c.query('insert into request (tenant_id, organization_id, requested_by, space_id, title, notes) values ($1,$2,$3,$4,$5,$6) returning id',
      [req.tenantId, g.org, req.userId, g.space, g.title, 'Imported']);
    for (const d of g.dates) await c.query('insert into booking_date (tenant_id, request_id, space_id, starts_at, ends_at) values ($1,$2,$3,$4,$5)', [req.tenantId, rq.id, g.space, d.startsAt, d.endsAt]);
    const d = await decideRequest(c, { tenantId: req.tenantId, requestId: rq.id, userId: req.userId, decision: 'approve', note: 'Imported' });
    confirmed += d.confirmed; flagged += d.flagged;
  }
  return { created: { requests: groups.size, confirmed, conflicts: flagged }, errors };
}));
