// Rules, auto-approve, closures, move/withdraw, notifications, documents, calendar feed, import, reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

process.env.SESSION_SECRET = 'test-secret';
process.env.APP_URL = 'http://test.local';
const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { makeSession } = await import('../src/session.js');
const { sunTimes } = await import('../src/sun.js');

const owner = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME, user: 'cwui_owner', password: process.env.OWNER_DB_PASSWORD });
const rnd = () => crypto.randomBytes(4).toString('hex');
const mails = []; const realLog = console.log;
let server, base, T, admin, approver, coach, other, org, org2, upper, lower, whole, litField;

const call = (method, path, uid, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: `cwui_session=${makeSession(uid)}` }, body: body && JSON.stringify(body) });
const json = async (...a) => (await call(...a)).json();
const q = async (sql, p) => (await owner.query(sql, p)).rows;
// next Tuesday-ish dates in the future, far enough out to be stable
const FUTURE = '2027-10-05'; // a Tuesday
const waitMail = async (n) => { for (let i = 0; i < 40 && mails.length < n; i++) await new Promise((r) => setTimeout(r, 25)); };

before(async () => {
  await owner.connect();
  T = (await q("insert into tenant (name, slug, latitude, longitude, plan_code) values ('Rules Group', $1, 39.95, -75.17, 'pro') returning id", [`rg-${rnd()}`]))[0].id;
  const user = async (label, role, orgId) => {
    const id = (await q("insert into app_user (email, full_name) values ($1,$2) returning id", [`${label}-${rnd()}@example.com`, label]))[0].id;
    await q("insert into role_assignment (tenant_id, user_id, role, organization_id) values ($1,$2,$3,$4)", [T, id, role, orgId || null]);
    return id;
  };
  admin = await user('admin', 'tenant_admin'); approver = await user('approver', 'approver');
  const fac = (await q("insert into facility (tenant_id, name) values ($1,'Park') returning id", [T]))[0].id;
  const sp = async (name, parent, lights) => (await q("insert into space (tenant_id, facility_id, parent_id, name, has_lights) values ($1,$2,$3,$4,$5) returning id", [T, fac, parent, name, lights || false]))[0].id;
  whole = await sp('Whole', null); upper = await sp('Upper', whole); lower = await sp('Lower', whole); litField = await sp('Lit Field', null, true);
  org = (await q("insert into organization (tenant_id, name) values ($1,'Club One') returning id", [T]))[0].id;
  org2 = (await q("insert into organization (tenant_id, name) values ($1,'Club Two') returning id", [T]))[0].id;
  coach = await user('coach', 'booker', org); other = await user('other', 'booker', org2);
  console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[mail:dev]')) mails.push(s); else realLog(...a); };
  server = buildApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { console.log = realLog; server.close(); await pool.end(); await owner.end(); });

const req = (uid, orgId, spaceId, date, start, end, extra = {}) =>
  call('POST', '/requests', uid, { organizationId: orgId, spaceId, title: extra.title || `Practice ${rnd()}`, weekly: { startsOn: date, until: date, weekdays: [new Date(`${date}T12:00:00Z`).getUTCDay()], startTime: start, endTime: end }, ...extra });

test('sunset times are right for Philadelphia', () => {
  const tz = (d) => d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  assert.match(tz(sunTimes('2026-12-21', 39.95, -75.17).sunset), /^4:3\d PM$/);
  assert.match(tz(sunTimes('2027-06-21', 39.95, -75.17).sunset), /^8:3\d PM$/);
});

test('hours and daylight rules: block, warn, and lit fields are exempt', async () => {
  assert.equal((await call('PATCH', '/settings', admin, { daylightRule: 'block' })).status, 200);
  // October 5: sunset in Philadelphia is about 6:20 PM, so an 8 PM finish at an unlit field is refused
  let r = await req(coach, org, upper, FUTURE, '18:00', '20:00');
  assert.equal(r.status, 400); assert.match((await r.json()).error, /after sunset/i);
  assert.equal((await req(coach, org, upper, FUTURE, '16:00', '17:30')).status, 201);
  assert.equal((await req(coach, org, litField, FUTURE, '18:00', '21:00')).status, 201); // lights: fine
  // warn mode lets it through with a note for staff
  await call('PATCH', '/settings', admin, { daylightRule: 'warn' });
  r = await req(coach, org, lower, FUTURE, '18:00', '20:00'); assert.equal(r.status, 201);
  const list = (await json('GET', '/requests?status=pending', approver)).requests.find((x) => x.space === 'Lower');
  assert.match(list.dates[0].warning, /sunset/);
  await call('PATCH', '/settings', admin, { daylightRule: 'off' });

  // bookable hours: 7 AM to 9 PM, refused outside
  const h = await call('POST', '/hours', admin, { opens: '07:00', closes: '21:00', enforcement: 'block', note: 'Quiet hours' });
  assert.equal(h.status, 201);
  r = await req(coach, org, litField, FUTURE, '21:00', '22:30'); assert.equal(r.status, 400); assert.match((await r.json()).error, /Outside bookable hours.*Quiet hours/);
  assert.equal((await req(coach, org, litField, FUTURE, '19:00', '20:30')).status, 201);
  assert.equal((await call('DELETE', `/hours/${(await h.json()).id}`, admin)).status, 200);
  assert.equal((await call('PATCH', '/settings', coach, { daylightRule: 'off' })).status, 403);
  assert.equal((await call('PATCH', '/settings', admin, { daylightRule: 'maybe' })).status, 400);
});

test('insurance rule uses documents with expiry dates', async () => {
  await call('PATCH', '/settings', admin, { insuranceRule: 'block' });
  const d = '2027-11-09';
  let r = await req(coach, org, litField, d, '18:00', '19:00'); assert.equal(r.status, 400); assert.match((await r.json()).error, /insurance/i);
  assert.equal((await call('POST', `/organizations/${org}/documents`, other, { kind: 'insurance', expiresOn: '2028-01-01' })).status, 403);
  assert.equal((await call('POST', `/organizations/${org}/documents`, coach, { kind: 'insurance', expiresOn: '2027-06-01' })).status, 403); // bookers can't, org admins can
  assert.equal((await call('POST', `/organizations/${org}/documents`, approver, { kind: 'insurance', expiresOn: '2027-06-01', note: 'expired policy' })).status, 201);
  assert.equal((await req(coach, org, litField, d, '18:00', '19:00')).status, 400); // expired before the date
  assert.equal((await call('POST', `/organizations/${org}/documents`, approver, { kind: 'insurance', expiresOn: '2028-06-01' })).status, 201);
  assert.equal((await req(coach, org, litField, d, '18:00', '19:00')).status, 201);
  const comp = (await json('GET', '/compliance', approver)).organizations;
  assert.equal(comp.find((o) => o.id === org).status, 'ok'); assert.equal(comp.find((o) => o.id === org2).status, 'missing');
  assert.equal((await json('GET', '/compliance', coach)).organizations.length, 1);
  await call('PATCH', '/settings', admin, { insuranceRule: 'off' });
});

test('notifications: staff hear about new requests, requesters about decisions', async () => {
  const n = mails.length;
  const r = await (await req(coach, org, upper, '2027-12-07', '10:00', '11:00', { title: 'Mail test' })).json();
  await waitMail(n + 2);
  const newMails = mails.slice(n).join('\n');
  assert.match(newMails, /New request: Mail test/);
  const m = mails.length;
  await call('POST', `/requests/${r.id}/decision`, approver, { decision: 'decline', note: 'Field is being resodded' });
  await waitMail(m + 1);
  assert.match(mails.at(-1), /Request declined: Mail test/); assert.match(mails.at(-1), /Field is being resodded/);
  const rows = await q("select count(*)::int n from notification where tenant_id = $1 and sent_at is not null", [T]);
  assert.ok(rows[0].n >= 3);
});

test('trusted groups are approved automatically unless something conflicts', async () => {
  assert.equal((await call('PATCH', `/organizations/${org}`, admin, { autoApprove: true })).status, 200);
  assert.equal((await call('PATCH', `/organizations/${org}`, coach, { autoApprove: true })).status, 403);
  const a = await (await req(coach, org, upper, '2028-01-11', '17:00', '18:30')).json();
  assert.equal(a.autoApproved, true); assert.equal(a.status, 'approved');
  // someone else holds the whole field at that time: trusted or not, it waits for a person
  const b = await (await req(other, org2, whole, '2028-01-18', '17:00', '18:30')).json();
  await call('POST', `/requests/${b.id}/decision`, approver, { decision: 'approve' });
  const c = await (await req(coach, org, lower, '2028-01-18', '17:30', '18:00')).json();
  assert.equal(c.autoApproved, false); assert.equal(c.status, 'pending');
  await call('PATCH', `/organizations/${org}`, admin, { autoApprove: false });
});

test('edit, move a single date, and withdraw', async () => {
  const orgAdmin = (await q("insert into app_user (email, full_name) values ($1,'OA') returning id", [`oa-${rnd()}@example.com`]))[0].id;
  await q("insert into role_assignment (tenant_id, user_id, role, organization_id) values ($1,$2,'org_admin',$3)", [T, orgAdmin, org]);
  const r = await (await call('POST', '/requests', coach, { organizationId: org, spaceId: lower, title: 'Series', weekly: { startsOn: '2028-03-07', until: '2028-03-21', weekdays: [2], startTime: '17:00', endTime: '18:00' } })).json();
  assert.equal((await call('PATCH', `/requests/${r.id}`, other, { title: 'Hijack' })).status, 403);
  assert.equal((await json('PATCH', `/requests/${r.id}`, coach, { title: 'Spring series' })).title, 'Spring series');
  await call('POST', `/requests/${r.id}/decision`, approver, { decision: 'approve' });
  const dates = async () => (await json('GET', '/requests', approver)).requests.find((y) => y.id === r.id).dates;
  let ds = await dates(); assert.equal(ds.length, 3);

  // staff move: immediate
  assert.equal((await json('POST', `/booking-dates/${ds[1].id}/move`, approver, { date: '2028-03-16', startTime: '18:00', endTime: '19:00' })).status, 'confirmed');
  // onto a taken slot: refused, and the date stays where it was
  const bad = await call('POST', `/booking-dates/${ds[1].id}/move`, approver, { date: '2028-03-21', startTime: '17:00', endTime: '18:00' });
  assert.equal(bad.status, 409);
  ds = await dates(); assert.equal(ds[1].status, 'confirmed');
  // the requester alone can't move a confirmed date
  assert.equal((await call('POST', `/booking-dates/${ds[0].id}/move`, coach, { date: '2028-03-08', startTime: '17:00', endTime: '18:00' })).status, 403);
  // an organization admin can, but it goes back for approval and frees the old time
  const mv = await json('POST', `/booking-dates/${ds[0].id}/move`, orgAdmin, { date: '2028-03-08', startTime: '17:00', endTime: '18:00' });
  assert.equal(mv.status, 'pending');
  assert.ok((await json('GET', '/requests?status=pending', approver)).requests.some((x) => x.id === r.id));
  const taken = await (await req(other, org2, lower, '2028-03-07', '17:00', '18:00')).json(); // old time is free again
  assert.equal((await json('POST', `/requests/${taken.id}/decision`, approver, { decision: 'approve' })).confirmed, 1);
  assert.equal((await json('POST', `/requests/${r.id}/decision`, approver, { decision: 'approve' })).confirmed, 1);

  // withdrawing releases every future date
  assert.equal((await call('POST', `/requests/${r.id}/withdraw`, other)).status, 403);
  const w = await json('POST', `/requests/${r.id}/withdraw`, coach);
  assert.deepEqual([w.status, w.released], ['cancelled', 3]);
  const left = await q("select count(*)::int n from blocked_slot bs join booking_date bd on bd.id = bs.booking_date_id where bd.request_id = $1", [r.id]);
  assert.equal(left[0].n, 0);
  assert.equal((await call('POST', `/requests/${r.id}/withdraw`, coach)).status, 409);
});

test('closures cancel what they overlap, notify people, and can be lifted', async () => {
  const r = await (await req(coach, org, upper, '2028-05-02', '17:00', '19:00', { title: 'Closure victim' })).json();
  await call('POST', `/requests/${r.id}/decision`, approver, { decision: 'approve' });
  const body = { facilityId: (await q("select id from facility where tenant_id = $1", [T]))[0].id, reason: 'Field aeration', startDate: '2028-05-02', endDate: '2028-05-03' };
  assert.equal((await call('POST', '/closures', coach, body)).status, 403);
  const pre = await json('POST', '/closures', approver, { ...body, preview: true });
  assert.deepEqual([pre.preview, pre.bookings], [true, 1]);
  assert.equal((await q("select status from booking_date where request_id = $1", [r.id]))[0].status, 'confirmed'); // preview changed nothing
  const n = mails.length;
  const done = await json('POST', '/closures', approver, body);
  assert.equal(done.cancelledBookings, 1);
  await waitMail(n + 1);
  assert.match(mails.slice(n).join('\n'), /Field aeration/);
  assert.equal((await q("select status from booking_date where request_id = $1", [r.id]))[0].status, 'cancelled');
  // the closed days now conflict, and a second closure on top is refused
  assert.equal((await req(coach, org, lower, '2028-05-02', '17:00', '18:00')).status, 201);
  const pend = (await json('GET', '/requests?status=pending', approver)).requests.find((x) => x.space === 'Lower' && x.dates[0].startsAt.startsWith('2028-05-02'));
  assert.equal(pend.dates[0].conflict, true);
  assert.equal((await call('POST', '/closures', approver, body)).status, 409);
  const list = (await json('GET', '/closures', approver)).closures;
  assert.ok(list.length >= 2);
  for (const c of list.filter((x) => x.startsAt.startsWith('2028-05'))) assert.equal((await call('DELETE', `/closures/${c.id}`, approver)).status, 200);
  assert.equal((await json('POST', '/closures', approver, { ...body, preview: true })).bookings, 0);
});

test('calendar feed: private link, valid iCalendar, only confirmed bookings', async () => {
  const r = await (await req(coach, org, litField, '2027-09-07', '18:00', '19:30', { title: 'Feed, test; "quotes"' })).json();
  await call('POST', `/requests/${r.id}/decision`, approver, { decision: 'approve' });
  assert.equal((await call('POST', '/calendar-feeds', coach, { organizationId: org2 })).status, 403);
  const mine = await json('POST', '/calendar-feeds', coach, { label: 'Phone', organizationId: org });
  assert.match(mine.url, /^http:\/\/test\.local\/calendar\/[\w-]+\.ics$/);
  const res = await fetch(base + new URL(mine.url).pathname);
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/calendar/);
  const ics = await res.text();
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*END:VCALENDAR/); assert.match(ics, /SUMMARY:Club One: Feed\\, test\\; "quotes"/);
  assert.match(ics, /DTSTART:20270907T220000Z/); // 6 PM Eastern daylight time
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  assert.equal((await fetch(base + '/calendar/not-a-real-token-at-all-0000.ics')).status, 404);
  // stored hashed, never plain
  assert.equal((await q("select count(*)::int n from calendar_feed where token_hash like '%' || $1 || '%'", [mine.url.split('/').pop().replace('.ics', '')]))[0].n, 0);
  assert.equal((await call('DELETE', `/calendar-feeds/${mine.id}`, coach)).status, 200);
  assert.equal((await fetch(base + new URL(mine.url).pathname)).status, 404);
});

