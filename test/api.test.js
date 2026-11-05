// Runs against a real Postgres that already has migration 001 applied.
// Env: DB_* for the app role (cwui_app), OWNER_DB_PASSWORD for seeding.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

process.env.SESSION_SECRET = 'test-secret';
const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { makeSession } = await import('../src/session.js');

const owner = new pg.Client({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME,
  user: 'cwui_owner', password: process.env.OWNER_DB_PASSWORD,
});
const rnd = () => crypto.randomBytes(4).toString('hex');
let server, base, A, B, userA, userNobody, userViewer;
const mails = [];
const realLog = console.log;

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const tokenFrom = (mail) => new URL(mail.match(/https?:\/\/\S+/)[0]).searchParams.get('token');

before(async () => {
  await owner.connect();
  const mk = async (name) => (await owner.query("insert into tenant (name, slug) values ($1, $2) returning id", [name, `t-${rnd()}`])).rows[0].id;
  A = await mk('Group A'); B = await mk('Group B');
  const mkUser = async (email) => (await owner.query("insert into app_user (email, full_name) values ($1, 'Test') returning id", [email])).rows[0].id;
  userA = { id: await mkUser(`a-${rnd()}@example.com`) };
  userA.email = (await owner.query('select email from app_user where id=$1', [userA.id])).rows[0].email;
  userNobody = await mkUser(`nobody-${rnd()}@example.com`);
  await owner.query("insert into role_assignment (tenant_id, user_id, role) values ($1, $2, 'tenant_admin')", [A, userA.id]);
  userViewer = await mkUser(`viewer-${rnd()}@example.com`);
  await owner.query("insert into role_assignment (tenant_id, user_id, role) values ($1, $2, 'viewer')", [A, userViewer]);
  for (const [t, n] of [[A, 'A Field'], [B, 'B Field']]) {
    const f = (await owner.query("insert into facility (tenant_id, name) values ($1, 'Park') returning id", [t])).rows[0].id;
    await owner.query("insert into space (tenant_id, facility_id, name) values ($1, $2, $3)", [t, f, n]);
  }
  console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[mail:dev]')) mails.push(s); else realLog(...a); };
  server = buildApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  console.log = realLog;
  server.close(); await pool.end(); await owner.end();
});

test('health check', async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
});

test('unknown email gets the same answer and no email', async () => {
  const n = mails.length;
  const r = await post('/auth/request-link', { email: `ghost-${rnd()}@example.com` });
  assert.equal(r.status, 200);
  assert.equal(mails.length, n);
});

