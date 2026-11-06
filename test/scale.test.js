// Multi-field requests, availability and waitlist, queue tools, applications, rounds, permits, files, notice windows,
// recurring closures, public schedule, site-scoped staff, fees.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

process.env.SESSION_SECRET = 'test-secret';
process.env.APP_URL = 'http://test.local';
const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { makeSession } = await import('../src/session.js');

const owner = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME, user: 'cwui_owner', password: process.env.OWNER_DB_PASSWORD });
const rnd = () => crypto.randomBytes(4).toString('hex');
const mails = []; const realLog = console.log;
let server, base, T, slug, admin, approver, scoped, grounds, coach, coach2, org, org2, parkFac, annexFac, whole, upper, lower, lit, annex1;

const call = (method, path, uid, body) => dbg(method, path, fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(uid ? { cookie: `cwui_session=${makeSession(uid)}` } : {}) }, body: body && JSON.stringify(body) }));
const dbg = async (m, p, pr) => { const r = await pr; if (process.env.DBG && r.status >= 400) { const t = await r.clone().text(); realLog('   !!', m, p.slice(0,70), r.status, t.slice(0,200)); } return r; };
const json = async (...a) => (await call(...a)).json();
const q = async (sql, p) => (await owner.query(sql, p)).rows;
const waitMail = async (n) => { for (let i = 0; i < 60 && mails.length < n; i++) await new Promise((r) => setTimeout(r, 25)); };
const weekly = (date, start, end, extra = {}) => ({ startsOn: date, until: date, weekdays: [new Date(`${date}T12:00:00Z`).getUTCDay()], startTime: start, endTime: end, ...extra });
const ask = (uid, orgId, spaceId, date, start, end, extra = {}) => call('POST', '/requests', uid, { organizationId: orgId, spaceId, title: extra.title || `Practice ${rnd()}`, weekly: weekly(date, start, end), ...extra.body });
const approve = async (id, uid = admin) => json('POST', `/requests/${id}/decision`, uid, { decision: 'approve' });
const listAll = async (uid = admin) => (await json('GET', '/requests', uid)).requests;
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

