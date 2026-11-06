import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { expandWeekly, isDate, isTime, localToUtc } from './time.js';
import { checkDates, summarize } from './rules.js';
import { notify, staffIds } from './notify.js';

export const requestsRouter = Router();
requestsRouter.use(requireUser, requireTenant);

const MAX_DATES = 200;
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const memberOf = (req, orgId) => req.roles.some((r) => ['org_admin', 'booker'].includes(r.role) && r.organizationId === orgId);
const orgAdminOf = (req, orgId) => req.roles.some((r) => r.role === 'org_admin' && r.organizationId === orgId);
const badUuid = (err) => err.code === '22P02';
const fail = (status, error) => ({ status, body: { error } });

const when = (d, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
const day = (d, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(d));
const loadTenant = async (c, id) => (await c.query('select id, name, timezone, latitude, longitude, daylight_rule, insurance_rule from tenant where id = $1', [id])).rows[0];

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

// Confirms every pending date of a request that is free, flags the rest, records the decision.
// Throws {http} errors for the caller to turn into responses.
export async function decideRequest(c, { tenantId, requestId, userId, decision, note, auto = false }) {
  const { rows } = await c.query('select id, status from request where id = $1 for update', [requestId]);
  if (!rows.length) throw Object.assign(new Error('Request not found'), { http: 404 });
  if (rows[0].status !== 'pending') throw Object.assign(new Error(`Request is already ${rows[0].status}`), { http: 409 });

  let confirmed = 0, flagged = 0;
  if (decision === 'approve') {
    const { rows: dates } = await c.query("select id from booking_date where request_id = $1 and status = 'pending' order by starts_at", [requestId]);
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
    await c.query("update booking_date set status = 'cancelled' where request_id = $1 and status in ('pending','flagged')", [requestId]);
  }
  const status = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'cancelled';
  await c.query('update request set status = $2 where id = $1', [requestId, status]);
  await c.query('insert into approval (tenant_id, request_id, decided_by, decision, note) values ($1,$2,$3,$4,$5)',
    [tenantId, requestId, userId, decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'returned', note || null]);
  await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,$3,'request',$4,$5)",
    [tenantId, userId, auto ? 'request.auto_approve' : `request.${decision}`, requestId, JSON.stringify({ confirmed, flagged })]);
  return { status, confirmed, flagged };
}