test('email link signs in once, then is dead', async () => {
  const r = await post('/auth/request-link', { email: userA.email });
  assert.equal(r.status, 200);
  const token = tokenFrom(mails.at(-1));
  // opening the page (what an email scanner does) must not use up the token
  assert.equal((await fetch(`${base}/auth/verify?token=${token}`)).status, 200);
  const v = await fetch(base + '/auth/verify', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` });
  assert.equal(v.status, 303);
  assert.match(v.headers.get('set-cookie'), /cwui_session=.+HttpOnly/);
  const again = await post('/auth/verify', { token });
  assert.equal(again.status, 400);
});

test('expired token is rejected', async () => {
  await post('/auth/request-link', { email: userA.email });
  const token = tokenFrom(mails.at(-1));
  await owner.query("update login_token set expires_at = now() - interval '1 minute' where token_hash = encode(sha256($1::bytea), 'hex')", [token]);
  assert.equal((await post('/auth/verify', { token })).status, 400);
});

test('at most 5 links per hour per email', async () => {
  const email = `limit-${rnd()}@example.com`;
  await owner.query("insert into app_user (email, full_name) values ($1, 'L')", [email]);
  const n = mails.length;
  for (let i = 0; i < 8; i++) await post('/auth/request-link', { email });
  assert.equal(mails.length - n, 5);
});

test('/me needs a session; a tampered cookie is refused', async () => {
  assert.equal((await fetch(base + '/me')).status, 401);
  const bad = makeSession(userA.id).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await fetch(base + '/me', { headers: { cookie: `cwui_session=${bad}` } })).status, 401);
  const ok = await fetch(base + '/me', { headers: { cookie: `cwui_session=${makeSession(userA.id)}` } });
  const body = await ok.json();
  assert.equal(body.memberships[0].tenant_id, A);
});

test('tenant isolation through the API', async () => {
  const cookie = `cwui_session=${makeSession(userA.id)}`;
  const mine = await (await fetch(base + '/spaces', { headers: { cookie } })).json();
  assert.deepEqual(mine.spaces.map((s) => s.name), ['A Field']);
  // asking for tenant B explicitly is refused
  assert.equal((await fetch(base + '/spaces', { headers: { cookie, 'x-tenant-id': B } })).status, 403);
  // a user with no memberships can't use any tenant
  const none = await fetch(base + '/spaces', { headers: { cookie: `cwui_session=${makeSession(userNobody)}` } });
  assert.equal(none.status, 400);
  assert.equal((await fetch(base + '/spaces')).status, 401);
});

test('tenant setting does not leak between requests on the same connection', async () => {
  const cookie = `cwui_session=${makeSession(userA.id)}`;
  await fetch(base + '/spaces', { headers: { cookie } });
  const { rows } = await pool.query('select count(*)::int n from space'); // no tenant set on this checkout
  assert.equal(rows[0].n, 0);
});

const authed = (uid, extra = {}) => ({ 'content-type': 'application/json', cookie: `cwui_session=${makeSession(uid)}`, ...extra });
const send = (method, path, uid, body) => fetch(base + path, { method, headers: authed(uid), body: body && JSON.stringify(body) });

test('admin builds facility > field > sub-fields with lights', async () => {
  const f = await (await send('POST', '/facilities', userA.id, { name: `Friendship ${rnd()}` })).json();
  assert.ok(f.id);
  const field = await (await send('POST', '/spaces', userA.id, { facilityId: f.id, name: 'Whole Field', hasLights: false })).json();
  assert.equal(field.has_lights, false);
  const upper = await send('POST', '/spaces', userA.id, { facilityId: f.id, parentId: field.id, name: 'Upper' });
  assert.equal(upper.status, 201);
  const lit = await (await send('PATCH', `/spaces/${field.id}`, userA.id, { hasLights: true })).json();
  assert.equal(lit.has_lights, true);
  const list = await (await send('GET', '/spaces', userA.id)).json();
  assert.ok(list.spaces.some((x) => x.name === 'Upper' && x.parent_id === field.id));
});

test('setup rules: viewers can read but not change; bad input is refused', async () => {
  assert.equal((await send('GET', '/facilities', userViewer)).status, 200);
  assert.equal((await send('POST', '/facilities', userViewer, { name: 'Nope' })).status, 403);
  assert.equal((await send('POST', '/facilities', userA.id, {})).status, 400);
  assert.equal((await send('POST', '/spaces', userA.id, { name: 'x' })).status, 400);
  assert.equal((await send('PATCH', '/spaces/not-a-uuid', userA.id, { name: 'x' })).status, 404);
});

test('a space cannot be attached to another tenant\'s facility or parent', async () => {
  const fB = (await owner.query("insert into facility (tenant_id, name) values ($1, $2) returning id", [B, `B-${rnd()}`])).rows[0].id;
  const r = await send('POST', '/spaces', userA.id, { facilityId: fB, name: 'Sneaky' });
  assert.equal(r.status, 400);
  const sB = (await owner.query("insert into space (tenant_id, facility_id, name) values ($1, $2, 'B-space') returning id", [B, fB])).rows[0].id;
  const fA = (await owner.query("insert into facility (tenant_id, name) values ($1, $2) returning id", [A, `A-${rnd()}`])).rows[0].id;
  assert.equal((await send('POST', '/spaces', userA.id, { facilityId: fA, parentId: sB, name: 'Sneaky2' })).status, 400);
});
