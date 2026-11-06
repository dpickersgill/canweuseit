import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { config } from './config.js';
import { planUsage, checkLimit } from './planlib.js';
import { notify } from './notify.js';

export const setupRouter = Router();
setupRouter.use(requireUser, requireTenant);

import { KIND_CODES as KINDS, defaultIndoor } from '../public/kinds.js';
const cap = (v) => (v === null || v === '' ? null : Number.isInteger(v) && v >= 1 && v <= 100000 ? v : undefined);
const requireAdmin = (req, res, next) =>
  hasRole(req, 'tenant_admin') ? next() : res.status(403).json({ error: 'Only a tenant admin can change setup' });

const cleanName = (v) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 120 ? v.trim() : null);

setupRouter.get('/tenant', async (req, res, next) => {
  try {
    const row = await withTenant(req.tenantId, async (c) =>
      ({ ...(await c.query('select id, name, slug, timezone, daylight_rule as "daylightRule", latitude::float, longitude::float from tenant where id = $1', [req.tenantId])).rows[0], plan: await planUsage(c, req.tenantId) }));
    res.json({ ...row, roles: req.roles, map: config.map, contact: config.legal.contact });
  } catch (err) { next(err); }
});

setupRouter.get('/facilities', async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId, async (c) =>
      (await c.query('select id, name, address, latitude::float, longitude::float from facility order by name')).rows);
    res.json({ facilities: rows });
  } catch (err) { next(err); }
});

setupRouter.post('/facilities', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const row = await withTenant(req.tenantId, async (c) => {
      await checkLimit(c, req.tenantId, 'facility');
      return (await c.query('insert into facility (tenant_id, name, address) values ($1, $2, $3) returning id, name, address',
        [req.tenantId, name, req.body?.address || null])).rows[0];
    });
    res.status(201).json(row);
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'A facility with that name already exists' });
    next(err);
  }
});

