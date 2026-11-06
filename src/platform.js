// The owner console: for the people who run CanWeUseIt (PLATFORM_ADMIN_EMAILS), not tied to any group.
// Lists every group, changes a group's plan, and lets the owner join a group as admin to help (logged in that group).
import { Router } from 'express';
import { query } from './db.js';
import { config } from './config.js';
import { requireUser } from './tenant.js';

export const platformRouter = Router();
export const plansPublic = Router();

export async function isPlatformAdmin(userId) {
  if (!config.platformAdmins.length) return false;
  const { rows: [u] } = await query('select lower(email) as email from app_user where id = $1', [userId]);
  return !!u && config.platformAdmins.includes(u.email);
}
async function requirePlatform(req, res, next) {
  try { (await isPlatformAdmin(req.userId)) ? next() : res.status(403).json({ error: 'Only the people who run CanWeUseIt can do this' }); } catch (e) { next(e); }
}

// The price list, for the sign-up page and the plan panel.
plansPublic.get('/plans', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select code, name, base_price_cents as "priceCents", annual_price_cents as "annualCents", max_facilities as "maxSites",
              case when included_fields >= 1000 then null else included_fields end as "maxFields", online_payments as "cardPayments", blurb
         from plan order by base_price_cents`);
    res.set('Cache-Control', 'public, max-age=300').json({ plans: rows });
  } catch (err) { next(err); }
});

platformRouter.get('/platform/tenants', requireUser, requirePlatform, async (req, res, next) => {
  try { res.json({ tenants: (await query('select * from platform_tenants()')).rows }); } catch (err) { next(err); }
});
platformRouter.patch('/platform/tenants/:id', requireUser, requirePlatform, async (req, res, next) => {
  try {
    const plan = String(req.body?.plan || '');
    const { rows: [r] } = await query('select platform_set_plan($1, $2) as ok', [req.params.id, plan]);
    r?.ok ? res.json({ ok: true }) : res.status(400).json({ error: 'Unknown group or plan' });
  } catch (err) { if (err.code === '22P02') return res.status(404).json({ error: 'Group not found' }); next(err); }
});
platformRouter.post('/platform/tenants/:id/join', requireUser, requirePlatform, async (req, res, next) => {
  try { await query('select platform_join($1, $2)', [req.params.id, req.userId]); res.json({ ok: true }); }
  catch (err) { if (err.code === '22P02' || err.code === '23503') return res.status(404).json({ error: 'Group not found' }); next(err); }
});
