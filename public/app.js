// CanWeUseIt web app. No build step; all text goes through el() so nothing user-supplied is ever parsed as HTML.
import { seasonsView, billingView, applicationsPanel, activityPanel, invoiceBox, download, money } from './more.js';
import { mapPicker, mapEditor, hasMap, teamPlanBox, releaseBox, teamsPanel, paymentsPanel, planPanel, utilizationPanel, profileView } from './gaps.js';
import { icon, brandMark, productArt, emptyState, skeleton, menu, sheet, groupColor, shortOrg, shortSpace, savedTheme, saveTheme, isPhone } from './ui.js';
const $app = document.getElementById('app');
const state = { me: null, tenants: [], tenant: null, view: 'schedule', spaces: [], orgs: [], weekStart: null, month: null, calMode: null, agendaStart: null, selectedDay: null,
  prefill: null, compliance: [], report: null, spaceFilter: '', rq: null, rqSel: null, pendingCount: 0, setupTab: 'start' };

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
const shortDate = (d) => fmt(d, { month: 'short', day: 'numeric' });
const compactTime = (d) => fmt(d, { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' AM', 'a').replace(' PM', 'p');
const addDays = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (s) => { const dow = new Date(`${s}T12:00:00Z`).getUTCDay(); return addDays(s, -((dow + 6) % 7)); };
const isStaff = () => state.tenant.roles.some((r) => ['tenant_admin', 'approver'].includes(r.role));
const canClose = () => state.tenant.roles.some((r) => ['tenant_admin', 'approver', 'grounds'].includes(r.role));
const isAdmin = () => state.tenant.roles.some((r) => r.role === 'tenant_admin');
const myOrgIds = () => state.tenant.roles.filter((r) => ['org_admin', 'booker'].includes(r.role)).map((r) => r.organizationId);
const orgAdminIds = () => state.tenant.roles.filter((r) => r.role === 'org_admin').map((r) => r.organizationId);
const spaceName = (id) => state.spaces.find((s) => s.id === id)?.name || '';
const facilityOf = (spaceId) => { const s = state.spaces.find((x) => x.id === spaceId); return (state.facilities || []).find((f) => f.id === s?.facility_id)?.name || ''; };
// each group keeps one color: by its place in the name-sorted list (distinct for the first eight), else by its id
const colorVar = (orgId) => `--c:${groupColor(orgId, state.orgs.findIndex((o) => o.id === orgId))}`;

async function guard(fn) { try { await fn(); } catch (e) { if (e.message !== 'Sign in required') toast(e.message, true); } }

/* ---------- pitch picker: each field drawn as a pitch, sections as its parts ---------- */
function pitchPicker(spaces, { selected, onSelect, closed = new Set() }) {
  const kids = (id) => spaces.filter((s) => s.parent_id === id);
  const tags = (s) => [s.has_lights ? el('span', { class: 'tag' }, icon('lightbulb', { size: 12 }), 'Lights') : null,
    closed.has(s.id) ? el('span', { class: 'tag' }, icon('lock', { size: 12 }), 'Closed') : null];
  const btn = (s, cls, label) => el('button', {
    type: 'button', class: cls, 'aria-pressed': String(selected === s.id), onclick: () => onSelect && onSelect(s),
    'aria-label': `${label || s.name}${closed.has(s.id) ? ', closed that day' : ''}${s.has_lights ? ', has lights' : ''}`,
  }, el('span', {}, label || s.name), ...tags(s));
  const node = (s) => {
    const parts = kids(s.id);
    if (!parts.length) return el('div', { class: 'pitch single' + (closed.has(s.id) ? ' closed' : '') }, btn(s, 'whole'));
    return el('div', { class: 'pitch' + (closed.has(s.id) ? ' closed' : '') },
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
    el('section', { class: 'facility' }, el('h3', {}, icon('map-pin', { size: 18 }), facilityName(fid)), el('div', { class: 'pitches' }, roots.map(node)))));
}

/* ---------- sign in ---------- */
function loginScreen() {
  const email = el('input', { type: 'email', id: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  const box = el('div', { class: 'stack' });
  const showForm = () => box.replaceChildren(el('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    await fetch('/auth/request-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value }) }).catch(() => null);
    box.replaceChildren(el('div', { class: 'check-email', role: 'status' },
      el('h2', {}, icon('mail', { size: 26 }), ' Check your email'),
      el('p', { class: 'muted' }, `If ${email.value} has an account, a sign-in link is on its way. It works once, for 15 minutes.`),
      el('div', { class: 'row' }, el('a', { class: 'btn', href: 'https://mail.google.com/', target: '_blank', rel: 'noopener' }, 'Open Gmail', icon('external-link', { size: 16 })),
        el('a', { class: 'btn alt', href: 'https://outlook.live.com/mail/', target: '_blank', rel: 'noopener' }, 'Open Outlook', icon('external-link', { size: 16 }))),
      el('button', { type: 'button', class: 'linkbtn', onclick: showForm }, 'Use a different email')));
  } },
  el('div', { class: 'field' }, el('label', { for: 'email' }, 'Email'), email),
  el('button', { class: 'btn', type: 'submit' }, 'Email me a sign-in link', icon('arrow-right', { size: 18 })),
  el('p', { class: 'muted small' }, 'No password needed. We email you a link that signs you in.')));
  showForm();
  return el('div', { class: 'signin' },
    el('main', { class: 'signin-form', id: 'main' },
      el('a', { class: 'public-brand', href: '/' }, brandMark(32), 'CanWeUseIt'),
      el('h1', {}, 'Sign in'),
      el('p', { class: 'muted' }, 'Request field time, see what is approved, and keep every club on the same page.'),
      box,
      el('p', { class: 'small' }, 'Run the fields for a league, district or town? ', el('a', { href: '/signup' }, 'Start your group free')),
      legalLinks()),
    el('aside', { class: 'signin-art' }, el('p', { class: 'tag-line' }, 'Fair field time, without the email chains.'),
      el('p', { class: 'sub' }, 'Clubs and schools ask for time. You approve it in one place. Everyone sees the same schedule.'), productArt()));
}

/* ---------- the frame: top bar, sidebar, phone tab bar ---------- */
const legalLinks = () => el('p', { class: 'legal-links small' }, el('a', { href: '/privacy' }, 'Privacy'), ' · ', el('a', { href: '/terms' }, 'Terms'), ' · ', el('a', { href: '/accessibility' }, 'Accessibility'));
const remember = (id) => { try { localStorage.setItem('cwui-tenant', id); } catch { /* private window */ } };
const remembered = () => { try { return localStorage.getItem('cwui-tenant'); } catch { return null; } };
const signOut = async () => { await fetch('/auth/logout', { method: 'POST' }); state.me = null; state.tenant = null; render(); };
function switcher() {
  const list = state.me.tenants || [];
  if (list.length < 2) return el('span', { class: 'tenant-name' }, state.tenant.name);
  return el('div', { class: 'switch' }, el('label', { for: 'tenant-pick', class: 'sr-only' }, 'Group'),
    el('select', { id: 'tenant-pick', onchange: (e) => guard(async () => { remember(e.target.value); state.tenant = { id: e.target.value }; state.tenant = await api('/tenant'); state.view = 'schedule'; state.rq = null; await loadData(); render(); }) },
      list.map((t) => el('option', { value: t.id, selected: t.id === state.tenant.id }, t.name))));
}
function navGroups() {
  const g = [{ label: 'Bookings', items: [['schedule', 'Schedule', 'calendar-days'], ['requests', 'Requests', 'inbox'], ['new', 'Request time', 'circle-plus']] }];
  const manage = [];
  if (isStaff() || orgAdminIds().length) manage.push(['groups', 'Groups', 'users']);
  if (canClose()) manage.push(['closures', 'Closures', 'cloud-rain']);
  if (isStaff()) manage.push(['seasons', 'Seasons', 'trophy']);
  if (manage.length) g.push({ label: 'Manage', items: manage });
  const money_ = [];
  if (isStaff() || myOrgIds().length) money_.push(['billing', isStaff() ? 'Fees' : 'Invoices', 'receipt']);
  if (isStaff()) money_.push(['reports', 'Usage', 'chart-column']);
  if (money_.length) g.push({ label: 'Money and reports', items: money_ });
  if (isAdmin()) g.push({ label: 'Admin', items: [['setup', 'Setup', 'settings']] });
  return g;
}
const countBadge = (id) => (id === 'requests' && state.pendingCount ? el('span', { class: 'count', 'aria-label': `${state.pendingCount} waiting` }, String(state.pendingCount)) : null);
function userMenu() {
  const name = state.me.user.full_name || state.me.user.email;
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const theme = savedTheme();
  const t = (mode, label, ic) => ({ label: `${label}${theme === mode ? ' (on)' : ''}`, icon: ic, onSelect: () => { saveTheme(mode); render(); } });
  return menu('Your account', [{ head: `${name} · ${state.me.user.email}` }, { label: 'Your settings', icon: 'user', onSelect: () => go('profile') },
    { label: 'Add to your calendar', icon: 'calendar', onSelect: () => go('calendar') },
    state.me.platformAdmin ? { label: 'Owner console', icon: 'layers', onSelect: () => go('platform') } : null, 'sep',
    t('system', 'Match my device', 'monitor'), t('light', 'Light', 'sun'), t('dark', 'Dark', 'moon'), 'sep',
    { label: 'Sign out', icon: 'log-out', onSelect: signOut }],
  { trigger: el('button', { type: 'button', class: 'avatar', 'aria-label': `Account menu for ${name}` }, initials) });
}
function shell(content, entering) {
  const groups = navGroups();
  const all = groups.flatMap((g) => g.items);
  const search = isStaff() ? el('form', { class: 'top-search', role: 'search', onsubmit: (e) => { e.preventDefault(); const q = e.target.q.value.trim(); state.rq = { status: '', q }; go('requests'); } },
    icon('search', { size: 16 }), el('label', { for: 'top-q', class: 'sr-only' }, 'Find a request'), el('input', { id: 'top-q', name: 'q', type: 'search', placeholder: 'Find a request or group' })) : null;
  const sidebar = el('nav', { class: 'sidebar', 'aria-label': 'Main' }, groups.map((g) => el('div', { class: 'nav-group' }, el('div', { class: 'nav-label' }, g.label),
    g.items.map(([id, label, ic]) => el('button', { class: 'nav-item', 'aria-current': state.view === id ? 'page' : null, onclick: () => go(id) }, icon(ic), label, countBadge(id))))));
  const primary = ['schedule', 'requests', 'new'];
  const moreItems = all.filter(([id]) => !primary.includes(id));
  const moreOpen = () => sheet('More', (close) => el('div', { class: 'stack' },
    el('div', {}, moreItems.map(([id, label, ic]) => el('button', { class: 'nav-item', 'aria-current': state.view === id ? 'page' : null, onclick: () => { close(); go(id); } }, icon(ic), label))),
    el('div', { class: 'menu-sep' }),
    el('button', { class: 'nav-item', onclick: () => { close(); go('profile'); } }, icon('user'), 'Your settings'),
    el('button', { class: 'nav-item', onclick: () => { close(); go('calendar'); } }, icon('calendar'), 'Add to your calendar'),
    el('button', { class: 'nav-item', onclick: () => { close(); signOut(); } }, icon('log-out'), 'Sign out')));
  const tab = (id, label, ic) => el('button', { class: 'tab', 'aria-current': state.view === id ? 'page' : null, onclick: () => go(id) }, icon(ic, { size: 22 }), label, countBadge(id));
  const tabbar = el('nav', { class: 'tabbar', 'aria-label': 'Main, phone' },
    tab('schedule', 'Schedule', 'calendar-days'), tab('requests', 'Requests', 'inbox'),
    el('button', { class: 'tab raise', 'aria-current': state.view === 'new' ? 'page' : null, onclick: () => go('new') }, el('span', { class: 'bubble' }, icon('circle-plus', { size: 26 })), 'Request'),
    el('button', { class: 'tab', 'aria-current': moreItems.some(([id]) => id === state.view) || ['profile', 'calendar'].includes(state.view) ? 'page' : null, onclick: moreOpen }, icon('menu', { size: 22 }), 'More'));
  return el('div', { class: 'app' },
    el('header', { class: 'topbar' }, el('a', { class: 'brand', href: '/', 'aria-label': 'CanWeUseIt, back to the schedule', onclick: (e) => { e.preventDefault(); go('schedule'); } }, brandMark(30), el('span', { class: 'wordmark' }, 'CanWeUseIt'), el('span', { class: 'sep' }, '/')),
      switcher(), el('span', { class: 'spacer' }), search, userMenu()),
    sidebar,
    el('div', { class: 'body' }, el('main', { id: 'main', class: entering ? 'view-enter' : null }, content), el('footer', { class: 'foot' }, legalLinks())),
    tabbar);
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

const STATUS = { pending: ['Waiting', 'clock'], approved: ['Approved', 'circle-check'], confirmed: ['Confirmed', 'circle-check'], declined: ['Declined', 'circle-x'],
  cancelled: ['Cancelled', 'circle-x'], flagged: ['Clash', 'triangle-alert'], conflict: ['Clash', 'triangle-alert'] };
function statusBadge(status) { const [label, ic] = STATUS[status] || [cap(status), 'clock']; return el('span', { class: 'badge ' + status }, icon(ic, { size: 14 }), label); }
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
const TIER = { 5: 'Top priority', 4: 'High priority', 3: 'Standard priority', 2: 'Low priority', 1: 'Lowest priority' };

/* a small form: time and place for a date (used to move a booking) */
function moveForm(d, done) {
  const date = el('input', { type: 'date', value: ymd(d.startsAt), 'aria-label': 'New date' });
  const start = el('input', { type: 'time', value: hhmm(d.startsAt), 'aria-label': 'New start' });
  const end = el('input', { type: 'time', value: hhmm(d.endsAt), 'aria-label': 'New end' });
  return el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); guard(async () => {
    const r = await api(`/booking-dates/${d.id}/move`, { method: 'POST', body: { date: date.value, startTime: start.value, endTime: end.value } });
    toast(r.status === 'pending' ? 'Change sent for approval' : 'Moved'); done();
  }); } }, field('Date', date), el('div', { class: 'grid2' }, field('Starts', start), field('Ends', end)), el('button', { class: 'btn', type: 'submit' }, 'Move'));
}
const skipDate = (d, reason) => guard(async () => {
  const note = reason ? prompt('Skip this date? Add a reason for the requester (optional).', '') : (confirm('Skip this date? The field becomes free for others.') ? '' : null);
  if (note === null) return;
  await api(`/booking-dates/${d.id}/cancel`, { method: 'POST', body: { note } }); toast('Date skipped'); render();
});

