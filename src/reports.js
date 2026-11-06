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

// Groups that hit the no-show limit in the last year. Allocation rounds place them last.
export async function atRiskOrgs(c, tenantId) {
  const t = (await c.query('select no_show_limit from tenant where id = $1', [tenantId])).rows[0];
  if (!t?.no_show_limit) return new Set();
  const { rows } = await c.query(
    `select r.organization_id from booking_date bd join request r on r.id = bd.request_id
      where bd.no_show and bd.starts_at > now() - interval '365 days' group by r.organization_id having count(*) >= $1`, [t.no_show_limit]);
  return new Set(rows.map((r) => r.organization_id));
}

const DEFAULT_OPEN = ['07:00', '22:00']; // used when a field has no opening hours set
const dayList = (from, to) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
const hm = (v) => String(v).slice(0, 5);

// How much of each field's open time was used, and how well each group used what it was given.
reportsRouter.get('/reports/utilization', async (req, res, next) => {
  try {
    if (!hasRole(req, 'tenant_admin', 'approver')) return res.status(403).json({ error: 'Only staff can see reports' });
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to) || to < from) return res.status(400).json({ error: 'from and to must be dates, with to on or after from' });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 400) return res.status(400).json({ error: 'Choose a range of 400 days or less' });
    const out = await withTenant(req.tenantId, async (c) => {
      const t = (await c.query('select timezone, min_use_pct, no_show_limit from tenant where id = $1', [req.tenantId])).rows[0];
      const tz = t.timezone;
      const f = localToUtc(from, '00:00', tz);
      const end = localToUtc(new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), '00:00', tz);
      const days = dayList(from, to);
      const fields = (await c.query('select id, name from space where parent_id is null and active order by name')).rows;
      const hours = (await c.query('select space_id, weekdays, opens, closes, starts_on::text, ends_on::text from space_hours')).rows;
      const bySpace = [];
      let assumed = false;
      for (const fl of fields) {
        let open = 0;
        for (const d of days) {
          const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
          const rules = hours.filter((h) => (!h.space_id || h.space_id === fl.id) && h.weekdays.includes(dow) && (!h.starts_on || h.starts_on <= d) && (!h.ends_on || h.ends_on >= d));
          let o = DEFAULT_OPEN[0], cl = DEFAULT_OPEN[1];
          if (rules.length) { o = rules.map((r) => hm(r.opens)).sort()[0]; cl = rules.map((r) => hm(r.closes)).sort().at(-1); } else assumed = true;
          open += Math.max(0, (localToUtc(d, cl, tz) - localToUtc(d, o, tz)) / 3600000);
        }
        // time the field or any part of it is in use: merge overlapping bookings so two halves at once count once
        const iv = (await c.query(
          `select greatest(bd.starts_at, $2) as a, least(bd.ends_at, $3) as b from booking_date bd
            where bd.status = 'confirmed' and bd.space_id in (select space_descendants($1)) and bd.starts_at < $3 and bd.ends_at > $2 order by 1`, [fl.id, f, end])).rows;
        let used = 0, cur = null;
        for (const { a, b } of iv) { if (!cur || a > cur.b) { if (cur) used += cur.b - cur.a; cur = { a, b }; } else if (b > cur.b) cur.b = b; }
        if (cur) used += cur.b - cur.a;
        const usedH = used / 3600000;
        bySpace.push({ id: fl.id, name: fl.name, openHours: Math.round(open), usedHours: Math.round(usedH * 10) / 10, percent: open ? Math.round((usedH / open) * 100) : 0 });
      }
      const risk = await atRiskOrgs(c, req.tenantId);
      const byOrg = (await c.query(
        `select o.id, o.name,
                round(coalesce(sum(extract(epoch from (bd.ends_at - bd.starts_at)) / 3600) filter (where bd.status = 'confirmed'), 0)::numeric, 1)::float as "givenHours",
                round(coalesce(sum(extract(epoch from (bd.ends_at - bd.starts_at)) / 3600) filter (where bd.status = 'confirmed' and bd.no_show), 0)::numeric, 1)::float as "noShowHours",
                round((coalesce(sum(bd.released_minutes), 0) / 60.0)::numeric, 1)::float as "releasedHours",
                count(*) filter (where bd.no_show)::int as "noShows",
                count(*) filter (where bd.late_cancel)::int as "lateCancels"
           from organization o join request r on r.organization_id = o.id join booking_date bd on bd.request_id = r.id
          where bd.starts_at < $2 and bd.ends_at > $1 group by o.id order by o.name`, [f, end])).rows.map((r) => {
        const base = r.givenHours + r.releasedHours;
        const usePct = base ? Math.round(((r.givenHours - r.noShowHours) / base) * 100) : null;
        const flags = [];
        if (t.no_show_limit && r.noShows >= t.no_show_limit) flags.push(`${r.noShows} no-shows`);
        if (t.min_use_pct && usePct !== null && usePct < t.min_use_pct) flags.push(`used ${usePct}% (minimum ${t.min_use_pct}%)`);
        if (risk.has(r.id)) flags.push('placed last in the next allocation');
        return { ...r, usePct, flags };
      });
      return { from, to, assumedHours: assumed ? DEFAULT_OPEN : null, minUsePct: t.min_use_pct, noShowLimit: t.no_show_limit, bySpace, byOrg };
    });
    res.json(out);
  } catch (err) { next(err); }
});
