import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole, staffScope } from './tenant.js';
import { expandWeekly, isDate, isTime, localToUtc } from './time.js';
import { checkDates, summarize } from './rules.js';
import { notify, staffIds } from './notify.js';
import { ensureDeposit } from './invoicelib.js';
import { ensurePermit } from './permitlib.js';
import { freeUp } from './availability.js';

export const requestsRouter = Router();
requestsRouter.use(requireUser, requireTenant);

const MAX_DATES = 500;
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const memberOf = (req, orgId) => req.roles.some((r) => ['org_admin', 'booker'].includes(r.role) && r.organizationId === orgId);
const orgAdminOf = (req, orgId) => req.roles.some((r) => r.role === 'org_admin' && r.organizationId === orgId);
const badUuid = (err) => err.code === '22P02';
const fail = (status, error) => ({ status, body: { error } });

const when = (d, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
const day = (d, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(d));
const loadTenant = async (c, id) => (await c.query('select id, name, timezone, latitude, longitude, daylight_rule, insurance_rule, min_coverage, require_additional_insured, cancel_notice_hours, hold_unpaid from tenant where id = $1', [id])).rows[0];

function datesFromBody(body, tz) {
  if (Array.isArray(body.dates)) {
    const out = body.dates.map((d) => (d?.date
      ? (isDate(d.date) && isTime(d.startTime) && isTime(d.endTime) && d.endTime > d.startTime
        ? { startsAt: localToUtc(d.date, d.startTime, tz), endsAt: localToUtc(d.date, d.endTime, tz), label: d.label }
        : { startsAt: new Date(NaN), endsAt: new Date(NaN) })
      : { startsAt: new Date(d?.startsAt), endsAt: new Date(d?.endsAt), label: d?.label }));
    if (!out.length) return { error: 'Provide at least one date' };
    if (out.some((d) => Number.isNaN(+d.startsAt) || Number.isNaN(+d.endsAt) || d.endsAt <= d.startsAt)) return { error: 'Each date needs a valid date, start and end' };
    return { dates: out };
  }
  const r = body.weekly;
  const every = r?.everyWeeks == null ? 1 : r.everyWeeks;
  if (r && isDate(r.startsOn) && isDate(r.until) && r.until >= r.startsOn && isTime(r.startTime) && isTime(r.endTime) && r.endTime > r.startTime
      && Array.isArray(r.weekdays) && r.weekdays.length && r.weekdays.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)
      && Number.isInteger(every) && every >= 1 && every <= 8 && (r.exclude == null || (Array.isArray(r.exclude) && r.exclude.every(isDate)))) {
    return { dates: expandWeekly({ ...r, everyWeeks: every }, tz), rule: JSON.stringify(r) };
  }
  return { error: 'Provide dates [{date, startTime, endTime}] or weekly {startsOn, until, weekdays[0-6], startTime, endTime, everyWeeks?, exclude?}' };
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
  if (decision === 'approve' && confirmed > 0) { await ensurePermit(c, { tenantId, requestId, userId }); await ensureDeposit(c, { tenantId, requestId, userId }); }
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

// Create a request. One request can cover several fields and teams (items). Rules can refuse it, or add a warning for staff.
// Trusted organizations are approved on the spot when nothing conflicts.
requestsRouter.post('/requests', async (req, res, next) => {
  try {
    const { organizationId } = req.body || {};
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const items = Array.isArray(req.body?.items) ? req.body.items : [{ spaceId: req.body?.spaceId, weekly: req.body?.weekly, dates: req.body?.dates, label: req.body?.label }];
    if (!organizationId || !title || title.length > 200 || !items.length || items.length > 60 || items.some((i) => !i?.spaceId)) return res.status(400).json({ error: 'organizationId, title and at least one field are required' });
    if (!memberOf(req, organizationId) && !hasRole(req, 'tenant_admin')) return res.status(403).json({ error: 'You cannot request on behalf of this organization' });

    let tz;
    const result = await withTenant(req.tenantId, async (c) => {
      const t = await loadTenant(c, req.tenantId); tz = t.timezone;
      const staff = isStaff(req);
      const { rows: [org] } = await c.query('select auto_approve, name from organization where id = $1', [organizationId]);
      if (!org) return fail(400, 'Organization not found');

      if (t.hold_unpaid && !staff) {
        const late = (await c.query("select count(*)::int n from invoice where organization_id = $1 and status = 'open' and due_on < current_date", [organizationId])).rows[0].n;
        if (late) return fail(409, `${org.name} has ${late} unpaid invoice${late === 1 ? '' : 's'} past due. Please pay before requesting more time`);
      }
      let round = null;
      if (req.body.roundId) {
        round = (await c.query('select * from allocation_round where id = $1', [req.body.roundId])).rows[0];
        if (!round) return fail(400, 'Round not found');
        const now = new Date();
        if (!staff && (round.status !== 'open' || now < round.opens_at || now > round.closes_at)) return fail(409, `${round.name} is not open for requests right now`);
      }

      const all = []; let rule = null;
      for (const [idx, item] of items.entries()) {
        const parsed = datesFromBody(item, t.timezone);
        if (parsed.error) return fail(400, parsed.error);
        if (!parsed.dates.length) return fail(400, 'That pattern produces no dates');
        const { rows: sp } = await c.query('select name, active from space where id = $1', [item.spaceId]);
        if (!sp.length || !sp[0].active) return fail(400, 'Space not found');
        if (parsed.dates.some((d) => d.startsAt < new Date())) return fail(400, 'Dates must be in the future');
        if (round) {
          const ds = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
          if (parsed.dates.some((d) => ds(d.startsAt) < round.season_start.toISOString().slice(0, 10) || ds(d.startsAt) > round.season_end.toISOString().slice(0, 10))) return fail(400, `Dates must fall within ${round.name}'s season`);
        }
        const checks = await checkDates(c, { tenant: t, spaceId: item.spaceId, organizationId, dates: parsed.dates });
        const blocked = summarize(checks, parsed.dates, t.timezone, 'blocks');
        if (blocked.length) return fail(400, (items.length > 1 ? `${sp[0].name}: ` : '') + blocked.join('. '));
        if (items.length === 1) rule = parsed.rule || null;
        parsed.dates.forEach((d, i) => all.push({ spaceId: item.spaceId, startsAt: d.startsAt, endsAt: d.endsAt, label: (d.label || item.label || null)?.toString().slice(0, 80) || null, warning: checks[i].warnings.join('; ') || null }));
      }
      if (all.length > MAX_DATES) return fail(400, `At most ${MAX_DATES} dates per request`);

      const { rows: pr } = await c.query('select level from user_priority where user_id = $1', [req.userId]);
      const { rows: [reqRow] } = await c.query(
        `insert into request (tenant_id, organization_id, requested_by, space_id, title, notes, priority_snapshot, recurrence_rule, round_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, status, priority_snapshot, submitted_at`,
        [req.tenantId, organizationId, req.userId, items[0].spaceId, title, req.body.notes || null, pr[0]?.level ?? 1, rule, round?.id || null]);
      for (const d of all) {
        await c.query('insert into booking_date (tenant_id, request_id, space_id, starts_at, ends_at, warning, label) values ($1,$2,$3,$4,$5,$6,$7)',
          [req.tenantId, reqRow.id, d.spaceId, d.startsAt, d.endsAt, d.warning, d.label]);
      }

      let auto = false;
      if (org.auto_approve && all.every((x) => !x.warning)) {
        await c.query('savepoint auto');
        try {
          const d = await decideRequest(c, { tenantId: req.tenantId, requestId: reqRow.id, userId: req.userId, decision: 'approve', note: 'Approved automatically (trusted group)', auto: true });
          if (d.flagged) { await c.query('rollback to savepoint auto'); } else { auto = true; reqRow.status = 'approved'; }
        } catch (e) { await c.query('rollback to savepoint auto'); if (!e.http) throw e; }
      }
      return { status: 201, body: { ...reqRow, dateCount: all.length, autoApproved: auto, warnings: all.filter((x) => x.warning).length }, first: all.reduce((m, d) => (d.startsAt < m.startsAt ? d : m)), title, orgName: org.name };
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
    if (badUuid(err) || err.code === '23503') return res.status(400).json({ error: 'Invalid organization, field or round' });
    next(err);
  }
});

// The queue. Staff see every request: pending first, then tier, then person priority, then earliest submitted.
// Filters: status, organizationId, spaceId, roundId, from, to (local dates), q (text), limit, offset.
requestsRouter.get('/requests', async (req, res, next) => {
  try {
    const mine = req.roles.map((r) => r.organizationId).filter(Boolean);
    const q = req.query;
    const limit = Math.min(Math.max(parseInt(q.limit || '200', 10) || 200, 1), 500), offset = Math.max(parseInt(q.offset || '0', 10) || 0, 0);
    if ((q.from && !isDate(q.from)) || (q.to && !isDate(q.to))) return res.status(400).json({ error: 'from and to must be dates like 2027-03-01' });
    const scope = staffScope(req);
    const rows = await withTenant(req.tenantId, async (c) => {
      const tz = (await c.query('select timezone from tenant where id = $1', [req.tenantId])).rows[0].timezone;
      const from = q.from ? localToUtc(q.from, '00:00', tz) : null;
      const to = q.to ? localToUtc(new Date(Date.parse(`${q.to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), '00:00', tz) : null;
      return (await c.query(
        `select r.id, r.title, r.notes, r.status, r.priority_snapshot, r.submitted_at, r.recurrence_rule, r.requested_by, r.round_id as "roundId",
                r.organization_id, o.name as organization, o.tier, r.space_id, s.name as space,
                n.note as "decisionNote",
                (select json_build_object('number', p.number, 'code', p.code) from permit p where p.request_id = r.id and p.revoked_at is null limit 1) as permit,
                json_agg(json_build_object(
                  'id', bd.id, 'startsAt', bd.starts_at, 'endsAt', bd.ends_at, 'status', bd.status, 'warning', bd.warning,
                  'spaceId', bd.space_id, 'space', ds.name, 'label', bd.label,
                  'conflict', bd.status in ('pending','flagged') and exists (
                     select 1 from affected_spaces(bd.space_id) a join blocked_slot b on b.space_id = a.space_id
                      where b.during && tstzrange(bd.starts_at, bd.ends_at, '[)') and (b.is_claim or a.is_claim))
                ) order by bd.starts_at) as dates
           from request r join organization o on o.id = r.organization_id join space s on s.id = r.space_id
           join booking_date bd on bd.request_id = r.id join space ds on ds.id = bd.space_id
           left join lateral (select note from approval a where a.request_id = r.id order by decided_at desc limit 1) n on true
          where ($1::text is null or r.status = $1)
            and ($2::uuid is null or r.organization_id = $2)
            and ($3::uuid is null or exists (select 1 from booking_date x where x.request_id = r.id and x.space_id = $3))
            and ($4::uuid is null or r.round_id = $4)
            and ($5::timestamptz is null or exists (select 1 from booking_date x where x.request_id = r.id and x.ends_at > $5))
            and ($6::timestamptz is null or exists (select 1 from booking_date x where x.request_id = r.id and x.starts_at < $6))
            and ($7::text is null or r.title ilike '%' || $7 || '%' or o.name ilike '%' || $7 || '%')
            and ($8::uuid[] is null or exists (select 1 from booking_date x join space xs on xs.id = x.space_id where x.request_id = r.id and xs.facility_id = any($8)))
          group by r.id, o.name, o.tier, s.name, n.note
          order by (r.status = 'pending') desc, o.tier desc, r.priority_snapshot desc, r.submitted_at asc
          limit ${limit} offset ${offset}`,
        [q.status || null, q.organizationId || null, q.spaceId || null, q.roundId || null, from, to, q.q || null, scope])).rows;
    });
    const visible = isStaff(req) ? rows : rows.filter((r) => mine.includes(r.organization_id));
    res.json({ requests: visible.map((r) => ({ ...r, mine: r.requested_by === req.userId })) });
  } catch (err) { if (badUuid(err)) return res.status(400).json({ error: 'Invalid filter' }); next(err); }
});

// Is any date of this request inside the facilities this staff member covers? (null scope = everything)
async function inScope(c, scope, requestId) {
  if (!scope) return true;
  return (await c.query('select 1 from booking_date b join space s on s.id = b.space_id where b.request_id = $1 and s.facility_id = any($2) limit 1', [requestId, scope])).rowCount > 0;
}

// Decide many requests at once. Each runs in its own savepoint; failures are reported per request.
requestsRouter.post('/requests/bulk-decision', async (req, res, next) => {
  try {
    if (!isStaff(req)) return res.status(403).json({ error: 'Only staff can decide requests' });
    const { ids, decision } = req.body || {};
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !['approve', 'decline', 'return'].includes(decision)) return res.status(400).json({ error: 'ids (up to 100) and a decision are required' });
    const scope = staffScope(req);
    const notices = []; let tz;
    const results = await withTenant(req.tenantId, async (c) => {
      tz = (await loadTenant(c, req.tenantId)).timezone;
      const out = [];
      for (const id of ids) {
        await c.query('savepoint b');
        try {
          if (!(await inScope(c, scope, id))) throw Object.assign(new Error('Outside your sites'), { http: 403 });
          const info = (await c.query('select title, requested_by from request where id = $1', [id])).rows[0];
          const r = await decideRequest(c, { tenantId: req.tenantId, requestId: id, userId: req.userId, decision, note });
          await c.query('release savepoint b');
          out.push({ id, ok: true, ...r });
          if (info && info.requested_by !== req.userId) notices.push({ userId: info.requested_by, kind: `request.${decision}`, subject: `Request ${decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'sent back'}: ${info.title}`,
            text: `Your request "${info.title}" was ${decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'sent back'}.${decision === 'approve' && r.flagged ? ` ${r.confirmed} dates are confirmed and ${r.flagged} could not be booked because the space was already taken.` : ''}${note ? `\n\nNote from the approver: ${note}` : ''}` });
        } catch (e) {
          await c.query('rollback to savepoint b');
          out.push({ id, ok: false, error: badUuid(e) ? 'Request not found' : (e.http ? e.message : 'Failed') });
        }
      }
      return out;
    });
    res.json({ results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
    notify(req.tenantId, notices);
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
      if (!(await inScope(c, staffScope(req), req.params.id))) throw Object.assign(new Error('That request is outside your sites'), { http: 403 });
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
    const wl = [];
    const out = await withTenant(req.tenantId, async (c) => {
      const r = await getRequest(c, req.params.id);
      if (!r) return fail(404, 'Request not found');
      if (!canManage(req, r)) return fail(403, 'Not allowed');
      if (!['pending', 'approved'].includes(r.status)) return fail(409, `Request is already ${r.status}`);
      const { rows: dates } = await c.query("select id, status, space_id, starts_at, ends_at from booking_date where request_id = $1 and status <> 'cancelled' and ends_at > now()", [r.id]);
      for (const d of dates) {
        if (d.status === 'confirmed') { await c.query('select cancel_booking_date($1)', [d.id]); wl.push(...await freeUp(c, req.tenantId, d.space_id, d.starts_at, d.ends_at)); }
        else await c.query("update booking_date set status = 'cancelled' where id = $1", [d.id]);
      }
      await c.query("update request set status = 'cancelled' where id = $1", [r.id]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'request.withdraw','request',$3,$4)",
        [req.tenantId, req.userId, r.id, JSON.stringify({ released: dates.length })]);
      return { status: 200, body: { status: 'cancelled', released: dates.length }, r };
    });
    res.status(out.status).json(out.body);
    notify(req.tenantId, wl);
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
// A group that cancels inside the notice window (tenant setting) is marked late and staff are told.
requestsRouter.post('/booking-dates/:id/cancel', async (req, res, next) => {
  try {
    let tz; const wl = []; let late = false;
    const out = await withTenant(req.tenantId, async (c) => {
      const t = await loadTenant(c, req.tenantId); tz = t.timezone;
      const d = await dateOwner(c, req.params.id);
      if (!d) return fail(404, 'Date not found');
      if (!canManage(req, d)) return fail(403, 'Not allowed');
      if (d.status === 'cancelled') return { status: 200, body: { status: 'cancelled' }, d };
      late = !isStaff(req) && d.status === 'confirmed' && t.cancel_notice_hours > 0 && new Date(d.starts_at) - Date.now() < t.cancel_notice_hours * 3600000;
      await c.query('select cancel_booking_date($1)', [req.params.id]);
      if (late) await c.query('update booking_date set late_cancel = true where id = $1', [req.params.id]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'booking_date.cancel','booking_date',$3,$4)", [req.tenantId, req.userId, req.params.id, JSON.stringify({ late })]);
      if (d.status === 'confirmed') wl.push(...await freeUp(c, req.tenantId, d.space_id, d.starts_at, d.ends_at));
      return { status: 200, body: { status: 'cancelled', late, noticeHours: t.cancel_notice_hours }, d, fresh: true };
    });
    res.status(out.status).json(out.body);
    notify(req.tenantId, wl);
    if (out.fresh && out.d.requested_by !== req.userId) {
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
      notify(req.tenantId, [{ userId: out.d.requested_by, kind: 'date.cancelled', subject: `Date cancelled: ${out.d.title}`,
        text: `${day(out.d.starts_at, tz)} was cancelled for "${out.d.title}".${note ? `\n\nReason: ${note}` : ''}`,
        sms: `${out.d.title} on ${day(out.d.starts_at, tz)} was cancelled.${note ? ` ${note.slice(0, 120)}` : ''}` }]);
    }
    if (out.fresh && late) {
      const staff = (await staffIds(req.tenantId)).filter((u) => u !== req.userId);
      notify(req.tenantId, staff.map((u) => ({ userId: u, kind: 'date.late_cancel', subject: `Late cancellation: ${out.d.title}`, text: `${day(out.d.starts_at, tz)} for "${out.d.title}" was cancelled inside the ${out.body.noticeHours}-hour notice window.` })));
    }
  } catch (err) { if (badUuid(err)) return res.status(404).json({ error: 'Date not found' }); next(err); }
});

// Move one date to another day or time. Staff moves take effect at once; anyone else's goes back for review.
requestsRouter.post('/booking-dates/:id/move', async (req, res, next) => {
  try {
    const { date, startTime, endTime } = req.body || {};
    if (!isDate(date) || !isTime(startTime) || !isTime(endTime) || endTime <= startTime) return res.status(400).json({ error: 'date, startTime and endTime are required' });
    let tz; const wl = [];
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
      if (d.status === 'confirmed') wl.push(...await freeUp(c, req.tenantId, d.space_id, d.starts_at, d.ends_at));
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'booking_date.move','booking_date',$3,$4)",
        [req.tenantId, req.userId, d.id, JSON.stringify({ from: d.starts_at, to: startsAt })]);
      return { status: 200, body: { status, startsAt, endsAt, warning }, d };
    });
    res.status(out.status).json(out.body);
    notify(req.tenantId, wl);
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