// Confirmed bookings for a stretch of days starting at a local date. Pending ones are added for staff, and for your own organizations.
requestsRouter.get('/bookings', async (req, res, next) => {
  try {
    const start = String(req.query.start || '');
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 62);
    if (!isDate(start)) return res.status(400).json({ error: 'start must be a date like 2027-03-01' });
    const mine = req.roles.map((r) => r.organizationId).filter(Boolean);
    const rows = await withTenant(req.tenantId, async (c) => {
      const t = await loadTenant(c, req.tenantId);
      const from = localToUtc(start, '00:00', t.timezone);
      const endDay = new Date(Date.parse(`${start}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
      const to = localToUtc(endDay, '00:00', t.timezone);
      return (await c.query(
        `select bd.id, bd.starts_at as "startsAt", bd.ends_at as "endsAt", bd.space_id as "spaceId", s.name as space, bd.status,
                o.id as "organizationId", o.name as organization, r.title, r.id as "requestId"
           from booking_date bd join request r on r.id = bd.request_id join space s on s.id = bd.space_id
           join organization o on o.id = r.organization_id
          where (bd.status = 'confirmed' or (bd.status = 'pending' and ($3 or r.organization_id = any($4::uuid[]))))
            and bd.starts_at < $2 and bd.ends_at > $1
          order by bd.starts_at, s.name`, [from, to, isStaff(req), mine])).rows;
    });
    res.json({ bookings: rows });
  } catch (err) { next(err); }
});

// Create a request. Rules can refuse it, or add a warning for staff. Trusted organizations are approved on the spot when nothing conflicts.
requestsRouter.post('/requests', async (req, res, next) => {
  try {
    const { organizationId, spaceId } = req.body || {};
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!organizationId || !spaceId || !title || title.length > 200) return res.status(400).json({ error: 'organizationId, spaceId and title are required' });
    if (!memberOf(req, organizationId) && !hasRole(req, 'tenant_admin')) return res.status(403).json({ error: 'You cannot request on behalf of this organization' });

    let tz;
    const result = await withTenant(req.tenantId, async (c) => {
      const t = await loadTenant(c, req.tenantId); tz = t.timezone;
      const parsed = datesFromBody(req.body, t.timezone);
      if (parsed.error) return fail(400, parsed.error);
      if (!parsed.dates.length) return fail(400, 'That pattern produces no dates');
      if (parsed.dates.length > MAX_DATES) return fail(400, `At most ${MAX_DATES} dates per request`);
      if (parsed.dates.some((d) => d.startsAt < new Date())) return fail(400, 'Dates must be in the future');

      const { rows: sp } = await c.query('select active from space where id = $1', [spaceId]);
      if (!sp.length || !sp[0].active) return fail(400, 'Space not found');
      const { rows: [org] } = await c.query('select auto_approve, name from organization where id = $1', [organizationId]);
      if (!org) return fail(400, 'Organization not found');

      const checks = await checkDates(c, { tenant: t, spaceId, organizationId, dates: parsed.dates });
      const blocked = summarize(checks, parsed.dates, t.timezone, 'blocks');
      if (blocked.length) return fail(400, blocked.join('. '));

      const { rows: pr } = await c.query('select level from user_priority where user_id = $1', [req.userId]);
      const { rows: [reqRow] } = await c.query(
        `insert into request (tenant_id, organization_id, requested_by, space_id, title, notes, priority_snapshot, recurrence_rule)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, status, priority_snapshot, submitted_at`,
        [req.tenantId, organizationId, req.userId, spaceId, title, req.body.notes || null, pr[0]?.level ?? 1, parsed.rule || null]);
      for (let i = 0; i < parsed.dates.length; i++) {
        const d = parsed.dates[i];
        await c.query('insert into booking_date (tenant_id, request_id, space_id, starts_at, ends_at, warning) values ($1,$2,$3,$4,$5,$6)',
          [req.tenantId, reqRow.id, spaceId, d.startsAt, d.endsAt, checks[i].warnings.join('; ') || null]);
      }

      let auto = false;
      if (org.auto_approve && checks.every((x) => !x.warnings.length)) {
        await c.query('savepoint auto');
        try {
          const d = await decideRequest(c, { tenantId: req.tenantId, requestId: reqRow.id, userId: req.userId, decision: 'approve', note: 'Approved automatically (trusted group)', auto: true });
          if (d.flagged) { await c.query('rollback to savepoint auto'); } else { auto = true; reqRow.status = 'approved'; }
        } catch (e) { await c.query('rollback to savepoint auto'); if (!e.http) throw e; }
      }
      return { status: 201, body: { ...reqRow, dateCount: parsed.dates.length, autoApproved: auto, warnings: checks.filter((x) => x.warnings.length).length }, first: parsed.dates[0], title, orgName: org.name };
    });
    res.status(result.status).json(result.body);
    if (result.status === 201) {
      if (result.body.autoApproved) {
        notify(req.tenantId, [{ userId: req.userId, kind: 'request.approved', subject: `Approved: ${title}`, text: `Your request "${title}" (${result.body.dateCount} date${result.body.dateCount === 1 ? '' : 's'}, starting ${when(result.first.startsAt, tz)}) was approved automatically.` }]);
      } else {
        const staff = (await staffIds(req.tenantId)).filter((u) => u !== req.userId);
        notify(req.tenantId, staff.map((u) => ({ userId: u, kind: 'request.new', subject: `New request: ${title}`,
          text: `${result.orgName} asked for time: "${title}", ${result.body.dateCount} date${result.body.dateCount === 1 ? '' : 's'}, starting ${when(result.first.startsAt, tz)}.${result.body.warnings ? ' Some dates need a closer look.' : ''}` })));
      }
    }
  } catch (err) {
    if (badUuid(err) || err.code === '23503') return res.status(400).json({ error: 'Invalid organization or space' });
    next(err);
  }
});

// The queue. Staff see every request: pending first, then highest priority, then earliest submitted.
requestsRouter.get('/requests', async (req, res, next) => {
  try {
    const mine = req.roles.map((r) => r.organizationId).filter(Boolean);
    const status = req.query.status;
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select r.id, r.title, r.notes, r.status, r.priority_snapshot, r.submitted_at, r.recurrence_rule, r.requested_by,
              r.organization_id, o.name as organization, r.space_id, s.name as space,
              n.note as "decisionNote",
              json_agg(json_build_object(
                'id', bd.id, 'startsAt', bd.starts_at, 'endsAt', bd.ends_at, 'status', bd.status, 'warning', bd.warning,
                'conflict', bd.status in ('pending','flagged') and exists (
                   select 1 from affected_spaces(bd.space_id) a join blocked_slot b on b.space_id = a.space_id
                    where b.during && tstzrange(bd.starts_at, bd.ends_at, '[)') and (b.is_claim or a.is_claim))
              ) order by bd.starts_at) as dates
         from request r join organization o on o.id = r.organization_id join space s on s.id = r.space_id
         join booking_date bd on bd.request_id = r.id
         left join lateral (select note from approval a where a.request_id = r.id order by decided_at desc limit 1) n on true
        where ($1::text is null or r.status = $1)
        group by r.id, o.name, s.name, n.note
        order by (r.status = 'pending') desc, r.priority_snapshot desc, r.submitted_at asc`, [status || null])).rows);
    const visible = isStaff(req) ? rows : rows.filter((r) => mine.includes(r.organization_id));
    res.json({ requests: visible.map((r) => ({ ...r, mine: r.requested_by === req.userId })) });
  } catch (err) { next(err); }
});