/* ---------- Schedule: month, week or agenda, with a day panel ---------- */
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
const AGENDA_DAYS = 21;

// Inside a day cell: time, field and group code. The cell itself is the control, so this is plain text.
function chip(b) {
  return el('span', { class: 'chip-b' + (b.status === 'pending' ? ' pending' : ''), style: colorVar(b.organizationId),
    title: `${b.organization}: ${b.title}, ${b.space}${b.status === 'pending' ? ' (waiting for approval)' : ''}` },
  b.status === 'pending' ? icon('clock', { size: 12 }) : null, el('b', {}, compactTime(b.startsAt)), ` ${shortSpace(b.space, facilityOf(b.spaceId))} · ${shortOrg(b.organization)}`);
}
function selectDay(d) { state.selectedDay = d; render().then(() => document.getElementById('day-panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }

async function scheduleView() {
  const today = ymd(new Date());
  if (!state.calMode) state.calMode = isPhone() ? 'agenda' : 'month';
  if (!state.weekStart) state.weekStart = mondayOf(today);
  if (!state.month) state.month = monthStartOf(today);
  if (!state.agendaStart) state.agendaStart = today;
  const mode = state.calMode;
  let from, days;
  if (mode === 'month') { const g = monthGrid(state.month); from = g.gridStart; days = g.n; } else if (mode === 'week') { from = state.weekStart; days = 7; } else { from = state.agendaStart; days = AGENDA_DAYS; }
  const [{ bookings }, { closures }] = await Promise.all([api(`/bookings?start=${from}&days=${days}`), api('/closures')]);
  const shown = bookings.filter((b) => !state.spaceFilter || related(b.spaceId, state.spaceFilter));
  const closedOn = (d) => closures.filter((c) => (!state.spaceFilter || related(c.spaceId, state.spaceFilter)) && ymd(c.startsAt) <= d && ymd(new Date(new Date(c.endsAt) - 1)) >= d);

  const modeBtn = (m, label) => el('button', { type: 'button', 'aria-pressed': String(mode === m), onclick: () => { state.calMode = m; render(); } }, label);
  const title = mode === 'month' ? fmt(`${state.month}T12:00:00Z`, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : mode === 'week' ? `${fmt(`${state.weekStart}T12:00:00Z`, { month: 'short', day: 'numeric', timeZone: 'UTC' })} to ${fmt(`${addDays(state.weekStart, 6)}T12:00:00Z`, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
      : state.agendaStart === today ? 'Coming up' : `From ${fmt(`${state.agendaStart}T12:00:00Z`, { month: 'long', day: 'numeric', timeZone: 'UTC' })}`;
  const step = (k) => { if (mode === 'month') state.month = shiftMonth(state.month, k); else if (mode === 'week') state.weekStart = addDays(state.weekStart, 7 * k); else state.agendaStart = addDays(state.agendaStart, AGENDA_DAYS * k); render(); };
  const unit = mode === 'month' ? 'month' : mode === 'week' ? 'week' : 'three weeks';
  const main = el('div', {});
  main.append(el('div', { class: 'head' }, el('h2', {}, title),
    el('div', { class: 'cal-tools' }, el('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, modeBtn('agenda', 'List'), modeBtn('week', 'Week'), modeBtn('month', 'Month')),
      el('button', { class: 'icon-btn', 'aria-label': `Previous ${unit}`, onclick: () => step(-1) }, icon('chevron-left')),
      el('button', { class: 'btn alt small', onclick: () => { state.month = monthStartOf(today); state.weekStart = mondayOf(today); state.agendaStart = today; state.selectedDay = mode === 'agenda' ? null : today; render(); } }, 'Today'),
      el('button', { class: 'icon-btn', 'aria-label': `Next ${unit}`, onclick: () => step(1) }, icon('chevron-right')),
      menu('More schedule options', [{ label: 'Add to your calendar', icon: 'calendar', onSelect: () => go('calendar') }, { label: 'Request time', icon: 'circle-plus', onSelect: () => go('new') }]))));

  // field filter as chips (a dropdown when there are many fields)
  const roots = state.spaces.filter((s) => !s.parent_id);
  if (roots.length > 1 && roots.length <= 6) main.append(el('div', { class: 'chips field-chips', role: 'group', 'aria-label': 'Show fields' },
    el('button', { class: 'chip', 'aria-pressed': String(!state.spaceFilter), onclick: () => { state.spaceFilter = ''; render(); } }, 'All fields'),
    roots.map((s) => el('button', { class: 'chip', 'aria-pressed': String(state.spaceFilter === s.id), onclick: () => { state.spaceFilter = s.id; render(); } }, s.name))));
  else if (roots.length > 6) main.append(el('div', { class: 'field-chips' }, el('select', { class: 'w-m', 'aria-label': 'Show fields', onchange: (e) => { state.spaceFilter = e.target.value; render(); } },
    el('option', { value: '' }, 'All fields'), state.spaces.map((s) => el('option', { value: s.id, selected: s.id === state.spaceFilter }, (s.parent_id ? '  ' : '') + s.name)))));
  main.append(el('div', { class: 'legend-row' }, el('span', {}, el('span', { class: 'sw' }), 'Approved'), el('span', {}, el('span', { class: 'sw pending' }), 'Waiting for approval'),
    el('span', {}, icon('lock', { size: 14 }), ' Closed'), isStaff() ? null : el('span', { class: 'small' }, 'You see waiting requests only for your own group.')));

  const cell = (d, inMonth) => {
    const items = shown.filter((b) => ymd(b.startsAt) === d);
    const closed = closedOn(d);
    const dots = items.slice(0, 6).map((b) => el('i', { class: 'dot' + (b.status === 'pending' ? ' pending' : ''), style: colorVar(b.organizationId) }));
    return el('div', { class: 'cell' + (d === today ? ' today' : '') + (inMonth ? '' : ' other') + (state.selectedDay === d ? ' sel' : ''), role: 'button', tabindex: '0',
      'aria-label': `${dayLabel(`${d}T12:00:00Z`)}, ${items.length} booking${items.length === 1 ? '' : 's'}${closed.length ? ', closed' : ''}`,
      onclick: () => selectDay(d), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDay(d); } } },
    el('span', { class: 'num' }, String(Number(d.slice(8)))),
    closed.length ? el('span', { class: 'closed-band' }, icon('lock', { size: 12 }), 'Closed') : null,
    el('div', { class: 'chips-b' }, items.slice(0, 3).map(chip), items.length > 3 ? el('span', { class: 'more' }, `+${items.length - 3} more`) : null),
    el('div', { class: 'dots' }, dots, items.length > 6 ? el('span', { class: 'more' }, '+') : null));
  };

  if (mode === 'month') {
    const g = monthGrid(state.month);
    main.append(el('div', { class: 'cal' }, el('div', { class: 'cal-head' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n) => el('div', {}, n))),
      el('div', { class: 'cal-grid' }, g.days.map((d) => cell(d, d.slice(0, 7) === state.month.slice(0, 7))))));
  } else if (mode === 'week') {
    main.append(el('div', { class: 'week' }, Array.from({ length: 7 }, (_, i) => {
      const d = addDays(state.weekStart, i); const items = shown.filter((b) => ymd(b.startsAt) === d); const closed = closedOn(d);
      return el('section', { class: 'day' + (d === today ? ' today' : '') + (state.selectedDay === d ? ' sel' : '') },
        el('h3', {}, el('button', { class: 'linkbtn dayhead', onclick: () => selectDay(d) }, dayLabel(`${d}T12:00:00Z`))),
        closed.map((c) => el('p', { class: 'closed-note' }, icon('lock', { size: 14 }), `${c.space}: ${c.reason}`)),
        items.length ? items.map((b) => el('div', { class: 'slot' + (b.status === 'pending' ? ' pending' : ''), style: colorVar(b.organizationId) },
          el('b', {}, timeRange(b.startsAt, b.endsAt)), b.space, el('br'), `${b.organization}: ${b.title}`, b.status === 'pending' ? el('em', {}, ' (waiting)') : null))
          : el('p', { class: 'empty small' }, 'Nothing booked'));
    })));
  } else {
    // agenda: the next three weeks as a list, the default on phones
    const list = el('div', { class: 'agenda' });
    for (let i = 0; i < AGENDA_DAYS; i++) {
      const d = addDays(state.agendaStart, i);
      const items = shown.filter((b) => ymd(b.startsAt) === d).sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
      const closed = closedOn(d);
      if (!items.length && !closed.length) continue;
      const label = d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : null;
      list.append(el('section', { class: 'ag-day' }, el('h3', {}, label ? el('span', { class: 'today-tag' }, label) : null, fmt(`${d}T12:00:00Z`, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })),
        el('div', { class: 'ag-list' }, closed.map((c) => el('div', { class: 'ag-closed' }, icon('lock', { size: 16 }), `${c.space} closed: ${c.reason}`)),
          items.map((b) => el('button', { type: 'button', class: 'ag-item' + (b.status === 'pending' ? ' pending' : ''), style: colorVar(b.organizationId),
            onclick: () => sheet(fmt(`${d}T12:00:00Z`, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }), dayPanel(d, bookings, closures, today, true)) },
          el('span', { class: 't' }, compactTime(b.startsAt)),
          el('span', {}, el('span', { style: 'font-weight:600' }, b.title), el('br'), el('span', { class: 'w' }, `${b.space} · ${b.organization} · until ${compactTime(b.endsAt)}`)),
          b.status === 'pending' ? statusBadge('pending') : icon('chevron-right', { size: 18 }))))));
    }
    main.append(list.childElementCount ? list : emptyState('Nothing booked in these three weeks', 'Approved field time shows up here. Use Request time to ask for a slot.',
      el('button', { class: 'btn', onclick: () => go('new') }, icon('circle-plus', { size: 18 }), 'Request time')));
  }
  if (mode !== 'agenda') {
    if (state.selectedDay) main.append(dayPanel(state.selectedDay, bookings, closures, today));
    else main.append(el('p', { class: 'muted small', style: 'margin-top:12px' }, 'Choose a day to see what is free and to ask for time.'));
  }
  return main;
}

/* One day, one lane per field: booked time is filled, free time is a button that starts a request. */
function dayPanel(day, bookings, closures, today, inSheet) {
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
  walk(null, 0);
  const laneEls = lanes.filter(([s]) => !state.spaceFilter || related(s.id, state.spaceFilter)).map(([s, depth]) => {
    const own = dayBookings.filter((b) => b.spaceId === s.id);
    const shared = dayBookings.filter((b) => b.spaceId !== s.id && related(b.spaceId, s.id));
    const shut = dayClosures.filter((c) => related(c.spaceId, s.id));
    const busy = [...own, ...shared, ...shut].map((b) => range(b.startsAt, b.endsAt));
    const cells = [];
    if (!past) for (let h = START; h < END; h++) {
      if (busy.some(([a, z]) => a < (h + 1) * 60 && z > h * 60)) continue;
      cells.push(el('button', { type: 'button', class: 'free', style: `left:${pct(h * 60)};width:${100 / (END - START)}%`,
        'aria-label': `Request ${s.name} at ${hourLabel(h)}`, title: `Request ${s.name} from ${hourLabel(h)}`,
        onclick: () => { document.querySelector('dialog[open]')?.close(); state.prefill = { spaceId: s.id, date: day, start: `${String(h).padStart(2, '0')}:00`, end: `${String(Math.min(h + 2, 23)).padStart(2, '0')}:00` }; go('new'); } }));
    }
    const block = (b, cls, label) => { const [a, z] = range(b.startsAt, b.endsAt);
      return el('div', { class: 'blk ' + cls, style: `left:${pct(a)};width:calc(${pct(z)} - ${pct(a)});${cls.startsWith('own') ? colorVar(b.organizationId) : ''}`, title: label }, el('span', {}, label)); };
    return el('div', { class: 'lane', style: `--depth:${depth}` },
      el('div', { class: 'lane-name' }, s.name, s.has_lights ? el('span', { class: 'tag dark' }, icon('lightbulb', { size: 12 }), 'Lights') : null),
      el('div', { class: 'bar-track' }, cells,
        shut.map((c) => block(c, 'shut', `Closed: ${c.reason}`)),
        shared.map((b) => block(b, 'shared', `${b.space} in use`)),
        own.map((b) => block(b, 'own' + (b.status === 'pending' ? ' pending' : ''), `${shortOrg(b.organization)} ${b.title}`))));
  });
  const hourTicks = el('div', { class: 'ticks' }, Array.from({ length: (END - START) / 2 + 1 }, (_, i) => el('span', { style: `left:${(i * 2 * 100) / (END - START)}%` }, hourLabel(START + i * 2))));

  const list = dayBookings.map((b) => {
    const manage = canManageOrg(b.organizationId) && b.status !== 'cancelled';
    return el('div', { class: 'item row between' },
      el('div', { class: 'grow-1' }, el('b', {}, timeRange(b.startsAt, b.endsAt)), ` ${b.space}`, el('br'), `${b.organization}: ${b.title}`),
      statusBadge(b.status === 'confirmed' ? 'confirmed' : 'pending'),
      manage && isFuture(b.endsAt) ? menu(`Actions for ${b.title}`, [
        { label: 'Move', icon: 'move', onSelect: () => sheet('Move this date', (close) => moveForm(b, () => { close(); render(); })) },
        { label: 'Skip this date', icon: 'calendar-x', danger: true, onSelect: () => skipDate(b, isStaff()) }]) : null);
  });
  return el('section', { class: inSheet ? 'stack' : 'panel stack', id: 'day-panel', style: inSheet ? null : 'margin-top:16px' },
    inSheet ? null : el('div', { class: 'head tight' }, el('h3', {}, fmt(`${day}T12:00:00Z`, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })),
      el('div', { class: 'row' }, !past ? el('button', { class: 'btn small', onclick: () => { state.prefill = { date: day, spaceId: state.spaceFilter || '' }; go('new'); } }, icon('circle-plus', { size: 16 }), 'Request time this day') : null,
        el('button', { class: 'icon-btn', onclick: () => { state.selectedDay = null; render(); } }, icon('x', { label: 'Close day' })))),
    inSheet && !past ? el('button', { class: 'btn', onclick: () => { document.querySelector('dialog[open]')?.close(); state.prefill = { date: day }; go('new'); } }, icon('circle-plus', { size: 18 }), 'Request time this day') : null,
    dayClosures.map((c) => el('p', { class: 'closed-note' }, icon('lock', { size: 14 }), `Closed: ${c.space}. ${c.reason}`)),
    el('div', { class: 'lanes' }, el('div', { class: 'lane head-lane' }, el('div', { class: 'lane-name' }), hourTicks), laneEls),
    !past ? el('p', { class: 'muted small' }, 'Tap an open hour to start a request. Striped time means part or all of that field is in use.') : null,
    list.length ? el('div', { class: 'items' }, list) : el('p', { class: 'muted' }, 'Nothing booked this day.'));
}

/* ---------- Requests ---------- */
function insuranceBanner(orgIds) {
  const bad = (state.compliance || []).filter((o) => orgIds.includes(o.id) && o.status !== 'ok');
  if (!bad.length) return null;
  const word = { missing: 'has no insurance on file', expiring: 'has insurance expiring soon', expired: 'has expired insurance' };
  return el('div', { class: 'notice ic-row' }, icon('shield-check'), el('div', {}, bad.map((o) => el('p', {}, `${o.name} ${word[o.status]}${o.expiresOn ? ` (${o.expiresOn})` : ''}. `,
    el('button', { class: 'linkbtn', onclick: () => go('groups') }, 'Add it here'), '.'))));
}

// "Mondays, 4:00 PM to 5:30 PM · Nov 9 to Nov 30 · 4 dates" — one line per repeating pattern.
function patternLines(dates) {
  const live = dates.filter((d) => d.status !== 'cancelled');
  const use = live.length ? live : dates;
  const groups = new Map();
  for (const d of use) {
    const k = `${fmt(d.startsAt, { weekday: 'long' })}|${hhmm(d.startsAt)}|${hhmm(d.endsAt)}|${d.space || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  if (groups.size > 3) {
    const s = [...use].sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    return [`${use.length} dates between ${shortDate(s[0].startsAt)} and ${shortDate(s.at(-1).startsAt)}`];
  }
  return [...groups.values()].map((g) => {
    g.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    const f = g[0], l = g.at(-1);
    return g.length === 1 ? `${dayLabel(f.startsAt)}, ${timeRange(f.startsAt, f.endsAt)}`
      : `${fmt(f.startsAt, { weekday: 'long' })}s, ${timeRange(f.startsAt, f.endsAt)} · ${shortDate(f.startsAt)} to ${shortDate(l.startsAt)} · ${g.length} dates`;
  });
}
// Rule notes and clashes, said once per kind instead of once per date.
function problemLines(r) {
  const open = r.dates.filter((d) => ['pending', 'flagged'].includes(d.status));
  const total = open.length, out = [];
  if (!total) return out;
  const say = (n, msg) => out.push(`${n === total ? (total === 1 ? 'This date' : `All ${total} dates`) : `${n} of ${total} dates`}: ${msg}`);
  const clash = open.filter((d) => d.conflict).length;
  if (clash) say(clash, 'the field is already booked');
  const warn = new Map();
  for (const d of open) if (d.warning) { const k = d.warning.replace(/\s*\([^)]*\)/g, '').trim(); warn.set(k, (warn.get(k) || 0) + 1); }
  for (const [k, n] of warn) say(n, k.charAt(0).toLowerCase() + k.slice(1));
  return out;
}

function datesList(r) {
  const all = r.dates;
  const box = el('ul', { class: 'dates' });
  const canManage = canManageOrg(r.organization_id) || r.mine;
  const draw = (limit) => {
    box.replaceChildren(...all.slice(0, limit).map((d) => {
      const actions = [
        canManage && ['confirmed', 'pending'].includes(d.status) && isFuture(d.endsAt) && r.status !== 'declined' ? { label: 'Move', icon: 'move', onSelect: () => sheet('Move this date', (close) => moveForm(d, () => { close(); render(); })) } : null,
        d.status === 'confirmed' ? { label: 'Teams', icon: 'users', onSelect: () => sheet(`Teams on ${dayLabel(d.startsAt)}`, teamPlanBox(d)) } : null,
        d.status === 'confirmed' && canManage && isFuture(d.startsAt) ? { label: 'Give back time', icon: 'undo-2', onSelect: () => sheet('Give back time', releaseBox(d)) } : null,
        d.status === 'confirmed' && canClose() && !isFuture(d.startsAt) ? { label: d.noShow ? 'Undo no-show' : 'Mark as no-show', icon: 'ban', onSelect: () => guard(async () => {
          const x = await api(`/booking-dates/${d.id}/no-show`, { method: 'POST', body: { noShow: !d.noShow } }); toast(x.noShow ? 'Marked as a no-show' : 'No-show removed'); render(); }) } : null,
        canManage && ['confirmed', 'pending'].includes(d.status) && isFuture(d.endsAt) && r.status !== 'declined' ? 'sep' : null,
        canManage && ['confirmed', 'pending'].includes(d.status) && isFuture(d.endsAt) && r.status !== 'declined' ? { label: 'Skip this date', icon: 'calendar-x', danger: true, onSelect: () => skipDate(d, false) } : null,
      ];
      return el('li', {},
        el('span', { class: 'when' }, `${dayLabel(d.startsAt)}, ${timeRange(d.startsAt, d.endsAt)}`,
          (d.space && d.space !== r.space) || d.label ? el('span', { class: 'muted small' }, ` · ${[d.space && d.space !== r.space ? d.space : null, d.label].filter(Boolean).join(', ')}`) : null),
        d.conflict ? statusBadge('conflict') : null,
        d.noShow ? el('span', { class: 'badge conflict' }, icon('ban', { size: 14 }), 'No-show') : null,
        d.releasedMinutes ? el('span', { class: 'pill' }, `${d.releasedMinutes} min given back`) : null,
        statusBadge(d.status),
        actions.some((a) => a && a !== 'sep') ? menu(`Actions for ${dayLabel(d.startsAt)}`, actions) : null);
    }));
    if (all.length > limit) box.append(el('li', {}, el('button', { class: 'linkbtn', onclick: () => draw(999) }, `Show all ${all.length} dates`)));
  };
  draw(8);
  return box;
}

function decisionBox(r, decision, done) {
  const note = el('textarea', { placeholder: decision === 'approve' ? 'Note for the requester (optional)' : 'Why? The requester will see this (optional)', maxlength: 500, 'aria-label': 'Note' });
  const lines = problemLines(r);
  return el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); guard(async () => {
    const d = await api(`/requests/${r.id}/decision`, { method: 'POST', body: { decision, note: note.value } });
    toast(decision === 'approve' ? (d.flagged ? `${d.confirmed} confirmed, ${d.flagged} clashes` : `Approved, ${d.confirmed} date${d.confirmed === 1 ? '' : 's'} confirmed`) : 'Request declined');
    done && done(); render();
  }); } },
  el('p', {}, el('b', {}, r.title), ` from ${r.organization}`),
  decision === 'approve' && lines.length ? el('div', { class: 'notice ic-row' }, icon('triangle-alert'), el('div', {}, lines.map((l) => el('p', {}, l)), el('p', { class: 'small' }, 'Free dates are confirmed; dates that clash are marked, never double booked.'))) : null,
  field(decision === 'approve' ? 'Note (optional)' : 'Reason (optional)', note),
  el('div', { class: 'actions' }, el('button', { class: decision === 'decline' ? 'btn danger solid' : 'btn', type: 'submit' }, decision === 'approve' ? 'Approve' : 'Decline')));
}

