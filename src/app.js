import express from 'express';
import { authRouter } from './auth.js';
import { query, withTenant } from './db.js';
import { requireUser, requireTenant } from './tenant.js';
import { setupRouter } from './setup.js';
import { peopleRouter } from './people.js';
import { requestsRouter } from './requests.js';
import { closuresRouter } from './closures.js';
import { settingsRouter } from './settings.js';
import { complianceRouter } from './compliance.js';
import { calendarPublic, calendarRouter } from './calendar.js';
import { reportsRouter } from './reports.js';
import { importRouter } from './import.js';
import { availabilityRouter } from './availability.js';
import { adminRouter, applyPublic } from './admin.js';
import { roundsRouter } from './rounds.js';
import { permitsRouter, permitsPublic } from './permits.js';
import { feesRouter } from './fees.js';
import { paymentsRouter, paymentsPublic } from './payments.js';
import { teamsRouter } from './teams.js';
import { exportsRouter } from './exports.js';
import { profileRouter, smsPublic } from './sms.js';
import { signupPublic } from './signup.js';
import { platformRouter, plansPublic, isPlatformAdmin } from './platform.js';
import { readFileSync } from 'node:fs';
import { config } from './config.js';

const tileHost = (() => { try { return new URL(config.map.tiles.replace(/\{[a-z]\}/g, '0')).origin; } catch { return ''; } })();
// Every response: no sniffing, no framing (except the embeddable schedule page), a strict content policy.
function securityHeaders(req, res, next) {
  const embeddable = req.path.startsWith('/s/') || req.path.startsWith('/js/schedule');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data: blob: ${tileHost}`.trim(), "connect-src 'self'", "form-action 'self'", "base-uri 'none'", "object-src 'none'",
    `frame-ancestors ${embeddable ? '*' : "'none'"}`].join('; '));
  if (!embeddable) res.set('X-Frame-Options', 'DENY');
  next();
}
const LEGAL = ['privacy', 'terms', 'accessibility', 'dpa'];
const legalPage = (name) => readFileSync(new URL(`../public/legal/${name}.html`, import.meta.url), 'utf8')
  .replaceAll('{{ENTITY}}', config.legal.entity).replaceAll('{{CONTACT}}', config.legal.contact).replaceAll('{{STATE}}', config.legal.state).replaceAll('{{UPDATED}}', 'November 6, 2026');

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloud Run sits behind one proxy; req.ip is the caller
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/stripe/')) req.rawBody = buf; } }));
  app.use('/vendor/leaflet', express.static(new URL('../node_modules/leaflet/dist', import.meta.url).pathname, { maxAge: '7d' }));
  app.use(express.static(new URL('../public', import.meta.url).pathname, { maxAge: '5m', index: 'index.html' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

  app.get('/health', async (req, res) => {
    try { await query('select 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });

  app.use('/auth', authRouter);
  app.use(calendarPublic); // secret-URL feeds, no session
  app.use(applyPublic); // group application form, no session
  app.use(permitsPublic); // permit check, no session
  app.use(paymentsPublic); // Stripe webhook, signature checked
  app.use(smsPublic); // Twilio replies (STOP), signature checked
  const page = (file) => (req, res) => res.sendFile(new URL(`../public/${file}`, import.meta.url).pathname);
  app.get('/apply/:slug', page('apply.html'));
  app.get('/permit/:code', page('permit.html'));
  app.get('/s/:token', page('schedule.html'));
  app.get('/signup', page('signup.html'));
  app.use(signupPublic);
  app.use(plansPublic); // the price list
  for (const name of LEGAL) { const html = legalPage(name); app.get(`/${name}`, (req, res) => res.type('html').send(html)); }

  // Who am I, and which tenants do I belong to?
  app.get('/me', requireUser, async (req, res, next) => {
    try {
      const { rows: [user] } = await query('select id, email, full_name from app_user where id = $1', [req.userId]);
      const { rows: memberships } = await query('select tenant_id, role, organization_id, facility_id from user_tenants($1)', [req.userId]);
      const { rows: tenants } = await query('select id, name, slug from user_tenant_names($1)', [req.userId]);
      res.json({ user, memberships, tenants, platformAdmin: await isPlatformAdmin(req.userId) });
    } catch (err) { next(err); }
  });

  app.use(profileRouter); // your own name, phone and text alerts
  app.use(platformRouter); // owner console, no group needed

  // Example tenant-scoped endpoint: every query inside withTenant is isolated by row-level security.
  app.get('/spaces', requireUser, requireTenant, async (req, res, next) => {
    try {
      const rows = await withTenant(req.tenantId, async (c) =>
        (await c.query('select id, facility_id, parent_id, name, kind, has_lights, buffer_minutes, outline from space where active order by name')).rows);
      res.json({ spaces: rows });
    } catch (err) { next(err); }
  });

  app.use(setupRouter);
  app.use(peopleRouter);
  app.use(requestsRouter);
  app.use(closuresRouter);
  app.use(settingsRouter);
  app.use(complianceRouter);
  app.use(calendarRouter);
  app.use(reportsRouter);
  app.use(importRouter);
  app.use(availabilityRouter);
  app.use(adminRouter);
  app.use(roundsRouter);
  app.use(permitsRouter);
  app.use(teamsRouter);
  app.use(exportsRouter);
  app.use(paymentsRouter);
  app.use(feesRouter);

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}