// Staff decision, with an optional note the requester will see.
requestsRouter.post('/requests/:id/decision', async (req, res, next) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ error: 'Only staff can decide requests' });
    const decision = req.body?.decision;
    if (!['approve', 'decline', 'return'].includes(decision)) return res.status(400).json({ error: 'decision must be approve, decline or return' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';

    let tz, info;
    const out = await withTenant(req.tenantId, async (c) => {
      tz = (await loadTenant(c, req.tenantId)).timezone;
      info = (await c.query('select r.title, r.requested_by, min(bd.starts_at) as first from request r join booking_date bd on bd.request_id = r.id where r.id = $1 group by r.id', [req.params.id])).rows[0];
      return decideRequest(c, { tenantId: req.tenantId, requestId: req.params.id, userId: req.userId, decision, note });
    });
    res.json(out);
    if (info && info.requested_by !== req.userId) {
      const verb = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'sent back';
      const extra = decision === 'approve' && out.flagged ? ` ${out.confirmed} date${out.confirmed === 1 ? ' is' : 's are'} confirmed and ${out.flagged} could not be booked because the space was already taken.` : '';
      notify(req.tenantId, [{ userId: info.requested_by, kind: `request.${decision}`, subject: `Request ${verb}: ${info.title}`,
        text: `Your request "${info.title}" was ${verb}.${extra}${note ? `\n\nNote from the approver: ${note}` : ''}` }]);
    }
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message });
    if (badUuid(err)) return res.status(404).json({ error: 'Request not found' });
    next(err);
  }
});

const getRequest = (c, id) => c.query('select id, status, organization_id, requested_by, title from request where id = $1 for update', [id]).then((r) => r.rows[0]);
const canManage = (req, r) => isStaff(req) || orgAdminOf(req, r.organization_id) || r.requested_by === req.userId;