function editBox(r, done) {
  const title = el('input', { type: 'text', value: r.title, maxlength: 200 });
  const notes = el('textarea', {}, r.notes || '');
  return el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); guard(async () => {
    await api(`/requests/${r.id}`, { method: 'PATCH', body: { title: title.value, notes: notes.value } }); toast('Saved'); done && done(); render();
  }); } }, field('Title', title), field('Notes', notes), el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'submit' }, 'Save')));
}

// One request, readable in two seconds: what, who, when, problems; Approve and Decline at the top.
function requestCard(r, { picked, onPick } = {}) {
  const staff = isStaff();
  const live = ['pending', 'approved'].includes(r.status);
  const where = [...new Set(r.dates.map((d) => d.space).filter(Boolean))];
  const mine = r.mine || canManageOrg(r.organization_id);
  const org = state.orgs.find((o) => o.id === r.organization_id);
  const problems = r.status === 'pending' ? problemLines(r) : [];
  const more = menu(`More actions for ${r.title}`, [
    r.permit ? { label: `Permit ${r.permit.number}`, icon: 'file-text', href: `/permit/${r.permit.code}`, target: '_blank' } : null,
    staff && r.status === 'approved' ? { label: 'Invoice', icon: 'receipt', onSelect: () => sheet(`Invoice for ${r.title}`, invoiceBox(r)) } : null,
    mine && live ? { label: 'Edit title or notes', icon: 'pencil', onSelect: () => sheet('Edit request', (close) => editBox(r, close)) } : null,
    ['declined', 'cancelled'].includes(r.status) && (mine || myOrgIds().includes(r.organization_id)) ? { label: 'Request again', icon: 'undo-2', onSelect: () => {
      const first = r.dates[0]; state.prefill = { spaceId: first.spaceId || r.space_id, orgId: r.organization_id, title: r.title, notes: r.notes || '', date: ymd(first.startsAt), start: hhmm(first.startsAt), end: hhmm(first.endsAt) }; go('new');
    } } : null,
    (staff && r.permit) || (mine && live) ? 'sep' : null,
    staff && r.permit ? { label: 'Revoke permit', icon: 'ban', danger: true, onSelect: () => guard(async () => { if (!confirm('Revoke this permit? The check page will show it as not valid.')) return; await api(`/requests/${r.id}/permit/revoke`, { method: 'POST' }); render(); }) } : null,
    mine && live ? { label: 'Withdraw request', icon: 'circle-x', danger: true, onSelect: () => guard(async () => {
      if (!confirm(r.status === 'approved' ? 'Withdraw this request? Every future date is released.' : 'Withdraw this request?')) return;
      await api(`/requests/${r.id}/withdraw`, { method: 'POST' }); toast('Request withdrawn'); render();
    }) } : null,
  ]);
  const dates = el('details', { class: 'dates-wrap' }, el('summary', {}, `Show ${r.dates.length === 1 ? 'the date' : `all ${r.dates.length} dates`}`), datesList(r));
  if (r.dates.length <= 2) dates.open = true;
  return el('article', { class: 'panel card', style: colorVar(r.organization_id) },
    el('div', { class: 'rq-head' },
      staff && r.status === 'pending' && onPick ? el('label', { class: 'pick' }, el('input', { type: 'checkbox', checked: !!picked, 'aria-label': `Select ${r.title}`, onchange: (e) => onPick(e.target.checked) })) : el('span', {}),
      el('div', { class: 'grow-1' }, el('h3', {}, r.title),
        el('div', { class: 'rq-meta' }, el('span', { class: 'dot', style: colorVar(r.organization_id) }), el('span', {}, r.organization),
          el('span', { class: 'sep' }, '·'), el('span', {}, where.length > 2 ? `${where.length} fields` : (where.join(' and ') || r.space)),
          staff ? el('span', { class: 'pill' }, `${cap(org?.kind || 'club')}${r.tier && r.tier !== 3 ? `, ${TIER[r.tier].toLowerCase()}` : ''}`) : null,
          r.submitted_at ? el('span', { class: 'small' }, `Sent ${shortDate(r.submitted_at)}`) : null)),
      el('div', { class: 'rq-acts' },
        staff && r.status === 'pending' ? [el('button', { class: 'btn', onclick: () => sheet('Approve request', (close) => decisionBox(r, 'approve', close)) }, icon('check', { size: 18 }), 'Approve'),
          el('button', { class: 'btn alt', onclick: () => sheet('Decline request', (close) => decisionBox(r, 'decline', close)) }, 'Decline')] : statusBadge(r.status),
        more)),
    el('div', { class: 'facts' },
      patternLines(r.dates).map((l) => el('div', { class: 'fact' }, icon('calendar-days', { size: 18 }), el('span', {}, l))),
      problems.map((l) => el('div', { class: 'fact problem' }, icon('triangle-alert', { size: 18 }), el('span', {}, l))),
      staff && r.status === 'pending' && !problems.length ? el('div', { class: 'fact ok' }, icon('circle-check', { size: 18 }), el('span', {}, 'No clashes and no rule problems')) : null,
      r.notes ? el('div', { class: 'fact' }, icon('file-text', { size: 18 }), el('span', {}, r.notes)) : null,
      r.decisionNote && r.status !== 'pending' ? el('div', { class: 'fact' }, icon('mail', { size: 18 }), el('span', {}, el('b', {}, 'From the approver: '), r.decisionNote)) : null),
    dates);
}

