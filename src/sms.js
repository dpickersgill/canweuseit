// Text messages through Twilio. Without credentials they are logged (local development).
import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from './db.js';
import { config } from './config.js';
import { requireUser } from './tenant.js';

export async function sendSms(to, body) {
  const tw = config.twilio;
  const text = `CanWeUseIt: ${body}`.slice(0, 320);
  if (!tw.sid || !tw.token || !(tw.from || tw.messagingService)) { console.log(`[sms:dev] to=${to} ${text}`); return; }
  const params = new URLSearchParams({ To: to, Body: `${text} Reply STOP to opt out.` });
  if (tw.messagingService) params.set('MessagingServiceSid', tw.messagingService); else params.set('From', tw.from);
  const res = await fetch(`${tw.apiBase}/2010-04-01/Accounts/${tw.sid}/Messages.json`, {
    method: 'POST', body: params,
    headers: { Authorization: `Basic ${Buffer.from(`${tw.sid}:${tw.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// US numbers may be typed any way; everything else needs a leading +country code.
export function normalizePhone(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, '');
  if (s.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : undefined;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return undefined;
}

export function twilioSignatureOk(url, params, signature, token) {
  if (!signature || !token) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const want = crypto.createHmac('sha1', token).update(data).digest('base64');
  return want.length === signature.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(signature));
}

// ---- your own contact settings (no tenant needed) ----
export const profileRouter = Router();
profileRouter.get('/profile', requireUser, async (req, res, next) => {
  try {
    const { rows: [u] } = await query('select full_name as "fullName", email, phone, sms_opt_in as "smsOptIn" from app_user where id = $1', [req.userId]);
    res.json({ ...u, textsAvailable: !!(config.twilio.sid && config.twilio.token) });
  } catch (err) { next(err); }
});
profileRouter.patch('/profile', requireUser, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows: [cur] } = await query('select full_name, phone, sms_opt_in from app_user where id = $1', [req.userId]);
    let name = cur.full_name, phone = cur.phone, opt = cur.sms_opt_in;
    if (b.fullName !== undefined) { name = String(b.fullName).trim().slice(0, 120); if (!name) return res.status(400).json({ error: 'Name cannot be empty' }); }
    if (b.phone !== undefined) {
      const p = normalizePhone(b.phone);
      if (p === undefined) return res.status(400).json({ error: 'Enter a mobile number like 610-555-0123, or +44 7700 900123 outside the US' });
      if (p !== phone) opt = false; // a new number must opt in again
      phone = p;
    }
    if (b.smsOptIn !== undefined) {
      if (typeof b.smsOptIn !== 'boolean') return res.status(400).json({ error: 'smsOptIn must be true or false' });
      if (b.smsOptIn && !phone) return res.status(400).json({ error: 'Add a mobile number first' });
      opt = b.smsOptIn;
    }
    const { rows: [u] } = await query(
      `update app_user set full_name = $2, phone = $3, sms_opt_in = $4, sms_opt_in_at = case when $4 and not sms_opt_in then now() else sms_opt_in_at end
        where id = $1 returning full_name as "fullName", email, phone, sms_opt_in as "smsOptIn"`, [req.userId, name, phone, opt]);
    res.json(u);
  } catch (err) { next(err); }
});

// ---- replies from phones: STOP turns texts off (Twilio also blocks further sends on its side) ----
export const smsPublic = Router();
const STOP = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
smsPublic.post('/sms/inbound', async (req, res, next) => {
  try {
    const params = Object.fromEntries(Object.entries(req.body || {}).map(([k, v]) => [k, String(v)]));
    if (!twilioSignatureOk(`${config.appUrl}/sms/inbound`, params, req.headers['x-twilio-signature'], config.twilio.token)) return res.status(403).type('text').send('Bad signature');
    if (STOP.has(String(params.Body || '').trim().toUpperCase()) && params.From) {
      await query('update app_user set sms_opt_in = false where phone = $1', [params.From]);
    }
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) { next(err); }
});
