import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isDate, localToUtc } from './time.js';
import { localParts, checkDates } from './rules.js';
import { decideRequest } from './requests.js';
import { notify } from './notify.js';

export const roundsRouter = Router();
roundsRouter.use(requireUser, requireTenant);
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const requireAdmin = (req, res, next) => (hasRole(req, 'tenant_admin') ? next() : res.status(403).json({ error: 'Only a tenant admin can manage rounds' }));
const bad = (e) => e.code === '22P02';
class Undo extends Error {}

roundsRouter.get('/rounds', async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select r.id, r.name, r.opens_at as "opensAt", r.closes_at as "closesAt", r.season_start::text as "seasonStart", r.season_end::text as "seasonEnd",
              r.max_hours_per_org as "maxHoursPerOrg", r.status,
              (select count(*)::int from request q where q.round_id = r.id) as requests,
              (select count(*)::int from request q where q.round_id = r.id and q.status = 'pending') as pending
         from allocation_round r order by r.opens_at desc`)).rows);
    res.json({ rounds: rows });
  } catch (err) { next(err); }
});

roundsRouter.post('/rounds', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const opens = new Date(b.opensAt), closes = new Date(b.closesAt);
    if (!name || name.length > 120 || Number.isNaN(+opens) || Number.isNaN(+closes) || closes <= opens || !isDate(b.seasonStart) || !isDate(b.seasonEnd) || b.seasonEnd < b.seasonStart) {
      return res.status(400).json({ error: 'name, a window that closes after it opens, and a season start and end are required' });
    }
    const cap = b.maxHoursPerOrg == null || b.maxHoursPerOrg === '' ? null : Number(b.maxHoursPerOrg);
    if (cap !== null && !(cap > 0)) return res.status(400).json({ error: 'maxHoursPerOrg must be more than 0' });
    const row = await withTenant(req.tenantId, async (c) => (await c.query(
      'insert into allocation_round (tenant_id, name, opens_at, closes_at, season_start, season_end, max_hours_per_org) values ($1,$2,$3,$4,$5,$6,$7) returning id',
      [req.tenantId, name, opens, closes, b.seasonStart, b.seasonEnd, cap])).rows[0]);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

roundsRouter.patch('/rounds/:id', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.status !== undefined) { if (!['open', 'closed'].includes(b.status)) return res.status(400).json({ error: 'status must be open or closed' }); add('status', b.status); }
    if (b.closesAt !== undefined) { const d = new Date(b.closesAt); if (Number.isNaN(+d)) return res.status(400).json({ error: 'Invalid closesAt' }); add('closes_at', d); }
    if (b.opensAt !== undefined) { const d = new Date(b.opensAt); if (Number.isNaN(+d)) return res.status(400).json({ error: 'Invalid opensAt' }); add('opens_at', d); }
    if (b.name !== undefined) { if (!String(b.name).trim()) return res.status(400).json({ error: 'Invalid name' }); add('name', String(b.name).trim().slice(0, 120)); }
    if (b.maxHoursPerOrg !== undefined) add('max_hours_per_org', b.maxHoursPerOrg === null || b.maxHoursPerOrg === '' ? null : Number(b.maxHoursPerOrg));
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.id);
    const n = await withTenant(req.tenantId, async (c) => (await c.query(`update allocation_round set ${sets.join(', ')} where id = $${vals.length}`, vals)).rowCount);
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Round not found' });
  } catch (err) { if (bad(err) || err.code === '23514') return res.status(400).json({ error: 'Check the values' }); next(err); }
});

// Start the round from last season: every confirmed date in [fromStart, fromEnd] becomes a pending, preliminary request, moved forward
// by whole weeks so each keeps its weekday. Groups then adjust or confirm; staff approve in bulk. Safe to run twice.
roundsRouter.post('/rounds/:id/rollover', requireAdmin, async (req, res, next) => {
  try {
    const { fromStart, fromEnd, preview } = req.body || {};
    if (!isDate(fromStart) || !isDate(fromEnd) || fromEnd < fromStart) return res.status(400).json({ error: 'fromStart and fromEnd are required' });
    let out;
    try {
      await withTenant(req.tenantId, async (c) => {
        const round = (await c.query('select * from allocation_round where id = $1', [req.params.id])).rows[0];
        if (!round) { out = { status: 404, body: { error: 'Round not found' } }; return; }
        const t = (await c.query('select id, timezone, latitude, longitude, daylight_rule, insurance_rule, min_coverage, require_additional_insured from tenant where id = $1', [req.tenantId])).rows[0];
        const tz = t.timezone;
        const season0 = round.season_start.toISOString().slice(0, 10), season1 = round.season_end.toISOString().slice(0, 10);
        const weeks = Math.round((Date.parse(`${season0}T00:00:00Z`) - Date.parse(`${fromStart}T00:00:00Z`)) / (7 * 86400000));
        const shift = weeks * 7;
        const f = localToUtc(fromStart, '00:00', tz), to = localToUtc(new Date(Date.parse(`${fromEnd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), '00:00', tz);
        const { rows: dates } = await c.query(
          `select bd.space_id, bd.starts_at, bd.ends_at, bd.label, r.id as request_id, r.organization_id, r.requested_by, r.title, r.space_id as main_space, r.priority_snapshot
             from booking_date bd join request r on r.id = bd.request_id where bd.status = 'confirmed' and bd.starts_at >= $1 and bd.starts_at < $2 order by r.id, bd.starts_at`, [f, to]);
        const by = new Map();
        for (const d of dates) { if (!by.has(d.request_id)) by.set(d.request_id, []); by.get(d.request_id).push(d); }
        let requests = 0, total = 0, skipped = 0;
        for (const list of by.values()) {
          const h = list[0];
          const moved = list.map((d) => {
            const sp = localParts(d.starts_at, tz), ep = localParts(d.ends_at, tz);
            const nd = new Date(Date.parse(`${sp.day}T12:00:00Z`) + shift * 86400000).toISOString().slice(0, 10);
            const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
            return { spaceId: d.space_id, label: d.label, day: nd, startsAt: localToUtc(nd, hm(sp.minutes), tz), endsAt: localToUtc(nd, ep.day === sp.day ? hm(ep.minutes) : '23:59', tz) };
          }).filter((d) => d.day >= season0 && d.day <= season1 && d.startsAt > new Date());
          if (!moved.length) { skipped++; continue; }
          const exists = (await c.query('select 1 from request where round_id = $1 and organization_id = $2 and title = $3 and space_id = $4', [round.id, h.organization_id, h.title, h.main_space])).rowCount;
          if (exists) { skipped++; continue; }
          const { rows: [nr] } = await c.query(
            `insert into request (tenant_id, organization_id, requested_by, space_id, title, notes, priority_snapshot, round_id)
             values ($1,$2,$3,$4,$5,'Carried over from last season. Please confirm or adjust.',$6,$7) returning id`, [req.tenantId, h.organization_id, h.requested_by, h.main_space, h.title, h.priority_snapshot, round.id]);
          for (const d of moved) {
            const [chk] = await checkDates(c, { tenant: t, spaceId: d.spaceId, organizationId: h.organization_id, dates: [d] });
            await c.query('insert into booking_date (tenant_id, request_id, space_id, starts_at, ends_at, label, warning) values ($1,$2,$3,$4,$5,$6,$7)',
              [req.tenantId, nr.id, d.spaceId, d.startsAt, d.endsAt, d.label, [...chk.blocks, ...chk.warnings].join('; ') || null]);
          }
          requests++; total += moved.length;
        }
        out = { status: 200, body: { preview: !!preview, requests, dates: total, skipped, shiftedDays: shift } };
        if (preview) throw new Undo();
      });
    } catch (e) { if (!(e instanceof Undo)) throw e; }
    res.status(out.status).json(out.body);
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Round not found' }); next(err); }
});