// Withdraw a request. A pending one is simply withdrawn; for an approved one, every date that hasn't happened is released.
requestsRouter.post('/requests/:id/withdraw', async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const r = await getRequest(c, req.params.id);
      if (!r) return fail(404, 'Request not found');
      if (!canManage(req, r)) return fail(403, 'Not allowed');
      if (!['pending', 'approved'].includes(r.status)) return fail(409, `Request is already ${r.status}`);
      const { rows: dates } = await c.query("select id, status from booking_date where request_id = $1 and status <> 'cancelled' and ends_at > now()", [r.id]);
      for (const d of dates) {
        if (d.status === 'confirmed') await c.query('select cancel_booking_date($1)', [d.id]);
        else await c.query("update booking_date set status = 'cancelled' where id = $1", [d.id]);
      }
      await c.query("update request set status = 'cancelled' where id = $1", [r.id]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'request.withdraw','request',$3,$4)",
        [req.tenantId, req.userId, r.id, JSON.stringify({ released: dates.length })]);
      return { status: 200, body: { status: 'cancelled', released: dates.length }, r };
    });
    res.status(out.status).json(out.body);
    if (out.status === 200 && out.r.status === 'approved' && out.r.requested_by === req.userId) {
      const staff = (await staffIds(req.tenantId)).filter((u) => u !== req.userId);
      notify(req.tenantId, staff.map((u) => ({ userId: u, kind: 'request.withdrawn', subject: `Withdrawn: ${out.r.title}`, text: `"${out.r.title}" was withdrawn. ${out.body.released} date${out.body.released === 1 ? '' : 's'} released.` })));
    }
  } catch (err) { if (badUuid(err)) return res.status(404).json({ error: 'Request not found' }); next(err); }
});

// Fix the title or notes of a request.
requestsRouter.patch('/requests/:id', async (req, res, next) => {
  try {
    const title = req.body?.title === undefined ? null : String(req.body.title).trim();
    if (title !== null && (!title || title.length > 200)) return res.status(400).json({ error: 'invalid title' });
    const out = await withTenant(req.tenantId, async (c) => {
      const r = await getRequest(c, req.params.id);
      if (!r) return fail(404, 'Request not found');
      if (!canManage(req, r)) return fail(403, 'Not allowed');
      const row = (await c.query('update request set title = coalesce($2, title), notes = coalesce($3, notes) where id = $1 returning id, title, notes',
        [r.id, title, req.body?.notes === undefined ? null : String(req.body.notes).slice(0, 1000)])).rows[0];
      return { status: 200, body: row };
    });
    res.status(out.status).json(out.body);
  } catch (err) { if (badUuid(err)) return res.status(404).json({ error: 'Request not found' }); next(err); }
});

const dateOwner = (c, id) => c.query(
  `select bd.id, bd.status, bd.space_id, bd.starts_at, bd.ends_at, r.organization_id, r.requested_by, r.title, r.id as request_id
     from booking_date bd join request r on r.id = bd.request_id where bd.id = $1 for update of bd`, [id]).then((x) => x.rows[0]);

// Skip (cancel) one date. Staff, an admin of the owning organization, or the requester.
requestsRouter.post('/booking-dates/:id/cancel', async (req, res, next) => {
  try {
    let tz;
    const out = await withTenant(req.tenantId, async (c) => {
      tz = (await loadTenant(c, req.tenantId)).timezone;
      const d = await dateOwner(c, req.params.id);
      if (!d) return fail(404, 'Date not found');
      if (!canManage(req, d)) return fail(403, 'Not allowed');
      if (d.status === 'cancelled') return { status: 200, body: { status: 'cancelled' }, d };
      await c.query('select cancel_booking_date($1)', [req.params.id]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id) values ($1,$2,'booking_date.cancel','booking_date',$3)", [req.tenantId, req.userId, req.params.id]);
      return { status: 200, body: { status: 'cancelled' }, d, fresh: true };
    });
    res.status(out.status).json(out.body);
    if (out.fresh && out.d.requested_by !== req.userId) {
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
      notify(req.tenantId, [{ userId: out.d.requested_by, kind: 'date.cancelled', subject: `Date cancelled: ${out.d.title}`,
        text: `${day(out.d.starts_at, tz)} was cancelled for "${out.d.title}".${note ? `\n\nReason: ${note}` : ''}` }]);
    }
  } catch (err) { if (badUuid(err)) return res.status(404).json({ error: 'Date not found' }); next(err); }
});

