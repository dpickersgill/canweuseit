import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';

export const setupRouter = Router();
setupRouter.use(requireUser, requireTenant);

const KINDS = ['field', 'room', 'court', 'other'];
const requireAdmin = (req, res, next) =>
  hasRole(req, 'tenant_admin') ? next() : res.status(403).json({ error: 'Only a tenant admin can change setup' });

const cleanName = (v) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 120 ? v.trim() : null);

setupRouter.get('/tenant', async (req, res, next) => {
  try {
    const row = await withTenant(req.tenantId, async (c) =>
      (await c.query('select id, name, timezone, daylight_rule as "daylightRule" from tenant where id = $1', [req.tenantId])).rows[0]);
    res.json({ ...row, roles: req.roles });
  } catch (err) { next(err); }
});

setupRouter.get('/facilities', async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId, async (c) =>
      (await c.query('select id, name, address from facility order by name')).rows);
    res.json({ facilities: rows });
  } catch (err) { next(err); }
});

setupRouter.post('/facilities', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const row = await withTenant(req.tenantId, async (c) =>
      (await c.query('insert into facility (tenant_id, name, address) values ($1, $2, $3) returning id, name, address',
        [req.tenantId, name, req.body?.address || null])).rows[0]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A facility with that name already exists' });
    next(err);
  }
});

setupRouter.post('/spaces', requireAdmin, async (req, res, next) => {
  try {
    const { facilityId, parentId = null, kind = 'field', hasLights = false, bufferMinutes = 0 } = req.body || {};
    const name = cleanName(req.body?.name);
    if (!name || !facilityId) return res.status(400).json({ error: 'name and facilityId are required' });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > 240)
      return res.status(400).json({ error: 'bufferMinutes must be a whole number from 0 to 240' });

    const row = await withTenant(req.tenantId, async (c) => {
      if (parentId) {
        const { rows } = await c.query('select facility_id from space where id = $1', [parentId]);
        if (!rows.length) return { error: 'Parent space not found' };
        if (rows[0].facility_id !== facilityId) return { error: 'A sub-space must be in the same facility as its parent' };
      }
      return (await c.query(
        `insert into space (tenant_id, facility_id, parent_id, name, kind, has_lights, buffer_minutes)
         values ($1,$2,$3,$4,$5,$6,$7) returning id, facility_id, parent_id, name, kind, has_lights, buffer_minutes`,
        [req.tenantId, facilityId, parentId, name, kind, !!hasLights, bufferMinutes])).rows[0];
    });
    if (row.error) return res.status(400).json(row);
    res.status(201).json(row);
  } catch (err) {
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
    if (b.active !== undefined) add('active', !!b.active);
    if (b.bufferMinutes !== undefined) {
      if (!Number.isInteger(b.bufferMinutes) || b.bufferMinutes < 0 || b.bufferMinutes > 240) return res.status(400).json({ error: 'invalid bufferMinutes' });
      add('buffer_minutes', b.bufferMinutes);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.id);
    const row = await withTenant(req.tenantId, async (c) =>
      (await c.query(`update space set ${sets.join(', ')} where id = $${vals.length}
                      returning id, facility_id, parent_id, name, kind, has_lights, buffer_minutes, active`, vals)).rows[0]);
    row ? res.json(row) : res.status(404).json({ error: 'Space not found' });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Space not found' });
    next(err);
  }
});
