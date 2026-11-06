// CanWeUseIt web app. No build step; all text goes through el() so nothing user-supplied is ever parsed as HTML.
import { seasonsView, billingView, applicationsPanel, activityPanel, invoiceBox, download, money } from './more.js';
import { mapPicker, mapEditor, hasMap, teamPlanBox, releaseBox, noShowButton, teamsPanel, paymentsPanel, planPanel, utilizationPanel, profileView } from './gaps.js';
const $app = document.getElementById('app');
const state = { me: null, tenants: [], tenant: null, view: 'schedule', spaces: [], orgs: [], weekStart: null, month: null, calMode: 'month', selectedDay: null, prefill: null, compliance: [], report: null, spaceFilter: '', rq: null };

/* ---------- helpers ---------- */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 3500);
}
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.tenant) headers['x-tenant-id'] = state.tenant.id;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { state.me = null; render(); throw new Error('Sign in required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const tz = () => state.tenant?.timezone || 'America/New_York';
const fmt = (d, o) => new Intl.DateTimeFormat('en-US', { timeZone: tz(), ...o }).format(new Date(d));
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const timeRange = (a, b) => `${fmt(a, { hour: 'numeric', minute: '2-digit' })} to ${fmt(b, { hour: 'numeric', minute: '2-digit' })}`;
const dayLabel = (d) => fmt(d, { weekday: 'short', month: 'short', day: 'numeric' });
const addDays = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (s) => { const dow = new Date(`${s}T12:00:00Z`).getUTCDay(); return addDays(s, -((dow + 6) % 7)); };
const isStaff = () => state.tenant.roles.some((r) => ['tenant_admin', 'approver'].includes(r.role));
const canClose = () => state.tenant.roles.some((r) => ['tenant_admin', 'approver', 'grounds'].includes(r.role));
const isAdmin = () => state.tenant.roles.some((r) => r.role === 'tenant_admin');
const myOrgIds = () => state.tenant.roles.filter((r) => ['org_admin', 'booker'].includes(r.role)).map((r) => r.organizationId);
const orgAdminIds = () => state.tenant.roles.filter((r) => r.role === 'org_admin').map((r) => r.organizationId);
const ORG_TINTS = ['#d9e8f5', '#f6e3c8', '#e4dcf1', '#dcefe0', '#f5d9d9', '#e9e9c9'];
const tint = (id) => ORG_TINTS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % ORG_TINTS.length];
const spaceName = (id) => state.spaces.find((s) => s.id === id)?.name || '';

async function guard(fn) { try { await fn(); } catch (e) { if (e.message !== 'Sign in required') toast(e.message, true); } }

/* ---------- pitch picker: spaces drawn as the field they are ---------- */
function pitchPicker(spaces, { selected, onSelect }) {
  const kids = (id) => spaces.filter((s) => s.parent_id === id);
  const lights = (s) => (s.has_lights ? el('span', { class: 'tag' }, 'Lights') : null);
  const btn = (s, cls, label) => el('button', {
    type: 'button', class: cls, 'aria-pressed': String(selected === s.id), onclick: () => onSelect && onSelect(s),
  }, el('span', {}, label || s.name), lights(s));
  const node = (s) => {
    const parts = kids(s.id);
    if (!parts.length) return el('div', { class: 'pitch single' }, btn(s, 'whole'));
    return el('div', { class: 'pitch' },
      btn(s, 'whole', `${s.name} (whole field)`),
      el('div', { class: 'parts' }, parts.map((p) => (kids(p.id).length ? node(p) : btn(p, 'part')))));
  };
  const byFacility = new Map();
  for (const s of spaces.filter((x) => !x.parent_id)) {
    if (!byFacility.has(s.facility_id)) byFacility.set(s.facility_id, []);
    byFacility.get(s.facility_id).push(s);
  }
  const facilityName = (id) => state.facilities?.find((f) => f.id === id)?.name || 'Facility';
  return el('div', {}, [...byFacility].map(([fid, roots]) =>
    el('section', { class: 'facility' }, el('h3', {}, facilityName(fid)), el('div', { class: 'pitches' }, roots.map(node)))));
}

/* ---------- screens ---------- */
function loginScreen() {
  const msg = el('p', { class: 'muted', role: 'status' });
  const email = el('input', { type: 'email', id: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  const form = el('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const r = await fetch('/auth/request-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value }) });
    const d = await r.json();
    msg.textContent = d.message || 'Check your email for a sign-in link.';
  } },
    el('div', { class: 'field' }, el('label', { for: 'email' }, 'Email'), email),
    el('button', { class: 'btn', type: 'submit' }, 'Email me a sign-in link'), msg);
  return el('div', { class: 'login' }, el('div', { class: 'login-top' }),
    el('div', { class: 'login-in stack' }, el('h1', {}, 'CanWeUseIt'),
      el('p', { class: 'muted' }, 'Request field time and see what has been approved. Sign in with a link sent to your email, no password needed.'), form,
      el('p', { class: 'small' }, 'Run the fields for a league, district or town? ', el('a', { href: '/signup' }, 'Start your group free')), legalLinks()));
}

const legalLinks = () => el('p', { class: 'legal-links small' }, el('a', { href: '/privacy' }, 'Privacy'), ' · ', el('a', { href: '/terms' }, 'Terms'), ' · ', el('a', { href: '/accessibility' }, 'Accessibility'));
const remember = (id) => { try { localStorage.setItem('cwui-tenant', id); } catch { /* private window */ } };
const remembered = () => { try { return localStorage.getItem('cwui-tenant'); } catch { return null; } };
function switcher() {
  const list = state.me.tenants || [];
  if (list.length < 2) return el('h1', {}, state.tenant.name);
  return el('div', { class: 'switch' }, el('label', { for: 'tenant-pick', class: 'sr-only' }, 'Group'),
    el('select', { id: 'tenant-pick', onchange: (e) => guard(async () => { remember(e.target.value); state.tenant = { id: e.target.value }; state.tenant = await api('/tenant'); state.view = 'schedule'; state.rq = null; await loadData(); render(); }) },
      list.map((t) => el('option', { value: t.id, selected: t.id === state.tenant.id }, t.name))));
}
function shell(content) {
  const tabs = [['schedule', 'Schedule'], ['requests', 'Requests'], ['new', 'Request time']];
  if (isStaff() || orgAdminIds().length) tabs.push(['groups', 'Groups']);
  if (canClose()) tabs.push(['closures', 'Closures']);
  if (isStaff()) tabs.push(['seasons', 'Seasons']);
  if (isStaff() || myOrgIds().length) tabs.push(['billing', isStaff() ? 'Fees' : 'Invoices']);
  if (isStaff()) tabs.push(['reports', 'Usage']);
  if (isAdmin()) tabs.push(['setup', 'Setup']);
  return el('div', {},
    el('header', { class: 'bar' }, el('div', { class: 'bar-in' },
      el('div', { class: 'bar-top' }, switcher(),
        el('div', { class: 'who' }, el('button', { class: 'linkbtn', onclick: () => go('profile'), 'aria-current': state.view === 'profile' ? 'page' : null }, state.me.user.full_name),
          el('button', { class: 'linkbtn', onclick: async () => { await fetch('/auth/logout', { method: 'POST' }); state.me = null; state.tenant = null; render(); } }, 'Sign out'))),
      el('nav', { class: 'tabs', 'aria-label': 'Main' }, tabs.map(([id, label]) =>
        el('button', { 'aria-current': state.view === id ? 'page' : null, onclick: () => go(id) }, label))))),
    el('main', { id: 'main' }, content), el('footer', { class: 'foot' }, legalLinks()));
}
function go(view) { state.view = view; render(); }

/* ---------- small shared pieces ---------- */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const cap = (t) => t[0].toUpperCase() + t.slice(1);
const hhmm = (d) => fmt(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const minutesOfDay = (d) => { const [h, m] = hhmm(d).split(':').map(Number); return (h % 24) * 60 + m; };
const hourLabel = (h) => fmt(`2027-01-15T${String(h).padStart(2, '0')}:00:00Z`.replace(/Z$/, 'Z'), { hour: 'numeric', timeZone: 'UTC' });
const isFuture = (d) => new Date(d) > new Date();
const ancestors = (id) => { const out = []; let s = state.spaces.find((x) => x.id === id); while (s?.parent_id) { out.push(s.parent_id); s = state.spaces.find((x) => x.id === s.parent_id); } return out; };
const related = (a, b) => a === b || ancestors(a).includes(b) || ancestors(b).includes(a);
const canManageOrg = (orgId) => isStaff() || orgAdminIds().includes(orgId);

function statusBadge(status) { return el('span', { class: 'badge ' + status }, cap(status)); }
function section(title, ...kids) { return el('section', { class: 'panel stack' }, el('h3', {}, title), ...kids); }
let fieldSeq = 0;
// A labelled control. The label points at the control (or the first control inside a group) so screen readers announce it.
function field(label, input, hint) {
  const ctl = input.matches?.('input,select,textarea') ? input : input.querySelector?.('input,select,textarea');
  const hintId = hint ? `hint-${++fieldSeq}` : null;
  if (ctl && !ctl.id) ctl.id = `f-${++fieldSeq}`;
  if (ctl && hintId) ctl.setAttribute('aria-describedby', hintId);
  return el('div', { class: 'field' }, el('label', ctl ? { for: ctl.id } : {}, label), input, hint ? el('p', { class: 'muted small', id: hintId }, hint) : null);
}

/* a small inline form: time and place for a date (used to move a booking) */
function moveForm(d, done) {
  const date = el('input', { type: 'date', value: ymd(d.startsAt), 'aria-label': 'New date' });
  const start = el('input', { type: 'time', value: hhmm(d.startsAt), 'aria-label': 'New start' });
  const end = el('input', { type: 'time', value: hhmm(d.endsAt), 'aria-label': 'New end' });
  return el('form', { class: 'inline-form', onsubmit: (e) => { e.preventDefault(); guard(async () => {
    const r = await api(`/booking-dates/${d.id}/move`, { method: 'POST', body: { date: date.value, startTime: start.value, endTime: end.value } });
    toast(r.status === 'pending' ? 'Change sent for approval' : 'Moved'); done();
  }); } }, date, start, end, el('button', { class: 'btn small', type: 'submit' }, 'Move'));
}

/* ---------- Schedule: month / week, with a day panel ---------- */
function monthGrid(first) { // list of local dates covering the month, whole weeks, Monday first
  const gridStart = mondayOf(first);
  const [y, m] = first.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const n = Math.ceil((offset + dim) / 7) * 7;
  return { gridStart, n, days: Array.from({ length: n }, (_, i) => addDays(gridStart, i)) };
}
const monthStartOf = (d) => `${d.slice(0, 7)}-01`;
const shiftMonth = (first, k) => { const [y, m] = first.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); return d.toISOString().slice(0, 10); };

