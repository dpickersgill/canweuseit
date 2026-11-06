import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isDate, isTime, localToUtc } from './time.js';
import { checkDates, localParts } from './rules.js';

export const availabilityRouter = Router();
availabilityRouter.use(requireUser, requireTenant);

const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const memberOf = (req, orgId) => req.roles.some((r) => ['org_admin', 'booker'].includes(r.role) && r.organizationId === orgId);

// Is this space free for the whole stretch? (a booking or closure on it, a part of it, or the whole field that holds it all count)
export async function isFree(c, spaceId, from, to) {
  const { rows } = await c.query(
    `select not exists (select 1 from affected_spaces($1) a join blocked_slot b on b.space_id = a.space_id
                         where b.during && tstzrange($2, $3, '[)') and (b.is_claim or a.is_claim)) as free`, [spaceId, from, to]);
  return rows[0].free;
}

const hhmm = (d, tz) => { const p = localParts(d, tz); return `${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`; };

// When a booked slot is released, tell people on the waitlist whose slot is now open. Returns notification items; the caller sends them after commit.
export async function freeUp(c, tenantId, spaceId, from, to) {
  const { rows } = await c.query(
    `select w.id, w.user_id, w.space_id, w.starts_at, w.ends_at, s.name as space
       from waitlist w join space s on s.id = w.space_id
      where w.status = 'open' and w.starts_at < $3 and w.ends_at > $2 and w.ends_at > now()
        and w.space_id in (select space_id from affected_spaces($1))`, [spaceId, from, to]);
  const tz = (await c.query('select timezone from tenant where id = $1', [tenantId])).rows[0].timezone;
  const out = [];
  for (const w of rows) {
    if (!(await isFree(c, w.space_id, w.starts_at, w.ends_at))) continue;
    await c.query("update waitlist set status = 'notified', notified_at = now() where id = $1", [w.id]);
    const when = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(w.starts_at);
    out.push({ userId: w.user_id, kind: 'waitlist.open', subject: `Now open: ${w.space}, ${when}`,
      text: `${w.space} is open ${when}, the time you were waiting for. Requests are approved by the group, so send a request soon.`,
      sms: `${w.space} just opened up for ${when}. Request it in the app.` });
  }
  return out;
}

