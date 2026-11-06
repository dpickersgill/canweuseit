// Inside a club's approved time: its teams, which team uses which part of the field when,
// giving back time it won't use, and staff marking no-shows.
import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole, closeScope } from './tenant.js';
import { localToUtc, isTime } from './time.js';
import { freeUp } from './availability.js';
import { notify, staffIds } from './notify.js';

export const teamsRouter = Router();
const authed = Router();
authed.use(requireUser, requireTenant);
const err = (http, message) => Object.assign(new Error(message), { http });
const send = (res, e, next) => (e.http ? res.status(e.http).json({ error: e.message })
  : e.code === '22P02' ? res.status(404).json({ error: 'Not found' })
  : e.code === '23505' ? res.status(409).json({ error: 'A team with that name already exists' })
  : e.code === 'P0001' ? res.status(409).json({ error: e.message }) : next(e));
const manages = (req, orgId) => hasRole(req, 'tenant_admin') || req.roles.some((r) => r.role === 'org_admin' && r.organizationId === orgId);
const member = (req, orgId) => hasRole(req, 'tenant_admin', 'approver', 'grounds') || req.roles.some((r) => r.organizationId === orgId);
const cleanName = (s) => String(s || '').trim().slice(0, 80);

// ---------------------------------------------------------------- teams
authed.get('/organizations/:id/teams', async (req, res, next) => {
  try {
    if (!member(req, req.params.id)) throw err(403, 'Not allowed');
    const teams = await withTenant(req.tenantId, async (c) => (await c.query(
      `select t.id, t.name, t.active, u.full_name as coach, u.email as "coachEmail" from team t left join app_user u on u.id = t.coach_user_id
        where t.organization_id = $1 order by t.active desc, lower(t.name)`, [req.params.id])).rows);
    res.json({ teams });
  } catch (e) { send(res, e, next); }
});

authed.post('/organizations/:id/teams', async (req, res, next) => {
  try {
    if (!manages(req, req.params.id)) throw err(403, 'Only the group admin can add teams');
    const name = cleanName(req.body?.name);
    if (!name) throw err(400, 'Give the team a name');
    const row = await withTenant(req.tenantId, async (c) => (await c.query(
      'insert into team (tenant_id, organization_id, name) values ($1,$2,$3) returning id, name', [req.tenantId, req.params.id, name])).rows[0]);
    res.status(201).json(row);
  } catch (e) { send(res, e, next); }
});

authed.patch('/teams/:id', async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const t = (await c.query('select id, organization_id from team where id = $1', [req.params.id])).rows[0];
      if (!t) throw err(404, 'Team not found');
      if (!manages(req, t.organization_id)) throw err(403, 'Only the group admin can change teams');
      if (req.body?.name !== undefined) { const n = cleanName(req.body.name); if (!n) throw err(400, 'Give the team a name'); await c.query('update team set name = $2 where id = $1', [t.id, n]); }
      if (typeof req.body?.active === 'boolean') await c.query('update team set active = $2 where id = $1', [t.id, req.body.active]);
      return { ok: true };
    });
    res.json(out);
  } catch (e) { send(res, e, next); }
});

// ---------------------------------------------------------------- one approved date: who uses it
async function loadDate(c, id) {
  const d = (await c.query(
    `select bd.id, bd.status, bd.starts_at, bd.ends_at, bd.space_id, s.name as space, s.facility_id, r.organization_id, r.title, r.requested_by, t.timezone
       from booking_date bd join request r on r.id = bd.request_id join space s on s.id = bd.space_id join tenant t on t.id = bd.tenant_id where bd.id = $1`, [id])).rows[0];
  if (!d) throw err(404, 'Date not found');
  return d;
}
const localDay = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

authed.get('/booking-dates/:id/team-slots', async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const d = await loadDate(c, req.params.id);
      if (!member(req, d.organization_id)) throw err(403, 'Not allowed');
      const slots = (await c.query(
        `select ts.id, ts.team_id as "teamId", tm.name as team, ts.space_id as "spaceId", s.name as space, ts.starts_at as "startsAt", ts.ends_at as "endsAt"
           from team_slot ts join team tm on tm.id = ts.team_id join space s on s.id = ts.space_id where ts.booking_date_id = $1 order by ts.starts_at, s.name`, [d.id])).rows;
      const spaces = (await c.query('select s.id, s.name, s.parent_id as "parentId" from space s where s.id in (select space_descendants($1)) and s.active order by s.parent_id nulls first, s.name', [d.space_id])).rows;
      const teams = (await c.query('select id, name from team where organization_id = $1 and active order by lower(name)', [d.organization_id])).rows;
      return { date: { id: d.id, status: d.status, startsAt: d.starts_at, endsAt: d.ends_at, space: d.space, title: d.title, localDate: localDay(d.starts_at, d.timezone) }, slots, spaces, teams, canEdit: manages(req, d.organization_id) };
    });
    res.json(out);
  } catch (e) { send(res, e, next); }
});