setupRouter.post('/spaces', requireAdmin, async (req, res, next) => {
  try {
    const { facilityId, parentId = null, hasLights = false, bufferMinutes = 0 } = req.body || {};
    const name = cleanName(req.body?.name);
    if (!name || !facilityId) return res.status(400).json({ error: 'name and facilityId are required' });
    if (req.body?.kind !== undefined && !KINDS.includes(req.body.kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    const capacity = cap(req.body?.capacity ?? null);
    if (capacity === undefined) return res.status(400).json({ error: 'capacity must be a whole number from 1 to 100000' });
    if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > 240)
      return res.status(400).json({ error: 'bufferMinutes must be a whole number from 0 to 240' });

    const row = await withTenant(req.tenantId, async (c) => {
      let kind = req.body?.kind || 'field', indoor;
      if (parentId) {
        const { rows } = await c.query('select facility_id, kind, indoor from space where id = $1', [parentId]);
        if (!rows.length) return { error: 'Parent space not found' };
        if (rows[0].facility_id !== facilityId) return { error: 'A sub-space must be in the same facility as its parent' };
        // a section is part of its parent: same kind and same indoors/outdoors unless told otherwise
        if (!req.body?.kind) kind = rows[0].kind;
        indoor = req.body?.indoor === undefined ? rows[0].indoor : !!req.body.indoor;
      } else await checkLimit(c, req.tenantId, 'field');
      if (indoor === undefined) indoor = req.body?.indoor === undefined ? defaultIndoor(kind) : !!req.body.indoor;
      return (await c.query(
        `insert into space (tenant_id, facility_id, parent_id, name, kind, has_lights, buffer_minutes, indoor, capacity)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, facility_id, parent_id, name, kind, has_lights, buffer_minutes, indoor, capacity`,
        [req.tenantId, facilityId, parentId, name, kind, !indoor && !!hasLights, bufferMinutes, indoor, capacity])).rows[0];
    });
    if (row.error) return res.status(400).json(row);
    res.status(201).json(row);
  } catch (err) {
    if (err.http) return res.status(err.http).json({ error: err.message });
    if (err.code === '23503') return res.status(400).json({ error: 'Facility not found' });
    next(err);
  }
});

setupRouter.patch('/spaces/:id', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) { const n = cleanName(b.name); if (!n) return res.status(400).json({ error: 'invalid name' }); add('name', n); }
    if (b.hasLights !== undefined) add('has_lights', !!b.hasLights);
    if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` }); add('kind', b.kind); }
    if (b.indoor !== undefined) add('indoor', !!b.indoor);
    if (b.capacity !== undefined) { const v = cap(b.capacity); if (v === undefined) return res.status(400).json({ error: 'capacity must be a whole number from 1 to 100000' }); add('capacity', v); }
    if (b.active !== undefined) add('active', !!b.active);
    if (b.outline !== undefined) {
      const ok = b.outline === null || (Array.isArray(b.outline) && b.outline.length >= 3 && b.outline.length <= 200
        && b.outline.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90));
      if (!ok) return res.status(400).json({ error: 'outline must be 3 to 200 points of [longitude, latitude]' });
      add('outline', b.outline === null ? null : JSON.stringify(b.outline.map(([x, y]) => [Math.round(x * 1e7) / 1e7, Math.round(y * 1e7) / 1e7])));
    }
    if (b.bufferMinutes !== undefined) {
      if (!Number.isInteger(b.bufferMinutes) || b.bufferMinutes < 0 || b.bufferMinutes > 240) return res.status(400).json({ error: 'invalid bufferMinutes' });
      add('buffer_minutes', b.bufferMinutes);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.id);
    const row = await withTenant(req.tenantId, async (c) =>
      (await c.query(`update space set ${sets.join(', ')} where id = $${vals.length}
                      returning id, facility_id, parent_id, name, kind, has_lights, buffer_minutes, active, outline, indoor, capacity`, vals)).rows[0]);
    row ? res.json(row) : res.status(404).json({ error: 'Space not found' });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Space not found' });
    next(err);
  }
});

// Where a site is on the map (admins set it by panning the map to it).
setupRouter.patch('/facilities/:id', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) { const n = cleanName(b.name); if (!n) return res.status(400).json({ error: 'invalid name' }); add('name', n); }
    if (b.latitude !== undefined || b.longitude !== undefined) {
      if (!(Number.isFinite(b.latitude) && Math.abs(b.latitude) <= 90 && Number.isFinite(b.longitude) && Math.abs(b.longitude) <= 180)) return res.status(400).json({ error: 'latitude and longitude are required together' });
      add('latitude', b.latitude); add('longitude', b.longitude);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.id);
    const row = await withTenant(req.tenantId, async (c) => (await c.query(`update facility set ${sets.join(', ')} where id = $${vals.length} returning id, name, latitude::float, longitude::float`, vals)).rows[0]);
    row ? res.json(row) : res.status(404).json({ error: 'Facility not found' });
  } catch (err) { if (err.code === '22P02') return res.status(404).json({ error: 'Facility not found' }); next(err); }
});

// Remove a space (or a section). It is archived, not erased: past bookings, invoices and reports still point at it.
// Its sections go with it, and future bookings on any of them are cancelled and the requesters told. ?preview=1 only counts.
setupRouter.delete('/spaces/:id', requireAdmin, async (req, res, next) => {
  try {
    const preview = req.query.preview === '1';
    const out = await withTenant(req.tenantId, async (c) => {
      const sp = (await c.query('select id, name from space where id = $1 and active', [req.params.id])).rows[0];
      if (!sp) return { status: 404, body: { error: 'Space not found' } };
      const ids = (await c.query('select space_descendants($1) as id', [sp.id])).rows.map((r) => r.id);
      const dates = (await c.query(
        `select bd.id, bd.status, bd.starts_at, r.title, r.requested_by from booking_date bd join request r on r.id = bd.request_id
          where bd.space_id = any($1) and bd.status in ('confirmed','pending','flagged') and bd.ends_at > now()`, [ids])).rows;
      if (preview) return { status: 200, body: { preview: true, name: sp.name, sections: ids.length - 1, futureBookings: dates.length } };
      for (const d of dates) {
        if (d.status === 'confirmed') await c.query('select cancel_booking_date($1)', [d.id]);
        else await c.query("update booking_date set status = 'cancelled' where id = $1", [d.id]);
      }
      await c.query('update space set active = false where id = any($1)', [ids]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'space.remove','space',$3,$4)",
        [req.tenantId, req.userId, sp.id, JSON.stringify({ name: sp.name, sections: ids.length - 1, cancelled: dates.length })]);
      return { status: 200, body: { ok: true, name: sp.name, sections: ids.length - 1, cancelled: dates.length }, dates, sp };
    });
    res.status(out.status).json(out.body);
    if (out.dates?.length) {
      const byUser = new Map();
      for (const d of out.dates) byUser.set(d.requested_by, [...(byUser.get(d.requested_by) || []), d]);
      notify(req.tenantId, [...byUser].map(([userId, list]) => ({ userId, kind: 'space.removed', subject: `${out.sp.name} is no longer available`,
        text: `${out.sp.name} has been taken out of use. ${list.length} upcoming date${list.length === 1 ? ' was' : 's were'} cancelled for: ${[...new Set(list.map((d) => d.title))].join(', ')}. Please request another field.`,
        sms: `${out.sp.name} is no longer available; ${list.length} upcoming date${list.length === 1 ? '' : 's'} cancelled.` })));
    }
  } catch (err) { if (err.code === '22P02') return res.status(404).json({ error: 'Space not found' }); next(err); }
});