// Check one slot and, when it is taken or breaks a rule, suggest nearby slots that work.
availabilityRouter.get('/availability/check', async (req, res, next) => {
  try {
    const { spaceId, date, start, end, organizationId } = req.query;
    if (!spaceId || !isDate(date) || !isTime(start) || !isTime(end) || end <= start) return res.status(400).json({ error: 'spaceId, date, start and end are required' });
    const out = await withTenant(req.tenantId, async (c) => {
      const t = (await c.query('select id, name, timezone, latitude, longitude, daylight_rule, insurance_rule, min_coverage, require_additional_insured from tenant where id = $1', [req.tenantId])).rows[0];
      const tz = t.timezone;
      const from = localToUtc(date, start, tz), to = localToUtc(date, end, tz);
      const { rows: [sp] } = await c.query('select id, name, facility_id from space where id = $1 and active', [spaceId]);
      if (!sp) return { status: 404, body: { error: 'Space not found' } };
      const orgId = organizationId || null;
      const verdict = async (sid, f, e) => {
        const free = await isFree(c, sid, f, e);
        const [chk] = await checkDates(c, { tenant: t, spaceId: sid, organizationId: orgId, dates: [{ startsAt: f, endsAt: e }] });
        return { free, blocks: chk.blocks, warnings: chk.warnings, ok: free && !chk.blocks.length };
      };
      const main = await verdict(spaceId, from, to);
      const body = { free: main.free, blocks: main.blocks, warnings: main.warnings, suggestions: [] };
      if (main.ok) return { status: 200, body };

      const dur = (to - from) / 60000;
      const startMin = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
      const add = (s) => body.suggestions.length < 8 && body.suggestions.push(s);
      const mk = (sid, name, d, sMin, kind) => ({ spaceId: sid, space: name, date: d,
        start: `${String(Math.floor(sMin / 60)).padStart(2, '0')}:${String(sMin % 60).padStart(2, '0')}`,
        end: `${String(Math.floor((sMin + dur) / 60)).padStart(2, '0')}:${String((sMin + dur) % 60).padStart(2, '0')}`, kind });
      // 1. other times the same day, nearest first
      const times = [];
      for (let m = 6 * 60; m + dur <= 23 * 60; m += 30) if (m !== startMin) times.push(m);
      times.sort((a, b) => Math.abs(a - startMin) - Math.abs(b - startMin));
      let n = 0;
      for (const m of times) {
        if (n >= 3) break;
        const f = localToUtc(date, mk(spaceId, '', date, m).start, tz), e = new Date(f.getTime() + dur * 60000);
        if ((await verdict(spaceId, f, e)).ok) { add(mk(spaceId, sp.name, date, m, 'time')); n++; }
      }
      // 2. other fields at the same time (same facility first)
      const { rows: others } = await c.query('select id, name from space where active and id <> $1 order by (facility_id = $2) desc, name limit 40', [spaceId, sp.facility_id]);
      n = 0;
      for (const o of others) {
        if (n >= 3) break;
        if ((await verdict(o.id, from, to)).ok) { add(mk(o.id, o.name, date, startMin, 'field')); n++; }
      }
      // 3. the same slot on the next days
      n = 0;
      for (let k = 1; k <= 14 && n < 2; k++) {
        const d2 = new Date(Date.parse(`${date}T12:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
        const f = localToUtc(d2, start, tz), e = localToUtc(d2, end, tz);
        if ((await verdict(spaceId, f, e)).ok) { add(mk(spaceId, sp.name, d2, startMin, 'day')); n++; }
      }
      return { status: 200, body };
    });
    res.status(out.status).json(out.body);
  } catch (err) { if (err.code === '22P02') return res.status(400).json({ error: 'Invalid id' }); next(err); }
});

// ---- waitlist: "tell me if this opens up"
availabilityRouter.get('/waitlist', async (req, res, next) => {
  try {
    const mine = req.roles.map((r) => r.organizationId).filter(Boolean);
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select w.id, w.status, w.note, w.starts_at as "startsAt", w.ends_at as "endsAt", s.name as space, o.name as organization, w.organization_id as "organizationId", w.user_id = $1 as mine
         from waitlist w join space s on s.id = w.space_id join organization o on o.id = w.organization_id
        where w.status <> 'cancelled' and w.ends_at > now() order by w.starts_at`, [req.userId])).rows);
    res.json({ waitlist: isStaff(req) ? rows : rows.filter((r) => mine.includes(r.organizationId)) });
  } catch (err) { next(err); }
});

availabilityRouter.post('/waitlist', async (req, res, next) => {
  try {
    const { organizationId, spaceId, date, start, end } = req.body || {};
    if (!organizationId || !spaceId || !isDate(date) || !isTime(start) || !isTime(end) || end <= start) return res.status(400).json({ error: 'organizationId, spaceId, date, start and end are required' });
    if (!memberOf(req, organizationId) && !hasRole(req, 'tenant_admin')) return res.status(403).json({ error: 'You cannot wait on behalf of this organization' });
    const row = await withTenant(req.tenantId, async (c) => {
      const tz = (await c.query('select timezone from tenant where id = $1', [req.tenantId])).rows[0].timezone;
      const from = localToUtc(date, start, tz), to = localToUtc(date, end, tz);
      if (from < new Date()) return null;
      return (await c.query('insert into waitlist (tenant_id, organization_id, user_id, space_id, starts_at, ends_at, note) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [req.tenantId, organizationId, req.userId, spaceId, from, to, req.body.note ? String(req.body.note).slice(0, 300) : null])).rows[0];
    });
    row ? res.status(201).json(row) : res.status(400).json({ error: 'That time has passed' });
  } catch (err) { if (err.code === '22P02' || err.code === '23503') return res.status(400).json({ error: 'Invalid organization or space' }); next(err); }
});

availabilityRouter.delete('/waitlist/:id', async (req, res, next) => {
  try {
    const n = await withTenant(req.tenantId, async (c) => (await c.query(
      "update waitlist set status = 'cancelled' where id = $1 and ($2 or user_id = $3) and status <> 'cancelled'", [req.params.id, isStaff(req), req.userId])).rowCount);
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  } catch (err) { if (err.code === '22P02') return res.status(404).json({ error: 'Not found' }); next(err); }
});