before(async () => {
  await owner.connect();
  slug = `sc-${rnd()}`;
  T = (await q("insert into tenant (name, slug, latitude, longitude, plan_code) values ('Scale Group', $1, 39.95, -75.17, 'pro') returning id", [slug]))[0].id;
  const user = async (label, role, orgId, facilityId) => {
    const id = (await q('insert into app_user (email, full_name) values ($1,$2) returning id', [`${label}-${rnd()}@example.com`, label]))[0].id;
    await q('insert into role_assignment (tenant_id, user_id, role, organization_id, facility_id) values ($1,$2,$3,$4,$5)', [T, id, role, orgId || null, facilityId || null]);
    return id;
  };
  admin = await user('admin', 'tenant_admin'); approver = await user('approver', 'approver');
  parkFac = (await q("insert into facility (tenant_id, name) values ($1,'Park') returning id", [T]))[0].id;
  annexFac = (await q("insert into facility (tenant_id, name) values ($1,'Annex') returning id", [T]))[0].id;
  const sp = async (fac, name, parent, lights) => (await q('insert into space (tenant_id, facility_id, parent_id, name, has_lights) values ($1,$2,$3,$4,$5) returning id', [T, fac, parent, name, lights || false]))[0].id;
  whole = await sp(parkFac, 'Whole', null); upper = await sp(parkFac, 'Upper', whole); lower = await sp(parkFac, 'Lower', whole); lit = await sp(parkFac, 'Lit Field', null, true);
  annex1 = await sp(annexFac, 'Annex 1', null, true);
  org = (await q("insert into organization (tenant_id, name) values ($1,'Club One') returning id", [T]))[0].id;
  org2 = (await q("insert into organization (tenant_id, name, kind) values ($1,'Club Two','school') returning id", [T]))[0].id;
  coach = await user('coach', 'booker', org); coach2 = await user('coach2', 'booker', org2);
  scoped = await user('scoped', 'approver', null, annexFac); grounds = await user('grounds', 'grounds', null, annexFac);
  console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[mail:dev]')) mails.push(s); else realLog(...a); };
  server = buildApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { console.log = realLog; server.close(); await pool.end(); await owner.end(); });

test('one request covers several fields and teams, every other week, with skipped dates', async () => {
  const r = await call('POST', '/requests', coach, { organizationId: org, title: 'Spring practices', items: [
    { spaceId: upper, label: 'U10', weekly: weekly('2028-03-06', '17:00', '18:30', { until: '2028-03-20', weekdays: [1], everyWeeks: 2 }) },
    { spaceId: lower, label: 'U12', dates: [{ date: '2028-03-08', startTime: '18:00', endTime: '19:30' }] },
    { spaceId: lit, label: 'U14', weekly: weekly('2028-03-06', '19:00', '20:00', { until: '2028-03-27', weekdays: [1], exclude: ['2028-03-13'] }) },
  ] });
  assert.equal(r.status, 201); const body = await r.json();
  assert.equal(body.dateCount, 2 + 1 + 3); // U10: Mar 6 and 20; U12: one; U14: Mar 6, 20, 27
  const mine = (await listAll(coach)).find((x) => x.id === body.id);
  assert.deepEqual([...new Set(mine.dates.map((d) => d.space))].sort(), ['Lit Field', 'Lower', 'Upper']);
  assert.ok(mine.dates.some((d) => d.label === 'U12'));
  const ok = await approve(body.id);
  assert.equal(ok.confirmed, 6);
  assert.equal((await call('POST', '/requests', coach, { organizationId: org, title: 'x', items: [] })).status, 400);
  assert.equal((await call('POST', '/requests', coach, { organizationId: org, title: 'x', weekly: { ...weekly('2028-03-06', '17:00', '18:00'), everyWeeks: 99 }, spaceId: upper })).status, 400);
});

test('availability check suggests other times, fields and days; the waitlist hears when a slot opens', async () => {
  // Upper is booked Mar 6 17:00 to 18:30, so the whole field is partly in use too
  const url = `/availability/check?spaceId=${whole}&date=2028-03-06&start=17:00&end=18:00&organizationId=${org}`;
  const c = await json('GET', url, coach);
  assert.equal(c.free, false);
  const kinds = new Set(c.suggestions.map((s) => s.kind));
  assert.ok(kinds.has('time') && kinds.has('field') && kinds.has('day'), JSON.stringify(c.suggestions));
  assert.ok(c.suggestions.every((s) => s.space && s.date && s.start && s.end));
  assert.equal((await json('GET', `/availability/check?spaceId=${lower}&date=2028-05-02&start=17:00&end=18:00`, coach)).free, true);
  assert.equal((await call('GET', '/availability/check?spaceId=x', coach)).status, 400);

  const w = await call('POST', '/waitlist', coach2, { organizationId: org2, spaceId: upper, date: '2028-03-06', start: '17:00', end: '18:00' });
  assert.equal(w.status, 201);
  assert.equal((await call('POST', '/waitlist', coach2, { organizationId: org, spaceId: upper, date: '2028-03-06', start: '17:00', end: '18:00' })).status, 403);
  assert.equal((await json('GET', '/waitlist', coach)).waitlist.length, 0); // another group's list is private
  const date = (await q("select bd.id from booking_date bd where bd.space_id = $1 and bd.starts_at = (select min(starts_at) from booking_date where space_id = $1 and status = 'confirmed')", [upper]))[0].id;
  const before = mails.length;
  assert.equal((await call('POST', `/booking-dates/${date}/cancel`, approver, {})).status, 200);
  await waitMail(before + 1);
  assert.ok(mails.slice(before).some((m) => /Now open: Upper/.test(m)));
  assert.equal((await json('GET', '/waitlist', coach2)).waitlist[0].status, 'notified');
});

test('queue filters, bulk decisions, CSV export and the audit log', async () => {
  const mk = async (uid, o, space, date, title) => (await (await ask(uid, o, space, date, '17:00', '18:00', { title })).json()).id;
  const a = await mk(coach, org, lower, '2028-04-04', 'Bulk A'), b = await mk(coach2, org2, lower, '2028-04-04', 'Bulk B'), c = await mk(coach, org, upper, '2028-04-05', '=HYPERLINK("x")');
  assert.equal((await json('GET', `/requests?organizationId=${org2}&status=pending`, admin)).requests.every((r) => r.organization_id === org2), true);
  assert.ok((await json('GET', '/requests?q=Bulk', admin)).requests.length >= 2);
  assert.equal((await json('GET', `/requests?q=${a}`, admin)).requests.length, 0);
  assert.equal((await json('GET', `/requests?spaceId=${upper}&from=2028-04-05&to=2028-04-05`, admin)).requests.some((r) => r.id === c), true);
  assert.equal((await call('GET', '/requests?from=nope', admin)).status, 400);
  const res = await json('POST', '/requests/bulk-decision', approver, { ids: [a, b, c, crypto.randomUUID(), 'not-a-uuid'], decision: 'approve', note: 'Season start' });
  assert.equal(res.ok, 3); assert.equal(res.failed, 2);
  // a and b ask for the same slot: tier decides, and the loser is flagged, not lost
  const all = await listAll(admin);
  const flagged = all.filter((r) => [a, b].includes(r.id)).flatMap((r) => r.dates).filter((d) => d.status === 'flagged');
  assert.equal(flagged.length, 1);
  assert.equal((await call('POST', '/requests/bulk-decision', coach, { ids: [a], decision: 'approve' })).status, 403);

  const csv = await call('GET', '/export/bookings.csv', approver);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text.split('\r\n')[0], /^organization,title,team,facility,space,date,start,end,status,permit,warning$/);
  assert.ok(text.includes(`'=HYPERLINK`), 'formulas are defused'); assert.ok(!/(^|,)=HYPERLINK/.test(text));
  assert.equal((await call('GET', '/export/bookings.csv', coach)).status, 403);
  assert.equal((await call('GET', '/export/usage.csv?from=2028-03-01&to=2028-04-30', admin)).status, 200);

  const audit = await json('GET', '/audit?limit=20', admin);
  assert.ok(audit.entries.length > 0 && audit.entries[0].action);
  assert.equal((await call('GET', '/audit', approver)).status, 403);
});