test('import: preview first, then create; reports add up', async () => {
  const preview = await json('POST', '/import/spaces', admin, { preview: true, rows: [{ facility: 'North Complex', field: 'Pitch A', section: 'North half', lights: 'yes' }, { facility: 'North Complex', field: 'Pitch A', section: 'South half' }, { field: 'no facility' }] });
  assert.deepEqual([preview.preview, preview.created.facilities, preview.created.spaces, preview.errors.length], [true, 1, 3, 1]);
  assert.equal((await q("select count(*)::int n from facility where name = 'North Complex' and tenant_id = $1", [T]))[0].n, 0);
  const real = await json('POST', '/import/spaces', admin, { rows: [{ facility: 'North Complex', field: 'Pitch A', section: 'North half', lights: 'yes' }, { facility: 'North Complex', field: 'Pitch A', section: 'South half' }] });
  assert.equal(real.created.spaces, 3);
  assert.equal((await json('POST', '/import/spaces', admin, { rows: [{ facility: 'North Complex', field: 'Pitch A', section: 'North half' }] })).created.spaces, 0); // idempotent
  assert.equal((await call('POST', '/import/spaces', approver, { rows: [{ facility: 'x', field: 'y' }] })).status, 403);

  const orgs = await json('POST', '/import/organizations', admin, { rows: [{ name: 'Imported FC', kind: 'club' }, { name: 'Club One' }, { name: 'Bad', kind: 'nope' }] });
  assert.deepEqual([orgs.created.organizations, orgs.errors.length], [1, 1]);

  const rows = [
    { organization: 'Imported FC', space: 'North half', title: 'U10', date: '2028-09-05', start: '17:00', end: '18:30' },
    { organization: 'Imported FC', space: 'North half', title: 'U10', date: '2028-09-12', start: '17:00', end: '18:30' },
    { organization: 'Imported FC', space: 'Pitch A', title: 'Clash', date: '2028-09-12', start: '18:00', end: '19:00' },
    { organization: 'Nobody', space: 'North half', title: 'x', date: '2028-09-12', start: '18:00', end: '19:00' },
  ];
  const pv = await json('POST', '/import/bookings', admin, { preview: true, rows });
  assert.deepEqual([pv.created.requests, pv.created.confirmed, pv.created.conflicts, pv.errors.length], [2, 2, 1, 1]);
  assert.equal((await q("select count(*)::int n from request where title = 'U10' and tenant_id = $1", [T]))[0].n, 0);
  await json('POST', '/import/bookings', admin, { rows });

  const rep = await json('GET', '/reports/usage?from=2028-09-01&to=2028-09-30', approver);
  assert.equal(rep.totalHours, 3); // two 1.5 hour sessions; the clashing one was not booked
  assert.equal(rep.byOrg[0].name, 'Imported FC'); assert.equal(rep.byOrg[0].bookings, 2);
  assert.equal(rep.conflicts, 1);
  assert.equal((await call('GET', '/reports/usage?from=2028-09-01&to=2028-09-30', coach)).status, 403);
  assert.equal((await call('GET', '/reports/usage?from=bad&to=2028-09-30', approver)).status, 400);
});