let keysBound = false;
async function requestsView() {
  const staff = isStaff();
  if (!state.rq) state.rq = { status: staff ? 'pending' : '' };
  const rq = state.rq;
  const params = new URLSearchParams({ limit: '200' });
  for (const [k, p] of [['status', 'status'], ['q', 'q'], ['org', 'organizationId'], ['space', 'spaceId'], ['round', 'roundId'], ['from', 'from'], ['to', 'to']]) if (rq[k]) params.set(p, rq[k]);
  const [{ requests }, { waitlist }] = await Promise.all([api('/requests?' + params), api('/waitlist').catch(() => ({ waitlist: [] }))]);
  const filters = [['pending', 'Waiting'], ['approved', 'Approved'], ['declined', 'Declined'], ['', 'All']];
  const wrap = el('div', {}, el('div', { class: 'head' }, el('div', {}, el('h2', {}, staff ? 'Requests' : 'Your requests'),
    el('p', { class: 'page-sub small' }, staff ? `${state.pendingCount} waiting for a decision` : 'Everything your group has asked for')),
  el('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, filters.map(([v, l]) => el('button', { type: 'button', 'aria-pressed': String(rq.status === v), onclick: () => { rq.status = v; state.rqSel = null; render(); } }, l)))));
  if (staff) {
    const q = el('input', { type: 'search', placeholder: 'Search title or group', value: rq.q || '', 'aria-label': 'Search' });
    const org = el('select', { 'aria-label': 'Group' }, el('option', { value: '' }, 'All groups'), state.orgs.map((o) => el('option', { value: o.id, selected: rq.org === o.id }, o.name)));
    const sp = el('select', { 'aria-label': 'Field' }, el('option', { value: '' }, 'All fields'), state.spaces.map((x) => el('option', { value: x.id, selected: rq.space === x.id }, x.name)));
    const f1 = el('input', { type: 'date', value: rq.from || '', 'aria-label': 'From date' }), f2 = el('input', { type: 'date', value: rq.to || '', 'aria-label': 'To date' });
    const apply = () => { Object.assign(rq, { q: q.value.trim(), org: org.value, space: sp.value, from: f1.value, to: f2.value }); render(); };
    const active = ['q', 'org', 'space', 'from', 'to', 'round'].filter((k) => rq[k]).length;
    wrap.append(el('details', { class: 'panel filters', open: active > 0 }, el('summary', {}, icon('filter', { size: 16 }), active ? ` Filters (${active} on)` : ' Filters'),
      el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); apply(); } }, q, el('div', { class: 'grid2' }, org, sp), el('div', { class: 'grid2' }, field('Dates from', f1), field('to', f2)),
        rq.round ? el('p', { class: 'muted small' }, 'Showing one season only. ', el('button', { type: 'button', class: 'linkbtn', onclick: () => { rq.round = ''; render(); } }, 'Show all')) : null,
        el('div', { class: 'actions' }, el('button', { class: 'btn small', type: 'submit' }, 'Apply'),
          el('button', { class: 'btn ghost small', type: 'button', onclick: () => { state.rq = { status: rq.status }; render(); } }, 'Clear'),
          el('button', { class: 'btn ghost small', type: 'button', onclick: () => guard(() => download(`/export/bookings.csv${rq.from || rq.to ? `?${new URLSearchParams({ ...(rq.from ? { from: rq.from } : {}), ...(rq.to ? { to: rq.to } : {}) })}` : ''}`, 'bookings.csv')) }, icon('download', { size: 16 }), 'Download bookings')))));
  } else { const b = insuranceBanner(myOrgIds()); if (b) wrap.append(b); }

  // bulk approve and decline
  const picked = new Set();
  const bar = el('div', { class: 'bulkbar hidden', role: 'region', 'aria-label': 'Selected requests' });
  const drawBar = () => {
    bar.classList.toggle('hidden', !picked.size);
    bar.replaceChildren(el('b', {}, `${picked.size} selected`), el('span', { class: 'grow-1' }),
      el('button', { class: 'btn small', onclick: () => bulk('approve') }, icon('check', { size: 16 }), 'Approve all'),
      el('button', { class: 'btn alt small', onclick: () => bulk('decline') }, 'Decline all'),
      el('button', { class: 'icon-btn', onclick: () => { picked.clear(); wrap.querySelectorAll('.pick input').forEach((i) => { i.checked = false; }); drawBar(); } }, icon('x', { label: 'Clear selection' })));
  };
  const bulk = (decision) => guard(async () => {
    const note = decision === 'decline' ? prompt('Reason for the requesters (optional)') : '';
    if (note === null) return;
    if (decision === 'approve' && !confirm(`Approve ${picked.size} request${picked.size === 1 ? '' : 's'}? Dates that clash are marked, not double booked.`)) return;
    const r = await api('/requests/bulk-decision', { method: 'POST', body: { ids: [...picked], decision, note } });
    toast(`${r.ok} ${decision === 'approve' ? 'approved' : 'declined'}${r.failed ? `, ${r.failed} could not be changed` : ''}`); render();
  });
  const onPick = (id) => (on) => { on ? picked.add(id) : picked.delete(id); drawBar(); };
  const pendingIds = requests.filter((r) => r.status === 'pending').map((r) => r.id);
  if (staff && pendingIds.length > 1) wrap.append(el('div', { class: 'rq-tools' }, el('button', { class: 'btn ghost small', onclick: () => {
    pendingIds.forEach((id) => picked.add(id)); wrap.querySelectorAll('.pick input').forEach((i) => { i.checked = true; }); drawBar(); } }, `Select all ${pendingIds.length} waiting`),
  matchMedia('(min-width: 1100px)').matches ? el('span', { class: 'muted small' }, el('span', { class: 'kbd' }, 'j'), ' ', el('span', { class: 'kbd' }, 'k'), ' to move through the list') : null));
  wrap.append(bar);

  if (!requests.length) wrap.append(emptyState(rq.status === 'pending' ? 'Nothing waiting' : 'No requests here',
    staff ? 'New requests from clubs and schools show up here.' : 'Ask for a field and your requests show up here.',
    staff ? null : el('button', { class: 'btn', onclick: () => go('new') }, icon('circle-plus', { size: 18 }), 'Request time')));
  else if (staff && matchMedia('(min-width: 1100px)').matches && requests.length > 1) {
    // inbox layout: the list on the left, the chosen request on the right
    if (!requests.some((r) => r.id === state.rqSel)) state.rqSel = requests[0].id;
    const sel = requests.find((r) => r.id === state.rqSel);
    const list = el('div', { class: 'rq-list', role: 'list', 'aria-label': 'Requests' }, requests.map((r) => el('div', { class: 'rq-row', role: 'listitem', 'aria-current': String(r.id === state.rqSel), style: colorVar(r.organization_id) },
      r.status === 'pending' ? el('label', { class: 'pick' }, el('input', { type: 'checkbox', 'aria-label': `Select ${r.title}`, onchange: (e) => onPick(r.id)(e.target.checked) })) : el('span', { class: 'bar' }),
      el('button', { type: 'button', class: 'linkbtn', style: 'text-decoration:none;text-align:left;color:inherit;font-weight:400', onclick: () => { state.rqSel = r.id; render(); } },
        el('div', { class: 't' }, r.title), el('div', { class: 'm' }, `${r.organization} · ${patternLines(r.dates)[0] || ''}`)),
      statusBadge(r.status))));
    wrap.append(el('div', { class: 'split' }, list, requestCard(sel, { picked: false, onPick: onPick(sel.id) })));
    if (!keysBound) {
      keysBound = true;
      document.addEventListener('keydown', (e) => {
        if (state.view !== 'requests' || /input|textarea|select/i.test(e.target.tagName) || e.metaKey || e.ctrlKey || document.querySelector('dialog[open]')) return;
        if (e.key !== 'j' && e.key !== 'k') return;
        const ids = [...document.querySelectorAll('.rq-row')].map((n, i) => i);
        if (!ids.length || !state.rqList) return;
        const i = state.rqList.indexOf(state.rqSel);
        const next = state.rqList[Math.max(0, Math.min(state.rqList.length - 1, i + (e.key === 'j' ? 1 : -1)))];
        if (next && next !== state.rqSel) { state.rqSel = next; render(); }
      });
    }
    state.rqList = requests.map((r) => r.id);
  } else for (const r of requests) wrap.append(requestCard(r, { onPick: onPick(r.id) }));

  if (waitlist.length) wrap.append(el('div', { style: 'margin-top:16px' }, section('Waiting for a slot to open',
    el('p', { class: 'muted small' }, 'You get an email (and a text, if you turned texts on) the moment one of these frees up.'),
    el('ul', { class: 'plain' }, waitlist.map((w) => el('li', { class: 'row between' },
      el('span', {}, `${w.organization}: ${w.space}, ${dayLabel(w.startsAt)} ${timeRange(w.startsAt, w.endsAt)}${w.status === 'notified' ? ' (it opened up)' : ''}`),
      w.mine || isAdmin() ? el('button', { class: 'btn ghost small', onclick: () => guard(async () => { await api(`/waitlist/${w.id}`, { method: 'DELETE' }); render(); }) }, 'Remove') : null))))));
  return wrap;
}

