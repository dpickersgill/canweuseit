import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isDate, isTime, localToUtc } from './time.js';
import { notify } from './notify.js';

export const closuresRouter = Router();
closuresRouter.use(requireUser, requireTenant);
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const requireStaff = (req, res, next) => (isStaff(req) ? next() : res.status(403).json({ error: 'Only staff can manage closures' }));
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

// Body: { reason, startDate, endDate?, startTime?, endTime?, spaceId | facilityId | all:true, preview? }
closuresRouter.post('/closures', requireStaff, async (req, res, next) => {
  try {
    const b = req.body || {};
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : '';
    const endDate = b.endDate || b.startDate;
    const startTime = b.startTime || '00:00', endTime = b.endTime || '23:59';
    if (!reason || !isDate(b.startDate) || !isDate(endDate) || endDate < b.startDate || !isTime(startTime) || !isTime(endTime)) {
      return res.status(400).json({ error: 'reason, startDate and a valid time range are required' });
    }
    if (!b.spaceId && !b.facilityId && !b.all) return res.status(400).json({ error: 'Choose a space, a facility, or everything' });

    let tz, cancelled = [];
    const out = await withTenant(req.tenantId, async (c) => {
      tz = (await c.query('select timezone from tenant where id = $1', [req.tenantId])).rows[0].timezone;
      const from = localToUtc(b.startDate, startTime, tz), to = localToUtc(endDate, endTime, tz);
      if (to <= from) return { status: 400, body: { error: 'The closure must end after it starts' } };

      const { rows: roots } = b.spaceId
        ? await c.query('select id from space where id = $1', [b.spaceId])
        : b.facilityId
          ? await c.query('select id from space where facility_id = $1 and parent_id is null', [b.facilityId])
          : await c.query('select id from space where parent_id is null');
      if (!roots.length) return { status: 404, body: { error: 'Nothing to close' } };

      // bookings that would collide with the closure
      const { rows: hit } = await c.query(
        `select distinct bd.id, bd.starts_at, r.requested_by, r.title, r.id as request_id
           from unnest($1::uuid[]) root, lateral affected_spaces(root) a
           join blocked_slot bs on bs.space_id = a.space_id and bs.booking_date_id is not null
           join booking_date bd on bd.id = bs.booking_date_id join request r on r.id = bd.request_id
          where bs.during && tstzrange($2, $3, '[)') and (bs.is_claim or a.is_claim)`, [roots.map((r) => r.id), from, to]);

      if (b.preview) return { status: 200, body: { preview: true, bookings: hit.length, requests: new Set(hit.map((h) => h.request_id)).size } };

      for (const h of hit) await c.query('select cancel_booking_date($1)', [h.id]);
      const ids = [];
      for (const r of roots) {
        await c.query('savepoint cl');
        try { ids.push((await c.query('select create_blackout($1,$2,$3,$4) as id', [r.id, from, to, reason])).rows[0].id); await c.query('release savepoint cl'); }
        catch (e) { if (e.code !== '23P01') throw e; await c.query('rollback to savepoint cl'); throw Object.assign(new Error('This overlaps an existing closure'), { http: 409 }); }
      }
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, detail) values ($1,$2,'closure.create','blackout',$3)",
        [req.tenantId, req.userId, JSON.stringify({ reason, from, to, cancelled: hit.length })]);
      cancelled = hit;
      return { status: 201, body: { closures: ids.length, cancelledBookings: hit.length } };
    });
    res.status(out.status).json(out.body);

    if (out.status === 201 && cancelled.length) {
      const fmt = (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
      const byUser = new Map();
      for (const h of cancelled) { if (!byUser.has(h.requested_by)) byUser.set(h.requested_by, []); byUser.get(h.requested_by).push(h); }
      notify(req.tenantId, [...byUser].map(([userId, list]) => ({ userId, kind: 'closure', subject: `Cancelled: ${reason}`,
        text: `Closure: ${reason}.\n\nThese bookings were cancelled:\n${list.map((h) => `- ${h.title}, ${fmt(h.starts_at)}`).join('\n')}` })));
    }
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message });
    if (badUuid(err)) return res.status(400).json({ error: 'Invalid space or facility' });
    next(err);
  }
});

// Lift a closure. Bookings it cancelled stay cancelled; people can ask again.
closuresRouter.delete('/closures/:id', requireStaff, async (req, res, next) => {
  try {
    const n = await withTenant(req.tenantId, async (c) => (await c.query('delete from blackout where id = $1', [req.params.id])).rowCount);
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Closure not found' });
  } catch (err) { if (badUuid(err)) return res.status(404).json({ error: 'Closure not found' }); next(err); }
});