test('group applications: public form, approval creates the group, rate limit, member import', async () => {
  const email = `apply-${rnd()}@example.com`;
  assert.equal((await call('GET', `/apply-api/${slug}`)).status, 200);
  assert.equal((await call('GET', '/apply-api/no-such-group')).status, 404);
  assert.equal((await call('POST', `/apply-api/${slug}`, null, { name: 'Valley FC', kind: 'club', contactName: 'Pat', email: 'bad' })).status, 400);
  assert.equal((await call('POST', `/apply-api/${slug}`, null, { name: 'Valley FC', kind: 'club', contactName: 'Pat', email, notes: 'U8 to U14' })).status, 201);
  assert.equal((await call('GET', '/applications', coach)).status, 403);
  const app = (await json('GET', '/applications', approver)).applications.find((a) => a.contactEmail === email);
  assert.ok(app);
  const before = mails.length;
  assert.equal((await call('POST', `/applications/${app.id}/decision`, approver, { decision: 'approve' })).status, 403); // admins only
  const ok = await call('POST', `/applications/${app.id}/decision`, admin, { decision: 'approve', tier: 4 });
  assert.equal(ok.status, 200);
  await waitMail(before + 1);
  const [o] = await q("select id, tier from organization where tenant_id = $1 and name = 'Valley FC'", [T]);
  assert.equal(o.tier, 4);
  assert.equal((await q("select count(*)::int n from role_assignment ra join app_user u on u.id = ra.user_id where u.email = $1 and ra.role = 'org_admin' and ra.organization_id = $2", [email, o.id]))[0].n, 1);
  assert.ok(mails.slice(before).some((m) => m.includes(email)));
  assert.equal((await call('POST', `/applications/${app.id}/decision`, admin, { decision: 'decline' })).status, 409);
  for (let i = 0; i < 2; i++) await call('POST', `/apply-api/${slug}`, null, { name: `G${i}`, contactName: 'Pat', email });
  assert.equal((await call('POST', `/apply-api/${slug}`, null, { name: 'G9', contactName: 'Pat', email })).status, 429);

  const rows = [{ organization: 'Valley FC', name: 'Sam', email: `sam-${rnd()}@example.com`, role: 'manager' }, { organization: 'Valley FC', name: 'Lee', email: `lee-${rnd()}@example.com` },
    { organization: 'Nope FC', name: 'X', email: 'x@example.com' }, { organization: 'Valley FC', name: 'Bad', email: 'bad' }];
  const prev = await json('POST', '/import/members', admin, { rows, preview: true });
  assert.equal(prev.created.people, 2); assert.equal(prev.errors.length, 2);
  assert.equal((await q('select count(*)::int n from app_user where email = $1', [rows[0].email]))[0].n, 0);
  const real = await json('POST', '/import/members', admin, { rows });
  assert.equal(real.created.people, 2);
  assert.equal((await q("select count(*)::int n from role_assignment ra join app_user u on u.id = ra.user_id where u.email = $1 and ra.role = 'org_admin'", [rows[0].email]))[0].n, 1);
  assert.equal((await json('POST', '/import/members', admin, { rows })).created.people, 0); // rerun adds nobody
  assert.equal((await call('POST', '/import/members', coach, { rows })).status, 403);
});