/* ---------- Request time: three short steps with a live summary ---------- */
const DOW = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];
const nextWeekday = () => { let d = addDays(ymd(new Date()), 1); while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDays(d, 1); return d; };
async function newRequestView() {
  const orgs = state.orgs.filter((o) => isAdmin() || myOrgIds().includes(o.id));
  if (!orgs.length) return emptyState('You are not in a group yet', 'Ask your club or school admin to add you, then you can request field time here.');
  const pre = state.prefill || {}; state.prefill = null;
  const [{ hours }, roundsRes, { closures }] = await Promise.all([api('/hours'), api('/rounds').catch(() => ({ rounds: [] })), api('/closures').catch(() => ({ closures: [] }))]);
  const now = Date.now();
  const openRounds = roundsRes.rounds.filter((r) => r.status === 'open' && new Date(r.opensAt) <= now && new Date(r.closesAt) >= now);
  const f = { step: 1, repeat: false, days: new Set(), items: [{ spaceId: pre.spaceId || '', label: '', start: '', end: '' }], uploaded: null, look: 'diagram', avail: null };

  const org = el('select', { id: 'org' }, orgs.map((o) => el('option', { value: o.id, selected: o.id === pre.orgId }, o.name)));
  const title = el('input', { type: 'text', id: 'title', maxlength: 200, placeholder: 'Spring practices', value: pre.title || '' });
  const notes = el('textarea', { id: 'notes', placeholder: 'Anything the approvers should know' }, pre.notes || '');
  const date = el('input', { type: 'date', id: 'date', value: pre.date || nextWeekday(), min: ymd(new Date()) });
  const until = el('input', { type: 'date', id: 'until' });
  const start = el('input', { type: 'time', id: 'start', value: pre.start || '18:00' });
  const end = el('input', { type: 'time', id: 'end', value: pre.end || '20:00' });
  const every = el('select', { id: 'every' }, [[1, 'Every week'], [2, 'Every other week'], [3, 'Every third week'], [4, 'Every fourth week']].map(([n, l]) => el('option', { value: n }, l)));
  const skip = el('input', { type: 'text', id: 'skip', placeholder: '2027-11-25, 2027-12-23' });
  const dayChips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Repeats on' }, DOW.map(([l, n]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: (e) => {
    f.days.has(n) ? f.days.delete(n) : f.days.add(n); e.currentTarget.setAttribute('aria-pressed', String(f.days.has(n))); changed(); } }, l)));
  const repeatBox = el('div', { class: 'hidden stack' },
    el('div', {}, el('label', {}, 'Repeats on'), dayChips),
    el('div', { class: 'grid2' }, field('How often', every), field('Last date', until)),
    field('Skip these dates (optional)', skip, 'Holidays, school breaks. Separate dates with commas.'));
  const rep = el('input', { type: 'checkbox', id: 'rep', onchange: (e) => { f.repeat = e.target.checked; repeatBox.classList.toggle('hidden', !f.repeat);
    if (f.repeat && !f.days.size) { const n = new Date(`${date.value}T12:00:00Z`).getUTCDay(); f.days.add(n); dayChips.querySelectorAll('.chip').forEach((c, i) => c.setAttribute('aria-pressed', String(DOW[i][1] === n))); }
    changed(); } });

  // the dates this request will make (same rules as the server)
  const skipList = () => skip.value.split(/[,\s]+/).filter(Boolean);
  const expand = () => {
    if (!date.value) return [];
    if (!f.repeat || !until.value || !f.days.size) return [date.value];
    const out = [], first = Date.parse(`${date.value}T00:00:00Z`), last = Date.parse(`${until.value}T00:00:00Z`);
    const mon0 = first - ((new Date(first).getUTCDay() + 6) % 7) * 864e5, ev = Number(every.value), sk = new Set(skipList());
    for (let t = first; t <= last && out.length < 200; t += 864e5) {
      const d = new Date(t), s = d.toISOString().slice(0, 10);
      if (Math.floor((t - mon0) / (7 * 864e5)) % ev || !f.days.has(d.getUTCDay()) || sk.has(s)) continue;
      out.push(s);
    }
    return out;
  };
  const closedSet = () => new Set(state.spaces.filter((s) => closures.some((c) => related(c.spaceId, s.id) && ymd(c.startsAt) <= date.value && ymd(new Date(new Date(c.endsAt) - 1)) >= date.value)).map((s) => s.id));

  // live availability for the first field, over the first 12 dates
  const availBox = el('div', { class: 'avail-box', role: 'status', 'aria-live': 'polite' });
  let availTimer, availSeq = 0;
  const checkAvail = () => { clearTimeout(availTimer); availTimer = setTimeout(async () => {
    const it = f.items[0], seq = ++availSeq;
    if (!it.spaceId || !date.value || f.uploaded) { f.avail = null; availBox.replaceChildren(); drawSummary(); return; }
    availBox.replaceChildren(el('span', { class: 'avail is-wait' }, icon('clock', { size: 16 }), 'Checking...'));
    const dates = expand().slice(0, 12);
    const res = await Promise.all(dates.map((d) => api('/availability/check?' + new URLSearchParams({ spaceId: it.spaceId, date: d, start: it.start || start.value, end: it.end || end.value, organizationId: org.value })).catch(() => null)));
    if (seq !== availSeq) return;
    const ok = res.filter((c) => c && c.free && !c.blocks.length).length, total = res.filter(Boolean).length;
    const firstBad = res.find((c) => c && !(c.free && !c.blocks.length));
    const more = expand().length > 12 ? ` (first 12 of ${expand().length} checked)` : '';
    f.avail = { ok, total };
    const kind = ok === total ? 'free' : ok ? 'part' : 'taken';
    const words = total === 1 ? (ok ? 'That time is free' : firstBad.free ? 'That time breaks a rule' : 'That time is taken') : ok === total ? `All ${total} dates are free${more}` : `${ok} of ${total} dates are free${more}`;
    const warns = [...new Set(res.filter(Boolean).flatMap((c) => [...c.blocks, ...c.warnings]).map((w) => w.replace(/\s*\([^)]*\)/g, '')))];
    const apply = (sg) => { if (sg.kind === 'day') date.value = sg.date; if (sg.kind === 'time') { start.value = sg.start; end.value = sg.end; } if (sg.kind === 'field') { it.spaceId = sg.spaceId; drawItems(); } toast('Updated'); changed(); };
    availBox.replaceChildren(el('div', { class: 'stack' },
      el('span', { class: `avail is-${kind}` }, icon(kind === 'free' ? 'circle-check' : 'triangle-alert', { size: 16 }), words),
      warns.length ? el('p', { class: 'small muted' }, warns.join('. ')) : null,
      firstBad && firstBad.suggestions?.length ? el('div', {}, el('p', { class: 'small' }, 'These work instead:'), el('div', { class: 'chips' }, firstBad.suggestions.slice(0, 6).map((sg) => el('button', { type: 'button', class: 'chip', onclick: () => apply(sg) },
        sg.kind === 'time' ? `${sg.start} to ${sg.end}` : sg.kind === 'field' ? `${sg.space}, same time` : `${dayLabel(`${sg.date}T12:00:00Z`)}`)))) : null,
      firstBad && !firstBad.free ? el('button', { type: 'button', class: 'btn ghost small', onclick: () => guard(async () => {
        await api('/waitlist', { method: 'POST', body: { organizationId: org.value, spaceId: it.spaceId, date: date.value, start: it.start || start.value, end: it.end || end.value } }); toast('You are on the list. We will tell you if it opens.'); }) }, icon('bell', { size: 16 }), 'Tell me if it opens up') : null));
    drawSummary();
  }, 350); };

  // fields and teams: one request can cover several
  const hint = el('p', { class: 'muted small' });
  const describe = () => {
    const sp = state.spaces.find((x) => x.id === f.items[0].spaceId);
    const rules = hours.filter((h) => !h.spaceId || (f.items[0].spaceId && related(h.spaceId, f.items[0].spaceId)));
    const parts = [];
    if (sp && !sp.has_lights && state.tenant.daylightRule && state.tenant.daylightRule !== 'off') parts.push('This field has no lights, so time must end before sunset.');
    for (const h of rules) parts.push(`${h.space || 'All fields'}: ${h.weekdays.length === 7 ? 'daily' : h.weekdays.map((n) => WEEKDAYS[n]).join(', ')} ${h.opens} to ${h.closes}${h.note ? ` (${h.note})` : ''}.`);
    hint.textContent = parts.join(' ');
  };
  const itemsHost = el('div', { class: 'stack' });
  const drawItems = () => {
    const closed = closedSet();
    itemsHost.replaceChildren(...f.items.map((it, i) => {
      const label = el('input', { type: 'text', maxlength: 80, placeholder: 'Team, for example U12 girls (optional)', value: it.label, 'aria-label': `Team for field ${i + 1}`, oninput: (e) => { it.label = e.target.value; drawSummary(); } });
      const picker = el('div', { class: 'stack' });
      const pick = (sp) => { it.spaceId = sp.id; draw(); describe(); changed(); };
      const views = () => (i === 0 && hasMap() ? el('div', { class: 'seg', role: 'group', 'aria-label': 'Show fields as' },
        [['diagram', 'Fields'], ['map', 'Satellite map']].map(([v, l]) => el('button', { type: 'button', 'aria-pressed': String(f.look === v), onclick: () => { f.look = v; draw(); } }, l))) : null);
      const draw = () => picker.replaceChildren(...[views(), i === 0
        ? (f.look === 'map' ? el('div', { class: 'stack' }, mapPicker({ selected: it.spaceId, onSelect: pick }), el('p', { class: 'muted small' }, it.spaceId ? `Chosen: ${spaceName(it.spaceId)}` : 'Tap a field or a section on the map.'))
          : pitchPicker(state.spaces, { selected: it.spaceId, onSelect: pick, closed }))
        : el('select', { 'aria-label': `Field ${i + 1}`, onchange: (e) => { it.spaceId = e.target.value; drawSummary(); } }, el('option', { value: '' }, 'Choose a field'), state.spaces.map((sp) => el('option', { value: sp.id, selected: sp.id === it.spaceId }, `${sp.parent_id ? 'Section: ' : ''}${sp.name}`)))].filter(Boolean));
      draw();
      const t1 = el('input', { type: 'time', value: it.start, oninput: (e) => { it.start = e.target.value; } }), t2 = el('input', { type: 'time', value: it.end, oninput: (e) => { it.end = e.target.value; } });
      return el('div', { class: i ? 'panel stack' : 'stack' }, i === 0 && f.items.length === 1 ? null : el('div', { class: 'row between' }, el('b', {}, `Field ${i + 1}`),
        i ? el('button', { type: 'button', class: 'btn ghost small', onclick: () => { f.items.splice(i, 1); drawItems(); drawSummary(); } }, icon('x', { size: 16 }), 'Remove') : null),
      picker, label,
      i ? el('details', {}, el('summary', {}, 'Different time for this team'), el('div', { class: 'grid2' }, field('Starts', t1), field('Ends', t2))) : null);
    }), el('button', { type: 'button', class: 'btn ghost small', onclick: () => { f.items.push({ spaceId: '', label: '', start: '', end: '' }); drawItems(); } }, icon('circle-plus', { size: 16 }), 'Add another field or team'));
  };

  // upload a whole schedule instead
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
    upOut.replaceChildren(errors.length ? el('div', { class: 'notice stack' }, errors.slice(0, 10).map((e) => el('p', {}, e))) : el('p', { class: 'muted' }, f.uploaded ? `Ready: ${n} dates for ${f.uploaded.length} field and team combination${f.uploaded.length === 1 ? '' : 's'}. Choose Next.` : 'Paste a header row and some rows.'));
    drawSummary();
  };
  const upFile = el('input', { type: 'file', accept: '.csv,.tsv,.txt', 'aria-label': 'Choose a file', onchange: async (e) => { const fl = e.target.files[0]; if (fl) { upBox.value = await fl.text(); readUpload(); } } });
  upBox.addEventListener('input', readUpload);

  // summary: always visible beside (or under) the steps
  const summary = el('aside', { class: 'panel summary', 'aria-label': 'Your request so far' });
  const drawSummary = () => {
    const dates = f.uploaded ? f.uploaded.flatMap((g) => g.dates) : expand();
    const fields = f.uploaded ? f.uploaded.map((g) => spaceName(g.spaceId)) : f.items.map((it) => spaceName(it.spaceId)).filter(Boolean);
    const when = f.uploaded ? 'From your spreadsheet' : !date.value ? 'Not chosen yet'
      : f.repeat && f.days.size && until.value ? `${[...f.days].map((n) => WEEKDAYS[n]).join(', ')}${Number(every.value) > 1 ? `, every ${every.value} weeks` : ''}, ${start.value} to ${end.value}, ${shortDate(`${date.value}T12:00:00Z`)} to ${shortDate(`${until.value}T12:00:00Z`)}`
        : `${dayLabel(`${date.value}T12:00:00Z`)}, ${start.value} to ${end.value}`;
    summary.replaceChildren(el('h3', {}, 'Your request'), el('dl', {},
      el('div', {}, el('dt', {}, 'For'), el('dd', {}, org.selectedOptions[0]?.textContent || '')),
      el('div', {}, el('dt', {}, 'When'), el('dd', {}, when)),
      el('div', {}, el('dt', {}, 'Where'), el('dd', {}, fields.length ? [...new Set(fields)].join(', ') : 'Not chosen yet')),
      el('div', {}, el('dt', {}, 'Dates'), el('dd', {}, String(dates.length))),
      f.avail ? el('div', {}, el('dt', {}, 'Availability'), el('dd', {}, f.avail.ok === f.avail.total ? 'All free' : `${f.avail.ok} of ${f.avail.total} free`)) : null));
  };
  const changed = () => { drawSummary(); if (f.step === 2) { drawItems(); checkAvail(); } };
  [date, until, start, end, every, skip, org].forEach((x) => x.addEventListener('change', changed));

  const roundSel = openRounds.length ? el('select', { id: 'round' }, el('option', { value: '' }, 'Not part of a season'), openRounds.map((r) => el('option', { value: r.id }, `${r.name} (${r.seasonStart} to ${r.seasonEnd})`))) : null;
  const banner = el('div', {});
  const stepsBar = el('ol', { class: 'steps', 'aria-label': 'Steps' });
  const panels = {
    1: el('div', { class: 'panel stack' }, el('h3', {}, 'When'),
      el('div', { class: 'grid2' }, field('Asking for', org), field('First date', date)),
      el('div', { class: 'grid2' }, field('Starts', start), field('Ends', end)),
      el('label', { for: 'rep', class: 'inline-check' }, rep, 'Repeats'), repeatBox,
      el('details', {}, el('summary', {}, icon('upload', { size: 16 }), ' Have a full schedule in a spreadsheet? Upload it instead'),
        el('div', { class: 'stack' }, el('p', { class: 'muted small' }, 'Columns: field, team, date, start, end. One row per practice or game.'), upBox, upFile, upOut))),
    2: el('div', { class: 'panel stack' }, el('h3', {}, 'Where'),
      el('p', { class: 'muted small' }, 'Tap a field or one of its halves. More than one field or team? Add them and send one request.'), itemsHost, hint, availBox),
    3: el('div', { class: 'panel stack' }, el('h3', {}, 'Review and send'), banner,
      field('Title', title, 'What the approver sees first, for example "U12 spring practices".'), field('Notes (optional)', notes),
      roundSel ? field('Season', roundSel) : null),
  };
  const back = el('button', { type: 'button', class: 'btn alt' }, icon('arrow-left', { size: 18 }), 'Back');
  const next = el('button', { type: 'button', class: 'btn' });
  const showStep = (n) => {
    f.step = n;
    stepsBar.replaceChildren(...['When', 'Where', 'Review'].map((l, i) => el('li', { class: i + 1 < n ? 'done' : null, 'aria-current': i + 1 === n ? 'step' : null }, l)));
    for (const [k, p] of Object.entries(panels)) p.classList.toggle('hidden', Number(k) !== n);
    back.classList.toggle('hidden', n === 1);
    next.replaceChildren(...(n === 3 ? [icon('check', { size: 18 }), 'Send request'] : ['Next', icon('arrow-right', { size: 18 })]));
    if (n === 2) { drawItems(); describe(); checkAvail(); }
    if (n === 3) { banner.replaceChildren(insuranceBanner([org.value]) || []); if (!title.value) title.value = f.items[0].label ? `${f.items[0].label} practice` : ''; }
    drawSummary();
    panels[n].querySelector('h3')?.setAttribute('tabindex', '-1');
    panels[n].querySelector('h3')?.focus({ preventScroll: false });
  };
  const send = () => guard(async () => {
    let items;
    if (f.uploaded) items = f.uploaded;
    else {
      const dow = new Date(`${date.value}T12:00:00Z`).getUTCDay();
      const exclude = skipList();
      items = f.items.map((it) => ({ spaceId: it.spaceId, label: it.label.trim() || undefined, weekly: f.repeat
        ? { startsOn: date.value, until: until.value, weekdays: [...f.days], startTime: it.start || start.value, endTime: it.end || end.value, everyWeeks: Number(every.value), ...(exclude.length ? { exclude } : {}) }
        : { startsOn: date.value, until: date.value, weekdays: [dow], startTime: it.start || start.value, endTime: it.end || end.value } }));
    }
    if (!title.value.trim()) throw new Error('Give the request a title');
    const r = await api('/requests', { method: 'POST', body: { organizationId: org.value, title: title.value, notes: notes.value, items, ...(roundSel?.value ? { roundId: roundSel.value } : {}) } });
    toast(r.autoApproved ? `Approved automatically, ${r.dateCount} date${r.dateCount === 1 ? '' : 's'}` : `Request sent, ${r.dateCount} date${r.dateCount === 1 ? '' : 's'}${r.warnings ? ` (${r.warnings} flagged for review)` : ''}`);
    state.rq = null; go('requests');
  });
  back.addEventListener('click', () => showStep(f.uploaded && f.step === 3 ? 1 : f.step - 1));
  next.addEventListener('click', () => guard(async () => {
    if (f.step === 1) {
      if (f.uploaded) return showStep(3);
      if (!date.value) throw new Error('Choose the first date');
      if (end.value <= start.value) throw new Error('The end time must be after the start');
      if (f.repeat && (!f.days.size || !until.value)) throw new Error('Choose the days it repeats on and a last date');
      if (skipList().some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error('Skip dates look like 2027-11-25');
      return showStep(2);
    }
    if (f.step === 2) {
      if (f.items.some((it) => !it.spaceId)) throw new Error('Pick a field for each team, or remove the empty one');
      return showStep(3);
    }
    return send();
  }));
  const form = el('div', { class: 'wizard' },
    el('div', {}, stepsBar, panels[1], panels[2], panels[3], el('div', { class: 'wiz-nav' }, back, el('span', { class: 'grow-1' }), next)),
    summary);
  showStep(pre.spaceId && pre.date ? 2 : 1);
  if (pre.spaceId && pre.date) { /* came from a free hour on the schedule: skip to choosing the field, already chosen */ }
  return el('div', {}, el('div', { class: 'head' }, el('div', {}, el('h2', {}, 'Request time'), el('p', { class: 'page-sub small' }, 'Three quick steps. You can see availability before you send.'))), form);
}