// Move one date to another day or time. Staff moves take effect at once; anyone else's goes back for review.
requestsRouter.post('/booking-dates/:id/move', async (req, res, next) => {
  try {
    const { date, startTime, endTime } = req.body || {};
    if (!isDate(date) || !isTime(startTime) || !isTime(endTime) || endTime <= startTime) return res.status(400).json({ error: 'date, startTime and endTime are required' });
    let tz;
    const out = await withTenant(req.tenantId, async (c) => {
      const t = await loadTenant(c, req.tenantId); tz = t.timezone;
      const d = await dateOwner(c, req.params.id);
      if (!d) return fail(404, 'Date not found');
      const staff = isStaff(req);
      if (!(staff || orgAdminOf(req, d.organization_id) || (d.requested_by === req.userId && d.status !== 'confirmed'))) return fail(403, 'Not allowed');
      if (d.status === 'cancelled') return fail(409, 'That date was cancelled');
      const startsAt = localToUtc(date, startTime, tz), endsAt = localToUtc(date, endTime, tz);
      if (startsAt < new Date() && !staff) return fail(400, 'Dates must be in the future');

      const [chk] = await checkDates(c, { tenant: t, spaceId: d.space_id, organizationId: d.organization_id, dates: [{ startsAt, endsAt }] });
      if (chk.blocks.length && !staff) return fail(400, chk.blocks.join('. '));
      const warning = [...chk.warnings, ...(staff ? chk.blocks : [])].join('; ') || null;

      await c.query('delete from blocked_slot where booking_date_id = $1', [d.id]);
      await c.query("update booking_date set starts_at = $2, ends_at = $3, status = 'pending', warning = $4 where id = $1", [d.id, startsAt, endsAt, warning]);
      let status = 'pending';
      if (staff && d.status === 'confirmed') {
        await c.query('savepoint mv');
        try { await c.query('select approve_booking_date($1)', [d.id]); status = 'confirmed'; await c.query('release savepoint mv'); }
        catch (e) { if (e.code !== '23P01') throw e; await c.query('rollback to savepoint mv'); throw Object.assign(new Error('That time is already taken'), { http: 409 }); }
      }
      if (status === 'pending') await c.query("update request set status = 'pending' where id = $1 and status = 'approved'", [d.request_id]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'booking_date.move','booking_date',$3,$4)",
        [req.tenantId, req.userId, d.id, JSON.stringify({ from: d.starts_at, to: startsAt })]);
      return { status: 200, body: { status, startsAt, endsAt, warning }, d };
    });
    res.status(out.status).json(out.body);
    if (out.status === 200) {
      if (out.d.requested_by !== req.userId && out.body.status === 'confirmed') {
        notify(req.tenantId, [{ userId: out.d.requested_by, kind: 'date.moved', subject: `Date moved: ${out.d.title}`, text: `"${out.d.title}" moved from ${when(out.d.starts_at, tz)} to ${when(out.body.startsAt, tz)}.` }]);
      } else if (out.body.status === 'pending') {
        const staff = (await staffIds(req.tenantId)).filter((u) => u !== req.userId);
        notify(req.tenantId, staff.map((u) => ({ userId: u, kind: 'date.move_requested', subject: `Change to review: ${out.d.title}`, text: `A date for "${out.d.title}" was moved to ${when(out.body.startsAt, tz)} and needs approval.` })));
      }
    }
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message });
    if (badUuid(err)) return res.status(404).json({ error: 'Date not found' });
    next(err);
  }
});
