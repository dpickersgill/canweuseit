import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole, closeScope } from './tenant.js';
import { freeUp } from './availability.js';
import { isDate, isTime, localToUtc } from './time.js';
import { notify } from './notify.js';

export const closuresRouter = Router();
closuresRouter.use(requireUser, requireTenant);
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const requireCloser = (req, res, next) => (closeScope(req) !== undefined ? next() : res.status(403).json({ error: 'Only staff and groundskeepers can manage closures' }));
const badUuid = (err) => err.code === '22P02';

// Closures (rainouts, aeration, tournaments). A closure blocks the space like a booking, and cancels the bookings it overlaps.
closuresRouter.get('/closures', async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select b.id, b.starts_at as "startsAt", b.ends_at as "endsAt", b.reason, s.id as "spaceId", s.name as space
         from blackout b join space s on s.id = b.space_id where b.ends_at > now() - interval '1 day' order by b.starts_at`)).rows);
    res.json({ closures: rows });
  } catch (err) { next(err); }
});

// Body: { reason, startDate, endDate?, startTime?, endTime?, weekdays?, spaceId | facilityId | all:true, preview? }
// With weekdays [0-6] and an endDate it repeats: every Tuesday 8 to 10 until the end date (up to 60 days).
// Staff can close anything in their sites; a groundskeeper can close fields in theirs.
closuresRouter.post('/closures', requireCloser, async (req, res, next) => {
  try {
    const b = req.body || {};
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : '';
    const endDate = b.endDate || b.startDate;
    const startTime = b.startTime || '00:00', endTime = b.endTime || '23:59';
    const weekdays = b.weekdays == null ? null : b.weekdays;
    if (!reason || !isDate(b.startDate) || !isDate(endDate) || endDate < b.startDate || !isTime(startTime) || !isTime(endTime)) {
      return res.status(400).json({ error: 'reason, startDate and a valid time range are required' });
    }
    if (weekdays && (!Array.isArray(weekdays) || !weekdays.length || !weekdays.every((n) => Number.isInteger(n) && n >= 0 && n <= 6) || endTime <= startTime)) return res.status(400).json({ error: 'weekdays must be numbers 0 to 6, and the end time after the start' });
    if (!b.spaceId && !b.facilityId && !b.all) return res.status(400).json({ error: 'Choose a space, a facility, or everything' });
    const scope = closeScope(req);

    let tz, cancelled = [];
    const wl = [];
    const out = await withTenant(req.tenantId, async (c) => {
      tz = (await c.query('select timezone from tenant where id = $1', [req.tenantId])).rows[0].timezone;
      const ranges = [];
      if (weekdays) {
        for (let t = Date.parse(`${b.startDate}T00:00:00Z`); t <= Date.parse(`${endDate}T00:00:00Z`) && ranges.length <= 60; t += 86400000) {
          if (!weekdays.includes(new Date(t).getUTCDay())) continue;
          const ds = new Date(t).toISOString().slice(0, 10);
          ranges.push([localToUtc(ds, startTime, tz), localToUtc(ds, endTime, tz)]);
        }
        if (!ranges.length) return { status: 400, body: { error: 'That pattern produces no days' } };
        if (ranges.length > 60) return { status: 400, body: { error: 'At most 60 days at a time' } };
      } else {
        const from = localToUtc(b.startDate, startTime, tz), to = localToUtc(endDate, endTime, tz);
        if (to <= from) return { status: 400, body: { error: 'The closure must end after it starts' } };
        ranges.push([from, to]);
      }

      const { rows: roots } = b.spaceId
        ? await c.query('select id, facility_id from space where id = $1', [b.spaceId])
        : b.facilityId
          ? await c.query('select id, facility_id from space where facility_id = $1 and parent_id is null', [b.facilityId])
          : await c.query('select id, facility_id from space where parent_id is null');
      if (!roots.length) return { status: 404, body: { error: 'Nothing to close' } };
      const allowed = scope ? roots.filter((r) => scope.includes(r.facility_id)) : roots;
      if (!allowed.length || allowed.length < roots.length) return { status: 403, body: { error: 'That is outside the sites you cover' } };

      // bookings that would collide with the closure
      const hit = new Map();
      for (const [from, to] of ranges) {
        const { rows } = await c.query(
          `select distinct bd.id, bd.space_id, bd.starts_at, bd.ends_at, r.requested_by, r.title, r.id as request_id
             from unnest($1::uuid[]) root, lateral affected_spaces(root) a
             join blocked_slot bs on bs.space_id = a.space_id and bs.booking_date_id is not null
             join booking_date bd on bd.id = bs.booking_date_id join request r on r.id = bd.request_id
            where bs.during && tstzrange($2, $3, '[)') and (bs.is_claim or a.is_claim)`, [roots.map((r) => r.id), from, to]);
        for (const r of rows) hit.set(r.id, r);
      }
      const hits = [...hit.values()];
      if (b.preview) return { status: 200, body: { preview: true, bookings: hits.length, requests: new Set(hits.map((h) => h.request_id)).size, days: ranges.length } };

      for (const h of hits) await c.query('select cancel_booking_date($1)', [h.id]);
      let made = 0;
      for (const [from, to] of ranges) for (const r of roots) {
        await c.query('savepoint cl');
        try { await c.query('select create_blackout($1,$2,$3,$4) as id', [r.id, from, to, reason]); made++; await c.query('release savepoint cl'); }
        catch (e) { if (e.code !== '23P01') throw e; await c.query('rollback to savepoint cl'); throw Object.assign(new Error('This overlaps an existing closure'), { http: 409 }); }
      }
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, detail) values ($1,$2,'closure.create','blackout',$3)",
        [req.tenantId, req.userId, JSON.stringify({ reason, ranges: ranges.length, cancelled: hits.length })]);
      cancelled = hits;
      return { status: 201, body: { closures: made, cancelledBookings: hits.length } };
    });
    res.status(out.status).json(out.body);

    if (out.status === 201 && cancelled.length) {
      const fmt = (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
      const byUser = new Map();
      for (const h of cancelled) { if (!byUser.has(h.requested_by)) byUser.set(h.requested_by, []); byUser.get(h.requested_by).push(h); }
      notify(req.tenantId, [...byUser].map(([userId, list]) => ({ userId, kind: 'closure', subject: `Cancelled: ${reason}`,
        text: `Closure: ${reason}.\n\nThese bookings were cancelled:\n${list.map((h) => `- ${h.title}, ${fmt(h.starts_at)}`).join('\n')}`,
        sms: `${reason}. Cancelled: ${list.slice(0, 2).map((h) => `${h.title} ${fmt(h.starts_at)}`).join('; ')}${list.length > 2 ? ` and ${list.length - 2} more` : ''}.` })));
    }
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message });
    if (badUuid(err)) return res.status(400).json({ error: 'Invalid space or facility' });
    next(err);
  }
});

// Lift a closure. Bookings it cancelled stay cancelled; people can ask again, and anyone waiting is told.
closuresRouter.delete('/closures/:id', requireCloser, async (req, res, next) => {
  try {
    const scope = closeScope(req); const wl = [];
    const n = await withTenant(req.tenantId, async (c) => {
      const b = (await c.query('select b.space_id, b.starts_at, b.ends_at, s.facility_id from blackout b join space s on s.id = b.space_id where b.id = $1', [req.params.id])).rows[0];
      if (!b) return 0;
      if (scope && !scope.includes(b.facility_id)) return -1;
      await c.query('delete from blackout where id = $1', [req.params.id]);
      wl.push(...await freeUp(c, req.tenantId, b.space_id, b.starts_at, b.ends_at));
      return 1;
    });
    if (n === -1) return res.status(403).json({ error: 'That is outside the sites you cover' });
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Closure not found' });
    notify(req.tenantId, wl);
  } catch (err) { if (badUuid(err)) return res.status(404).json({ error: 'Closure not found' }); next(err); }
});
