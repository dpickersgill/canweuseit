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

test('organizations and people: roles are enforced', async () => {
  const org1 = await (await send('POST', '/organizations', userA.id, { name: `Club ${rnd()}`, kind: 'club' })).json();
  const org2 = await (await send('POST', '/organizations', userA.id, { name: `School ${rnd()}`, kind: 'school' })).json();
  assert.ok(org1.id && org2.id);
  assert.equal((await send('POST', '/organizations', userViewer, { name: 'Nope' })).status, 403);
  assert.equal((await send('POST', '/organizations', userA.id, { name: org1.name })).status, 409);

  // admin adds an org admin; they get a sign-in email
  const adminEmail = `oa-${rnd()}@example.com`;
  const n = mails.length;
  let r = await send('POST', `/organizations/${org1.id}/members`, userA.id, { email: adminEmail, fullName: 'Org Admin', role: 'org_admin' });
  assert.equal(r.status, 201);
  assert.equal(mails.length, n + 1);
  assert.match(mails.at(-1), /added you to CanWeUseIt/);
  assert.equal((await send('POST', `/organizations/${org1.id}/members`, userA.id, { email: adminEmail, fullName: 'Org Admin', role: 'org_admin' })).status, 409);

  // that org admin can add bookers to their own org only
  const oaId = (await owner.query('select id from app_user where lower(email)=$1', [adminEmail])).rows[0].id;
  r = await send('POST', `/organizations/${org1.id}/members`, oaId, { email: `bk-${rnd()}@example.com`, fullName: 'Booker', role: 'booker' });
  assert.equal(r.status, 201);
  r = await send('POST', `/organizations/${org2.id}/members`, oaId, { email: `bk-${rnd()}@example.com`, fullName: 'Booker', role: 'booker' });
  assert.equal(r.status, 403);
  r = await send('POST', `/organizations/${org1.id}/members`, oaId, { email: `x-${rnd()}@example.com`, fullName: 'X', role: 'org_admin' });
  assert.equal(r.status, 403);
  assert.equal((await send('POST', '/staff', oaId, { email: `s-${rnd()}@example.com`, fullName: 'S', role: 'tenant_admin' })).status, 403);

  // org admin sees only their own org; staff see all
  const theirs = await (await send('GET', '/organizations', oaId)).json();
  assert.deepEqual(theirs.organizations.map((o) => o.id), [org1.id]);
  assert.ok((await (await send('GET', '/organizations', userA.id)).json()).organizations.length >= 2);
  const members = await (await send('GET', `/organizations/${org1.id}/members`, oaId)).json();
  assert.equal(members.members.length, 2);
  assert.equal((await send('GET', `/organizations/${org2.id}/members`, oaId)).status, 403);
});

test('staff and priority', async () => {
  const email = `ap-${rnd()}@example.com`;
  assert.equal((await send('POST', '/staff', userA.id, { email, fullName: 'Approver', role: 'approver' })).status, 201);
  assert.equal((await send('POST', '/staff', userA.id, { email, fullName: 'Approver', role: 'booker' })).status, 400);
  assert.equal((await send('PUT', '/priority', userA.id, { email, level: 4 })).status, 200);
  assert.equal((await send('PUT', '/priority', userA.id, { email, level: 9 })).status, 400);
  assert.equal((await send('PUT', '/priority', userA.id, { email: userNobody && 'nobody@nowhere.test', level: 2 })).status, 404);
  assert.equal((await send('PUT', '/priority', userViewer, { email, level: 2 })).status, 403);
  const { rows } = await owner.query("select level from user_priority where tenant_id=$1", [A]);
  assert.equal(rows[0].level, 4);
});

test('time zone math survives the March clock change', async () => {
  const { localToUtc, expandWeekly } = await import('../src/time.js');
  assert.equal(localToUtc('2027-03-09', '18:00', 'America/New_York').toISOString(), '2027-03-09T23:00:00.000Z'); // EST, UTC-5
  assert.equal(localToUtc('2027-03-16', '18:00', 'America/New_York').toISOString(), '2027-03-16T22:00:00.000Z'); // EDT, UTC-4
  const d = expandWeekly({ startsOn: '2027-03-02', until: '2027-03-23', weekdays: [2], startTime: '18:00', endTime: '20:00' }, 'America/New_York');
  assert.equal(d.length, 4);
  assert.equal(d[3].startsAt.toISOString(), '2027-03-23T22:00:00.000Z');
});

