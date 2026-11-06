import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isDate, localToUtc } from './time.js';

export const reportsRouter = Router();
reportsRouter.use(requireUser, requireTenant);

// Hours booked per space and per organization over a date range (inclusive, local dates).
reportsRouter.get('/reports/usage', async (req, res, next) => {
  try {
    if (!hasRole(req, 'tenant_admin', 'approver')) return res.status(403).json({ error: 'Only staff can see reports' });
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to) || to < from) return res.status(400).json({ error: 'from and to must be dates, with to on or after from' });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 400) return res.status(400).json({ error: 'Choose a range of 400 days or less' });
    const out = await withTenant(req.tenantId, async (c) => {
      const tz = (await c.query('select timezone from tenant where id = $1', [req.tenantId])).rows[0].timezone;
      const f = localToUtc(from, '00:00', tz);
      const t = localToUtc(new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), '00:00', tz);
      const hrs = 'sum(extract(epoch from (least(bd.ends_at, $2) - greatest(bd.starts_at, $1))) / 3600)';
      const base = `from booking_date bd join request r on r.id = bd.request_id where bd.status = 'confirmed' and bd.starts_at < $2 and bd.ends_at > $1`;
      const bySpace = (await c.query(`select s.id, s.name, count(*)::int as bookings, round((${hrs})::numeric, 1)::float as hours
        ${base.replace('where', 'join space s on s.id = bd.space_id where')} group by s.id order by hours desc`, [f, t])).rows;
      const byOrg = (await c.query(`select o.id, o.name, count(*)::int as bookings, round((${hrs})::numeric, 1)::float as hours
        ${base.replace('where', 'join organization o on o.id = r.organization_id where')} group by o.id order by hours desc`, [f, t])).rows;
      const counts = (await c.query(
        `select count(*) filter (where bd.status = 'cancelled')::int as cancelled, count(*) filter (where bd.status = 'flagged')::int as conflicts,
                count(*) filter (where bd.status = 'pending')::int as pending
           from booking_date bd where bd.starts_at < $2 and bd.ends_at > $1`, [f, t])).rows[0];
      return { from, to, bySpace, byOrg, totalHours: Math.round(bySpace.reduce((a, r) => a + r.hours, 0) * 10) / 10, ...counts };
    });
    res.json(out);
  } catch (err) { next(err); }
});
