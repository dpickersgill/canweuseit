// Self-serve: anyone can start a governing group on the Free plan, then gets a sign-in link by email.
import { Router } from 'express';
import { query } from './db.js';
import { issueLoginLink } from './auth.js';

export const signupPublic = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'signup', 'login', 'auth', 'help', 'support', 'status', 'billing', 'mail', 'canweuseit']);
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

signupPublic.get('/signup-api/slug/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) || RESERVED.has(slug)) return res.json({ available: false });
    const { rows } = await query('select 1 from public_tenant($1)', [slug]);
    res.json({ available: !rows.length });
  } catch (err) { next(err); }
});

signupPublic.post('/signup-api', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim(), fullName = String(b.fullName || '').trim();
    const email = String(b.email || '').trim().toLowerCase(), slug = String(b.slug || '').trim().toLowerCase();
    const timezone = String(b.timezone || 'America/New_York');
    if (name.length < 2 || name.length > 120) return res.status(400).json({ error: 'Enter the name of your group (2 to 120 characters)' });
    if (!fullName || fullName.length > 120) return res.status(400).json({ error: 'Enter your name' });
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email' });
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) || RESERVED.has(slug)) return res.status(400).json({ error: 'The short name can use 3 to 40 lowercase letters, numbers and dashes' });
    if (!validTz(timezone)) return res.status(400).json({ error: 'Unknown time zone' });
    if (b.agree !== true) return res.status(400).json({ error: 'Please accept the terms and privacy policy' });
    try {
      await query('select signup_tenant($1,$2,$3,$4,$5,$6)', [name, slug, timezone, email, fullName, req.ip || null]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'That short name is taken. Try another' });
      if (e.code === 'P0001') return res.status(429).json({ error: 'Too many sign-ups from here today. Try again tomorrow' });
      throw e;
    }
    await issueLoginLink(email, { subject: `Finish setting up ${name} on CanWeUseIt`, intro: `Your group "${name}" is ready on the Free plan. Click to sign in and add your fields (valid for 15 minutes, works once):` });
    res.status(201).json({ ok: true, message: 'Check your email for a link to sign in.' });
  } catch (err) { next(err); }
});
