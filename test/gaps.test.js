// Payments, teams inside a club's time, release and no-shows, utilization, club-app exports, team feeds,
// text alerts, self-serve sign-up and plan limits, field outlines, legal pages and security headers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';

// a stand-in for Stripe and Twilio
const calls = [];
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
    const p = Object.fromEntries(new URLSearchParams(body)); calls.push({ method: req.method, url: req.url, p, headers: req.headers });
    const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/v1/accounts' && req.method === 'POST') return send({ id: 'acct_test1' });
    if (req.url === '/v1/account_links') return send({ url: 'https://connect.stripe.test/onboard' });
    if (req.url.startsWith('/v1/accounts/acct_test1')) return send({ id: 'acct_test1', charges_enabled: true, details_submitted: true });
    if (req.url === '/v1/checkout/sessions') return send({ id: `cs_test_${calls.length}`, url: `https://checkout.stripe.test/${calls.length}` });
    if (req.url === '/v1/refunds') return send({ id: 're_test' });
    if (req.url.includes('/Messages.json')) return send({ sid: 'SM1' }, 201);
    send({ error: { message: 'unknown' } }, 404);
  });
});
await new Promise((r) => fake.listen(0, r));
const fakeBase = `http://127.0.0.1:${fake.address().port}`;
Object.assign(process.env, { SESSION_SECRET: 'test-secret', APP_URL: 'http://test.local', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: fakeBase,
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'twtoken', TWILIO_FROM: '+15550001111', TWILIO_API_BASE: fakeBase, LEGAL_ENTITY: 'Test Fields LLC', PLATFORM_ADMIN_EMAILS: 'owner@cwui.test' });

const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { makeSession } = await import('../src/session.js');

const owner = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME, user: 'cwui_owner', password: process.env.OWNER_DB_PASSWORD });
const rnd = () => crypto.randomBytes(4).toString('hex');
const mails = []; const realLog = console.log;
let server, base, T, admin, approver, grounds, coach, mgr, coach2, org, org2, fac, whole, upper, lower, lit;
const call = (method, path, uid, body, headers = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(uid ? { cookie: `cwui_session=${makeSession(uid)}`, 'x-tenant-id': T } : {}), ...headers }, body: body && JSON.stringify(body) });
const json = async (...a) => (await call(...a)).json();
const q = async (sql, p) => (await owner.query(sql, p)).rows;
const waitFor = async (fn) => { for (let i = 0; i < 80 && !fn(); i++) await new Promise((r) => setTimeout(r, 25)); };
const weekly = (date, start, end) => ({ startsOn: date, until: date, weekdays: [new Date(`${date}T12:00:00Z`).getUTCDay()], startTime: start, endTime: end });
const book = async (uid, o, space, date, s, e, title = `T ${rnd()}`) => {
  const r = await json('POST', '/requests', uid, { organizationId: o, spaceId: space, title, weekly: weekly(date, s, e) });
  await json('POST', `/requests/${r.id}/decision`, admin, { decision: 'approve' });
  const d = (await json('GET', '/requests', admin)).requests.find((x) => x.id === r.id);
  return { requestId: r.id, dateId: d.dates[0].id };
};

