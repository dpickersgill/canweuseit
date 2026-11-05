import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { expandWeekly, isDate, isTime, localToUtc } from './time.js';

export const requestsRouter = Router();
requestsRouter.use(requireUser, requireTenant);

const MAX_DATES = 200;
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const memberOf = (req, orgId) => req.roles.some((r) => ['org_admin', 'booker'].includes(r.role) && r.organizationId === orgId);
const orgAdminOf = (req, orgId) => req.roles.some((r) => r.role === 'org_admin' && r.organizationId === orgId);
const badUuid = (err) => err.code === '22P02';

// Turn the body into a list of {startsAt, endsAt}. Either explicit dates or a weekly pattern.
function datesFromBody(body, tz) {
  if (Array.isArray(body.dates)) {
    const out = body.dates.map((d) => ({ startsAt: new Date(d?.startsAt), endsAt: new Date(d?.endsAt) }));
    if (out.some((d) => Number.isNaN(+d.startsAt) || Number.isNaN(+d.endsAt) || d.endsAt <= d.startsAt)) return { error: 'Each date needs a valid startsAt before endsAt' };
    return { dates: out };
  }
  const r = body.weekly;
  if (r && isDate(r.startsOn) && isDate(r.until) && r.until >= r.startsOn && isTime(r.startTime) && isTime(r.endTime) && r.endTime > r.startTime
      && Array.isArray(r.weekdays) && r.weekdays.length && r.weekdays.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) {
    return { dates: expandWeekly(r, tz), rule: JSON.stringify(r) };
  }
  return { error: 'Provide dates [{startsAt, endsAt}] or weekly {startsOn, until, weekdays[0-6], startTime, endTime}' };
}

