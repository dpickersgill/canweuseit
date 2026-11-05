import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'cwui_session';
const MAX_AGE_S = 60 * 60 * 24 * 30;

const sign = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');

export function makeSession(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readSession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now() / 1000 ? uid : null;
  } catch { return null; }
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
}

export function setSessionCookie(res, userId) {
  const parts = [`${COOKIE}=${makeSession(userId)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${MAX_AGE_S}`];
  if (config.isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

export const sessionUserId = (req) => readSession(parseCookies(req.headers.cookie)[COOKIE]);