before(async () => {
  await owner.connect();
  await q("delete from signup_attempt where ip like '%127.0.0.1'"); // keep reruns under the per-address daily limit
  T = (await q("insert into tenant (name, slug, latitude, longitude, plan_code) values ('Gap Group', $1, 40.13, -75.52, 'standard') returning id", [`gp-${rnd()}`]))[0].id;
  const user = async (label, role, orgId, facilityId) => {
    const id = (await q('insert into app_user (email, full_name) values ($1,$2) returning id', [`${label}-${rnd()}@example.com`, label]))[0].id;
    await q('insert into role_assignment (tenant_id, user_id, role, organization_id, facility_id) values ($1,$2,$3,$4,$5)', [T, id, role, orgId || null, facilityId || null]);
    return id;
  };
  admin = await user('admin', 'tenant_admin'); approver = await user('approver', 'approver');
  fac = (await q("insert into facility (tenant_id, name) values ($1,'Park') returning id", [T]))[0].id;
  const sp = async (name, parent, lights) => (await q('insert into space (tenant_id, facility_id, parent_id, name, has_lights) values ($1,$2,$3,$4,$5) returning id', [T, fac, parent, name, lights || false]))[0].id;
  whole = await sp('Whole', null, true); upper = await sp('Upper', whole, true); lower = await sp('Lower', whole, true); lit = await sp('Lit Field', null, true);
  org = (await q("insert into organization (tenant_id, name) values ($1,'Club One') returning id", [T]))[0].id;
  org2 = (await q("insert into organization (tenant_id, name) values ($1,'Club Two') returning id", [T]))[0].id;
  mgr = await user('mgr', 'org_admin', org); coach = await user('coach', 'booker', org); coach2 = await user('coach2', 'booker', org2);
  grounds = await user('grounds', 'grounds', null, fac);
  console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[mail:dev]')) mails.push(s); else realLog(...a); };
  server = buildApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { console.log = realLog; server.close(); fake.close(); await pool.end(); await owner.end(); });

const signStripe = (raw, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

test('online payments: connect, deposit on approval, card checkout, signed webhook, refunds', async () => {
  assert.equal((await call('POST', '/payments/connect', approver)).status, 403);
  const c = await json('POST', '/payments/connect', admin);
  assert.equal(c.url, 'https://connect.stripe.test/onboard');
  const st = await json('GET', '/payments/status', admin);
  assert.equal(st.ready, true); assert.equal(st.connected, true);
  await call('PATCH', '/settings', admin, { depositCents: 2500 });
  const { requestId } = await book(mgr, org, lit, '2028-05-03', '18:00', '19:00', 'Deposit please');
  const inv = (await json('GET', '/invoices', mgr));
  assert.equal(inv.payOnline, true);
  const dep = inv.invoices.find((i) => i.kind === 'deposit');
  assert.ok(dep && dep.amountCents === 2500 && dep.status === 'open');
  assert.equal((await q("select count(*)::int n from invoice where request_id = $1 and kind = 'deposit'", [requestId]))[0].n, 1);

  assert.equal((await q('select platform_fee_bps from tenant where id = $1', [T]))[0].platform_fee_bps, 0, 'no CanWeUseIt fee by default');
  await q('update tenant set platform_fee_bps = 100 where id = $1', [T]); // a fee can still be set per group
  assert.equal((await call('POST', `/invoices/${dep.id}/checkout`, coach2)).status, 403);
  const co = await json('POST', `/invoices/${dep.id}/checkout`, coach);
  assert.match(co.url, /checkout\.stripe\.test/);
  const sess = calls.filter((x) => x.url === '/v1/checkout/sessions').at(-1).p;
  assert.equal(sess['payment_intent_data[application_fee_amount]'], '25');
  assert.equal(sess['payment_intent_data[transfer_data][destination]'], 'acct_test1');
  assert.equal(sess['line_items[0][price_data][unit_amount]'], '2500');
  const checkoutId = (await q('select checkout_id from invoice where id = $1', [dep.id]))[0].checkout_id;

  const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: checkoutId, payment_status: 'paid', payment_intent: 'pi_1', amount_total: 2500, metadata: { invoice_id: dep.id } } } });
  const hook = (raw, sig) => fetch(`${base}/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: raw });
  assert.equal((await hook(ev, signStripe(ev, 'wrong'))).status, 400);
  assert.equal((await hook(ev, signStripe(ev, 'whsec_test', Math.floor(Date.now() / 1000) - 3600))).status, 400, 'old signatures are refused');
  const wrongAmount = JSON.stringify({ ...JSON.parse(ev), data: { object: { ...JSON.parse(ev).data.object, amount_total: 1 } } });
  assert.equal((await hook(wrongAmount, signStripe(wrongAmount))).status, 200);
  assert.equal((await q('select status from invoice where id = $1', [dep.id]))[0].status, 'open', 'an amount mismatch does not mark it paid');
  assert.equal((await hook(ev, signStripe(ev))).status, 200);
  assert.deepEqual((await q('select status, paid_method, payment_intent from invoice where id = $1', [dep.id]))[0], { status: 'paid', paid_method: 'card', payment_intent: 'pi_1' });

  assert.equal((await call('POST', `/invoices/${dep.id}/refund`, coach, {})).status, 403);
  assert.equal((await call('POST', `/invoices/${dep.id}/refund`, approver, { amountCents: 9999 })).status, 400);
  const r1 = await json('POST', `/invoices/${dep.id}/refund`, approver, { amountCents: 1000 });
  assert.equal(r1.refundedCents, 1000); assert.equal(r1.card, true);
  assert.equal(calls.filter((x) => x.url === '/v1/refunds').at(-1).p.reverse_transfer, 'true');
  await json('POST', `/invoices/${dep.id}/refund`, approver, {});
  assert.equal((await q('select status, refunded_cents from invoice where id = $1', [dep.id]))[0].status, 'refunded');
  await call('PATCH', '/settings', admin, { depositCents: 0 });

  await q("update tenant set plan_code = 'free' where id = $1", [T]);
  assert.equal((await call('POST', '/payments/connect', admin)).status, 402);
  await q("update tenant set plan_code = 'standard' where id = $1", [T]);
});

test('teams placed inside a club\'s time, release of unused time, waitlist hears about it', async () => {
  const add = (uid, name) => call('POST', `/organizations/${org}/teams`, uid, { name });
  assert.equal((await add(coach, 'U10')).status, 403);
  const u10 = await (await add(mgr, 'U10')).json(); const u12 = await (await add(mgr, 'U12')).json(); const u14 = await (await add(mgr, 'U14')).json();
  assert.equal((await add(mgr, 'u10')).status, 409);
  assert.equal((await json('GET', `/organizations/${org}/teams`, coach)).teams.length, 3);
  assert.equal((await call('GET', `/organizations/${org}/teams`, coach2)).status, 403);

  const { dateId } = await book(mgr, org, whole, '2028-06-06', '17:00', '21:00', 'Club block');
  const plan = await json('GET', `/booking-dates/${dateId}/team-slots`, coach);
  assert.equal(plan.canEdit, false); assert.deepEqual(plan.spaces.map((s) => s.name).sort(), ['Lower', 'Upper', 'Whole']);
  const put = (uid, slots) => call('PUT', `/booking-dates/${dateId}/team-slots`, uid, { slots });
  const good = [{ teamId: u10.id, spaceId: upper, start: '17:00', end: '18:30' }, { teamId: u12.id, spaceId: lower, start: '17:00', end: '18:30' }, { teamId: u14.id, spaceId: whole, start: '18:30', end: '20:00' }];
  assert.equal((await put(coach, good)).status, 403);
  assert.equal((await put(mgr, [...good, { teamId: u14.id, spaceId: whole, start: '17:30', end: '18:00' }])).status, 409, 'whole field overlaps a half in use');
  assert.equal((await put(mgr, [{ teamId: u10.id, spaceId: upper, start: '16:00', end: '17:30' }])).status, 400, 'must sit inside the booking');
  assert.equal((await put(mgr, [{ teamId: u10.id, spaceId: lit, start: '17:00', end: '18:00' }])).status, 400, 'another field');
  assert.equal((await (await put(mgr, good)).json()).slots, 3);
  assert.equal((await json('GET', `/booking-dates/${dateId}/team-slots`, coach)).slots.length, 3);

  await call('POST', '/waitlist', coach2, { organizationId: org2, spaceId: upper, date: '2028-06-06', start: '20:00', end: '21:00' });
  const before = mails.length;
  assert.equal((await call('POST', `/booking-dates/${dateId}/release`, mgr, { keepStart: '17:00', keepEnd: '19:00' })).status, 409, 'U14 runs to 20:00');
  const rel = await json('POST', `/booking-dates/${dateId}/release`, mgr, { keepStart: '17:00', keepEnd: '20:00' });
  assert.equal(rel.releasedMinutes, 60);
  await waitFor(() => mails.slice(before).some((m) => /Now open: Upper/.test(m)));
  assert.ok(mails.slice(before).some((m) => /Now open: Upper/.test(m)));
  assert.ok(mails.slice(before).some((m) => /Time given back/.test(m)));
  // the freed hour is bookable by someone else now
  const other = await json('POST', '/requests', coach2, { organizationId: org2, spaceId: upper, title: 'Late slot', weekly: weekly('2028-06-06', '20:00', '21:00') });
  assert.equal((await json('POST', `/requests/${other.id}/decision`, admin, { decision: 'approve' })).confirmed, 1);
  assert.equal((await q('select released_minutes from booking_date where id = $1', [dateId]))[0].released_minutes, 60);
});

test('no-shows, utilization and use-it-or-lose-it flags', async () => {
  const { dateId } = await book(mgr, org, lit, '2028-07-04', '18:00', '20:00', 'Missed one');
  assert.equal((await call('POST', `/booking-dates/${dateId}/no-show`, grounds, {})).status, 409, 'not yet started');
  await q("update booking_date set starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' where id = $1", [dateId]);
  assert.equal((await call('POST', `/booking-dates/${dateId}/no-show`, coach, {})).status, 403);
  assert.equal((await json('POST', `/booking-dates/${dateId}/no-show`, grounds, {})).noShow, true);
  await call('PATCH', '/settings', admin, { noShowLimit: 1, minUsePct: 90 });
  const today = new Date().toISOString().slice(0, 10);
  const u = await json('GET', `/reports/utilization?from=${new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)}&to=${today}`, approver);
  const one = u.byOrg.find((o) => o.name === 'Club One');
  assert.equal(one.noShows, 1); assert.ok(one.flags.some((f) => /no-shows/.test(f))); assert.ok(one.flags.some((f) => /placed last/.test(f)));
  const lf = u.bySpace.find((s) => s.name === 'Lit Field');
  assert.ok(lf.openHours > 0 && lf.usedHours >= 2 && lf.percent > 0);
  assert.deepEqual(u.assumedHours, ['07:00', '22:00']);
  const june = await json('GET', '/reports/utilization?from=2028-06-06&to=2028-06-06', approver);
  const w = june.bySpace.find((s) => s.name === 'Whole');
  assert.equal(w.usedHours, 4, 'the club block 17-20 and the freed hour 20-21 count once each, not per half');
  assert.equal((await call('GET', '/reports/utilization?from=2028-06-06&to=2028-06-06', coach)).status, 403);
  await call('PATCH', '/settings', admin, { noShowLimit: null, minUsePct: null });
});

test('club schedule exports for TeamSnap, SportsEngine and LeagueApps, and a team calendar feed', async () => {
  const teams = (await json('GET', `/organizations/${org}/teams`, mgr)).teams;
  const u10 = teams.find((t) => t.name === 'U10');
  const get = (fmt, extra = '') => call('GET', `/export/club-schedule.csv?organizationId=${org}&format=${fmt}&from=2028-06-01&to=2028-06-30${extra}`, coach);
  const ts = await (await get('teamsnap')).text();
  assert.equal(ts.split('\r\n')[0], 'Date,Time,Name,Location Name,Location Details,Duration (HH:MM),Arrival Time (Minutes),Notes');
  assert.ok(ts.includes('06/06/2028,5:00 PM,U10 practice,Park,Upper,01:30'), ts);
  const se = (await (await get('sportsengine')).text()).split('\r\n');
  assert.equal(se[0].split(',').length, 27); assert.ok(se[0].startsWith('Start_Date,Start_Time,End_Date,End_Time,Title'));
  assert.ok(se.some((l) => l.startsWith('06/06/2028,18:30,06/06/2028,20:00,U14 practice')));
  const la = (await (await get('leagueapps', `&teamId=${u10.id}`)).text()).split('\r\n');
  assert.equal(la[0], 'SUB_PROGRAM,NAME,TYPE,START_DATE,END_DATE,START_TIME,END_TIME,TEAM,LOCATION,SUB_LOCATION,LOCATION_NOTE,DESCRIPTION');
  assert.equal(la.filter(Boolean).length, 2, 'one U10 row');
  assert.ok(la[1].includes(',Practice,06/06/2028,06/06/2028,17:00,18:30,U10,Park,Upper,'));
  assert.equal((await call('GET', `/export/club-schedule.csv?organizationId=${org}&format=teamsnap`, coach2)).status, 403);
  assert.equal((await get('excel')).status, 400);

  // feeds look a year ahead, so plan U10 on a date in the coming weeks
  const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const { dateId } = await book(mgr, org, whole, soon, '17:00', '19:00', 'Soon block');
  await call('PUT', `/booking-dates/${dateId}/team-slots`, mgr, { slots: [{ teamId: u10.id, spaceId: upper, start: '17:00', end: '18:00' }] });
  const feed = await json('POST', '/calendar-feeds', coach, { teamId: u10.id, label: 'U10' });
  const ics = await (await fetch(feed.url.replace('http://test.local', base))).text();
  assert.match(ics.replace(/\r\n /g, ''), /SUMMARY:Club One: U10 at Upper/, ics); assert.ok(!/U12/.test(ics));
  const token = feed.pageUrl.split('/s/')[1];
  const pub = await json('GET', `/public-api/schedule/${token}`);
  assert.equal(pub.organization, 'Club One: U10');
});

test('text alerts: opt in with a phone, closures text you, STOP turns it off', async () => {
  assert.equal((await call('PATCH', '/profile', coach, { smsOptIn: true })).status, 400, 'needs a phone first');
  assert.equal((await call('PATCH', '/profile', coach, { phone: '12' })).status, 400);
  const p = await json('PATCH', '/profile', coach, { phone: '(610) 555-0123', smsOptIn: true });
  assert.equal(p.phone, '+16105550123'); assert.equal(p.smsOptIn, true);
  await book(coach, org, lit, '2028-08-08', '18:00', '19:00', 'Rainy day');
  const n = calls.length;
  await call('POST', '/closures', grounds, { reason: 'Lightning', startDate: '2028-08-08', spaceId: lit });
  await waitFor(() => calls.slice(n).some((x) => x.url.includes('/Messages.json')));
  const sms = calls.slice(n).find((x) => x.url.includes('/Messages.json'));
  assert.equal(sms.p.To, '+16105550123'); assert.match(sms.p.Body, /Lightning/); assert.match(sms.p.Body, /STOP/);
  const params = { From: '+16105550123', Body: 'stop' };
  const sig = crypto.createHmac('sha1', 'twtoken').update('http://test.local/sms/inbound' + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
  const inbound = (s) => fetch(`${base}/sms/inbound`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': s }, body: new URLSearchParams(params) });
  assert.equal((await inbound('nope')).status, 403);
  assert.equal((await inbound(sig)).status, 200);
  assert.equal((await json('GET', '/profile', coach)).smsOptIn, false);
});

test('self-serve sign-up, plan limits and the group switcher', async () => {
  const email = `founder-${rnd()}@example.com`, slug = `vy-${rnd()}`;
  const body = { name: 'Valley Youth', slug, timezone: 'America/Chicago', fullName: 'Fran', email, agree: true };
  assert.equal((await call('POST', '/signup-api', null, { ...body, agree: false })).status, 400);
  assert.equal((await call('POST', '/signup-api', null, { ...body, slug: 'admin' })).status, 400);
  assert.equal((await json('GET', `/signup-api/slug/${slug}`)).available, true);
  const before = mails.length;
  assert.equal((await call('POST', '/signup-api', null, body)).status, 201);
  assert.equal((await json('GET', `/signup-api/slug/${slug}`)).available, false);
  assert.ok(mails.slice(before).some((m) => m.includes(email) && /Finish setting up Valley Youth/.test(m)));
  assert.equal((await call('POST', '/signup-api', null, { ...body, email: `x-${rnd()}@example.com` })).status, 409);
  const [t] = await q('select id, plan_code, timezone from tenant where slug = $1', [slug]);
  assert.deepEqual([t.plan_code, t.timezone], ['free', 'America/Chicago']);
  const founder = (await q('select id from app_user where lower(email) = $1', [email]))[0].id;
  const as = (method, path, b) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `cwui_session=${makeSession(founder)}`, 'x-tenant-id': t.id }, body: b && JSON.stringify(b) });
  const tenant = await (await as('GET', '/tenant')).json();
  assert.equal(tenant.plan.plan, 'free'); assert.equal(tenant.plan.maxFields, 4);
  const f1 = await (await as('POST', '/facilities', { name: 'Main' })).json();
  assert.equal((await as('POST', '/facilities', { name: 'Second' })).status, 402);
  for (const n of ['A', 'B', 'C', 'C2']) assert.equal((await as('POST', '/spaces', { facilityId: f1.id, name: n })).status, 201);
  const fourth = await as('POST', '/spaces', { facilityId: f1.id, name: 'D' });
  assert.equal(fourth.status, 402); assert.match((await fourth.json()).error, /Free plan includes 4 spaces/);
  const a = (await q("select id from space where tenant_id = $1 and name = 'A'", [t.id]))[0].id;
  assert.equal((await as('POST', '/spaces', { facilityId: f1.id, parentId: a, name: 'A north' })).status, 201, 'sections do not count');

  // someone in two groups sees both in the switcher
  await q("insert into role_assignment (tenant_id, user_id, role) values ($1,$2,'approver')", [t.id, approver]);
  const me = await json('GET', '/me', approver);
  assert.deepEqual(me.tenants.map((x) => x.name).sort(), ['Gap Group', 'Valley Youth']);
  for (let i = 0; i < 2; i++) await call('POST', '/signup-api', null, { ...body, slug: `vy-${rnd()}` });
  assert.equal((await call('POST', '/signup-api', null, { ...body, slug: `vy-${rnd()}` })).status, 429, 'three a day per email');
});

test('field outlines for the map, legal pages and security headers', async () => {
  const ring = [[-75.52, 40.13], [-75.519, 40.13], [-75.519, 40.131], [-75.52, 40.131]];
  const r = await json('PATCH', `/spaces/${whole}`, admin, { outline: ring });
  assert.deepEqual(r.outline, ring);
  assert.equal((await call('PATCH', `/spaces/${whole}`, admin, { outline: [[1, 2]] })).status, 400);
  assert.equal((await call('PATCH', `/spaces/${whole}`, admin, { outline: [[0, 0], [0, 1], [500, 1]] })).status, 400);
  assert.equal((await call('PATCH', `/spaces/${whole}`, approver, { outline: ring })).status, 403);
  assert.ok((await json('GET', '/spaces', coach)).spaces.find((s) => s.id === whole).outline);
  assert.equal((await json('PATCH', `/facilities/${fac}`, admin, { latitude: 40.1301, longitude: -75.5201 })).latitude, 40.1301);
  const t = await json('GET', '/tenant', coach);
  assert.match(t.map.tiles, /\{z\}/);

  for (const page of ['privacy', 'terms', 'accessibility', 'dpa']) {
    const res = await fetch(`${base}/${page}`);
    assert.equal(res.status, 200); const html = await res.text();
    assert.ok(html.includes('Test Fields LLC') && !html.includes('{{'), page);
  }
  const home = await fetch(`${base}/`);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const embed = await fetch(`${base}/s/whatever-token-value-123456`);
  assert.match(embed.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal(embed.headers.get('x-frame-options'), null);
  assert.equal((await fetch(`${base}/vendor/leaflet/leaflet.css`)).status, 200);
  assert.equal((await fetch(`${base}/signup`)).status, 200);
  const fav = await fetch(`${base}/favicon.ico`, { redirect: 'manual' });
  assert.equal(fav.status, 301); assert.equal(fav.headers.get('location'), '/favicon.svg');
  assert.equal((await fetch(`${base}/favicon.svg`)).status, 200);
  // the waiting count behind the Requests badge: staff see all, a group sees its own
  const pend = async (uid) => (await json('GET', '/requests/pending-count', uid)).count;
  const before = await pend(admin), mine = await pend(coach2);
  await call('POST', '/requests', coach2, { organizationId: org2, spaceId: lit, title: 'Count me', weekly: weekly('2029-02-06', '18:00', '19:00') });
  assert.equal(await pend(admin), before + 1); assert.equal(await pend(coach2), mine + 1);
});

test('rename the group; remove a field with its sections and future bookings', async () => {
  assert.equal((await call('PATCH', '/settings', approver, { name: 'Ruckets' })).status, 403);
  assert.equal((await call('PATCH', '/settings', admin, { name: 'R' })).status, 400);
  assert.equal((await call('PATCH', '/settings', admin, { name: 'Ruckets' })).status, 200);
  assert.equal((await json('GET', '/tenant', coach)).name, 'Ruckets');
  assert.ok((await json('GET', '/me', approver)).tenants.some((t) => t.name === 'Ruckets'));

  const f = (await q("insert into space (tenant_id, facility_id, name) values ($1,$2,'Old Pitch') returning id", [T, fac]))[0].id;
  const half = (await q("insert into space (tenant_id, facility_id, parent_id, name) values ($1,$2,$3,'Old Half') returning id", [T, fac, f]))[0].id;
  const r = await json('POST', '/requests', coach, { organizationId: org, spaceId: half, title: 'On the old half', weekly: weekly('2029-03-06', '18:00', '19:00') });
  await json('POST', `/requests/${r.id}/decision`, admin, { decision: 'approve' });
  assert.equal((await call('DELETE', `/spaces/${f}`, approver)).status, 403);
  const pv = await json('DELETE', `/spaces/${f}?preview=1`, admin);
  assert.deepEqual([pv.sections, pv.futureBookings], [1, 1]);
  assert.equal((await q('select active from space where id = $1', [f]))[0].active, true, 'preview changes nothing');
  const before = mails.length;
  const done = await json('DELETE', `/spaces/${f}`, admin);
  assert.equal(done.cancelled, 1);
  assert.deepEqual((await q('select active from space where id = any($1) order by name', [[f, half]])).map((x) => x.active), [false, false]);
  assert.equal((await q("select status from booking_date where request_id = $1", [r.id]))[0].status, 'cancelled');
  assert.ok(!(await json('GET', '/spaces', coach)).spaces.some((s) => [f, half].includes(s.id)));
  await waitFor(() => mails.slice(before).some((m) => /Old Pitch is no longer available/.test(m)));
  assert.ok(mails.slice(before).some((m) => /Old Pitch is no longer available/.test(m)));
  assert.equal((await call('DELETE', `/spaces/${f}`, admin)).status, 404, 'already removed');
  await call('PATCH', '/settings', admin, { name: 'Gap Group' });
});

test('price list and the owner console', async () => {
  const { plans } = await (await fetch(`${base}/plans`)).json();
  assert.deepEqual(plans.map((p) => [p.name, p.priceCents, p.annualCents, p.maxSites, p.maxFields, p.cardPayments]),
    [['Free', 0, 0, 1, 4, false], ['Community', 2900, 29000, 3, 15, true], ['League', 7900, 79000, null, null, true]]);
  const found = await q("select id from app_user where lower(email) = 'owner@cwui.test'");
  const owner = found.length ? found[0].id : (await q("insert into app_user (email, full_name) values ('owner@cwui.test', 'Owner') returning id"))[0].id;
  const as = (method, path, b) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `cwui_session=${makeSession(owner)}` }, body: b && JSON.stringify(b) });
  assert.equal((await (await as('GET', '/me')).json()).platformAdmin, true);
  assert.equal((await json('GET', '/me', admin)).platformAdmin, false);
  assert.equal((await call('GET', '/platform/tenants', admin)).status, 403, 'a group admin is not the owner');
  const list = (await (await as('GET', '/platform/tenants')).json()).tenants;
  const mine = list.find((t) => t.id === T);
  assert.ok(mine && mine.fields >= 1 && /admin-/.test(mine.admins));
  assert.equal((await as('PATCH', `/platform/tenants/${T}`, { plan: 'nope' })).status, 400);
  assert.equal((await as('PATCH', `/platform/tenants/${T}`, { plan: 'pro' })).status, 200);
  assert.equal((await q('select plan_code from tenant where id = $1', [T]))[0].plan_code, 'pro');
  assert.equal((await as('POST', `/platform/tenants/${T}/join`)).status, 200);
  assert.equal((await as('POST', `/platform/tenants/${T}/join`)).status, 200, 'joining twice is fine');
  assert.equal((await q("select count(*)::int n from role_assignment where tenant_id = $1 and user_id = $2 and role = 'tenant_admin'", [T, owner]))[0].n, 1);
  assert.ok((await q("select 1 from audit_log where tenant_id = $1 and action = 'platform.join'", [T])).length);
  await q("delete from role_assignment where tenant_id = $1 and user_id = $2", [T, owner]);
  await q("update tenant set plan_code = 'standard' where id = $1", [T]);
});