function chip(b) {
  // plain text inside the day cell: the cell itself is the control (a button inside a button confuses screen readers)
  return el('span', { class: 'chip-b' + (b.status === 'pending' ? ' pending' : ''), style: `background:${tint(b.organizationId)}`,
    title: `${b.organization}: ${b.title} (${b.space})` },
  `${hhmm(b.startsAt).replace(/^0/, '')} ${b.organization}`);
}
function selectDay(d) { state.selectedDay = d; render().then(() => document.getElementById('day-panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }

async function scheduleView() {
  const today = ymd(new Date());
  if (!state.weekStart) state.weekStart = mondayOf(today);
  if (!state.month) state.month = monthStartOf(today);
  const month = state.calMode === 'month';
  let from, days;
  if (month) { const g = monthGrid(state.month); from = g.gridStart; days = g.n; } else { from = state.weekStart; days = 7; }
  const [{ bookings }, { closures }] = await Promise.all([api(`/bookings?start=${from}&days=${days}`), api('/closures')]);
  const shown = bookings.filter((b) => !state.spaceFilter || related(b.spaceId, state.spaceFilter));
  const closedOn = (d) => closures.filter((c) => (!state.spaceFilter || related(c.spaceId, state.spaceFilter)) && ymd(c.startsAt) <= d && ymd(new Date(new Date(c.endsAt) - 1)) >= d);

  const modeBtn = (m, label) => el('button', { class: 'chip', 'aria-pressed': String(state.calMode === m), onclick: () => { state.calMode = m; render(); } }, label);
  const spaceSel = el('select', { 'aria-label': 'Space', onchange: (e) => { state.spaceFilter = e.target.value; render(); } },
    el('option', { value: '' }, 'All spaces'), state.spaces.map((s) => el('option', { value: s.id, selected: s.id === state.spaceFilter }, (s.parent_id ? '  ' : '') + s.name)));
  const title = month ? fmt(`${state.month}T12:00:00Z`, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : `${fmt(`${state.weekStart}T12:00:00Z`, { month: 'short', day: 'numeric', timeZone: 'UTC' })} to ${fmt(`${addDays(state.weekStart, 6)}T12:00:00Z`, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  const step = (k) => { if (month) state.month = shiftMonth(state.month, k); else state.weekStart = addDays(state.weekStart, 7 * k); render(); };
  const main = el('div', {});
  main.append(el('div', { class: 'head' }, el('h2', {}, title),
    el('div', { class: 'row' }, el('div', { class: 'chips' }, modeBtn('month', 'Month'), modeBtn('week', 'Week')),
      el('button', { class: 'btn alt small', 'aria-label': month ? 'Previous month' : 'Previous week', onclick: () => step(-1) }, '‹'),
      el('button', { class: 'btn alt small', onclick: () => { state.month = monthStartOf(today); state.weekStart = mondayOf(today); state.selectedDay = today; render(); } }, 'Today'),
      el('button', { class: 'btn alt small', 'aria-label': month ? 'Next month' : 'Next week', onclick: () => step(1) }, '›'),
      spaceSel, el('button', { class: 'btn alt small', onclick: () => go('calendar') }, 'Add to your calendar'))));

  const cell = (d, inMonth) => {
    const items = shown.filter((b) => ymd(b.startsAt) === d);
    const closed = closedOn(d);
    const dots = items.slice(0, 6).map((b) => el('i', { class: 'dot' + (b.status === 'pending' ? ' pending' : ''), style: `background:${tint(b.organizationId)}` }));
    return el('div', { class: 'cell' + (d === today ? ' today' : '') + (inMonth ? '' : ' other') + (state.selectedDay === d ? ' sel' : ''), role: 'button', tabindex: '0',
      'aria-label': `${dayLabel(`${d}T12:00:00Z`)}, ${items.length} booking${items.length === 1 ? '' : 's'}${closed.length ? ', closed' : ''}`,
      onclick: () => selectDay(d), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDay(d); } } },
    el('span', { class: 'num' }, String(Number(d.slice(8)))),
    closed.length ? el('span', { class: 'closed-tag' }, 'Closed') : null,
    el('div', { class: 'chips-b' }, items.slice(0, 3).map(chip), items.length > 3 ? el('span', { class: 'more' }, `+${items.length - 3} more`) : null),
    el('div', { class: 'dots' }, dots, items.length > 6 ? el('span', { class: 'more' }, '+') : null));
  };

  if (month) {
    const g = monthGrid(state.month);
    main.append(el('div', { class: 'cal' }, el('div', { class: 'cal-head' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n) => el('div', {}, n))),
      el('div', { class: 'cal-grid' }, g.days.map((d) => cell(d, d.slice(0, 7) === state.month.slice(0, 7))))));
  } else {
    main.append(el('div', { class: 'week' }, Array.from({ length: 7 }, (_, i) => {
      const d = addDays(state.weekStart, i); const items = shown.filter((b) => ymd(b.startsAt) === d); const closed = closedOn(d);
      return el('section', { class: 'day' + (d === today ? ' today' : '') + (state.selectedDay === d ? ' sel' : '') },
        el('h3', {}, el('button', { class: 'linkbtn dayhead', onclick: () => selectDay(d) }, dayLabel(`${d}T12:00:00Z`))),
        closed.map((c) => el('p', { class: 'closed-note' }, `Closed: ${c.space}, ${c.reason}`)),
        items.length ? items.map((b) => el('div', { class: 'slot' + (b.status === 'pending' ? ' pending' : ''), style: `background:${tint(b.organizationId)}` },
          el('b', {}, timeRange(b.startsAt, b.endsAt)), b.space, el('br'), `${b.organization}: ${b.title}`, b.status === 'pending' ? el('em', {}, ' (waiting for approval)') : null))
          : el('p', { class: 'empty' }, 'Nothing booked'));
    })));
  }
  main.append(el('p', { class: 'muted small legend' }, 'Dashed outline means waiting for approval. Only approvers and the requesting group see those.'));
  if (state.selectedDay) main.append(dayPanel(state.selectedDay, bookings, closures, today));
  else main.append(el('p', { class: 'muted' }, 'Tap a day to see what is free and to ask for time.'));
  return main;
}

/* One day, one lane per space: booked time is filled, free time is a button that starts a request. */
function dayPanel(day, bookings, closures, today) {
  const START = 6, END = 22, span = (END - START) * 60;
  const dayBookings = bookings.filter((b) => ymd(b.startsAt) === day);
  const dayClosures = closures.filter((c) => ymd(c.startsAt) <= day && ymd(new Date(new Date(c.endsAt) - 1)) >= day);
  const past = day < today;
  const pct = (m) => `${Math.max(0, Math.min(100, ((m - START * 60) / span) * 100))}%`;
  const range = (a, b) => { // clip to this day, in minutes
    const sM = ymd(a) < day ? 0 : minutesOfDay(a);
    const eM = ymd(new Date(new Date(b) - 1)) > day ? 24 * 60 : minutesOfDay(b) || 24 * 60;
    return [sM, eM];
  };
  const lanes = [];
  const walk = (parentId, depth) => {
    for (const s of state.spaces.filter((x) => (x.parent_id || null) === parentId).sort((a, b) => a.name.localeCompare(b.name))) { lanes.push([s, depth]); walk(s.id, depth + 1); }
  };
  const shownSpaces = state.spaceFilter ? null : true;
  walk(null, 0);
  const laneEls = lanes.filter(([s]) => shownSpaces || related(s.id, state.spaceFilter)).map(([s, depth]) => {
    const own = dayBookings.filter((b) => b.spaceId === s.id);
    const shared = dayBookings.filter((b) => b.spaceId !== s.id && related(b.spaceId, s.id));
    const shut = dayClosures.filter((c) => related(c.spaceId, s.id));
    const busy = [...own, ...shared, ...shut].map((b) => range(b.startsAt, b.endsAt));
    const cells = [];
    if (!past) for (let h = START; h < END; h++) {
      if (busy.some(([a, z]) => a < (h + 1) * 60 && z > h * 60)) continue;
      cells.push(el('button', { type: 'button', class: 'free', style: `left:${pct(h * 60)};width:${100 / (END - START)}%`,
        'aria-label': `Request ${s.name} at ${hourLabel(h)}`, title: `Request ${s.name} from ${hourLabel(h)}`,
        onclick: () => { state.prefill = { spaceId: s.id, date: day, start: `${String(h).padStart(2, '0')}:00`, end: `${String(Math.min(h + 2, 23)).padStart(2, '0')}:00` }; go('new'); } }));
    }
    const block = (b, cls, label) => { const [a, z] = range(b.startsAt, b.endsAt);
      return el('div', { class: 'blk ' + cls, style: `left:${pct(a)};width:calc(${pct(z)} - ${pct(a)});${cls === 'own' ? `background:${tint(b.organizationId)}` : ''}`, title: label }, el('span', {}, label)); };
    return el('div', { class: 'lane', style: `--depth:${depth}` },
      el('div', { class: 'lane-name' }, s.name, s.has_lights ? el('span', { class: 'tag dark' }, 'Lights') : null),
      el('div', { class: 'bar-track' }, cells,
        shut.map((c) => block(c, 'shut', `Closed: ${c.reason}`)),
        shared.map((b) => block(b, 'shared', `${b.space} in use`)),
        own.map((b) => block(b, 'own' + (b.status === 'pending' ? ' pending' : ''), `${b.organization}`))));
  });
  const hourTicks = el('div', { class: 'ticks' }, Array.from({ length: (END - START) / 2 + 1 }, (_, i) => el('span', { style: `left:${(i * 2 * 100) / (END - START)}%` }, hourLabel(START + i * 2))));

  const list = dayBookings.map((b) => {
    const manage = canManageOrg(b.organizationId) && b.status !== 'cancelled';
    const slot = el('div', { class: 'item' });
    slot.append(el('div', { class: 'item-main' }, el('b', {}, timeRange(b.startsAt, b.endsAt)), ` ${b.space}`, el('br'), `${b.organization}: ${b.title}`, ' ', statusBadge(b.status === 'confirmed' ? 'confirmed' : 'pending')));
    if (manage && isFuture(b.endsAt)) {
      const moveHost = el('div', {});
      slot.append(el('div', { class: 'actions' },
        el('button', { class: 'btn alt small', onclick: () => moveHost.replaceChildren(moveHost.firstChild ? [] : moveForm(b, () => render())) }, 'Move'),
        el('button', { class: 'btn danger small', onclick: () => guard(async () => {
          const note = isStaff() ? prompt('Skip this date? Add a reason for the requester (optional).', '') : (confirm('Skip this date? The space becomes free for others.') ? '' : null);
          if (note === null) return;
          await api(`/booking-dates/${b.id}/cancel`, { method: 'POST', body: { note } }); toast('Date skipped'); render();
        }) }, 'Skip this date')), moveHost);
    }
    return slot;
  });
  const panel = el('section', { class: 'panel stack', id: 'day-panel' },
    el('div', { class: 'head tight' }, el('h3', {}, fmt(`${day}T12:00:00Z`, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })),
      el('div', { class: 'row' }, !past ? el('button', { class: 'btn small', onclick: () => { state.prefill = { date: day, spaceId: state.spaceFilter || '' }; go('new'); } }, 'Request time this day') : null,
        el('button', { class: 'btn alt small', onclick: () => { state.selectedDay = null; render(); } }, 'Close'))),
    dayClosures.map((c) => el('p', { class: 'closed-note' }, `Closed: ${c.space}. ${c.reason}`)),
    el('div', { class: 'lanes' }, el('div', { class: 'lane head-lane' }, el('div', { class: 'lane-name' }), hourTicks), laneEls),
    !past ? el('p', { class: 'muted small' }, 'Tap an open hour to start a request. Striped time means a part or the whole of that field is already in use.') : null,
    list.length ? el('div', { class: 'items' }, list) : el('p', { class: 'muted' }, 'Nothing booked this day.'));
  return panel;
}

/* ---------- Requests ---------- */
function insuranceBanner(orgIds) {
  const bad = (state.compliance || []).filter((o) => orgIds.includes(o.id) && o.status !== 'ok');
  if (!bad.length) return null;
  const word = { missing: 'has no insurance on file', expiring: 'has insurance expiring soon', expired: 'has expired insurance' };
  return el('div', { class: 'notice' }, bad.map((o) => el('p', {}, `${o.name} ${word[o.status]}${o.expiresOn ? ` (${o.expiresOn})` : ''}. `,
    el('button', { class: 'linkbtn', onclick: () => go('groups') }, 'Add it here'), '.')));
}

function datesList(r) {
  const all = r.dates;
  const box = el('ul', { class: 'dates' });
  const canManage = canManageOrg(r.organization_id) || r.mine;
  const draw = (limit) => {
    box.replaceChildren(...all.slice(0, limit).map((d) => {
      const moveHost = el('div', { class: 'grow' });
      return el('li', {},
        el('span', { class: 'when' }, `${dayLabel(d.startsAt)}, ${timeRange(d.startsAt, d.endsAt)}`),
        (d.space && d.space !== r.space) || d.label ? el('span', { class: 'muted small' }, [d.space && d.space !== r.space ? d.space : null, d.label].filter(Boolean).join(', ')) : null,
        d.conflict ? el('span', { class: 'badge conflict' }, 'Space already booked') : null,
        statusBadge(d.status),
        d.warning ? el('span', { class: 'warn-text' }, d.warning) : null,
        canManage && ['confirmed', 'pending'].includes(d.status) && isFuture(d.endsAt) && r.status !== 'declined' ? el('span', { class: 'row' },
          el('button', { class: 'btn alt small', onclick: () => moveHost.replaceChildren(moveHost.firstChild ? [] : moveForm(d, () => render())) }, 'Move'),
          el('button', { class: 'btn danger small', onclick: () => guard(async () => {
            if (!confirm('Skip this date?')) return;
            await api(`/booking-dates/${d.id}/cancel`, { method: 'POST', body: {} }); toast('Date skipped'); render();
          }) }, 'Skip')) : null,
        d.status === 'confirmed' ? el('span', { class: 'row' },
          el('button', { class: 'btn alt small', onclick: () => { const on = moveHost.dataset.k === 't'; moveHost.dataset.k = on ? '' : 't'; moveHost.replaceChildren(...(on ? [] : [teamPlanBox(d)])); } }, 'Teams'),
          canManage && isFuture(d.startsAt) ? el('button', { class: 'btn alt small', onclick: () => { const on = moveHost.dataset.k === 'g'; moveHost.dataset.k = on ? '' : 'g'; moveHost.replaceChildren(...(on ? [] : [releaseBox(d)])); } }, 'Give back time') : null,
          canClose() && !isFuture(d.startsAt) ? noShowButton(d) : null) : null,
        d.noShow ? el('span', { class: 'badge conflict' }, 'No-show') : null,
        d.releasedMinutes ? el('span', { class: 'muted small' }, `${d.releasedMinutes} min given back`) : null, moveHost);
    }));
    if (all.length > limit) box.append(el('li', {}, el('button', { class: 'linkbtn', onclick: () => draw(999) }, `Show all ${all.length} dates`)));
  };
  draw(6);
  return box;
}

function decisionBox(r, decision) {
  const note = el('textarea', { placeholder: decision === 'approve' ? 'Note for the requester (optional)' : 'Why? The requester will see this (optional)', maxlength: 500, 'aria-label': 'Note' });
  return el('form', { class: 'stack note-box', onsubmit: (e) => { e.preventDefault(); guard(async () => {
    const d = await api(`/requests/${r.id}/decision`, { method: 'POST', body: { decision, note: note.value } });
    toast(decision === 'approve' ? (d.flagged ? `${d.confirmed} confirmed, ${d.flagged} conflicts` : `Approved, ${d.confirmed} dates confirmed`) : 'Request declined'); render();
  }); } }, note, el('div', { class: 'actions' }, el('button', { class: 'btn' + (decision === 'decline' ? ' danger' : ''), type: 'submit' }, decision === 'approve' ? 'Confirm approval' : 'Confirm decline')));
}

function editBox(r) {
  const title = el('input', { type: 'text', value: r.title, maxlength: 200, 'aria-label': 'Title' });
  const notes = el('textarea', { 'aria-label': 'Notes' }, r.notes || '');
  return el('form', { class: 'stack note-box', onsubmit: (e) => { e.preventDefault(); guard(async () => {
    await api(`/requests/${r.id}`, { method: 'PATCH', body: { title: title.value, notes: notes.value } }); toast('Saved'); render();
  }); } }, title, notes, el('div', { class: 'actions' }, el('button', { class: 'btn small', type: 'submit' }, 'Save')));
}

async function requestsView() {
  const staff = isStaff();
  if (!state.rq) state.rq = { status: staff ? 'pending' : '' };
  const rq = state.rq;
  const params = new URLSearchParams({ limit: '200' });
  for (const [k, p] of [['status', 'status'], ['q', 'q'], ['org', 'organizationId'], ['space', 'spaceId'], ['round', 'roundId'], ['from', 'from'], ['to', 'to']]) if (rq[k]) params.set(p, rq[k]);
  const [{ requests }, { waitlist }] = await Promise.all([api('/requests?' + params), api('/waitlist').catch(() => ({ waitlist: [] }))]);
  const filters = [['pending', 'Waiting'], ['approved', 'Approved'], ['declined', 'Declined'], ['', 'All']];
  const wrap = el('div', {}, el('div', { class: 'head' }, el('h2', {}, staff ? 'Requests to review' : 'Your requests'),
    el('div', { class: 'chips' }, filters.map(([v, l]) => el('button', { class: 'chip', 'aria-pressed': String(rq.status === v), onclick: () => { rq.status = v; render(); } }, l)))));
  if (staff) {
    const q = el('input', { type: 'search', placeholder: 'Search title or group', value: rq.q || '', 'aria-label': 'Search' });
    const org = el('select', { 'aria-label': 'Group' }, el('option', { value: '' }, 'All groups'), state.orgs.map((o) => el('option', { value: o.id, selected: rq.org === o.id }, o.name)));
    const sp = el('select', { 'aria-label': 'Field' }, el('option', { value: '' }, 'All fields'), state.spaces.map((x) => el('option', { value: x.id, selected: rq.space === x.id }, x.name)));
    const f1 = el('input', { type: 'date', value: rq.from || '', 'aria-label': 'From date' }), f2 = el('input', { type: 'date', value: rq.to || '', 'aria-label': 'To date' });
    const apply = () => { Object.assign(rq, { q: q.value.trim(), org: org.value, space: sp.value, from: f1.value, to: f2.value }); render(); };
    const active = ['q', 'org', 'space', 'from', 'to', 'round'].filter((k) => rq[k]).length;
    wrap.append(el('details', { class: 'panel filters', open: active > 0 }, el('summary', {}, active ? `Filters (${active} on)` : 'Filters'),
      el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); apply(); } }, q, el('div', { class: 'grid2' }, org, sp), el('div', { class: 'grid2' }, field('Dates from', f1), field('to', f2)),
        rq.round ? el('p', { class: 'muted small' }, 'Showing one season only. ', el('button', { type: 'button', class: 'linkbtn', onclick: () => { rq.round = ''; render(); } }, 'Show all')) : null,
        el('div', { class: 'actions' }, el('button', { class: 'btn small', type: 'submit' }, 'Apply'),
          el('button', { class: 'btn alt small', type: 'button', onclick: () => { state.rq = { status: rq.status }; render(); } }, 'Clear'),
          el('button', { class: 'btn alt small', type: 'button', onclick: () => guard(() => download(`/export/bookings.csv${rq.from || rq.to ? `?${new URLSearchParams({ ...(rq.from ? { from: rq.from } : {}), ...(rq.to ? { to: rq.to } : {}) })}` : ''}`, 'bookings.csv')) }, 'Download bookings (CSV)')))));
  } else wrap.append(insuranceBanner(myOrgIds()));

  // bulk approve and decline
  const picked = new Set();
  const bar = el('div', { class: 'bulkbar hidden', role: 'region', 'aria-label': 'Selected requests' });
  const drawBar = () => {
    bar.classList.toggle('hidden', !picked.size);
    bar.replaceChildren(el('b', {}, `${picked.size} selected`),
      el('button', { class: 'btn small', onclick: () => bulk('approve') }, 'Approve'),
      el('button', { class: 'btn danger small', onclick: () => bulk('decline') }, 'Decline'),
      el('button', { class: 'btn alt small', onclick: () => { picked.clear(); wrap.querySelectorAll('.pick input').forEach((i) => { i.checked = false; }); drawBar(); } }, 'Clear'));
  };
  const bulk = (decision) => guard(async () => {
    const note = decision === 'decline' ? prompt('Reason for the requesters (optional)') : '';
    if (note === null) return;
    if (decision === 'approve' && !confirm(`Approve ${picked.size} request${picked.size === 1 ? '' : 's'}? Dates that clash are marked, not double booked.`)) return;
    const r = await api('/requests/bulk-decision', { method: 'POST', body: { ids: [...picked], decision, note } });
    toast(`${r.ok} ${decision === 'approve' ? 'approved' : 'declined'}${r.failed ? `, ${r.failed} could not be changed` : ''}`); render();
  });
  const pendingIds = requests.filter((r) => r.status === 'pending').map((r) => r.id);
  if (staff && pendingIds.length > 1) wrap.append(el('div', { class: 'row' }, el('button', { class: 'btn alt small', onclick: () => {
    pendingIds.forEach((id) => picked.add(id)); wrap.querySelectorAll('.pick input').forEach((i) => { i.checked = true; }); drawBar(); } }, `Select all ${pendingIds.length} waiting`)));
  wrap.append(bar);

  if (!requests.length) wrap.append(el('div', { class: 'panel empty-big' }, el('h3', {}, rq.status === 'pending' ? 'Nothing waiting' : 'No requests here'),
    el('p', { class: 'muted' }, staff ? 'New requests from clubs and schools show up here.' : 'Use Request time to ask for a slot.')));
  for (const r of requests) {
    const conflicts = r.dates.filter((d) => d.conflict).length;
    const warned = r.dates.filter((d) => d.warning && ['pending', 'flagged'].includes(d.status)).length;
    const box = el('div', {});
    const toggle = (key, make) => () => { if (box.dataset.k === key) { box.dataset.k = ''; box.replaceChildren(); } else { box.dataset.k = key; box.replaceChildren(make()); } };
    const live = ['pending', 'approved'].includes(r.status);
    const where = [...new Set(r.dates.map((d) => d.space).filter(Boolean))];
    const mine = r.mine || canManageOrg(r.organization_id);
    wrap.append(el('article', { class: 'panel card' },
      el('div', { class: 'card-head' },
        staff && r.status === 'pending' ? el('label', { class: 'pick' }, el('input', { type: 'checkbox', 'aria-label': `Select ${r.title}`, onchange: (e) => { e.target.checked ? picked.add(r.id) : picked.delete(r.id); drawBar(); } })) : null,
        el('div', { class: 'grow-1' }, el('h3', {}, r.title), el('p', { class: 'muted small' }, `${r.organization} asking for ${where.length > 2 ? `${where.length} fields` : (where.join(' and ') || r.space)}${staff ? `, priority ${r.priority_snapshot}${r.tier ? `, tier ${r.tier}` : ''}` : ''}`)),
        statusBadge(r.status)),
      r.notes ? el('p', {}, r.notes) : null,
      r.decisionNote && r.status !== 'pending' ? el('p', { class: 'decision-note' }, el('b', {}, 'Note from the approver: '), r.decisionNote) : null,
      conflicts && r.status === 'pending' ? el('p', { class: 'small', style: 'color:var(--flag)' }, `${conflicts} of ${r.dates.length} dates are already taken. Approving will confirm the free dates and mark these as conflicts.`) : null,
      warned && r.status === 'pending' && staff ? el('p', { class: 'small', style: 'color:var(--flag)' }, `${warned} date${warned === 1 ? ' breaks' : 's break'} a booking rule. See the notes on each date.`) : null,
      datesList(r),
      el('div', { class: 'actions' },
        staff && r.status === 'pending' ? [el('button', { class: 'btn', onclick: toggle('a', () => decisionBox(r, 'approve')) }, 'Approve'),
          el('button', { class: 'btn danger', onclick: toggle('d', () => decisionBox(r, 'decline')) }, 'Decline')] : null,
        r.permit ? el('a', { class: 'btn alt small', href: `/permit/${r.permit.code}`, target: '_blank', rel: 'noopener' }, `Permit ${r.permit.number}`) : null,
        staff && r.permit ? el('button', { class: 'btn danger small', onclick: () => guard(async () => { if (!confirm('Revoke this permit? The check page will show it as not valid.')) return; await api(`/requests/${r.id}/permit/revoke`, { method: 'POST' }); render(); }) }, 'Revoke permit') : null,
        staff && r.status === 'approved' ? el('button', { class: 'btn alt small', onclick: toggle('i', () => invoiceBox(r)) }, 'Invoice') : null,
        mine && live ? el('button', { class: 'btn alt small', onclick: toggle('e', () => editBox(r)) }, 'Edit title or notes') : null,
        mine && live ? el('button', { class: 'btn danger small', onclick: () => guard(async () => {
          if (!confirm(r.status === 'approved' ? 'Withdraw this request? Every future date is released.' : 'Withdraw this request?')) return;
          await api(`/requests/${r.id}/withdraw`, { method: 'POST' }); toast('Request withdrawn'); render();
        }) }, 'Withdraw') : null,
        ['declined', 'cancelled'].includes(r.status) && (mine || myOrgIds().includes(r.organization_id)) ? el('button', { class: 'btn alt small', onclick: () => {
          const first = r.dates[0]; state.prefill = { spaceId: first.spaceId || r.space_id, orgId: r.organization_id, title: r.title, notes: r.notes || '', date: ymd(first.startsAt), start: hhmm(first.startsAt), end: hhmm(first.endsAt) }; go('new');
        } }, 'Request again') : null),
      box));
  }
  if (waitlist.length) wrap.append(section('Waiting for a slot to open',
    el('p', { class: 'muted small' }, 'You get an email the moment one of these frees up. Then request it quickly.'),
    el('ul', { class: 'plain' }, waitlist.map((w) => el('li', { class: 'row between' },
      el('span', {}, `${w.organization}: ${w.space}, ${dayLabel(w.startsAt)} ${timeRange(w.startsAt, w.endsAt)}${w.status === 'notified' ? ' (it opened up)' : ''}`),
      w.mine || isAdmin() ? el('button', { class: 'btn alt small', onclick: () => guard(async () => { await api(`/waitlist/${w.id}`, { method: 'DELETE' }); render(); }) }, 'Remove') : null)))));
  return wrap;
}

/* ---------- Request time ---------- */
const DOW = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];
async function newRequestView() {
  const orgs = state.orgs.filter((o) => isAdmin() || myOrgIds().includes(o.id));
  if (!orgs.length) return el('div', { class: 'panel empty-big' }, el('h3', {}, 'No organization yet'),
    el('p', { class: 'muted' }, 'Ask the group admin to add you to your club, school or team before requesting time.'));
  const pre = state.prefill || {}; state.prefill = null;
  const [{ hours }, roundsRes] = await Promise.all([api('/hours'), api('/rounds').catch(() => ({ rounds: [] }))]);
  const now = Date.now();
  const openRounds = roundsRes.rounds.filter((r) => r.status === 'open' && new Date(r.opensAt) <= now && new Date(r.closesAt) >= now);
  const f = { repeat: false, days: new Set(), items: [{ spaceId: pre.spaceId || '', label: '', start: '', end: '' }], uploaded: null };
  const hint = el('p', { class: 'muted small', role: 'status' });
  const describe = () => {
    const sp = state.spaces.find((x) => x.id === f.items[0].spaceId);
    const rules = hours.filter((h) => !h.spaceId || (f.items[0].spaceId && related(h.spaceId, f.items[0].spaceId)));
    const parts = [];
    if (sp && !sp.has_lights && state.tenant.daylightRule && state.tenant.daylightRule !== 'off') parts.push('This field has no lights, so time must end before sunset.');
    for (const h of rules) parts.push(`${h.space || 'All spaces'}: ${h.weekdays.length === 7 ? 'daily' : h.weekdays.map((n) => WEEKDAYS[n]).join(', ')} ${h.opens} to ${h.closes}${h.note ? ` (${h.note})` : ''}.`);
    hint.textContent = parts.join(' ');
  };
  const org = el('select', { id: 'org' }, orgs.map((o) => el('option', { value: o.id, selected: o.id === pre.orgId }, o.name)));
  const title = el('input', { type: 'text', id: 'title', maxlength: 200, placeholder: 'Spring practices', required: true, value: pre.title || '' });
  const notes = el('textarea', { id: 'notes', placeholder: 'Anything the approvers should know' }, pre.notes || '');
  const date = el('input', { type: 'date', id: 'date', value: pre.date || '' });
  const until = el('input', { type: 'date', id: 'until' });
  const start = el('input', { type: 'time', id: 'start', value: pre.start || '18:00' });
  const end = el('input', { type: 'time', id: 'end', value: pre.end || '20:00' });
  const every = el('select', { id: 'every', 'aria-label': 'How often' }, [[1, 'Every week'], [2, 'Every other week'], [3, 'Every third week'], [4, 'Every fourth week']].map(([n, l]) => el('option', { value: n }, l)));
  const skip = el('input', { type: 'text', id: 'skip', placeholder: '2027-11-25, 2027-12-23', 'aria-label': 'Dates to skip' });
  const repeatBox = el('div', { class: 'hidden stack' },
    el('div', {}, el('label', {}, 'Repeats on'), el('div', { class: 'chips' }, DOW.map(([l, n]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: (e) => {
      f.days.has(n) ? f.days.delete(n) : f.days.add(n); e.currentTarget.setAttribute('aria-pressed', String(f.days.has(n))); } }, l)))),
    el('div', { class: 'grid2' }, el('div', {}, el('label', { for: 'every' }, 'How often'), every), el('div', {}, el('label', { for: 'until' }, 'Last date'), until)),
    el('div', {}, el('label', { for: 'skip' }, 'Skip these dates (optional)'), skip, el('p', { class: 'muted small' }, 'Holidays, school breaks. Separate dates with commas.')));
  const rep = el('input', { type: 'checkbox', id: 'rep', onchange: (e) => { f.repeat = e.target.checked; repeatBox.classList.toggle('hidden', !f.repeat); } });
  const banner = el('div', {});
  const showBanner = () => banner.replaceChildren(insuranceBanner([org.value]) || []);
  org.addEventListener('change', showBanner); showBanner();

  // fields and teams: one request can cover several
  const itemsHost = el('div', { class: 'stack' });
  const drawItems = () => {
    itemsHost.replaceChildren(...f.items.map((it, i) => {
      const label = el('input', { type: 'text', maxlength: 80, placeholder: 'Team, for example U12 girls', value: it.label, 'aria-label': 'Team', oninput: (e) => { it.label = e.target.value; } });
      const picker = el('div', {});
      const pick = (sp) => { it.spaceId = sp.id; draw(); describe(); };
      const views = () => i === 0 && hasMap() ? el('div', { class: 'chips', role: 'group', 'aria-label': 'Show fields as' },
        [['diagram', 'Diagram'], ['map', 'Satellite map']].map(([v, l]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': String((f.look || 'diagram') === v), onclick: () => { f.look = v; draw(); } }, l))) : null;
      const draw = () => picker.replaceChildren(...(views() ? [views()] : []), i === 0
        ? (f.look === 'map' ? el('div', { class: 'stack' }, mapPicker({ selected: it.spaceId, onSelect: pick }), el('p', { class: 'muted small', role: 'status' }, it.spaceId ? `Chosen: ${spaceName(it.spaceId)}` : 'Tap a field or a section on the map.'))
          : pitchPicker(state.spaces, { selected: it.spaceId, onSelect: pick }))
        : el('select', { 'aria-label': 'Field', onchange: (e) => { it.spaceId = e.target.value; } }, el('option', { value: '' }, 'Choose a field'), state.spaces.map((sp) => el('option', { value: sp.id, selected: sp.id === it.spaceId }, `${sp.parent_id ? 'Section: ' : ''}${sp.name}`))));
      draw();
      const t1 = el('input', { type: 'time', value: it.start, 'aria-label': 'Different start', oninput: (e) => { it.start = e.target.value; } }), t2 = el('input', { type: 'time', value: it.end, 'aria-label': 'Different end', oninput: (e) => { it.end = e.target.value; } });
      return el('div', { class: i ? 'item stack' : 'stack' }, i === 0 && f.items.length === 1 ? null : el('div', { class: 'row between' }, el('b', {}, `Field ${i + 1}`),
        i ? el('button', { type: 'button', class: 'btn danger small', onclick: () => { f.items.splice(i, 1); drawItems(); } }, 'Remove') : null),
        picker, label,
        i ? el('details', {}, el('summary', {}, 'Different time for this team'), el('div', { class: 'grid2' }, field('Starts', t1), field('Ends', t2), el('p', { class: 'muted small' }, 'Leave empty to use the time above.'))) : null);
    }), el('button', { type: 'button', class: 'btn alt small', onclick: () => { f.items.push({ spaceId: '', label: '', start: '', end: '' }); drawItems(); } }, 'Add another field or team'));
  };
  drawItems(); describe();

  // upload a whole schedule
  const upBox = el('textarea', { class: 'mono', rows: '5', placeholder: 'field,team,date,start,end\nUpper field,U10,2027-09-07,17:00,18:30\nLower field,U12,2027-09-08,18:00,19:30', 'aria-label': 'Paste your schedule' });
  const upOut = el('div', { role: 'status' });
  const readUpload = () => {
    const rows = parseTable(upBox.value); const errors = []; const groups = new Map();
    rows.forEach((r, i) => {
      const sp = state.spaces.find((x) => x.name.toLowerCase() === String(r.field || r.space || '').trim().toLowerCase());
      if (!sp) return errors.push(`Row ${i + 1}: unknown field "${r.field || r.space || ''}"`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || !/^\d{2}:\d{2}$/.test(r.start || '') || !/^\d{2}:\d{2}$/.test(r.end || '')) return errors.push(`Row ${i + 1}: use date 2027-09-07 and times like 17:00`);
      const k = `${sp.id}|${r.team || ''}`; if (!groups.has(k)) groups.set(k, { spaceId: sp.id, label: (r.team || '').slice(0, 80), dates: [] });
      groups.get(k).dates.push({ date: r.date, startTime: r.start, endTime: r.end });
    });
    f.uploaded = errors.length || !groups.size ? null : [...groups.values()];
    const n = f.uploaded ? f.uploaded.reduce((a, g) => a + g.dates.length, 0) : 0;
    upOut.replaceChildren(errors.length ? el('div', { class: 'notice' }, errors.slice(0, 10).map((e) => el('p', {}, e))) : el('p', { class: 'muted' }, f.uploaded ? `Ready: ${n} dates for ${f.uploaded.length} field/team combination${f.uploaded.length === 1 ? '' : 's'}. Send request to submit them.` : 'Paste a header row and some rows.'));
  };
  const upFile = el('input', { type: 'file', accept: '.csv,.tsv,.txt', 'aria-label': 'Choose a file', onchange: async (e) => { const fl = e.target.files[0]; if (fl) { upBox.value = await fl.text(); readUpload(); } } });
  upBox.addEventListener('input', readUpload);

  // check the slot first
  const checkOut = el('div', { role: 'status' });
  const checkBtn = el('button', { type: 'button', class: 'btn alt', onclick: () => guard(async () => {
    const it = f.items[0];
    if (!it.spaceId || !date.value) throw new Error('Pick a field and a first date to check');
    const q = new URLSearchParams({ spaceId: it.spaceId, date: date.value, start: it.start || start.value, end: it.end || end.value, organizationId: org.value });
    const c = await api('/availability/check?' + q);
    const apply = (sg) => { date.value = sg.date; if (sg.kind === 'time') { start.value = sg.start; end.value = sg.end; } if (sg.kind === 'field') { it.spaceId = sg.spaceId; drawItems(); describe(); } checkOut.replaceChildren(); toast('Updated. Check again or send the request.'); };
    const ok = c.free && !c.blocks.length;
    checkOut.replaceChildren(el('div', { class: ok ? 'okbox' : 'notice stack' },
      el('p', {}, el('b', {}, ok ? (c.warnings.length ? 'Free, but note: ' : 'That time is free.') : c.free ? 'This breaks a rule: ' : 'That time is already taken.'), ' ', [...c.blocks, ...c.warnings].join(' ')),
      !ok && c.suggestions.length ? el('div', { class: 'stack' }, el('p', { class: 'small' }, 'These work instead:'), el('div', { class: 'chips' }, c.suggestions.map((sg) => el('button', { type: 'button', class: 'chip', onclick: () => apply(sg) },
        sg.kind === 'time' ? `${sg.start} to ${sg.end}` : sg.kind === 'field' ? `${sg.space}, same time` : `${dayLabel(`${sg.date}T12:00:00Z`)}`)))) : null,
      !ok && !c.free ? el('button', { type: 'button', class: 'btn alt small', onclick: () => guard(async () => {
        await api('/waitlist', { method: 'POST', body: { organizationId: org.value, spaceId: it.spaceId, date: date.value, start: it.start || start.value, end: it.end || end.value } }); toast('You are on the list. We will email you if it opens.'); }) }, 'Tell me if it opens up') : null));
  }) }, 'Check this time');

  const roundSel = openRounds.length ? el('select', { id: 'round' }, el('option', { value: '' }, 'Not part of a season'), openRounds.map((r) => el('option', { value: r.id }, `${r.name} (${r.seasonStart} to ${r.seasonEnd})`))) : null;
  const form = el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); guard(async () => {
    let items;
    if (f.uploaded) items = f.uploaded;
    else {
      if (!date.value) throw new Error('Choose the first date');
      if (f.items.some((it) => !it.spaceId)) throw new Error('Pick a field for each team, or remove the empty one');
      const dow = new Date(`${date.value}T12:00:00Z`).getUTCDay();
      if (f.repeat && (!f.days.size || !until.value)) throw new Error('Choose the days it repeats on and a last date');
      const exclude = skip.value.split(/[,\s]+/).filter(Boolean);
      if (exclude.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error('Skip dates look like 2027-11-25');
      items = f.items.map((it) => ({ spaceId: it.spaceId, label: it.label.trim() || undefined, weekly: f.repeat
        ? { startsOn: date.value, until: until.value, weekdays: [...f.days], startTime: it.start || start.value, endTime: it.end || end.value, everyWeeks: Number(every.value), ...(exclude.length ? { exclude } : {}) }
        : { startsOn: date.value, until: date.value, weekdays: [dow], startTime: it.start || start.value, endTime: it.end || end.value } }));
    }
    const r = await api('/requests', { method: 'POST', body: { organizationId: org.value, title: title.value, notes: notes.value, items, ...(roundSel?.value ? { roundId: roundSel.value } : {}) } });
    toast(r.autoApproved ? `Approved automatically, ${r.dateCount} date${r.dateCount === 1 ? '' : 's'}` : `Request sent, ${r.dateCount} date${r.dateCount === 1 ? '' : 's'}${r.warnings ? ` (${r.warnings} flagged for review)` : ''}`);
    state.rq = null; go('requests');
  }); } },
  banner,
  el('div', { class: 'panel stack' }, el('h3', {}, 'When'),
    el('div', { class: 'grid2' }, el('div', {}, el('label', { for: 'date' }, 'First date'), date), el('div', {}, el('label', { for: 'org' }, 'Asking for'), org)),
    el('div', { class: 'grid2' }, el('div', {}, el('label', { for: 'start' }, 'Starts'), start), el('div', {}, el('label', { for: 'end' }, 'Ends'), end)),
    el('label', { for: 'rep', class: 'row', style: 'font-weight:500' }, rep, 'Repeats'), repeatBox),
  el('div', { class: 'panel stack' }, el('h3', {}, 'Where'), el('p', { class: 'muted small' }, 'Tap the field, or a section of it. Need more than one field or team? Add them below and send one request.'), itemsHost, hint, checkBtn, checkOut),
  el('div', { class: 'panel stack' }, el('h3', {}, 'What for'),
    el('div', {}, el('label', { for: 'title' }, 'Title'), title), el('div', {}, el('label', { for: 'notes' }, 'Notes (optional)'), notes),
    roundSel ? el('div', {}, el('label', { for: 'round' }, 'Season'), roundSel) : null),
  el('details', { class: 'panel' }, el('summary', {}, 'Have a full schedule in a spreadsheet? Upload it instead'),
    el('div', { class: 'stack' }, el('p', { class: 'muted small' }, 'Columns: field, team, date, start, end. One row per practice or game. This replaces the When and Where choices above.'), upBox, upFile, upOut)),
  el('div', {}, el('button', { class: 'btn', type: 'submit' }, 'Send request')));
  return el('div', {}, el('div', { class: 'head' }, el('h2', {}, 'Request time')), form);
}

/* ---------- Groups: insurance, permits, trusted groups ---------- */
async function groupsView() {
  const [{ organizations: status }, { organizations }] = await Promise.all([api('/compliance'), api('/organizations')]);
  state.compliance = status;
  const label = { ok: 'Insurance on file', expiring: 'Expiring soon', expired: 'Expired', missing: 'No insurance' };
  const wrap = el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, 'Groups and insurance')));
  if (isStaff()) wrap.append(await applicationsPanel());
  if (isStaff()) wrap.append(el('p', { class: 'muted' }, 'Keep each group\'s insurance certificate and permits current. Turn on Trusted to approve a group\'s requests automatically when nothing conflicts.'));
  for (const o of status) {
    const info = organizations.find((x) => x.id === o.id);
    const host = el('div', {});
    const load = async () => {
      const { documents } = await api(`/organizations/${o.id}/documents`);
      const kind = el('select', { 'aria-label': 'Kind' }, ['insurance', 'permit', 'waiver', 'background_check', 'other'].map((k) => el('option', { value: k }, cap(k).replace('_', ' '))));
      const exp = el('input', { type: 'date', 'aria-label': 'Expires on' });
      const note = el('input', { type: 'text', placeholder: 'Policy number or note', 'aria-label': 'Note' });
      const cov = el('input', { type: 'number', min: '0', step: '1000', placeholder: 'Coverage, dollars', 'aria-label': 'Coverage amount in dollars' });
      const addl = el('input', { type: 'checkbox', id: `addl-${o.id}` });
      const file = el('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', 'aria-label': 'Certificate file (PDF or image, up to 3 MB)' });
      host.replaceChildren(
        documents.length ? el('ul', { class: 'plain' }, documents.map((d) => el('li', { class: 'row between' },
          el('span', {}, `${cap(d.kind).replace('_', ' ')}${d.expiresOn ? `, expires ${d.expiresOn}` : ', no expiry'}${d.coverageAmount ? `, ${money(d.coverageAmount * 100)} coverage` : ''}${d.additionalInsured ? ', group named as additional insured' : ''}${d.note ? `, ${d.note}` : ''}`),
          d.hasFile ? el('button', { class: 'btn alt small', onclick: () => guard(() => download(`/documents/${d.id}/file`, d.fileName || 'certificate')) }, 'View file') : null,
          canManageOrg(o.id) ? el('button', { class: 'btn danger small', onclick: () => guard(async () => { await api(`/documents/${d.id}`, { method: 'DELETE' }); await load(); }) }, 'Remove') : null)))
          : el('p', { class: 'muted small' }, 'Nothing on file.'),
        canManageOrg(o.id) ? el('div', { class: 'stack' }, el('div', { class: 'row' }, kind, exp, note, cov),
          el('label', { class: 'row inline-check', for: `addl-${o.id}` }, addl, 'Our group is named as additional insured'), file,
          el('button', { class: 'btn alt small', onclick: () => guard(async () => {
          const doc = await api(`/organizations/${o.id}/documents`, { method: 'POST', body: { kind: kind.value, expiresOn: exp.value || null, note: note.value, coverageAmount: cov.value ? Number(cov.value) : null, additionalInsured: addl.checked } });
          const fl = file.files[0];
          if (fl) {
            if (fl.size > 3 * 1024 * 1024) throw new Error('That file is over 3 MB. Save it smaller and try again');
            const up = await fetch(`/documents/${doc.id}/file`, { method: 'POST', headers: { 'content-type': fl.type || 'application/octet-stream', 'x-file-name': fl.name.replace(/[^\w.\- ]/g, ''), 'x-tenant-id': state.tenant.id }, body: fl });
            if (!up.ok) throw new Error((await up.json().catch(() => ({}))).error || 'The file could not be saved');
          }
          toast('Saved'); await load();
          const { organizations: s2 } = await api('/compliance'); state.compliance = s2;
        }) }, 'Add')) : null);
    };
    const body = el('div', {});
    wrap.append(el('article', { class: 'panel card' }, el('div', { class: 'card-head' }, el('h3', {}, o.name),
      el('div', { class: 'row' }, el('span', { class: 'badge ' + (o.status === 'ok' ? 'confirmed' : o.status === 'expiring' ? 'pending' : 'conflict') }, label[o.status]),
        isAdmin() && info ? el('select', { 'aria-label': `Priority for ${o.name}`, onchange: (e) => guard(async () => { await api(`/organizations/${o.id}`, { method: 'PATCH', body: { tier: Number(e.target.value) } }); toast('Priority saved'); }) },
          [5, 4, 3, 2, 1].map((n) => el('option', { value: n, selected: info.tier === n }, `Priority ${n}`))) : null,
        isAdmin() && info ? el('label', { class: 'row inline-check' }, el('input', { type: 'checkbox', checked: info.autoApprove, onchange: (e) => guard(async () => {
          await api(`/organizations/${o.id}`, { method: 'PATCH', body: { autoApprove: e.target.checked } }); toast(e.target.checked ? 'Trusted: auto-approve on' : 'Auto-approve off');
        }) }), 'Trusted') : null)), body));
    body.append(host);
    if (isStaff() || myOrgIds().includes(o.id)) body.append(teamsPanel(o, isAdmin() || orgAdminIds().includes(o.id)));
    load();
  }
  if (!status.length) wrap.append(el('div', { class: 'panel empty-big' }, el('p', { class: 'muted' }, 'No groups yet.')));
  return wrap;
}

/* ---------- Closures ---------- */
async function closuresView() {
  const [{ closures }, { facilities }] = await Promise.all([api('/closures'), api('/facilities')]);
  const reason = el('input', { type: 'text', maxlength: 200, placeholder: 'Rain, aeration, tournament', 'aria-label': 'Reason' });
  const d1 = el('input', { type: 'date', 'aria-label': 'First day' });
  const d2 = el('input', { type: 'date', 'aria-label': 'Last day (optional)' });
  const t1 = el('input', { type: 'time', 'aria-label': 'From time' });
  const t2 = el('input', { type: 'time', 'aria-label': 'Until time' });
  const target = el('select', { 'aria-label': 'What to close' }, el('option', { value: 'all' }, 'Everything'),
    facilities.map((f) => el('option', { value: `f:${f.id}` }, `All of ${f.name}`)),
    state.spaces.map((s) => el('option', { value: `s:${s.id}` }, `${s.parent_id ? 'Section: ' : ''}${s.name}`)));
  const result = el('p', { class: 'muted', role: 'status' });
  const days = new Set();
  const dayChips = el('div', { class: 'chips' }, [1, 2, 3, 4, 5, 6, 0].map((n) => el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: (e) => {
    days.has(n) ? days.delete(n) : days.add(n); e.currentTarget.setAttribute('aria-pressed', String(days.has(n))); } }, WEEKDAYS[n])));
  const body = (preview) => { const b = { reason: reason.value, startDate: d1.value, endDate: d2.value || d1.value, preview }; if (days.size) b.weekdays = [...days];
    if (t1.value) b.startTime = t1.value; if (t2.value) b.endTime = t2.value;
    if (target.value === 'all') b.all = true; else if (target.value.startsWith('f:')) b.facilityId = target.value.slice(2); else b.spaceId = target.value.slice(2); return b; };
  const closeBtn = el('button', { class: 'btn danger', type: 'button', onclick: () => guard(async () => {
    const p = await api('/closures', { method: 'POST', body: body(true) });
    if (p.bookings && !confirm(`${p.bookings} booking${p.bookings === 1 ? '' : 's'} from ${p.requests} request${p.requests === 1 ? '' : 's'} will be cancelled and the people told. Close anyway?`)) return;
    const r = await api('/closures', { method: 'POST', body: body(false) });
    toast(r.closures > 1 ? `Closed ${r.closures} days${r.cancelledBookings ? `. ${r.cancelledBookings} booking${r.cancelledBookings === 1 ? '' : 's'} cancelled` : ''}` : r.cancelledBookings ? `Closed. ${r.cancelledBookings} booking${r.cancelledBookings === 1 ? '' : 's'} cancelled` : 'Closed'); render();
  }) }, 'Close it');
  return el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, 'Closures')),
    section('Close a field', el('p', { class: 'muted small' }, 'Use for rain, aeration or a tournament. Anything booked in that time is cancelled and each person gets an email. Leave the times empty to close all day.'),
      el('div', { class: 'grid2' }, field('Reason', reason), field('What', target)),
      el('div', { class: 'grid2' }, field('First day', d1), field('Last day', d2, 'Leave empty for one day')),
      el('div', { class: 'grid2' }, field('From (optional)', t1), field('Until (optional)', t2)),
      field('Only on these days (optional)', dayChips, 'For a repeating closure such as aeration every Monday morning. Up to 60 days at a time.'), result, closeBtn),
    section('Upcoming closures', closures.length ? el('ul', { class: 'plain' }, closures.map((c) => el('li', { class: 'row between' },
      el('span', {}, `${c.space}: ${c.reason}, ${dayLabel(c.startsAt)} ${hhmm(c.startsAt)} to ${ymd(c.startsAt) === ymd(new Date(new Date(c.endsAt) - 1)) ? hhmm(c.endsAt) : `${dayLabel(new Date(new Date(c.endsAt) - 1))} ${hhmm(c.endsAt)}`}`),
      el('button', { class: 'btn alt small', onclick: () => guard(async () => { if (!confirm('Reopen this? Cancelled bookings stay cancelled.')) return; await api(`/closures/${c.id}`, { method: 'DELETE' }); render(); }) }, 'Reopen'))))
      : el('p', { class: 'muted' }, 'None.')));
}

/* ---------- Reports ---------- */
async function reportsView() {
  const today = ymd(new Date());
  if (!state.report) state.report = { from: addDays(today, -90), to: today };
  const from = el('input', { type: 'date', value: state.report.from, 'aria-label': 'From' });
  const to = el('input', { type: 'date', value: state.report.to, 'aria-label': 'To' });
  const data = await api(`/reports/usage?from=${state.report.from}&to=${state.report.to}`);
  const table = (rows, label) => rows.length ? el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, el('th', {}, label), el('th', { class: 'num' }, 'Bookings'), el('th', { class: 'num' }, 'Hours'))),
    el('tbody', {}, rows.map((r) => el('tr', {}, el('td', {}, r.name), el('td', { class: 'num' }, String(r.bookings)), el('td', { class: 'num' }, String(r.hours)))))) : el('p', { class: 'muted' }, 'No bookings in this range.');
  const activity = isAdmin() ? await activityPanel() : null;
  return el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, 'Usage'),
    el('button', { class: 'btn alt small', onclick: () => guard(() => download(`/export/usage.csv?from=${state.report.from}&to=${state.report.to}`, 'usage.csv')) }, 'Download CSV')),
    el('div', { class: 'panel row' }, el('label', {}, 'From'), from, el('label', {}, 'To'), to,
      el('button', { class: 'btn small', onclick: () => { state.report = { from: from.value, to: to.value }; render(); } }, 'Show')),
    el('div', { class: 'stats' }, [['Hours booked', data.totalHours], ['Waiting', data.pending], ['Cancelled dates', data.cancelled], ['Conflicts', data.conflicts]].map(([l, v]) =>
      el('div', { class: 'stat panel' }, el('b', {}, String(v)), el('span', { class: 'muted small' }, l)))),
    section('By field', table(data.bySpace, 'Field')), section('By group', table(data.byOrg, 'Group')), await utilizationPanel(state.report.from, state.report.to), activity);
}

/* ---------- Add to your calendar ---------- */
async function calendarView() {
  const { feeds } = await api('/calendar-feeds');
  const mine = state.orgs.filter((o) => isStaff() || myOrgIds().includes(o.id));
  const which = el('select', { 'aria-label': 'Which bookings' }, el('option', { value: '' }, 'The whole schedule'), mine.map((o) => el('option', { value: o.id }, o.name)));
  const out = el('div', {});
  const copy = (txt) => navigator.clipboard?.writeText(txt).then(() => toast('Copied'), () => toast('Select and copy the address', true));
  return el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, 'Add to your calendar')),
    section('Subscribe in Google, Apple or Outlook', el('p', { class: 'muted' }, 'You get a private address. Add it as a calendar subscription and approved bookings show up and stay up to date. Anyone with the address can see the bookings, so do not share it.'),
      field('What to include', which),
      el('button', { class: 'btn', onclick: () => guard(async () => {
        const r = await api('/calendar-feeds', { method: 'POST', body: { organizationId: which.value || null, label: which.selectedOptions[0].textContent } });
        out.replaceChildren(el('div', { class: 'notice stack' }, el('p', {}, el('b', {}, 'Copy this now. It is shown only once.')),
          el('input', { type: 'text', readonly: true, value: r.url, 'aria-label': 'Calendar address', onfocus: (e) => e.target.select() }),
          el('div', { class: 'actions' }, el('button', { class: 'btn small', onclick: () => copy(r.url) }, 'Copy address'),
            el('a', { class: 'btn alt small', href: r.webcal }, 'Open in calendar app')),
          el('p', { class: 'muted small' }, 'Google Calendar: Other calendars, From URL, paste the address. Apple and Outlook: choose Add subscription.'),
          el('h3', {}, 'Share a schedule page'), el('p', { class: 'muted small' }, 'A read-only page with the same bookings, for parents or a club website. Anyone with the link can see it.'),
          el('input', { type: 'text', readonly: true, value: r.pageUrl, 'aria-label': 'Schedule page address', onfocus: (e) => e.target.select() }),
          el('div', { class: 'actions' }, el('button', { class: 'btn small', onclick: () => copy(r.pageUrl) }, 'Copy page link'), el('a', { class: 'btn alt small', href: r.pageUrl, target: '_blank', rel: 'noopener' }, 'Open')),
          el('p', { class: 'muted small' }, 'To embed it in a website:'),
          el('input', { type: 'text', readonly: true, class: 'mono', value: `<iframe src="${r.pageUrl}?embed=1" width="100%" height="640" style="border:0" title="Schedule"></iframe>`, 'aria-label': 'Embed code', onfocus: (e) => e.target.select() })));
      }) }, 'Create my calendar address'), out),
    feeds.length ? section('Your addresses', el('ul', { class: 'plain' }, feeds.map((f) => el('li', { class: 'row between' }, el('span', {}, f.label),
      el('button', { class: 'btn danger small', onclick: () => guard(async () => { if (!confirm('Turn this address off? Calendars using it stop updating.')) return; await api(`/calendar-feeds/${f.id}`, { method: 'DELETE' }); render(); }) }, 'Turn off'))))) : null);
}

/* ---------- Setup (tenant admin) ---------- */
function parseTable(text) { // CSV or tab separated (paste from a spreadsheet); first row is the header
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const split = (line) => { const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) { const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === delim) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out.map((x) => x.trim()); };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}
const IMPORTS = {
  spaces: { label: 'Fields and sections', cols: 'facility, field, section, lights', example: 'facility,field,section,lights\nNorth Complex,Pitch A,North half,yes\nNorth Complex,Pitch A,South half,yes' },
  organizations: { label: 'Clubs, schools and teams', cols: 'name, kind', example: 'name,kind\nU10 Boys,club\nSpring-Ford HS,school' },
  members: { label: 'People in each group', cols: 'organization, name, email, role (manager or blank)', example: 'organization,name,email,role\nU10 Boys,Pat Lee,pat@example.com,manager\nU10 Boys,Sam Ortiz,sam@example.com' },
  bookings: { label: 'Existing bookings', cols: 'organization, space, title, date, start, end', example: 'organization,space,title,date,start,end\nU10 Boys,North half,Practice,2027-09-07,17:00,18:30' },
};
function importPanel() {
  const kind = el('select', { 'aria-label': 'What to import', onchange: () => { box.placeholder = IMPORTS[kind.value].example; info.textContent = `Columns: ${IMPORTS[kind.value].cols}`; } },
    Object.entries(IMPORTS).map(([k, v]) => el('option', { value: k }, v.label)));
  const info = el('p', { class: 'muted small' }, `Columns: ${IMPORTS.spaces.cols}`);
  const box = el('textarea', { class: 'mono', rows: '6', placeholder: IMPORTS.spaces.example, 'aria-label': 'Paste rows here' });
  const file = el('input', { type: 'file', accept: '.csv,.tsv,.txt', 'aria-label': 'Choose a file', onchange: async (e) => { const f = e.target.files[0]; if (f) box.value = await f.text(); } });
  const out = el('div', { role: 'status' });
  const run = (preview) => guard(async () => {
    const rows = parseTable(box.value);
    if (!rows.length) throw new Error('Paste a header row and at least one data row');
    const r = await api(`/import/${kind.value}`, { method: 'POST', body: { rows, preview } });
    out.replaceChildren(el('div', { class: 'notice' },
      el('p', {}, el('b', {}, preview ? 'This is what would happen: ' : 'Done: '), Object.entries(r.created).map(([k, v]) => `${v} ${k}`).join(', ')),
      r.errors.length ? el('ul', {}, r.errors.slice(0, 20).map((x) => el('li', {}, `Row ${x.row}: ${x.message}`))) : null,
      r.errors.length > 20 ? el('p', { class: 'muted small' }, `and ${r.errors.length - 20} more`) : null));
    if (!preview) { toast('Imported'); await loadData(); }
  });
  return section('Import from a spreadsheet', el('p', { class: 'muted small' }, 'Copy rows from Excel or Google Sheets and paste them here, or choose a CSV file. Check first, then import. Up to 500 rows at a time.'),
    field('What are you importing', kind), info, box, file,
    el('div', { class: 'actions' }, el('button', { class: 'btn alt', onclick: () => run(true) }, 'Check first'), el('button', { class: 'btn', onclick: () => run(false) }, 'Import')), out);
}

async function rulesPanel() {
  const [s, { hours }] = await Promise.all([api('/settings'), api('/hours')]);
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const zone = el('input', { type: 'text', list: 'zones', value: s.timezone, 'aria-label': 'Time zone' });
  const lat = el('input', { type: 'text', inputmode: 'decimal', value: s.latitude ?? '', placeholder: '40.13', 'aria-label': 'Latitude' });
  const lon = el('input', { type: 'text', inputmode: 'decimal', value: s.longitude ?? '', placeholder: '-75.51', 'aria-label': 'Longitude' });
  const level = (v, opts) => el('select', {}, opts.map(([k, l]) => el('option', { value: k, selected: k === v }, l)));
  const dl = level(s.daylightRule, [['off', 'Do not check'], ['warn', 'Flag for the approver'], ['block', 'Do not allow']]);
  const ins = level(s.insuranceRule, [['off', 'Do not check'], ['warn', 'Flag for the approver'], ['block', 'Do not allow']]);
  const num = (v) => (v.trim() === '' ? null : Number(v));
  const notice = el('input', { type: 'number', min: '0', max: '720', value: s.cancelNoticeHours ?? 0, 'aria-label': 'Hours of notice' });
  const minCov = el('input', { type: 'number', min: '0', step: '1000', value: s.minCoverage ?? '', placeholder: 'No minimum', 'aria-label': 'Minimum coverage' });
  const addl = el('input', { type: 'checkbox', id: 'addl', checked: !!s.requireAdditionalInsured });
  const hold = el('input', { type: 'checkbox', id: 'hold', checked: !!s.holdUnpaid });
  const minUse = el('input', { type: 'number', min: '1', max: '100', value: s.minUsePct ?? '', placeholder: 'Off', 'aria-label': 'Minimum use percent' });
  const noShows = el('input', { type: 'number', min: '1', max: '50', value: s.noShowLimit ?? '', placeholder: 'Off', 'aria-label': 'No-shows allowed per year' });
  const save = el('button', { class: 'btn', onclick: () => guard(async () => {
    await api('/settings', { method: 'PATCH', body: { timezone: zone.value, latitude: num(lat.value), longitude: num(lon.value), daylightRule: dl.value, insuranceRule: ins.value,
      cancelNoticeHours: Number(notice.value || 0), minCoverage: num(minCov.value), requireAdditionalInsured: addl.checked, holdUnpaid: hold.checked,
      minUsePct: num(minUse.value), noShowLimit: num(noShows.value) } });
    state.tenant = await api('/tenant'); state.tenant.daylightRule = dl.value; toast('Saved');
  }) }, 'Save rules');

  // bookable hours
  const hSpace = el('select', { 'aria-label': 'Applies to' }, el('option', { value: '' }, 'All spaces'), state.spaces.map((x) => el('option', { value: x.id }, x.name)));
  const hDays = new Set([0, 1, 2, 3, 4, 5, 6]);
  const dayChips = el('div', { class: 'chips' }, [1, 2, 3, 4, 5, 6, 0].map((n) => el('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', onclick: (e) => {
    hDays.has(n) ? hDays.delete(n) : hDays.add(n); e.currentTarget.setAttribute('aria-pressed', String(hDays.has(n))); } }, WEEKDAYS[n])));
  const opens = el('input', { type: 'time', value: '08:00', 'aria-label': 'Opens' }), closes = el('input', { type: 'time', value: '21:00', 'aria-label': 'Closes' });
  const enf = level('block', [['block', 'Do not allow outside these hours'], ['warn', 'Flag for the approver']]);
  const hNote = el('input', { type: 'text', placeholder: 'Note, for example neighbors', 'aria-label': 'Note' });
  const hs = (x) => `${x.space || 'All spaces'}: ${x.weekdays.length === 7 ? 'daily' : x.weekdays.map((n) => WEEKDAYS[n]).join(', ')} ${x.opens} to ${x.closes}, ${x.enforcement === 'block' ? 'enforced' : 'flagged'}${x.note ? `, ${x.note}` : ''}`;
  return el('div', { class: 'stack' },
    section('Rules', el('p', { class: 'muted small' }, 'Rules can flag a request for the approver or stop it from being sent.'),
      el('datalist', { id: 'zones' }, zones.map((z) => el('option', { value: z }))),
      field('Time zone', zone),
      el('div', { class: 'grid2' }, field('Latitude', lat, 'Needed for sunset times'), field('Longitude', lon)),
      field('Fields without lights: time must end before sunset', dl), field('Group has no valid insurance', ins),
      field('Minimum insurance coverage, in dollars', minCov, 'Checked when the rule above is on'),
      el('label', { for: 'addl', class: 'row', style: 'font-weight:500' }, addl, 'Group must be named as additional insured'),
      field('Cancelling inside this many hours counts as a late cancellation', notice, 'Staff are told and it shows in the usage download. 0 turns it off.'),
      el('label', { for: 'hold', class: 'row', style: 'font-weight:500' }, hold, 'Hold new requests from groups with an overdue invoice'),
      el('h4', {}, 'Use it or lose it'),
      el('div', { class: 'grid2' }, field('No-shows allowed in a year', noShows, 'Groups over this are placed last in the next season.'), field('Minimum share of given time a group must use (%)', minUse, 'Groups below it are flagged under Usage.')), save),
    section('Bookable hours', hours.length ? el('ul', { class: 'plain' }, hours.map((x) => el('li', { class: 'row between' }, el('span', {}, hs(x)),
      el('button', { class: 'btn danger small', onclick: () => guard(async () => { await api(`/hours/${x.id}`, { method: 'DELETE' }); render(); }) }, 'Remove')))) : el('p', { class: 'muted small' }, 'No limits. Add hours to stop late-night bookings.'),
      field('Applies to', hSpace), field('Days', dayChips), el('div', { class: 'grid2' }, field('Opens', opens), field('Closes', closes)), field('If outside these hours', enf), hNote,
      el('button', { class: 'btn alt', onclick: () => guard(async () => {
        if (!hDays.size) throw new Error('Pick at least one day');
        await api('/hours', { method: 'POST', body: { spaceId: hSpace.value || null, weekdays: [...hDays], opens: opens.value, closes: closes.value, enforcement: enf.value, note: hNote.value } }); toast('Added'); render();
      }) }, 'Add hours')));
}

async function setupView() {
  const [{ facilities }, { organizations }] = await Promise.all([api('/facilities'), api('/organizations')]);
  state.facilities = facilities;
  const post = (path, body, ok) => guard(async () => { await api(path, { method: 'POST', body }); toast(ok); await loadData(); render(); });

  const facName = el('input', { type: 'text', placeholder: 'Veterans Park', 'aria-label': 'Facility name' });
  const spFac = el('select', { 'aria-label': 'Facility' }, facilities.map((f) => el('option', { value: f.id }, f.name)));
  const spParent = el('select', { 'aria-label': 'Part of' }, el('option', { value: '' }, 'A whole field'), state.spaces.map((s) => el('option', { value: s.id }, `Section of ${s.name}`)));
  const spName = el('input', { type: 'text', placeholder: 'Upper field', 'aria-label': 'Space name' });
  const spLights = el('input', { type: 'checkbox', id: 'lights' });
  const orgName = el('input', { type: 'text', placeholder: 'U12 Girls', 'aria-label': 'Organization name' });
  const orgKind = el('select', { 'aria-label': 'Kind' }, ['club', 'school', 'league', 'other'].map((k) => el('option', { value: k }, cap(k))));
  const mOrg = el('select', { 'aria-label': 'Organization' }, organizations.map((o) => el('option', { value: o.id }, o.name)));
  const mName = el('input', { type: 'text', placeholder: 'Full name', 'aria-label': 'Full name' });
  const mEmail = el('input', { type: 'email', placeholder: 'email@example.com', 'aria-label': 'Email' });
  const mRole = el('select', { 'aria-label': 'Role' }, el('option', { value: 'booker' }, 'Can request time'), el('option', { value: 'org_admin' }, 'Manages the organization'));
  const sName = el('input', { type: 'text', placeholder: 'Full name', 'aria-label': 'Staff name' });
  const sEmail = el('input', { type: 'email', placeholder: 'email@example.com', 'aria-label': 'Staff email' });
  const sRole = el('select', { 'aria-label': 'Staff role', onchange: () => { sSite.classList.toggle('hidden', sRole.value === 'tenant_admin'); } }, el('option', { value: 'approver' }, 'Approver'), el('option', { value: 'grounds' }, 'Groundskeeper (closes fields)'), el('option', { value: 'tenant_admin' }, 'Admin'));
  const sSite = el('select', { 'aria-label': 'Which site' }, el('option', { value: '' }, 'All sites'), facilities.map((f) => el('option', { value: f.id }, `Only ${f.name}`)));

  const money_ = await paymentsPanel().catch(() => null);
  return el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, 'Setup')), planPanel(), money_,
    section('Fields and sections',
      state.spaces.length ? pitchPicker(state.spaces, {}) : el('p', { class: 'muted' }, 'No fields yet. Add a facility, then its fields.'),
      el('div', { class: 'row' }, facName, el('button', { class: 'btn alt', onclick: () => facName.value && post('/facilities', { name: facName.value }, 'Facility added') }, 'Add facility')),
      facilities.length ? el('div', { class: 'stack' },
        el('div', { class: 'grid2' }, spFac, spParent), spName,
        el('label', { for: 'lights', class: 'row', style: 'font-weight:500' }, spLights, 'Has lights'),
        el('button', { class: 'btn', onclick: () => spName.value && post('/spaces', { facilityId: spFac.value, parentId: spParent.value || null, name: spName.value, hasLights: spLights.checked }, 'Added') }, 'Add field or section')) : null),
    section('Clubs, schools and teams',
      organizations.length ? el('ul', {}, organizations.map((o) => el('li', {}, `${o.name} (${o.kind}), priority ${o.tier}${o.autoApprove ? ', trusted' : ''}`))) : el('p', { class: 'muted' }, 'None yet.'),
      el('div', { class: 'row' }, orgName, orgKind, el('button', { class: 'btn alt', onclick: () => orgName.value && post('/organizations', { name: orgName.value, kind: orgKind.value }, 'Organization added') }, 'Add organization')),
      organizations.length ? el('div', { class: 'stack' }, el('h3', {}, 'Invite someone'),
        el('p', { class: 'muted small' }, 'They get an email with a sign-in link.'),
        el('div', { class: 'grid2' }, mOrg, mRole), el('div', { class: 'grid2' }, mName, mEmail),
        el('button', { class: 'btn', onclick: () => post(`/organizations/${mOrg.value}/members`, { fullName: mName.value, email: mEmail.value, role: mRole.value }, 'Invitation sent') }, 'Send invitation')) : null),
    section('Approvers', el('p', { class: 'muted small' }, 'Approvers review requests. Admins can also change setup.'),
      el('div', { class: 'grid2' }, sName, sEmail), el('div', { class: 'grid2' }, sRole, sSite),
      el('p', { class: 'muted small' }, 'Limit an approver to one site and they only see and decide requests there. A groundskeeper can close fields but not approve. A groundskeeper must be tied to a site.'),
      el('button', { class: 'btn alt', onclick: () => post('/staff', { fullName: sName.value, email: sEmail.value, role: sRole.value, ...(sSite.value && sRole.value !== 'tenant_admin' ? { facilityId: sSite.value } : {}) }, 'Invitation sent') }, 'Add')),
    await rulesPanel(), importPanel(), mapEditor());
}

/* ---------- boot ---------- */
async function loadData() {
  const [{ spaces }, { facilities }, { organizations }] = await Promise.all([api('/spaces'), api('/facilities'), api('/organizations')]);
  state.spaces = spaces; state.facilities = facilities; state.orgs = organizations;
  try { state.compliance = (await api('/compliance')).organizations; } catch { state.compliance = []; }
}
async function render() {
  if (!state.me) {
    try { state.me = await (await fetch('/me')).json(); if (!state.me.user) state.me = null; } catch { state.me = null; }
  }
  if (!state.me) return $app.replaceChildren(loginScreen());
  if (!state.tenant) {
    const ids = [...new Set(state.me.memberships.map((m) => m.tenant_id))];
    if (!ids.length) return $app.replaceChildren(el('main', {}, el('p', {}, 'Your email is not part of any group yet. Ask a group admin to add you.')));
    const saved = remembered();
    state.tenant = { id: ids.includes(saved) ? saved : ids[0] };
    state.tenant = await api('/tenant');
    await loadData();
  }
  const views = { schedule: scheduleView, requests: requestsView, new: newRequestView, groups: groupsView, closures: closuresView, seasons: seasonsView, billing: billingView, profile: profileView, reports: reportsView, calendar: calendarView, setup: setupView };
  let content;
  try { content = await views[state.view](); } catch (e) { content = el('p', { role: 'alert' }, e.message); }
  $app.replaceChildren(shell(content));
}
const params = new URLSearchParams(location.search);
if (params.has('paid') || params.has('stripe')) {
  if (location.hash === '#billing') state.view = 'billing'; else if (location.hash === '#setup') state.view = 'setup';
  history.replaceState(null, '', '/');
  setTimeout(() => toast(params.has('paid') ? 'Payment received. Thank you.' : 'Back from Stripe.'), 600);
}
render();

const reload = async () => { await loadData(); await render(); };
export { el, api, state, toast, guard, render, go, section, field, cap, dayLabel, hhmm, ymd, isAdmin, isStaff, myOrgIds, canManageOrg, parseTable, reload };