/* ---------- Groups: insurance, permits, trusted groups ---------- */
async function groupsView() {
  const [{ organizations: status }, { organizations }] = await Promise.all([api('/compliance'), api('/organizations')]);
  state.compliance = status;
  const label = { ok: 'Insurance on file', expiring: 'Expiring soon', expired: 'Expired', missing: 'No insurance' };
  const wrap = el('div', { class: 'stack' }, el('div', { class: 'head' }, el('div', {}, el('h2', {}, 'Groups'), el('p', { class: 'page-sub small' }, 'Clubs, schools and teams, their insurance and their people.'))));
  if (isStaff()) wrap.append(await applicationsPanel());
  for (const o of status) {
    const info = organizations.find((x) => x.id === o.id);
    const host = el('div', {});
    const load = async () => {
      const { documents } = await api(`/organizations/${o.id}/documents`);
      const kind = el('select', { 'aria-label': 'Kind' }, ['insurance', 'permit', 'waiver', 'background_check', 'other'].map((k) => el('option', { value: k }, cap(k).replace('_', ' '))));
      const exp = el('input', { type: 'date', 'aria-label': 'Expires on' });
      const note = el('input', { type: 'text', placeholder: 'Policy number or note', 'aria-label': 'Note' });
      const cov = el('input', { type: 'number', min: '0', step: '1000', placeholder: 'Coverage', 'aria-label': 'Coverage amount in dollars' });
      const addl = el('input', { type: 'checkbox', id: `addl-${o.id}` });
      const file = el('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', 'aria-label': 'Certificate file (PDF or image, up to 3 MB)' });
      host.replaceChildren(
        documents.length ? el('ul', { class: 'plain' }, documents.map((d) => el('li', { class: 'row between' },
          el('span', {}, icon('file-text', { size: 16 }), ` ${cap(d.kind).replace('_', ' ')}${d.expiresOn ? `, expires ${d.expiresOn}` : ', no expiry'}${d.coverageAmount ? `, ${money(d.coverageAmount * 100)} coverage` : ''}${d.additionalInsured ? ', named as additional insured' : ''}${d.note ? `, ${d.note}` : ''}`),
          el('span', { class: 'row' }, d.hasFile ? el('button', { class: 'btn ghost small', onclick: () => guard(() => download(`/documents/${d.id}/file`, d.fileName || 'certificate')) }, 'View file') : null,
            canManageOrg(o.id) ? menu(`Actions for this ${d.kind}`, [{ label: 'Remove', icon: 'x', danger: true, onSelect: () => guard(async () => { await api(`/documents/${d.id}`, { method: 'DELETE' }); await load(); }) }]) : null))))
          : el('p', { class: 'muted small' }, 'Nothing on file.'),
        canManageOrg(o.id) ? el('details', {}, el('summary', {}, 'Add a document'), el('div', { class: 'stack' }, el('div', { class: 'grid2' }, field('Kind', kind), field('Expires on', exp)),
          el('div', { class: 'grid2' }, field('Policy number or note', note), field('Coverage (dollars)', cov)),
          el('label', { class: 'inline-check', for: `addl-${o.id}` }, addl, 'Our group is named as additional insured'), field('Certificate file', file),
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
          }) }, 'Add document'))) : null);
    };
    const body = el('div', { class: 'stack' });
    wrap.append(el('article', { class: 'panel card', style: colorVar(o.id) }, el('div', { class: 'row between' },
      el('h3', { class: 'row' }, el('span', { class: 'dot', style: colorVar(o.id) }), o.name),
      el('div', { class: 'row' }, el('span', { class: 'badge ' + (o.status === 'ok' ? 'confirmed' : o.status === 'expiring' ? 'pending' : 'conflict') }, icon(o.status === 'ok' ? 'shield-check' : 'triangle-alert', { size: 14 }), label[o.status]),
        isAdmin() && info ? el('select', { class: 'w-m', 'aria-label': `Priority for ${o.name}`, onchange: (e) => guard(async () => { await api(`/organizations/${o.id}`, { method: 'PATCH', body: { tier: Number(e.target.value) } }); toast('Priority saved'); }) },
          [5, 4, 3, 2, 1].map((n) => el('option', { value: n, selected: info.tier === n }, TIER[n]))) : null,
        isAdmin() && info ? el('label', { class: 'inline-check' }, el('input', { type: 'checkbox', checked: info.autoApprove, onchange: (e) => guard(async () => {
          await api(`/organizations/${o.id}`, { method: 'PATCH', body: { autoApprove: e.target.checked } }); toast(e.target.checked ? 'Trusted: approved automatically when free' : 'Auto-approve off');
        }) }), 'Trusted') : null)), body));
    body.append(host);
    if (isStaff() || myOrgIds().includes(o.id)) body.append(teamsPanel(o, isAdmin() || orgAdminIds().includes(o.id)));
    load();
  }
  if (!status.length) wrap.append(emptyState('No groups yet', 'Clubs and schools appear here once they are added or their application is approved.', isAdmin() ? el('button', { class: 'btn', onclick: () => { state.setupTab = 'people'; go('setup'); } }, 'Add a group') : null));
  return wrap;
}

/* ---------- Closures ---------- */
async function closuresView() {
  const [{ closures }, { facilities }] = await Promise.all([api('/closures'), api('/facilities')]);
  const reason = el('input', { type: 'text', maxlength: 200, placeholder: 'Rain, aeration, tournament' });
  const d1 = el('input', { type: 'date', value: ymd(new Date()) });
  const d2 = el('input', { type: 'date' });
  const t1 = el('input', { type: 'time' });
  const t2 = el('input', { type: 'time' });
  const target = el('select', {}, el('option', { value: 'all' }, 'Everything'),
    facilities.map((f) => el('option', { value: `f:${f.id}` }, `All of ${f.name}`)),
    state.spaces.map((s) => el('option', { value: `s:${s.id}` }, `${s.parent_id ? 'Section: ' : ''}${s.name}`)));
  const days = new Set();
  const dayChips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Only on these days' }, [1, 2, 3, 4, 5, 6, 0].map((n) => el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: (e) => {
    days.has(n) ? days.delete(n) : days.add(n); e.currentTarget.setAttribute('aria-pressed', String(days.has(n))); } }, WEEKDAYS[n])));
  const body = (preview) => { const b = { reason: reason.value, startDate: d1.value, endDate: d2.value || d1.value, preview }; if (days.size) b.weekdays = [...days];
    if (t1.value) b.startTime = t1.value; if (t2.value) b.endTime = t2.value;
    if (target.value === 'all') b.all = true; else if (target.value.startsWith('f:')) b.facilityId = target.value.slice(2); else b.spaceId = target.value.slice(2); return b; };
  const closeBtn = el('button', { class: 'btn', type: 'button', onclick: () => guard(async () => {
    const p = await api('/closures', { method: 'POST', body: body(true) });
    if (p.bookings && !confirm(`${p.bookings} booking${p.bookings === 1 ? '' : 's'} from ${p.requests} request${p.requests === 1 ? '' : 's'} will be cancelled and the people told. Close anyway?`)) return;
    const r = await api('/closures', { method: 'POST', body: body(false) });
    toast(r.closures > 1 ? `Closed ${r.closures} days${r.cancelledBookings ? `. ${r.cancelledBookings} booking${r.cancelledBookings === 1 ? '' : 's'} cancelled` : ''}` : r.cancelledBookings ? `Closed. ${r.cancelledBookings} booking${r.cancelledBookings === 1 ? '' : 's'} cancelled` : 'Closed'); render();
  }) }, icon('lock', { size: 18 }), 'Close it');
  return el('div', { class: 'stack' }, el('div', { class: 'head' }, el('div', {}, el('h2', {}, 'Closures'), el('p', { class: 'page-sub small' }, 'Rain, aeration, tournaments. Anything booked is cancelled and each group is told.'))),
    section('Close a field',
      el('div', { class: 'grid2' }, field('Reason', reason), field('What', target)),
      el('div', { class: 'grid2' }, field('First day', d1), field('Last day', d2, 'Leave empty for one day')),
      el('div', { class: 'grid2' }, field('From (optional)', t1), field('Until (optional)', t2, 'Leave both times empty to close all day')),
      field('Only on these days (optional)', dayChips, 'For a repeating closure such as aeration every Monday morning. Up to 60 days at a time.'), closeBtn),
    closures.length ? section('Coming up', el('ul', { class: 'plain' }, closures.map((c) => el('li', { class: 'row between' },
      el('span', {}, icon('lock', { size: 16 }), ` ${c.space}: ${c.reason}, ${dayLabel(c.startsAt)} ${hhmm(c.startsAt)} to ${ymd(c.startsAt) === ymd(new Date(new Date(c.endsAt) - 1)) ? hhmm(c.endsAt) : `${dayLabel(new Date(new Date(c.endsAt) - 1))} ${hhmm(c.endsAt)}`}`),
      el('button', { class: 'btn ghost small', onclick: () => guard(async () => { if (!confirm('Reopen this? Cancelled bookings stay cancelled.')) return; await api(`/closures/${c.id}`, { method: 'DELETE' }); render(); }) }, 'Reopen')))))
      : emptyState('No closures coming up', 'Every field is open as scheduled.'));
}

/* ---------- Reports ---------- */
async function reportsView() {
  const today = ymd(new Date());
  if (!state.report) state.report = { from: addDays(today, -90), to: today };
  const from = el('input', { type: 'date', value: state.report.from, 'aria-label': 'From' });
  const to = el('input', { type: 'date', value: state.report.to, 'aria-label': 'To' });
  const data = await api(`/reports/usage?from=${state.report.from}&to=${state.report.to}`);
  const table = (rows, label) => rows.length ? el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, label), el('th', { class: 'num', scope: 'col' }, 'Bookings'), el('th', { class: 'num', scope: 'col' }, 'Hours'))),
    el('tbody', {}, rows.map((r) => el('tr', {}, el('td', {}, r.name), el('td', { class: 'num' }, String(r.bookings)), el('td', { class: 'num' }, String(r.hours)))))) : el('p', { class: 'muted' }, 'No bookings in this range.');
  const activity = isAdmin() ? await activityPanel() : null;
  return el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, 'Usage'),
    el('button', { class: 'btn alt small', onclick: () => guard(() => download(`/export/usage.csv?from=${state.report.from}&to=${state.report.to}`, 'usage.csv')) }, icon('download', { size: 16 }), 'Download CSV')),
    el('div', { class: 'panel row' }, el('label', {}, 'From'), from, el('label', {}, 'To'), to,
      el('button', { class: 'btn small', onclick: () => { state.report = { from: from.value, to: to.value }; render(); } }, 'Show')),
    el('div', { class: 'stats' }, [['Hours booked', data.totalHours], ['Waiting', data.pending], ['Cancelled dates', data.cancelled], ['Clashes', data.conflicts]].map(([l, v]) =>
      el('div', { class: 'stat panel' }, el('b', {}, String(v)), el('span', { class: 'muted small' }, l)))),
    section('By field', table(data.bySpace, 'Field')), section('By group', table(data.byOrg, 'Group')), await utilizationPanel(state.report.from, state.report.to), activity);
}

