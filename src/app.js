import express from 'express';
import { authRouter } from './auth.js';
import { query, withTenant } from './db.js';
import { requireUser, requireTenant } from './tenant.js';
import { setupRouter } from './setup.js';
import { peopleRouter } from './people.js';
import { requestsRouter } from './requests.js';

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  app.get('/health', async (req, res) => {
    try { await query('select 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });

  app.use('/auth', authRouter);

  // Who am I, and which tenants do I belong to?
  app.get('/me', requireUser, async (req, res, next) => {
    try {
      const { rows: [user] } = await query('select id, email, full_name from app_user where id = $1', [req.userId]);
      const { rows: memberships } = await query('select tenant_id, role, organization_id from user_tenants($1)', [req.userId]);
      res.json({ user, memberships });
    } catch (err) { next(err); }
  });

  // Example tenant-scoped endpoint: every query inside withTenant is isolated by row-level security.
  app.get('/spaces', requireUser, requireTenant, async (req, res, next) => {
    try {
      const rows = await withTenant(req.tenantId, async (c) =>
        (await c.query('select id, facility_id, parent_id, name, kind, has_lights, buffer_minutes from space where active order by name')).rows);
      res.json({ spaces: rows });
    } catch (err) { next(err); }
  });

  app.use(setupRouter);
  app.use(peopleRouter);
  app.use(requestsRouter);

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}