test('allocation rounds: window and season, tiers decide, group cap, rollover from last season', async () => {
  await call('PATCH', `/organizations/${org2}`, admin, { tier: 5 });
  assert.equal((await call('PATCH', `/organizations/${org2}`, admin, { tier: 9 })).status, 400);
  const mkRound = async (name, season, extra = {}) => (await (await call('POST', '/rounds', admin, { name, opensAt: new Date(Date.now() - 3600000).toISOString(), closesAt: new Date(Date.now() + 86400000).toISOString(), seasonStart: season[0], seasonEnd: season[1], ...extra })).json()).id;
  const round = await mkRound('Fall 2028', ['2028-09-01', '2028-12-31'], { maxHoursPerOrg: 5 });
  assert.equal((await call('POST', '/rounds', coach, {})).status, 403);
  const inRound = (uid, o, date, s, e, title) => call('POST', '/requests', uid, { organizationId: o, spaceId: lower, title, roundId: round, weekly: weekly(date, s, e) });
  assert.equal((await inRound(coach, org, '2029-01-09', '17:00', '18:00', 'Out of season')).status, 400);
  const c1 = await (await inRound(coach, org, '2028-09-05', '17:00', '19:00', 'One first')).json();
  const c2 = await (await inRound(coach2, org2, '2028-09-05', '17:00', '19:00', 'Two second')).json();
  const c3 = await (await inRound(coach, org, '2028-09-12', '17:00', '23:00', 'One over cap')).json();
  assert.ok(c1.id && c2.id && c3.id);
  const queue = (await json('GET', `/requests?roundId=${round}&status=pending`, admin)).requests.map((r) => r.id);
  assert.equal(queue[0], c2.id, 'tier 5 goes first');
  const prev = await json('POST', `/rounds/${round}/allocate`, admin, { preview: true });
  assert.equal(prev.preview, true); assert.equal((await q("select status from request where id = $1", [c2.id]))[0].status, 'pending');
  const run = await json('POST', `/rounds/${round}/allocate`, admin, {});
  const by = Object.fromEntries(run.results.map((r) => [r.id, r]));
  assert.equal(by[c2.id].confirmed, 1);
  assert.equal(by[c1.id].flagged, 1, 'the lower tier lost the contested slot');
  assert.match(by[c3.id].skipped, /cap/);
  assert.equal((await q('select status from request where id = $1', [c2.id]))[0].status, 'approved');
  assert.equal((await call('POST', `/rounds/${round}/allocate`, approver, {})).status, 403);

  await call('PATCH', `/rounds/${round}`, admin, { status: 'closed' });
  const late = await inRound(coach, org, '2028-10-03', '17:00', '18:00', 'Too late');
  assert.equal(late.status, 409);
  assert.equal((await call('POST', '/requests', admin, { organizationId: org, spaceId: lower, title: 'Staff may', roundId: round, weekly: weekly('2028-10-03', '17:00', '18:00') })).status, 201);

  const next = await mkRound('Fall 2029', ['2029-09-01', '2029-12-31']);
  const body = { fromStart: '2028-09-01', fromEnd: '2028-12-31' };
  const pv = await json('POST', `/rounds/${next}/rollover`, admin, { ...body, preview: true });
  assert.ok(pv.requests >= 1 && pv.preview); assert.equal(pv.shiftedDays % 7, 0);
  assert.equal((await q('select count(*)::int n from request where round_id = $1', [next]))[0].n, 0);
  const real = await json('POST', `/rounds/${next}/rollover`, admin, body);
  assert.equal(real.requests, pv.requests);
  const moved = (await json('GET', `/requests?roundId=${next}`, admin)).requests;
  assert.ok(moved.every((r) => r.status === 'pending' && /Carried over/.test(r.notes)));
  const d = new Date(moved[0].dates[0].startsAt);
  assert.equal(d.getUTCDay(), 2 /* Tuesday, same weekday as 2028-09-05 */); assert.equal(d.getUTCFullYear(), 2029);
  assert.equal((await json('POST', `/rounds/${next}/rollover`, admin, body)).requests, 0, 'running it twice adds nothing');
});