/* ---------- Add to your calendar ---------- */
async function calendarView() {
  const { feeds } = await api('/calendar-feeds');
  const mine = state.orgs.filter((o) => isStaff() || myOrgIds().includes(o.id));
  const which = el('select', {}, el('option', { value: '' }, 'The whole schedule'), mine.map((o) => el('option', { value: o.id }, o.name)));
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
  const kind = el('select', { onchange: () => { box.placeholder = IMPORTS[kind.value].example; info.textContent = `Columns: ${IMPORTS[kind.value].cols}`; } },
    Object.entries(IMPORTS).map(([k, v]) => el('option', { value: k }, v.label)));
  const info = el('p', { class: 'muted small' }, `Columns: ${IMPORTS.spaces.cols}`);
  const box = el('textarea', { class: 'mono', rows: '6', placeholder: IMPORTS.spaces.example, 'aria-label': 'Paste rows here' });
  const file = el('input', { type: 'file', accept: '.csv,.tsv,.txt', 'aria-label': 'Choose a file', onchange: async (e) => { const f = e.target.files[0]; if (f) box.value = await f.text(); } });
  const out = el('div', { role: 'status' });
  const run = (preview) => guard(async () => {
    const rows = parseTable(box.value);
    if (!rows.length) throw new Error('Paste a header row and at least one data row');
    const r = await api(`/import/${kind.value}`, { method: 'POST', body: { rows, preview } });
    out.replaceChildren(el('div', { class: 'notice stack' },
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
  const zone = el('input', { type: 'text', list: 'zones', value: s.timezone, class: 'w-m' });
  const lat = el('input', { type: 'text', inputmode: 'decimal', value: s.latitude ?? '', placeholder: '40.13' });
  const lon = el('input', { type: 'text', inputmode: 'decimal', value: s.longitude ?? '', placeholder: '-75.51' });
  const level = (v, opts) => el('select', { class: 'w-m' }, opts.map(([k, l]) => el('option', { value: k, selected: k === v }, l)));
  const dl = level(s.daylightRule, [['off', 'Do not check'], ['warn', 'Flag for the approver'], ['block', 'Do not allow']]);
  const ins = level(s.insuranceRule, [['off', 'Do not check'], ['warn', 'Flag for the approver'], ['block', 'Do not allow']]);
  const num = (v) => (v.trim() === '' ? null : Number(v));
  const notice = el('input', { type: 'number', min: '0', max: '720', value: s.cancelNoticeHours ?? 0, class: 'w-s' });
  const minCov = el('input', { type: 'number', min: '0', step: '1000', value: s.minCoverage ?? '', placeholder: 'No minimum' });
  const addl = el('input', { type: 'checkbox', id: 'addl', checked: !!s.requireAdditionalInsured });
  const hold = el('input', { type: 'checkbox', id: 'hold', checked: !!s.holdUnpaid });
  const minUse = el('input', { type: 'number', min: '1', max: '100', value: s.minUsePct ?? '', placeholder: 'Off', class: 'w-s' });
  const noShows = el('input', { type: 'number', min: '1', max: '50', value: s.noShowLimit ?? '', placeholder: 'Off', class: 'w-s' });
  const save = el('button', { class: 'btn', onclick: () => guard(async () => {
    await api('/settings', { method: 'PATCH', body: { timezone: zone.value, latitude: num(lat.value), longitude: num(lon.value), daylightRule: dl.value, insuranceRule: ins.value,
      cancelNoticeHours: Number(notice.value || 0), minCoverage: num(minCov.value), requireAdditionalInsured: addl.checked, holdUnpaid: hold.checked,
      minUsePct: num(minUse.value), noShowLimit: num(noShows.value) } });
    state.tenant = await api('/tenant'); state.tenant.daylightRule = dl.value; toast('Saved');
  }) }, 'Save rules');

  // bookable hours
  const hSpace = el('select', { class: 'w-m' }, el('option', { value: '' }, 'All fields'), state.spaces.map((x) => el('option', { value: x.id }, x.name)));
  const hDays = new Set([0, 1, 2, 3, 4, 5, 6]);
  const dayChips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Days' }, [1, 2, 3, 4, 5, 6, 0].map((n) => el('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', onclick: (e) => {
    hDays.has(n) ? hDays.delete(n) : hDays.add(n); e.currentTarget.setAttribute('aria-pressed', String(hDays.has(n))); } }, WEEKDAYS[n])));
  const opens = el('input', { type: 'time', value: '08:00' }), closes = el('input', { type: 'time', value: '21:00' });
  const enf = level('block', [['block', 'Do not allow outside these hours'], ['warn', 'Flag for the approver']]);
  const hNote = el('input', { type: 'text', placeholder: 'For example: neighbors, no whistles before 9' });
  const hs = (x) => `${x.space || 'All fields'}: ${x.weekdays.length === 7 ? 'daily' : x.weekdays.map((n) => WEEKDAYS[n]).join(', ')} ${x.opens} to ${x.closes}, ${x.enforcement === 'block' ? 'enforced' : 'flagged'}${x.note ? `, ${x.note}` : ''}`;
  const money_ = el('div', { class: 'affix' }, el('span', {}, '$'), minCov);
  return el('div', { class: 'stack' },
    section('Rules', el('p', { class: 'muted small' }, 'Rules can flag a request for the approver or stop it from being sent.'),
      el('datalist', { id: 'zones' }, zones.map((z) => el('option', { value: z }))),
      field('Time zone', zone),
      el('div', { class: 'grid2' }, field('Latitude', lat, 'Needed for sunset times'), field('Longitude', lon)),
      field('Fields without lights: time must end before sunset', dl), field('Group has no valid insurance', ins),
      field('Minimum insurance coverage', money_, 'Checked when the insurance rule is on'),
      el('label', { for: 'addl', class: 'inline-check' }, addl, 'Group must be named as additional insured'),
      field('Hours of notice before a cancellation counts as late', notice, 'Staff are told and it shows in the usage download. 0 turns it off.'),
      el('label', { for: 'hold', class: 'inline-check' }, hold, 'Hold new requests from groups with an overdue invoice'),
      el('h4', {}, 'Use it or lose it'),
      el('div', { class: 'grid2' }, field('No-shows allowed in a year', noShows, 'Groups over this are placed last in the next season.'), field('Minimum share of given time used (%)', minUse, 'Groups below it are flagged under Usage.')), save),
    section('Bookable hours', hours.length ? el('ul', { class: 'plain' }, hours.map((x) => el('li', { class: 'row between' }, el('span', {}, hs(x)),
      el('button', { class: 'btn ghost small', onclick: () => guard(async () => { await api(`/hours/${x.id}`, { method: 'DELETE' }); render(); }) }, 'Remove')))) : el('p', { class: 'muted small' }, 'No limits yet. Add hours to stop late-night bookings, and to make the usage report accurate.'),
      field('Applies to', hSpace), field('Days', dayChips), el('div', { class: 'grid2' }, field('Opens', opens), field('Closes', closes)), field('If outside these hours', enf), field('Note (optional)', hNote),
      el('button', { class: 'btn alt', onclick: () => guard(async () => {
        if (!hDays.size) throw new Error('Pick at least one day');
        await api('/hours', { method: 'POST', body: { spaceId: hSpace.value || null, weekdays: [...hDays], opens: opens.value, closes: closes.value, enforcement: enf.value, note: hNote.value } }); toast('Added'); render();
      }) }, 'Add hours')));
}

// A field's outline as a little drawing (no map tiles needed).
function outlineThumb(s) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 160 90'); svg.setAttribute('class', 'thumb'); svg.setAttribute('aria-hidden', 'true');
  const shapes = [s, ...state.spaces.filter((x) => x.parent_id === s.id)].filter((x) => x.outline);
  const add = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); };
  if (!shapes.length) { add('rect', { x: 20, y: 12, width: 120, height: 66, rx: 3, fill: 'none', stroke: 'rgba(255,255,255,.85)', 'stroke-width': 2 }); add('line', { x1: 80, y1: 12, x2: 80, y2: 78, stroke: 'rgba(255,255,255,.85)', 'stroke-width': 2 }); add('circle', { cx: 80, cy: 45, r: 10, fill: 'none', stroke: 'rgba(255,255,255,.85)', 'stroke-width': 2 }); return svg; }
  const pts = shapes.flatMap((x) => x.outline);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sc = Math.min(140 / ((x1 - x0) || 1e-9), 70 / ((y1 - y0) || 1e-9));
  const P = ([x, y]) => `${(10 + (x - x0) * sc + (140 - (x1 - x0) * sc) / 2).toFixed(1)},${(10 + (y1 - y) * sc + (70 - (y1 - y0) * sc) / 2).toFixed(1)}`;
  shapes.forEach((x, i) => add('polygon', { points: x.outline.map(P).join(' '), fill: i ? 'rgba(242,194,48,.18)' : 'rgba(255,255,255,.08)', stroke: i ? '#f2c230' : '#fff', 'stroke-width': 2 }));
  return svg;
}

// Rename anything with a one-field form in a sheet.
function renameBox(title, current, save) {
  sheet(title, (close) => { const input = el('input', { type: 'text', value: current, maxlength: 120 });
    return el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); guard(async () => { if (!input.value.trim()) throw new Error('Enter a name'); await save(input.value.trim()); toast('Renamed'); close(); await loadData(); render(); }); } },
      field('Name', input), el('button', { class: 'btn', type: 'submit' }, 'Save')); });
}
// Remove a field or a section: show what it affects, then archive it.
const removeSpace = (s) => guard(async () => {
  const p = await api(`/spaces/${s.id}?preview=1`, { method: 'DELETE' });
  const parts = [p.sections ? `its ${p.sections} section${p.sections === 1 ? '' : 's'}` : null, p.futureBookings ? `${p.futureBookings} upcoming booking${p.futureBookings === 1 ? '' : 's'} (each group is told)` : null].filter(Boolean);
  sheet(`Remove ${s.name}?`, (close) => el('div', { class: 'stack' },
    el('p', {}, `${s.name} will no longer appear for booking${parts.length ? `. This also removes ${parts.join(' and cancels ')}` : ''}.`),
    el('p', { class: 'muted small' }, 'Past bookings, invoices and reports keep it, so history stays accurate.'),
    el('div', { class: 'actions' }, el('button', { class: 'btn danger solid', onclick: () => guard(async () => {
      const r = await api(`/spaces/${s.id}`, { method: 'DELETE' }); close();
      toast(`${r.name} removed${r.cancelled ? `, ${r.cancelled} booking${r.cancelled === 1 ? '' : 's'} cancelled` : ''}`); await loadData(); render();
    }) }, 'Remove'), el('button', { class: 'btn alt', onclick: close }, 'Keep it'))));
});
function fieldCard(s) {
  const sections = state.spaces.filter((x) => x.parent_id === s.id);
  const lightsToggle = (x) => ({ label: x.has_lights ? 'Mark as no lights' : 'Mark as having lights', icon: 'lightbulb', onSelect: () => guard(async () => { await api(`/spaces/${x.id}`, { method: 'PATCH', body: { hasLights: !x.has_lights } }); toast('Saved'); await loadData(); render(); }) });
  const actions = (x, kind) => menu(`Actions for ${x.name}`, [
    { label: `Rename ${kind}`, icon: 'pencil', onSelect: () => renameBox(`Rename ${kind}`, x.name, (name) => api(`/spaces/${x.id}`, { method: 'PATCH', body: { name } })) },
    lightsToggle(x), 'sep', { label: `Remove ${kind}`, icon: 'x', danger: true, onSelect: () => removeSpace(x) }]);
  return el('div', { class: 'field-card' }, outlineThumb(s),
    el('div', { class: 'row between' }, el('b', {}, s.name), actions(s, 'field')),
    el('span', { class: 'muted small' }, [s.has_lights ? 'Lights' : 'No lights', s.outline ? 'on the map' : 'not on the map yet'].join(', ')),
    sections.length ? el('ul', { class: 'plain small' }, sections.map((x) => el('li', { class: 'row between' }, el('span', {}, `Section: ${x.name}`), actions(x, 'section')))) : null);
}

