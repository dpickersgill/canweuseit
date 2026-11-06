import crypto from 'node:crypto';
import { Router } from 'express';
import { query, withTenant } from './db.js';
import { config } from './config.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ---- public feed: the secret in the address is the credential (calendar apps can't sign in) ----
export const calendarPublic = Router();

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function fold(line) { // lines longer than 75 bytes are continued on the next line with a leading space
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 74) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function buildIcs(name, events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CanWeUseIt//Field bookings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@canweuseit.com`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(e.startsAt)}`, `DTEND:${stamp(e.endsAt)}`,
      `SUMMARY:${esc(`${e.organization}: ${e.title}`)}`, `LOCATION:${esc(e.facility ? `${e.space}, ${e.facility}` : e.space)}`, 'STATUS:CONFIRMED', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

calendarPublic.get('/calendar/:file', async (req, res, next) => {
  try {
    const token = req.params.file.replace(/\.ics$/, '');
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return res.status(404).type('text').send('Not found');
    const { rows: [feed] } = await query('select * from feed_lookup($1)', [hash(token)]);
    if (!feed) return res.status(404).type('text').send('Not found');
    const { name, events } = await withTenant(feed.tenant_id, async (c) => {
      const t = (await c.query('select name from tenant where id = $1', [feed.tenant_id])).rows[0];
      const ev = (await c.query(
        `select bd.id, bd.starts_at as "startsAt", bd.ends_at as "endsAt", s.name as space, f.name as facility, o.name as organization, r.title
           from booking_date bd join request r on r.id = bd.request_id join space s on s.id = bd.space_id join facility f on f.id = s.facility_id
           join organization o on o.id = r.organization_id
          where bd.status = 'confirmed' and bd.ends_at > now() - interval '30 days' and bd.starts_at < now() + interval '400 days'
            and ($1::uuid is null or r.organization_id = $1) order by bd.starts_at limit 5000`, [feed.organization_id])).rows;
      return { name: t.name, events: ev };
    });
    res.set('Content-Type', 'text/calendar; charset=utf-8').set('Cache-Control', 'private, max-age=300').send(buildIcs(`${name} field schedule`, events));
  } catch (err) { next(err); }
});

// ---- managing your own feed links ----
export const calendarRouter = Router();
calendarRouter.use(requireUser, requireTenant);

calendarRouter.get('/calendar-feeds', async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select f.id, f.label, f.organization_id as "organizationId", o.name as organization, f.created_at as "createdAt"
         from calendar_feed f left join organization o on o.id = f.organization_id where f.user_id = $1 order by f.created_at`, [req.userId])).rows);
    res.json({ feeds: rows });
  } catch (err) { next(err); }
});

// The address is shown once; only a hash is kept. Make a new link if you lose it.
calendarRouter.post('/calendar-feeds', async (req, res, next) => {
  try {
    const organizationId = req.body?.organizationId || null;
    const staff = hasRole(req, 'tenant_admin', 'approver');
    if (organizationId && !staff && !req.roles.some((r) => r.organizationId === organizationId)) return res.status(403).json({ error: 'Not your organization' });
    const label = String(req.body?.label || 'My calendar').trim().slice(0, 80) || 'My calendar';
    const token = crypto.randomBytes(24).toString('base64url');
    const row = await withTenant(req.tenantId, async (c) => (await c.query(
      'insert into calendar_feed (tenant_id, user_id, organization_id, label, token_hash) values ($1,$2,$3,$4,$5) returning id', [req.tenantId, req.userId, organizationId, label, hash(token)])).rows[0]);
    const url = `${config.appUrl}/calendar/${token}.ics`;
    res.status(201).json({ id: row.id, url, webcal: url.replace(/^https?:/, 'webcal:') });
  } catch (err) { if (err.code === '22P02' || err.code === '23503') return res.status(400).json({ error: 'Invalid organization' }); next(err); }
});

calendarRouter.delete('/calendar-feeds/:id', async (req, res, next) => {
  try {
    const n = await withTenant(req.tenantId, async (c) => (await c.query('delete from calendar_feed where id = $1 and user_id = $2', [req.params.id, req.userId])).rowCount);
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  } catch (err) { if (err.code === '22P02') return res.status(404).json({ error: 'Not found' }); next(err); }
});