test('permits: issued on approval, public check, revoke, only the group sees its own', async () => {
  const id = (await (await ask(coach, org, lit, '2028-05-02', '18:00', '20:00', { title: 'Permit me' })).json()).id;
  assert.equal((await json('GET', `/requests/${id}/permit`, coach)).permit, null);
  assert.equal((await call('POST', `/requests/${id}/permit`, admin)).status, 409); // not approved yet
  await approve(id);
  const p = await json('GET', `/requests/${id}/permit`, coach);
  assert.match(p.number, /^P-\d{4}-\d{4}$/); assert.match(p.url, /\/permit\//);
  assert.equal((await call('GET', `/requests/${id}/permit`, coach2)).status, 403);
  const pub = await json('GET', `/permit-api/${p.code}`);
  assert.equal(pub.valid, true); assert.equal(pub.organization, 'Club One'); assert.equal(pub.dates.length, 1);
  assert.equal((await call('GET', '/permit-api/AAAAAAAAAAAA')).status, 404);
  assert.equal((await call('GET', `/permit/${p.code}`)).status, 200); // the printable page
  assert.equal((await call('POST', `/requests/${id}/permit/revoke`, coach)).status, 403);
  assert.equal((await call('POST', `/requests/${id}/permit/revoke`, approver)).status, 200);
  assert.equal((await json('GET', `/permit-api/${p.code}`)).valid, false);
});

test('insurance: coverage amount rule and certificate upload', async () => {
  await call('PATCH', '/settings', admin, { insuranceRule: 'warn', minCoverage: 1000000, requireAdditionalInsured: true });
  const doc = (body) => call('POST', `/organizations/${org}/documents`, admin, { kind: 'insurance', expiresOn: '2030-01-01', ...body });
  const low = await (await doc({ coverageAmount: 500000, additionalInsured: true })).json();
  let r = await (await ask(coach, org, lit, '2028-06-06', '18:00', '19:00')).json();
  let mine = (await listAll(coach)).find((x) => x.id === r.id);
  assert.match(mine.dates[0].warning, /below the required \$1,000,000/);
  const ok = await (await doc({ coverageAmount: 1000000, additionalInsured: false })).json();
  r = await (await ask(coach, org, lit, '2028-06-13', '18:00', '19:00')).json();
  assert.match((await listAll(coach)).find((x) => x.id === r.id).dates[0].warning, /additional insured/);
  await call('POST', `/organizations/${org}/documents`, admin, { kind: 'insurance', expiresOn: '2030-01-01', coverageAmount: 2000000, additionalInsured: true });
  r = await (await ask(coach, org, lit, '2028-06-20', '18:00', '19:00')).json();
  assert.equal((await listAll(coach)).find((x) => x.id === r.id).dates[0].warning, null);
  await call('PATCH', '/settings', admin, { insuranceRule: 'off', minCoverage: null, requireAdditionalInsured: false });

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
  const put = (uid, buf, type = 'application/pdf') => fetch(`${base}/documents/${ok.id}/file`, { method: 'POST', headers: { 'content-type': type, 'x-file-name': 'cert.pdf', cookie: `cwui_session=${makeSession(uid)}` }, body: buf });
  assert.equal((await put(coach, pdf)).status, 403);
  assert.equal((await put(admin, Buffer.from('not a pdf'))).status, 415);
  assert.equal((await put(admin, pdf)).status, 200);
  const got = await call('GET', `/documents/${ok.id}/file`, coach);
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'application/pdf'); assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('GET', `/documents/${ok.id}/file`, coach2)).status, 403);
  const docs = (await json('GET', `/organizations/${org}/documents`, coach)).documents;
  assert.ok(docs.find((d) => d.id === ok.id).hasFile); void low;
});

