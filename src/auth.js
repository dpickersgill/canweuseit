import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from './db.js';
import { config } from './config.js';
import { sendMail } from './mail.js';
import { setSessionCookie, clearSessionCookie } from './session.js';

export const authRouter = Router();

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LINKS_PER_HOUR = 5;

// Creates a one-time link for a registered email and sends it. Returns false if rate-limited.
export async function issueLoginLink(email, { subject, intro }) {
  const { rows: [{ n }] } = await query(
    "select count(*)::int n from login_token where lower(email) = $1 and created_at > now() - interval '1 hour'", [email]);
  if (n >= MAX_LINKS_PER_HOUR) return false;
  const token = crypto.randomBytes(32).toString('base64url');
  await query("insert into login_token (email, token_hash, expires_at) values ($1, $2, now() + interval '15 minutes')", [email, hash(token)]);
  const link = `${config.appUrl}/auth/verify?token=${token}`;
  await sendMail({ to: email, subject, text: `${intro}\n\n${link}\n\nIf you didn't expect this, ignore this email.` });
  return true;
}

// 1. Ask for a sign-in link. The answer is always the same, so nobody can probe which emails are registered.
authRouter.post('/request-link', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const reply = { ok: true, message: 'If that email is registered, a sign-in link is on its way.' };
    if (!EMAIL_RE.test(email) || email.length > 254) return res.json(reply);

    const { rows: users } = await query('select id from app_user where lower(email) = $1', [email]);
    if (!users.length) return res.json(reply);

    await issueLoginLink(email, {
      subject: 'Your CanWeUseIt sign-in link',
      intro: 'Click to sign in (valid for 15 minutes, works once):',
    });
    res.json(reply);
  } catch (err) { next(err); }
});

// 2. The email link lands here. It only shows a button: email scanners that pre-fetch links can't use up the token.
authRouter.get('/verify', (req, res) => {
  const token = String(req.query.token || '').replace(/[^A-Za-z0-9_-]/g, '');
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><body style="font-family:system-ui;max-width:24rem;margin:20vh auto;padding:0 1rem;text-align:center">
<h1 style="font-size:1.4rem">CanWeUseIt</h1>
<form method="post" action="/auth/verify"><input type="hidden" name="token" value="${token}">
<button style="font-size:1rem;padding:.7rem 1.4rem">Finish signing in</button></form></body>`);
});

// 3. Exchange the token for a session. Single use, 15 minutes.
authRouter.post('/verify', async (req, res, next) => {
  try {
    const token = String(req.body?.token || '');
    const { rows } = await query(
      `update login_token set used_at = now()
        where token_hash = $1 and used_at is null and expires_at > now()
        returning email`, [hash(token)]);
    if (!rows.length) return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one.' });
    const { rows: users } = await query('select id from app_user where lower(email) = $1', [rows[0].email]);
    if (!users.length) return res.status(400).json({ error: 'No account for this email.' });
    setSessionCookie(res, users[0].id);
    res.redirect(303, '/');
  } catch (err) { next(err); }
});

authRouter.post('/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