// Replace the whole plan for a date. slots: [{teamId, spaceId, start:'HH:MM', end:'HH:MM'}]
authed.put('/booking-dates/:id/team-slots', async (req, res, next) => {
  try {
    const list = Array.isArray(req.body?.slots) ? req.body.slots : null;
    if (!list || list.length > 40) throw err(400, 'Send slots: a list of up to 40 team times');
    const out = await withTenant(req.tenantId, async (c) => {
      const d = await loadDate(c, req.params.id);
      if (!manages(req, d.organization_id)) throw err(403, 'Only the group admin can plan teams');
      if (d.status !== 'confirmed') throw err(409, 'Teams can only be placed on approved dates');
      const day = localDay(d.starts_at, d.timezone);
      const allowed = new Set((await c.query('select space_descendants($1) as id', [d.space_id])).rows.map((r) => r.id));
      const teams = new Set((await c.query('select id from team where organization_id = $1 and active', [d.organization_id])).rows.map((r) => r.id));
      const desc = new Map();
      const under = async (id) => { if (!desc.has(id)) desc.set(id, new Set((await c.query('select space_descendants($1) as id', [id])).rows.map((r) => r.id))); return desc.get(id); };
      const clean = [];
      for (const [n, s] of list.entries()) {
        const at = `Row ${n + 1}`;
        if (!teams.has(s?.teamId)) throw err(400, `${at}: choose one of your teams`);
        if (!allowed.has(s?.spaceId)) throw err(400, `${at}: pick the booked field or a section of it`);
        if (!isTime(s?.start) || !isTime(s?.end)) throw err(400, `${at}: times look like 17:30`);
        const from = localToUtc(day, s.start, d.timezone), to = localToUtc(day, s.end, d.timezone);
        if (to <= from) throw err(400, `${at}: the end must be after the start`);
        if (from < new Date(d.starts_at) || to > new Date(d.ends_at)) throw err(400, `${at}: must sit inside your booked time`);
        clean.push({ ...s, from, to, n });
      }
      for (const a of clean) for (const b of clean) {
        if (a.n >= b.n || !(a.from < b.to && b.from < a.to)) continue;
        const related = (await under(a.spaceId)).has(b.spaceId) || (await under(b.spaceId)).has(a.spaceId);
        if (related) throw err(409, `Rows ${a.n + 1} and ${b.n + 1} put two teams on the same ground at the same time`);
      }
      await c.query('delete from team_slot where booking_date_id = $1', [d.id]);
      for (const s of clean) await c.query('insert into team_slot (tenant_id, booking_date_id, team_id, space_id, starts_at, ends_at) values ($1,$2,$3,$4,$5,$6)',
        [req.tenantId, d.id, s.teamId, s.spaceId, s.from, s.to]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'team_slots.set','booking_date',$3,$4)", [req.tenantId, req.userId, d.id, JSON.stringify({ slots: clean.length })]);
      return { ok: true, slots: clean.length };
    });
    res.json(out);
  } catch (e) { send(res, e, next); }
});

// Give back the start or end of an approved date: keep only start..end (local times on that day).
authed.post('/booking-dates/:id/release', async (req, res, next) => {
  try {
    let wl = [], d;
    const out = await withTenant(req.tenantId, async (c) => {
      d = await loadDate(c, req.params.id);
      if (!manages(req, d.organization_id) && !hasRole(req, 'tenant_admin', 'approver')) throw err(403, 'Not allowed');
      if (!isTime(req.body?.keepStart) || !isTime(req.body?.keepEnd)) throw err(400, 'Say which part to keep: keepStart and keepEnd like 17:00');
      const day = localDay(d.starts_at, d.timezone);
      const from = localToUtc(day, req.body.keepStart, d.timezone), to = localToUtc(day, req.body.keepEnd, d.timezone);
      await c.query('select trim_booking_date($1, $2, $3)', [d.id, from, to]);
      if (from > new Date(d.starts_at)) wl.push(...await freeUp(c, req.tenantId, d.space_id, d.starts_at, from));
      if (to < new Date(d.ends_at)) wl.push(...await freeUp(c, req.tenantId, d.space_id, to, d.ends_at));
      const minutes = Math.round(((new Date(d.ends_at) - new Date(d.starts_at)) - (to - from)) / 60000);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'booking_date.release','booking_date',$3,$4)", [req.tenantId, req.userId, d.id, JSON.stringify({ minutes })]);
      return { ok: true, releasedMinutes: minutes, startsAt: from, endsAt: to };
    });
    res.json(out);
    notify(req.tenantId, wl);
    if (out.releasedMinutes) {
      const staff = (await staffIds(req.tenantId)).filter((u) => u !== req.userId);
      notify(req.tenantId, staff.map((userId) => ({ userId, kind: 'date.released', subject: `Time given back: ${d.space}`,
        text: `"${d.title}" gave back ${out.releasedMinutes} minutes on ${d.space}, ${localDay(d.starts_at, d.timezone)}. It is free for others now.` })));
    }
  } catch (e) { send(res, e, next); }
});

// Staff or groundskeepers mark a past date as a no-show (the group didn't use it).
authed.post('/booking-dates/:id/no-show', async (req, res, next) => {
  try {
    const scope = closeScope(req);
    if (scope === undefined) throw err(403, 'Only staff or groundskeepers can mark no-shows');
    const out = await withTenant(req.tenantId, async (c) => {
      const d = await loadDate(c, req.params.id);
      if (scope && !scope.includes(d.facility_id)) throw err(403, 'That field is outside your site');
      if (d.status !== 'confirmed') throw err(409, 'Only approved dates can be marked');
      if (new Date(d.starts_at) > new Date()) throw err(409, 'You can only mark a no-show once the time has started');
      const v = req.body?.noShow !== false;
      await c.query('update booking_date set no_show = $2 where id = $1', [d.id, v]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'booking_date.no_show','booking_date',$3,$4)", [req.tenantId, req.userId, d.id, JSON.stringify({ noShow: v })]);
      return { ok: true, noShow: v };
    });
    res.json(out);
  } catch (e) { send(res, e, next); }
});

teamsRouter.use(authed);