test('cancelling inside the notice window is marked late; closures can repeat weekly', async () => {
  await call('PATCH', '/settings', admin, { cancelNoticeHours: 72 });
  const soon = plusDays(2);
  const id = (await (await ask(coach, org, lit, soon, '15:00', '16:00', { title: 'Soon' })).json()).id;
  await approve(id);
  const dateId = (await listAll(coach)).find((x) => x.id === id).dates[0].id;
  const before = mails.length;
  const cancel = await json('POST', `/booking-dates/${dateId}/cancel`, coach, {});
  assert.equal(cancel.late, true);
  assert.equal((await q('select late_cancel from booking_date where id = $1', [dateId]))[0].late_cancel, true);
  await waitMail(before + 1); assert.ok(mails.slice(before).some((m) => /Late cancellation/.test(m)));
  await call('PATCH', '/settings', admin, { cancelNoticeHours: 0 });
  const id2 = (await (await ask(coach, org, lit, plusDays(3), '15:00', '16:00', { title: 'Soon2' })).json()).id; await approve(id2);
  const d2 = (await listAll(coach)).find((x) => x.id === id2).dates[0].id;
  assert.equal((await json('POST', `/booking-dates/${d2}/cancel`, coach, {})).late, false);

  const booked = (await (await ask(coach, org, lit, '2028-04-10', '08:30', '09:30', { title: 'Monday morning' })).json()).id; await approve(booked);
  const body = { reason: 'Aeration', startDate: '2028-04-03', endDate: '2028-04-24', weekdays: [1], startTime: '08:00', endTime: '10:00', spaceId: lit };
  const prev = await json('POST', '/closures', approver, { ...body, preview: true });
  assert.equal(prev.days, 4); assert.equal(prev.bookings, 1);
  const done = await json('POST', '/closures', approver, body);
  assert.equal(done.closures, 4); assert.equal(done.cancelledBookings, 1);
  assert.equal((await call('POST', '/closures', approver, { ...body, weekdays: [9] })).status, 400);
  assert.equal((await call('POST', '/closures', coach, body)).status, 403);
  const first = (await json('GET', '/closures', coach)).closures.find((c) => c.reason === 'Aeration');
  assert.equal((await call('DELETE', `/closures/${first.id}`, approver)).status, 200);
});

test('public schedule page, a site-scoped approver and a groundskeeper', async () => {
  const feed = await json('POST', '/calendar-feeds', coach, { organizationId: org });
  assert.match(feed.pageUrl, /\/s\/[A-Za-z0-9_-]+$/);
  const token = feed.pageUrl.split('/s/')[1];
  const id = (await (await ask(coach, org, lit, plusDays(20), '18:00', '19:00', { title: 'Visible to parents' })).json()).id; await approve(id);
  const sched = await json('GET', `/public-api/schedule/${token}`);
  assert.equal(sched.organization, 'Club One'); assert.ok(sched.events.some((e) => e.title === 'Visible to parents'));
  assert.ok(sched.events.every((e) => e.organization === 'Club One'), 'only this group');
  assert.equal((await call('GET', `/s/${token}`)).status, 200);
  assert.equal((await call('GET', '/public-api/schedule/short')).status, 404);

  const park = (await (await ask(coach, org, upper, '2028-07-11', '17:00', '18:00', { title: 'Park request' })).json()).id;
  const ann = (await (await ask(coach, org, annex1, '2028-07-11', '17:00', '18:00', { title: 'Annex request' })).json()).id;
  const seen = (await listAll(scoped)).map((r) => r.id);
  assert.ok(seen.includes(ann) && !seen.includes(park));
  assert.equal((await call('POST', `/requests/${park}/decision`, scoped, { decision: 'approve' })).status, 403);
  assert.equal((await call('POST', `/requests/${ann}/decision`, scoped, { decision: 'approve' })).status, 200);
  const bulk = await json('POST', '/requests/bulk-decision', scoped, { ids: [park], decision: 'approve' });
  assert.equal(bulk.failed, 1);

  const close = (uid, space) => call('POST', '/closures', uid, { reason: 'Wet field', startDate: '2028-09-01', spaceId: space });
  assert.equal((await close(grounds, annex1)).status, 201);
  assert.equal((await close(grounds, lit)).status, 403);
  assert.equal((await close(scoped, lit)).status, 403);
  assert.equal((await call('GET', '/requests', grounds)).status, 200); // read access works
  const added = await call('POST', '/staff', admin, { fullName: 'Gus', email: `gus-${rnd()}@example.com`, role: 'grounds', facilityId: annexFac });
  assert.equal(added.status, 201);
  assert.equal((await call('POST', '/staff', admin, { fullName: 'Gus', email: `gus2-${rnd()}@example.com`, role: 'grounds' })).status, 400);
});