test('more than fields: pavilions, gyms and classrooms with capacity, indoor rooms skip the sunset rule, rates by type, import by type', async () => {
  const [{ id: facId }] = await q('select id from facility where tenant_id = $1 limit 1', [T]);
  const add = async (b) => { const r = await call('POST', '/spaces', admin, { facilityId: facId, ...b }); return { status: r.status, body: await r.json() }; };
  const pav = await add({ name: 'Main pavilion', kind: 'pavilion', capacity: 120 });
  assert.equal(pav.status, 201); assert.deepEqual([pav.body.kind, pav.body.indoor, pav.body.capacity], ['pavilion', false, 120]);
  const room = await add({ name: 'Room 104', kind: 'classroom', capacity: 30, hasLights: true });
  assert.deepEqual([room.body.indoor, room.body.has_lights], [true, false], 'classrooms are indoors; lights do not apply');
  const court = await add({ name: 'Court 1', kind: 'court', indoor: true });
  assert.equal(court.body.indoor, true, 'a court can be indoors');
  const half = await add({ name: 'Court 1 east', parentId: court.body.id });
  assert.deepEqual([half.body.kind, half.body.indoor], ['court', true], 'sections take after their parent');
  assert.equal((await add({ name: 'Bad', kind: 'spaceship' })).status, 400);
  assert.equal((await add({ name: 'Bad', kind: 'gym', capacity: 0 })).status, 400);
  const listed = (await json('GET', '/spaces', coach)).spaces.find((s) => s.id === room.body.id);
  assert.deepEqual([listed.kind, listed.indoor, listed.capacity], ['classroom', true, 30]);

  // change type and capacity later; the old 'room' kind is gone
  const p = await (await call('PATCH', `/spaces/${pav.body.id}`, admin, { capacity: 150, kind: 'park' })).json();
  assert.deepEqual([p.kind, p.capacity], ['park', 150]);
  await call('PATCH', `/spaces/${pav.body.id}`, admin, { kind: 'pavilion', capacity: null });
  assert.equal((await call('PATCH', `/spaces/${pav.body.id}`, admin, { kind: 'room' })).status, 400);
  assert.equal((await call('PATCH', `/spaces/${pav.body.id}`, coach, { capacity: 10 })).status, 403);

  // sunset rule: an evening meeting in a classroom is fine, an unlit pavilion is not
  await call('PATCH', '/settings', admin, { daylightRule: 'block' });
  const late = '2026-12-14';
  assert.equal((await req(coach, org, room.body.id, late, '18:30', '20:30')).status, 201);
  assert.equal((await req(coach, org, pav.body.id, late, '18:30', '20:30')).status, 400);
  await call('PATCH', '/settings', admin, { daylightRule: 'off' });

  // a rate for every pavilion beats the general rate; one space beats the type
  for (const b of [{ centsPerHour: 1000 }, { centsPerHour: 4000, spaceKind: 'pavilion' }, { centsPerHour: 2500, spaceKind: 'classroom' }])
    assert.equal((await call('POST', '/fee-rates', admin, b)).status, 201);
  assert.equal((await call('POST', '/fee-rates', admin, { centsPerHour: 1, spaceKind: 'castle' })).status, 400);
  assert.equal((await call('POST', '/fee-rates', admin, { centsPerHour: 1, spaceKind: 'gym', spaceId: room.body.id })).status, 400);
  let day = 3;
  const priced = async (spaceId) => {
    const r = await (await req(coach, org, spaceId, `2027-05-${String(day++).padStart(2, '0')}`, '10:00', '12:00')).json();
    await call('POST', `/requests/${r.id}/decision`, admin, { decision: 'approve' });
    return (await json('POST', `/requests/${r.id}/invoice`, admin, { preview: true })).totalCents;
  };
  assert.equal(await priced(pav.body.id), 8000);
  assert.equal(await priced(room.body.id), 5000);
  assert.equal(await priced(court.body.id), 2000);
  assert.equal((await call('POST', '/fee-rates', admin, { centsPerHour: 9000, spaceId: pav.body.id })).status, 201);
  assert.equal(await priced(pav.body.id), 18000);

  // import understands the type column, in plain words
  const rows = [
    { facility: 'Lincoln Elementary', space: 'Gym', type: 'Gymnasium', capacity: '300' },
    { facility: 'Lincoln Elementary', space: 'Room 12', type: 'classroom', capacity: '28' },
    { facility: 'Lincoln Elementary', space: 'All-purpose room', type: 'Multi-purpose room' },
    { facility: 'Riverside Park', space: 'Shelter A', type: 'picnic pavilion' },
    { facility: 'Riverside Park', field: 'Diamond 1', type: 'softball' },
    { facility: 'Riverside Park', space: 'Moon base', type: 'spaceship' },
  ];
  const imp = await json('POST', '/import/spaces', admin, { rows });
  assert.equal(imp.created.spaces, 5); assert.equal(imp.errors.length, 1); assert.match(imp.errors[0].message, /Unknown type/);
  const got = Object.fromEntries((await q("select name, kind, indoor, capacity from space where tenant_id = $1 and name in ('Gym','Room 12','All-purpose room','Shelter A','Diamond 1')", [T])).map((s) => [s.name, [s.kind, s.indoor, s.capacity]]));
  assert.deepEqual(got, { Gym: ['gym', true, 300], 'Room 12': ['classroom', true, 28], 'All-purpose room': ['multipurpose', true, null], 'Shelter A': ['pavilion', false, null], 'Diamond 1': ['diamond', false, null] });
});
