import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isTime } from './time.js';

export const settingsRouter = Router();
settingsRouter.use(requireUser, requireTenant);
const requireAdmin = (req, res, next) => (hasRole(req, 'tenant_admin') ? next() : res.status(403).json({ error: 'Only a tenant admin can change settings' }));
const LEVELS = ['off', 'warn', 'block'];

const validZone = (z) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };

settingsRouter.get('/settings', requireAdmin, async (req, res, next) => {
  try {
    const row = await withTenant(req.tenantId, async (c) => (await c.query(
      'select name, timezone, latitude, longitude, daylight_rule as "daylightRule", insurance_rule as "insuranceRule", cancel_notice_hours as "cancelNoticeHours", hold_unpaid as "holdUnpaid", min_coverage as "minCoverage", require_additional_insured as "requireAdditionalInsured", slug from tenant where id = $1', [req.tenantId])).rows[0]);
    res.json(row);
  } catch (err) { next(err); }
});

settingsRouter.patch('/settings', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.timezone !== undefined) { if (!validZone(b.timezone)) return res.status(400).json({ error: 'Unknown time zone' }); add('timezone', b.timezone); }
    if (b.latitude !== undefined) { const v = b.latitude === null ? null : Number(b.latitude); if (v !== null && !(v >= -90 && v <= 90)) return res.status(400).json({ error: 'latitude must be between -90 and 90' }); add('latitude', v); }
    if (b.longitude !== undefined) { const v = b.longitude === null ? null : Number(b.longitude); if (v !== null && !(v >= -180 && v <= 180)) return res.status(400).json({ error: 'longitude must be between -180 and 180' }); add('longitude', v); }
    for (const [key, col] of [['daylightRule', 'daylight_rule'], ['insuranceRule', 'insurance_rule']]) {
      if (b[key] !== undefined) { if (!LEVELS.includes(b[key])) return res.status(400).json({ error: `${key} must be off, warn or block` }); add(col, b[key]); }
    }
    if (b.cancelNoticeHours !== undefined) { if (!(Number.isInteger(b.cancelNoticeHours) && b.cancelNoticeHours >= 0 && b.cancelNoticeHours <= 720)) return res.status(400).json({ error: 'cancelNoticeHours must be 0 to 720' }); add('cancel_notice_hours', b.cancelNoticeHours); }
    if (b.minCoverage !== undefined) { const v = b.minCoverage === null || b.minCoverage === '' ? null : Number(b.minCoverage); if (v !== null && !(Number.isInteger(v) && v >= 0)) return res.status(400).json({ error: 'minCoverage must be a whole number of dollars' }); add('min_coverage', v); }
    if (b.requireAdditionalInsured !== undefined) { if (typeof b.requireAdditionalInsured !== 'boolean') return res.status(400).json({ error: 'requireAdditionalInsured must be true or false' }); add('require_additional_insured', b.requireAdditionalInsured); }
    if (b.holdUnpaid !== undefined) { if (typeof b.holdUnpaid !== 'boolean') return res.status(400).json({ error: 'holdUnpaid must be true or false' }); add('hold_unpaid', b.holdUnpaid); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.tenantId);
    await withTenant(req.tenantId, (c) => c.query(`update tenant set ${sets.join(', ')} where id = $${vals.length}`, vals));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Bookable hours. Staff can read them (the request form uses them); only admins change them.
settingsRouter.get('/hours', async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId, async (c) => (await c.query(
      `select h.id, h.space_id as "spaceId", s.name as space, h.weekdays, to_char(h.opens, 'HH24:MI') as opens, to_char(h.closes, 'HH24:MI') as closes,
              h.starts_on::text as "startsOn", h.ends_on::text as "endsOn", h.enforcement, h.note
         from space_hours h left join space s on s.id = h.space_id order by s.name nulls first, h.opens`)).rows);
    res.json({ hours: rows });
  } catch (err) { next(err); }
});

settingsRouter.post('/hours', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const weekdays = b.weekdays ?? [0, 1, 2, 3, 4, 5, 6];
    if (!isTime(b.opens) || !isTime(b.closes) || b.closes <= b.opens) return res.status(400).json({ error: 'opens and closes are required, and closes must be later' });
    if (!Array.isArray(weekdays) || !weekdays.length || !weekdays.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) return res.status(400).json({ error: 'weekdays must be numbers 0 to 6' });
    if (!['warn', 'block'].includes(b.enforcement || 'block')) return res.status(400).json({ error: 'enforcement must be warn or block' });
    const row = await withTenant(req.tenantId, async (c) => (await c.query(
      `insert into space_hours (tenant_id, space_id, weekdays, opens, closes, starts_on, ends_on, enforcement, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [req.tenantId, b.spaceId || null, weekdays, b.opens, b.closes, b.startsOn || null, b.endsOn || null, b.enforcement || 'block', b.note ? String(b.note).slice(0, 200) : null])).rows[0]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23503' || err.code === '22P02' || err.code === '22007' || err.code === '23514') return res.status(400).json({ error: 'Check the space and dates' });
    next(err);
  }
});

settingsRouter.delete('/hours/:id', requireAdmin, async (req, res, next) => {
  try {
    const n = await withTenant(req.tenantId, async (c) => (await c.query('delete from space_hours where id = $1', [req.params.id])).rowCount);
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  } catch (err) { if (err.code === '22P02') return res.status(404).json({ error: 'Not found' }); next(err); }
});

// Trusted organizations (approved automatically when nothing conflicts) and priority tier (1 to 5, higher goes first).
settingsRouter.patch('/organizations/:id', requireAdmin, async (req, res, next) => {
  try {
    const { autoApprove, tier } = req.body || {};
    if (autoApprove !== undefined && typeof autoApprove !== 'boolean') return res.status(400).json({ error: 'autoApprove must be true or false' });
    if (tier !== undefined && !(Number.isInteger(tier) && tier >= 1 && tier <= 5)) return res.status(400).json({ error: 'tier must be a whole number from 1 to 5' });
    if (autoApprove === undefined && tier === undefined) return res.status(400).json({ error: 'nothing to update' });
    const n = await withTenant(req.tenantId, async (c) => (await c.query(
      'update organization set auto_approve = coalesce($2, auto_approve), tier = coalesce($3, tier) where id = $1', [req.params.id, autoApprove ?? null, tier ?? null])).rowCount);
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Organization not found' });
  } catch (err) { if (err.code === '22P02') return res.status(404).json({ error: 'Organization not found' }); next(err); }
});