// Create a request with all its dates. Nothing is blocked until staff approve.
requestsRouter.post('/requests', async (req, res, next) => {
  try {
    const { organizationId, spaceId } = req.body || {};
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!organizationId || !spaceId || !title || title.length > 200) return res.status(400).json({ error: 'organizationId, spaceId and title are required' });
    if (!memberOf(req, organizationId) && !hasRole(req, 'tenant_admin')) return res.status(403).json({ error: 'You cannot request on behalf of this organization' });

    const result = await withTenant(req.tenantId, async (c) => {
      const { rows: [t] } = await c.query('select timezone from tenant where id = $1', [req.tenantId]);
      const parsed = datesFromBody(req.body, t.timezone);
      if (parsed.error) return { status: 400, body: { error: parsed.error } };
      if (!parsed.dates.length) return { status: 400, body: { error: 'That pattern produces no dates' } };
      if (parsed.dates.length > MAX_DATES) return { status: 400, body: { error: `At most ${MAX_DATES} dates per request` } };
      if (parsed.dates.some((d) => d.startsAt < new Date())) return { status: 400, body: { error: 'Dates must be in the future' } };

      const { rows: sp } = await c.query('select active from space where id = $1', [spaceId]);
      if (!sp.length || !sp[0].active) return { status: 400, body: { error: 'Space not found' } };
      const { rows: org } = await c.query('select 1 from organization where id = $1', [organizationId]);
      if (!org.length) return { status: 400, body: { error: 'Organization not found' } };

      const { rows: pr } = await c.query('select level from user_priority where user_id = $1', [req.userId]);
      const { rows: [reqRow] } = await c.query(
        `insert into request (tenant_id, organization_id, requested_by, space_id, title, notes, priority_snapshot, recurrence_rule)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, status, priority_snapshot, submitted_at`,
        [req.tenantId, organizationId, req.userId, spaceId, title, req.body.notes || null, pr[0]?.level ?? 1, parsed.rule || null]);
      for (const d of parsed.dates) {
        await c.query('insert into booking_date (tenant_id, request_id, space_id, starts_at, ends_at) values ($1,$2,$3,$4,$5)',
          [req.tenantId, reqRow.id, spaceId, d.startsAt, d.endsAt]);
      }
      return { status: 201, body: { ...reqRow, dateCount: parsed.dates.length } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    if (badUuid(err) || err.code === '23503') return res.status(400).json({ error: 'Invalid organization or space' });
    next(err);
  }
});

// The queue. Staff see every request: pending first, then highest priority, then earliest submitted.
// Everyone else sees requests for their own organizations.
requestsRouter.get('/requests', async (req, res, next) => {
  try {
    const mine = req.roles.map((r) => r.organizationId).filter(Boolean);
    const status = req.query.status;
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select r.id, r.title, r.notes, r.status, r.priority_snapshot, r.submitted_at, r.organization_id, o.name as organization, r.space_id, s.name as space,
              json_agg(json_build_object(
                'id', bd.id, 'startsAt', bd.starts_at, 'endsAt', bd.ends_at, 'status', bd.status,
                'conflict', bd.status in ('pending','flagged') and exists (
                   select 1 from affected_spaces(bd.space_id) a join blocked_slot b on b.space_id = a.space_id
                    where b.during && tstzrange(bd.starts_at, bd.ends_at, '[)') and (b.is_claim or a.is_claim))
              ) order by bd.starts_at) as dates
         from request r join organization o on o.id = r.organization_id join space s on s.id = r.space_id
         join booking_date bd on bd.request_id = r.id
        where ($1::text is null or r.status = $1)
        group by r.id, o.name, s.name
        order by (r.status = 'pending') desc, r.priority_snapshot desc, r.submitted_at asc`, [status || null])).rows);
    res.json({ requests: isStaff(req) ? rows : rows.filter((r) => mine.includes(r.organization_id)) });
  } catch (err) { next(err); }
});

// Staff decision. approve: each pending date is confirmed if the space is free, otherwise flagged.
requestsRouter.post('/requests/:id/decision', async (req, res, next) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ error: 'Only staff can decide requests' });
    const decision = req.body?.decision;
    if (!['approve', 'decline', 'return'].includes(decision)) return res.status(400).json({ error: 'decision must be approve, decline or return' });

    const result = await withTenant(req.tenantId, async (c) => {
      const { rows } = await c.query('select id, status from request where id = $1 for update', [req.params.id]);
      if (!rows.length) return { status: 404, body: { error: 'Request not found' } };
      if (rows[0].status !== 'pending') return { status: 409, body: { error: `Request is already ${rows[0].status}` } };

      let confirmed = 0, flagged = 0;
      if (decision === 'approve') {
        const { rows: dates } = await c.query("select id from booking_date where request_id = $1 and status = 'pending' order by starts_at", [req.params.id]);
        for (const d of dates) {
          await c.query('savepoint d');
          try { await c.query('select approve_booking_date($1)', [d.id]); confirmed++; await c.query('release savepoint d'); }
          catch (e) {
            if (e.code !== '23P01') throw e;
            await c.query('rollback to savepoint d');
            await c.query("update booking_date set status = 'flagged' where id = $1", [d.id]); flagged++;
          }
        }
      } else {
        await c.query("update booking_date set status = 'cancelled' where request_id = $1 and status in ('pending','flagged')", [req.params.id]);
      }
      const newStatus = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'cancelled';
      await c.query('update request set status = $2 where id = $1', [req.params.id, newStatus]);
      await c.query('insert into approval (tenant_id, request_id, decided_by, decision, note) values ($1,$2,$3,$4,$5)',
        [req.tenantId, req.params.id, req.userId, decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'returned', req.body.note || null]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,$3,'request',$4,$5)",
        [req.tenantId, req.userId, `request.${decision}`, req.params.id, JSON.stringify({ confirmed, flagged })]);
      return { status: 200, body: { status: newStatus, confirmed, flagged } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    if (badUuid(err)) return res.status(404).json({ error: 'Request not found' });
    next(err);
  }
});

// Cancel one date (staff, or an admin of the owning organization). Frees the space immediately.
requestsRouter.post('/booking-dates/:id/cancel', async (req, res, next) => {
  try {
    const result = await withTenant(req.tenantId, async (c) => {
      const { rows } = await c.query(
        'select bd.id, bd.status, r.organization_id from booking_date bd join request r on r.id = bd.request_id where bd.id = $1', [req.params.id]);
      if (!rows.length) return { status: 404, body: { error: 'Date not found' } };
      if (!isStaff(req) && !orgAdminOf(req, rows[0].organization_id)) return { status: 403, body: { error: 'Not allowed' } };
      if (rows[0].status === 'cancelled') return { status: 200, body: { status: 'cancelled' } };
      await c.query('select cancel_booking_date($1)', [req.params.id]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id) values ($1,$2,'booking_date.cancel','booking_date',$3)",
        [req.tenantId, req.userId, req.params.id]);
      return { status: 200, body: { status: 'cancelled' } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    if (badUuid(err)) return res.status(404).json({ error: 'Date not found' });
    next(err);
  }
});