// Run the round: approve pending requests in order of tier, then person priority, then who asked first. Conflicting dates are flagged.
// With a per-group cap, a request that would take a group over its hours is left pending. preview:true shows the result and changes nothing.
roundsRouter.post('/rounds/:id/allocate', requireAdmin, async (req, res, next) => {
  try {
    const preview = !!req.body?.preview;
    let out; const notices = [];
    try {
      await withTenant(req.tenantId, async (c) => {
        const round = (await c.query('select * from allocation_round where id = $1', [req.params.id])).rows[0];
        if (!round) { out = { status: 404, body: { error: 'Round not found' } }; return; }
        const { rows: queue } = await c.query(
          `select r.id, r.title, r.organization_id, r.requested_by, o.name as organization,
                  coalesce(sum(extract(epoch from (bd.ends_at - bd.starts_at)) / 3600) filter (where bd.status = 'pending'), 0) as hours
             from request r join organization o on o.id = r.organization_id join booking_date bd on bd.request_id = r.id
            where r.round_id = $1 and r.status = 'pending' group by r.id, o.name, o.tier
            order by o.tier desc, r.priority_snapshot desc, r.submitted_at asc`, [round.id]);
        const used = new Map();
        if (round.max_hours_per_org != null) {
          const { rows } = await c.query(
            `select r.organization_id, sum(extract(epoch from (bd.ends_at - bd.starts_at)) / 3600) as h from request r join booking_date bd on bd.request_id = r.id
              where r.round_id = $1 and bd.status = 'confirmed' group by r.organization_id`, [round.id]);
          for (const r of rows) used.set(r.organization_id, Number(r.h));
        }
        const results = [];
        for (const q of queue) {
          const hours = Number(q.hours);
          if (round.max_hours_per_org != null && (used.get(q.organization_id) || 0) + hours > Number(round.max_hours_per_org)) {
            results.push({ id: q.id, title: q.title, organization: q.organization, skipped: `Over the ${round.max_hours_per_org}-hour cap for a group` });
            continue;
          }
          await c.query('savepoint a');
          try {
            const r = await decideRequest(c, { tenantId: req.tenantId, requestId: q.id, userId: req.userId, decision: 'approve', note: `Allocated in ${round.name}` });
            await c.query('release savepoint a');
            const got = r.confirmed + r.flagged ? hours * (r.confirmed / (r.confirmed + r.flagged)) : 0;
            used.set(q.organization_id, (used.get(q.organization_id) || 0) + got);
            results.push({ id: q.id, title: q.title, organization: q.organization, confirmed: r.confirmed, flagged: r.flagged });
            if (q.requested_by !== req.userId) notices.push({ userId: q.requested_by, kind: 'request.approved', subject: `Allocated: ${q.title}`, text: `Your request "${q.title}" was allocated in ${round.name}: ${r.confirmed} date${r.confirmed === 1 ? '' : 's'} confirmed${r.flagged ? `, ${r.flagged} could not be booked because the space was taken` : ''}.` });
          } catch (e) { await c.query('rollback to savepoint a'); results.push({ id: q.id, title: q.title, organization: q.organization, skipped: e.message }); }
        }
        out = { status: 200, body: { preview, results, confirmedDates: results.reduce((a, r) => a + (r.confirmed || 0), 0), flaggedDates: results.reduce((a, r) => a + (r.flagged || 0), 0), skipped: results.filter((r) => r.skipped).length } };
        if (preview) throw new Undo();
      });
    } catch (e) { if (!(e instanceof Undo)) throw e; }
    res.status(out.status).json(out.body);
    if (!preview) notify(req.tenantId, notices);
  } catch (err) { if (bad(err)) return res.status(404).json({ error: 'Round not found' }); next(err); }
});