test('fees: most specific rate wins, invoice, pay, and unpaid invoices can hold new requests', async () => {
  assert.equal((await call('POST', '/fee-rates', approver, { facilityId: parkFac, centsPerHour: 5000 })).status, 403);
  await call('POST', '/fee-rates', admin, { facilityId: parkFac, centsPerHour: 5000, note: 'Park standard' });
  await call('POST', '/fee-rates', admin, { spaceId: lit, centsPerHour: 8000 });
  assert.equal((await call('POST', '/fee-rates', admin, { spaceId: lit, facilityId: parkFac, centsPerHour: 1 })).status, 400);
  const id = (await (await call('POST', '/requests', coach, { organizationId: org, title: 'Paid use', items: [
    { spaceId: lit, weekly: weekly('2028-08-01', '18:00', '20:00', { until: '2028-08-08', weekdays: [2] }) }, { spaceId: lower, dates: [{ date: '2028-08-03', startTime: '18:00', endTime: '19:00' }] }] })).json()).id;
  assert.equal((await call('POST', `/requests/${id}/invoice`, admin, {})).status, 400); // nothing confirmed yet
  await approve(id);
  const pv = await json('POST', `/requests/${id}/invoice`, admin, { preview: true });
  assert.equal(pv.totalCents, 2 * 2 * 8000 + 5000); // 2 dates x 2 h at $80 on the lit field, 1 h at $50 on Lower
  const inv = await json('POST', `/requests/${id}/invoice`, approver, { dueDays: 14 });
  assert.match(inv.number, /^INV-\d{4}-\d{4}$/); assert.equal(inv.lines.length, 2);
  assert.equal((await json('GET', '/invoices', coach)).invoices.length, 1);
  assert.equal((await json('GET', '/invoices', coach2)).invoices.length, 0);
  assert.equal((await call('POST', `/invoices/${inv.id}/pay`, coach, {})).status, 403);

  await call('PATCH', '/settings', admin, { holdUnpaid: true });
  assert.equal((await ask(coach, org, lit, '2028-09-19', '18:00', '19:00')).status, 201, 'not overdue yet');
  await q("update invoice set due_on = current_date - 3 where id = $1", [inv.id]);
  const held = await ask(coach, org, lit, '2028-09-26', '18:00', '19:00');
  assert.equal(held.status, 409); assert.match((await held.json()).error, /unpaid invoice/);
  assert.equal((await call('POST', `/invoices/${inv.id}/pay`, approver, { method: 'check', reference: '1042' })).status, 200);
  assert.equal((await ask(coach, org, lit, '2028-09-26', '18:00', '19:00')).status, 201);
  assert.equal((await call('POST', `/invoices/${inv.id}/void`, approver)).status, 409); // already paid
  const csv = await (await call('GET', '/export/invoices.csv', admin)).text();
  assert.ok(csv.includes(inv.number) && csv.includes('1042'));
  await call('PATCH', '/settings', admin, { holdUnpaid: false });
});