const SETUP_TABS = [['start', 'Getting started', 'sparkles'], ['fields', 'Fields and map', 'map'], ['people', 'Groups and people', 'users'], ['rules', 'Rules and hours', 'shield-check'], ['money', 'Plan and payments', 'credit-card'], ['import', 'Import', 'upload']];
async function setupView() {
  const [{ facilities }, { organizations }, { hours }] = await Promise.all([api('/facilities'), api('/organizations'), api('/hours')]);
  state.facilities = facilities;
  const post = (path, body, ok) => guard(async () => { await api(path, { method: 'POST', body }); toast(ok); await loadData(); render(); });
  const tabBtn = ([id, label, ic]) => el('button', { class: 'nav-item', 'aria-current': state.setupTab === id ? 'page' : null, onclick: () => { state.setupTab = id; render(); } }, icon(ic), label);
  let page;
  if (state.setupTab === 'start') {
    const steps = [
      ['Add a site', facilities.length > 0, 'fields'], ['Add its fields and sections', state.spaces.length > 0, 'fields'], ['Draw your fields on the map', state.spaces.some((s) => s.outline), 'fields'],
      ['Add a club or school', organizations.length > 0, 'people'], ['Set bookable hours', hours.length > 0, 'rules'],
    ];
    const done = steps.filter((s) => s[1]).length;
    const NS = 'http://www.w3.org/2000/svg', ring = document.createElementNS(NS, 'svg');
    ring.setAttribute('viewBox', '0 0 64 64'); ring.setAttribute('width', '84'); ring.setAttribute('height', '84'); ring.setAttribute('role', 'img'); ring.setAttribute('aria-label', `${done} of ${steps.length} done`);
    const c = (attrs) => { const n = document.createElementNS(NS, 'circle'); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); ring.append(n); };
    c({ cx: 32, cy: 32, r: 26, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': 7 });
    c({ cx: 32, cy: 32, r: 26, fill: 'none', stroke: 'var(--primary)', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': `${(done / steps.length) * 163.4} 163.4`, transform: 'rotate(-90 32 32)' });
    const t = document.createElementNS(NS, 'text'); t.setAttribute('x', 32); t.setAttribute('y', 37); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', 15); t.setAttribute('font-weight', 700); t.setAttribute('fill', 'currentColor'); t.textContent = `${done}/${steps.length}`; ring.append(t);
    page = el('div', { class: 'stack' },
      section(done === steps.length ? 'You are all set up' : 'Get set up', el('div', { class: 'checklist' }, ring, el('ol', {}, steps.map(([l, ok, tab]) => el('li', { class: ok ? 'done' : null },
        icon(ok ? 'circle-check' : 'chevron-right', { size: 18 }), ok ? l : el('button', { class: 'linkbtn', onclick: () => { state.setupTab = tab; render(); } }, l)))))),
      (() => { const nm = el('input', { type: 'text', value: state.tenant.name, maxlength: 120 });
        return section('Your group', field('Group name', nm, 'Shown at the top of every screen, on permits, emails and the public pages.'),
          el('button', { class: 'btn alt', onclick: () => guard(async () => {
            await api('/settings', { method: 'PATCH', body: { name: nm.value.trim() } });
            state.tenant = await api('/tenant'); state.me = await (await fetch('/me')).json(); toast('Group name saved'); render();
          }) }, 'Save name')); })(),
      planPanel(),
      section('Let new groups apply', el('p', { class: 'muted small' }, 'Share this page so a club or school can ask to join. You approve each one under Groups.'),
        el('div', { class: 'row' }, el('input', { type: 'text', readonly: true, value: `${location.origin}/apply/${state.tenant.slug}`, 'aria-label': 'Application page address', onfocus: (e) => e.target.select() }),
          el('button', { class: 'btn alt small', onclick: () => navigator.clipboard?.writeText(`${location.origin}/apply/${state.tenant.slug}`).then(() => toast('Copied')) }, 'Copy'))));
  } else if (state.setupTab === 'fields') {
    const facName = el('input', { type: 'text', placeholder: 'Veterans Park' });
    const spFac = el('select', {}, facilities.map((f) => el('option', { value: f.id }, f.name)));
    const spParent = el('select', {}, el('option', { value: '' }, 'A whole field'), state.spaces.map((s) => el('option', { value: s.id }, `Section of ${s.name}`)));
    const spName = el('input', { type: 'text', placeholder: 'Upper field' });
    const spLights = el('input', { type: 'checkbox', id: 'lights' });
    page = el('div', { class: 'stack' },
      section('Fields', state.spaces.length ? facilities.map((f) => el('div', { class: 'stack' }, el('div', { class: 'row between' }, el('h4', { class: 'row' }, icon('map-pin', { size: 18 }), f.name),
        menu(`Actions for ${f.name}`, [{ label: 'Rename site', icon: 'pencil', onSelect: () => renameBox('Rename site', f.name, (name) => api(`/facilities/${f.id}`, { method: 'PATCH', body: { name } })) }])),
        el('div', { class: 'field-cards' }, state.spaces.filter((s) => s.facility_id === f.id && !s.parent_id).map((s) => fieldCard(s)))))
        : emptyState('No fields yet', 'Add a site, then its fields. Halves or thirds can be added as sections.')),
      section('Add a site', el('div', { class: 'row' }, el('label', { class: 'sr-only', for: 'fac-name' }, 'Site name'), Object.assign(facName, { id: 'fac-name' }), el('button', { class: 'btn alt', onclick: () => facName.value && post('/facilities', { name: facName.value }, 'Site added') }, 'Add site'))),
      facilities.length ? section('Add a field or section', el('div', { class: 'grid2' }, field('Site', spFac), field('Part of', spParent)), field('Name', spName),
        el('label', { for: 'lights', class: 'inline-check' }, spLights, 'Has lights'),
        el('button', { class: 'btn', onclick: () => spName.value && post('/spaces', { facilityId: spFac.value, parentId: spParent.value || null, name: spName.value, hasLights: spLights.checked }, 'Added') }, 'Add')) : null,
      mapEditor());
  } else if (state.setupTab === 'people') {
    const orgName = el('input', { type: 'text', placeholder: 'U12 Girls' });
    const orgKind = el('select', {}, ['club', 'school', 'league', 'other'].map((k) => el('option', { value: k }, cap(k))));
    const mOrg = el('select', {}, organizations.map((o) => el('option', { value: o.id }, o.name)));
    const mName = el('input', { type: 'text', placeholder: 'Full name' });
    const mEmail = el('input', { type: 'email', placeholder: 'email@example.com' });
    const mRole = el('select', {}, el('option', { value: 'booker' }, 'Can request time'), el('option', { value: 'org_admin' }, 'Manages the group'));
    const sName = el('input', { type: 'text', placeholder: 'Full name' });
    const sEmail = el('input', { type: 'email', placeholder: 'email@example.com' });
    const sSite = el('select', {}, el('option', { value: '' }, 'All sites'), facilities.map((f) => el('option', { value: f.id }, `Only ${f.name}`)));
    const sRole = el('select', { onchange: () => { sSiteWrap.classList.toggle('hidden', sRole.value === 'tenant_admin'); } }, el('option', { value: 'approver' }, 'Approver'), el('option', { value: 'grounds' }, 'Groundskeeper (closes fields)'), el('option', { value: 'tenant_admin' }, 'Admin'));
    const sSiteWrap = field('Which sites', sSite);
    page = el('div', { class: 'stack' },
      section('Clubs, schools and teams',
        organizations.length ? el('ul', { class: 'plain' }, organizations.map((o) => el('li', { class: 'row between' }, el('span', { class: 'row' }, el('span', { class: 'dot', style: colorVar(o.id) }), o.name),
          el('span', { class: 'muted small' }, `${cap(o.kind)}, ${TIER[o.tier].toLowerCase()}${o.autoApprove ? ', trusted' : ''}`)))) : el('p', { class: 'muted' }, 'None yet.'),
        el('div', { class: 'grid2' }, field('Name', orgName), field('Kind', orgKind)),
        el('button', { class: 'btn alt', onclick: () => orgName.value && post('/organizations', { name: orgName.value, kind: orgKind.value }, 'Group added') }, 'Add group')),
      organizations.length ? section('Invite someone to a group', el('p', { class: 'muted small' }, 'They get an email with a sign-in link.'),
        el('div', { class: 'grid2' }, field('Group', mOrg), field('What they can do', mRole)), el('div', { class: 'grid2' }, field('Name', mName), field('Email', mEmail)),
        el('button', { class: 'btn', onclick: () => post(`/organizations/${mOrg.value}/members`, { fullName: mName.value, email: mEmail.value, role: mRole.value }, 'Invitation sent') }, icon('mail', { size: 18 }), 'Send invitation')) : null,
      section('Staff', el('p', { class: 'muted small' }, 'Approvers review requests; limit one to a site and they only see that site. Groundskeepers can close fields but not approve. Admins can also change setup.'),
        el('div', { class: 'grid2' }, field('Name', sName), field('Email', sEmail)), el('div', { class: 'grid2' }, field('Role', sRole), sSiteWrap),
        el('button', { class: 'btn alt', onclick: () => post('/staff', { fullName: sName.value, email: sEmail.value, role: sRole.value, ...(sSite.value && sRole.value !== 'tenant_admin' ? { facilityId: sSite.value } : {}) }, 'Invitation sent') }, 'Add staff')));
  } else if (state.setupTab === 'rules') page = await rulesPanel();
  else if (state.setupTab === 'money') page = el('div', { class: 'stack' }, planPanel(), await paymentsPanel().catch(() => null));
  else page = importPanel();
  return el('div', {}, el('div', { class: 'head' }, el('h2', {}, 'Setup')),
    el('div', { class: 'setup' }, el('nav', { class: 'setup-nav', 'aria-label': 'Setup sections' }, SETUP_TABS.map(tabBtn)), el('div', {}, page)));
}

/* ---------- Owner console: every group on CanWeUseIt (for the people who run it) ---------- */
async function platformView() {
  const [{ tenants }, { plans }] = await Promise.all([api('/platform/tenants'), api('/plans')]);
  const price = Object.fromEntries(plans.map((p) => [p.code, p.priceCents]));
  const byPlan = plans.map((p) => [p.name, tenants.filter((t) => t.plan_code === p.code).length]);
  const monthly = tenants.reduce((a, t) => a + (price[t.plan_code] || 0), 0);
  const open = (t) => guard(async () => {
    await api(`/platform/tenants/${t.id}/join`, { method: 'POST' });
    state.me = await (await fetch('/me')).json(); remember(t.id);
    state.tenant = { id: t.id }; state.tenant = await api('/tenant'); await loadData(); state.view = 'schedule'; render();
  });
  return el('div', { class: 'stack' },
    el('div', { class: 'head' }, el('div', {}, el('h2', {}, 'Owner console'), el('p', { class: 'page-sub small' }, 'Every group on CanWeUseIt. Only the emails in PLATFORM_ADMIN_EMAILS see this.'))),
    el('div', { class: 'owner-stats' }, [['Groups', tenants.length], ...byPlan, ['Plan value a month', money(monthly)]].map(([l, v]) => el('div', { class: 'stat panel' }, el('b', {}, String(v)), el('span', { class: 'muted small' }, l)))),
    tenants.length ? el('div', { class: 'panel table-wrap', role: 'region', 'aria-label': 'All groups', tabindex: '0' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ['Group', 'Plan', 'Sites', 'Fields', 'Clubs', 'Waiting', 'Admins', 'Started', ''].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, tenants.map((t) => el('tr', {},
        el('td', {}, el('b', {}, t.name), el('div', { class: 'muted small' }, t.slug)),
        el('td', {}, el('select', { 'aria-label': `Plan for ${t.name}`, onchange: (e) => guard(async () => { await api(`/platform/tenants/${t.id}`, { method: 'PATCH', body: { plan: e.target.value } }); toast(`${t.name} is now on ${e.target.selectedOptions[0].textContent.split(',')[0]}`); render(); }) },
          plans.map((p) => el('option', { value: p.code, selected: p.code === t.plan_code }, p.priceCents ? `${p.name}, ${money(p.priceCents)}/mo` : p.name)))),
        el('td', {}, String(t.sites)), el('td', {}, String(t.fields)), el('td', {}, String(t.groups)), el('td', {}, String(t.pending)),
        el('td', { class: 'small' }, t.admins || ''), el('td', { class: 'small' }, shortDate(t.created_at)),
        el('td', {}, el('button', { class: 'btn alt small', onclick: () => open(t) }, 'Open'))))))) : emptyState('No groups yet', 'Groups appear here when someone signs up.'),
    el('p', { class: 'muted small' }, 'Plan changes take effect at once. Billing for plans is by invoice for now; change the plan here after a group pays. Open adds you as an admin of that group, recorded in its activity log.'));
}

/* ---------- boot ---------- */
async function loadData() {
  const [{ spaces }, { facilities }, { organizations }] = await Promise.all([api('/spaces'), api('/facilities'), api('/organizations')]);
  state.spaces = spaces; state.facilities = facilities; state.orgs = organizations;
  try { state.compliance = (await api('/compliance')).organizations; } catch { state.compliance = []; }
}
let renderSeq = 0, lastView = null;
async function render() {
  if (!state.me) {
    try { state.me = await (await fetch('/me')).json(); if (!state.me.user) state.me = null; } catch { state.me = null; }
  }
  if (!state.me) { lastView = null; return $app.replaceChildren(loginScreen()); }
  if (!state.tenant) {
    const ids = [...new Set(state.me.memberships.map((m) => m.tenant_id))];
    if (!ids.length && state.me.platformAdmin) { // the owner, before joining any group
      const content = await platformView().catch((e) => el('p', { role: 'alert' }, e.message));
      return $app.replaceChildren(el('div', { class: 'public-wrap', style: 'max-width:1180px' }, el('div', { class: 'row between' }, el('a', { class: 'public-brand', href: '/' }, brandMark(32), 'CanWeUseIt'),
        el('button', { class: 'btn ghost small', onclick: signOut }, icon('log-out', { size: 16 }), 'Sign out')), el('main', { id: 'main' }, content)));
    }
    if (!ids.length) return $app.replaceChildren(el('main', { class: 'public-wrap' }, el('a', { class: 'public-brand', href: '/' }, brandMark(32), 'CanWeUseIt'),
      emptyState('You are not part of a group yet', 'Ask your club, school or league admin to add you. Running the fields yourself? Start your own group.', el('a', { class: 'btn', href: '/signup' }, 'Start a group'))));
    const saved = remembered();
    state.tenant = { id: ids.includes(saved) ? saved : ids[0] };
    state.tenant = await api('/tenant');
    await loadData();
  }
  const views = { platform: platformView, schedule: scheduleView, requests: requestsView, new: newRequestView, groups: groupsView, closures: closuresView, seasons: seasonsView, billing: billingView, profile: profileView, reports: reportsView, calendar: calendarView, setup: setupView };
  const seq = ++renderSeq;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  const entering = state.view !== lastView;
  const mainNow = $app.querySelector('.app main');
  const sk = entering && mainNow ? setTimeout(() => mainNow.replaceChildren(skeleton()), 150) : null;
  const scrollY = window.scrollY;
  const [content, count] = await Promise.all([
    (views[state.view] || scheduleView)().catch((e) => el('p', { role: 'alert' }, e.message)),
    api('/requests/pending-count').then((r) => r.count).catch(() => state.pendingCount || 0)]);
  clearTimeout(sk);
  if (seq !== renderSeq) return;
  state.pendingCount = count;
  $app.replaceChildren(shell(content, entering));
  lastView = state.view;
  if (entering) { window.scrollTo(0, 0); document.title = `${state.tenant.name} · CanWeUseIt`; } else window.scrollTo(0, scrollY);
}
const params = new URLSearchParams(location.search);
if (params.has('paid') || params.has('stripe')) {
  if (location.hash === '#billing') state.view = 'billing'; else if (location.hash === '#setup') { state.view = 'setup'; state.setupTab = 'money'; }
  history.replaceState(null, '', '/');
  setTimeout(() => toast(params.has('paid') ? 'Payment received. Thank you.' : 'Back from Stripe.'), 600);
}
render();

const reload = async () => { await loadData(); await render(); };
export { el, api, state, toast, guard, render, go, section, field, cap, dayLabel, hhmm, ymd, isAdmin, isStaff, myOrgIds, canManageOrg, parseTable, reload };