test('requests: recurring series, priority queue, conflicts, approval, cancel', async () => {
  const mkU = async (label, role, org) => {
    const id = (await owner.query("insert into app_user (email, full_name) values ($1, $2) returning id", [`${label}-${rnd()}@example.com`, label])).rows[0].id;
    await owner.query("insert into role_assignment (tenant_id, user_id, role, organization_id) values ($1,$2,$3,$4)", [A, id, role, org || null]);
    return id;
  };
  const fac = await (await send('POST', '/facilities', userA.id, { name: `Friendship ${rnd()}` })).json();
  const whole = await (await send('POST', '/spaces', userA.id, { facilityId: fac.id, name: 'Whole' })).json();
  const upper = await (await send('POST', '/spaces', userA.id, { facilityId: fac.id, parentId: whole.id, name: 'Upper' })).json();
  const lower = await (await send('POST', '/spaces', userA.id, { facilityId: fac.id, parentId: whole.id, name: 'Lower' })).json();
  const org1 = await (await send('POST', '/organizations', userA.id, { name: `U12 ${rnd()}` })).json();
  const org2 = await (await send('POST', '/organizations', userA.id, { name: `HS ${rnd()}` })).json();
  const b1 = await mkU('b1', 'booker', org1.id), b2 = await mkU('b2', 'booker', org2.id), approver = await mkU('ap', 'approver');
  await owner.query("insert into user_priority (tenant_id, user_id, level) values ($1,$2,5)", [A, b2]);

  const weekly = { startsOn: '2027-03-02', until: '2027-03-23', weekdays: [2], startTime: '18:00', endTime: '20:00' };
  // validation
  assert.equal((await send('POST', '/requests', b1, { organizationId: org2.id, spaceId: upper.id, title: 'x', weekly })).status, 403);
  assert.equal((await send('POST', '/requests', b1, { organizationId: org1.id, spaceId: upper.id, title: 'x' })).status, 400);
  assert.equal((await send('POST', '/requests', b1, { organizationId: org1.id, spaceId: upper.id, title: 'x', weekly: { ...weekly, startsOn: '2020-01-07', until: '2020-01-28' } })).status, 400);

  const r1 = await (await send('POST', '/requests', b1, { organizationId: org1.id, spaceId: upper.id, title: 'U12 practice', weekly })).json();
  assert.equal(r1.dateCount, 4);
  const r2 = await (await send('POST', '/requests', b2, { organizationId: org2.id, spaceId: whole.id, title: 'HS game',
    dates: [{ startsAt: '2027-03-09T23:00:00Z', endsAt: '2027-03-10T01:00:00Z' }] })).json();
  const r3 = await (await send('POST', '/requests', b2, { organizationId: org2.id, spaceId: lower.id, title: 'HS practice',
    dates: [{ startsAt: '2027-03-09T23:00:00Z', endsAt: '2027-03-10T01:00:00Z' }] })).json();
  assert.equal(r2.priority_snapshot, 5);

  // queue order: highest priority first, then earliest submitted
  const q = (await (await send('GET', '/requests?status=pending', approver)).json()).requests.filter((r) => [r1.id, r2.id, r3.id].includes(r.id));
  assert.deepEqual(q.map((r) => r.id), [r2.id, r3.id, r1.id]);
  // a booker sees only their own org's requests
  const own = (await (await send('GET', '/requests', b1)).json()).requests;
  assert.ok(own.every((r) => r.organization_id === org1.id) && own.some((r) => r.id === r1.id));
  assert.equal((await send('POST', `/requests/${r1.id}/decision`, b1, { decision: 'approve' })).status, 403);

  // approve the series for Upper: 4 confirmed
  let d = await (await send('POST', `/requests/${r1.id}/decision`, approver, { decision: 'approve' })).json();
  assert.deepEqual([d.status, d.confirmed, d.flagged], ['approved', 4, 0]);
  // the whole-field request now shows a conflict on its one date, and approving it flags the date
  const view = (await (await send('GET', '/requests?status=pending', approver)).json()).requests.find((r) => r.id === r2.id);
  assert.equal(view.dates[0].conflict, true);
  d = await (await send('POST', `/requests/${r2.id}/decision`, approver, { decision: 'approve' })).json();
  assert.deepEqual([d.confirmed, d.flagged], [0, 1]);
  // the other half is free at the same time
  d = await (await send('POST', `/requests/${r3.id}/decision`, approver, { decision: 'approve' })).json();
  assert.deepEqual([d.confirmed, d.flagged], [1, 0]);
  assert.equal((await send('POST', `/requests/${r3.id}/decision`, approver, { decision: 'approve' })).status, 409);

  // cancelling one Upper date frees it up; only the owning org's admin or staff may
  const r1view = (await (await send('GET', '/requests', approver)).json()).requests.find((r) => r.id === r1.id);
  const firstDate = r1view.dates[0].id;
  assert.equal((await send('POST', `/booking-dates/${firstDate}/cancel`, b1)).status, 403);
  assert.equal((await send('POST', `/booking-dates/${firstDate}/cancel`, approver)).status, 200);
  const slots = await owner.query("select count(*)::int n from blocked_slot where booking_date_id = $1", [firstDate]);
  assert.equal(slots.rows[0].n, 0);

  // decline works and everything is audited
  const r4 = await (await send('POST', '/requests', b1, { organizationId: org1.id, spaceId: upper.id, title: 'later', weekly: { ...weekly, startsOn: '2027-04-06', until: '2027-04-06' } })).json();
  assert.equal((await (await send('POST', `/requests/${r4.id}/decision`, approver, { decision: 'decline' })).json()).status, 'declined');
  const audit = await owner.query("select count(*)::int n from audit_log where tenant_id = $1 and entity = 'request'", [A]);
  assert.equal(audit.rows[0].n, 4);
});
