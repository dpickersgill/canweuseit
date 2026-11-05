// CanWeUseIt web app. No build step; all text goes through el() so nothing user-supplied is ever parsed as HTML.
const $app = document.getElementById('app');
const state = { me: null, tenants: [], tenant: null, view: 'schedule', spaces: [], orgs: [], weekStart: null, spaceFilter: '', reqFilter: null };

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
      el('p', { class: 'muted' }, 'Request field time and see what has been approved. Sign in with a link sent to your email, no password needed.'), form));
}

function shell(content) {
  const tabs = [['schedule', 'Schedule'], ['requests', 'Requests'], ['new', 'Request time']];
  if (isAdmin()) tabs.push(['setup', 'Setup']);
  return el('div', {},
    el('header', { class: 'bar' }, el('div', { class: 'bar-in' },
      el('div', { class: 'bar-top' }, el('h1', {}, state.tenant.name),
        el('div', { class: 'who' }, state.me.user.full_name,
          el('button', { class: 'linkbtn', onclick: async () => { await fetch('/auth/logout', { method: 'POST' }); state.me = null; render(); } }, 'Sign out'))),
      el('nav', { class: 'tabs', 'aria-label': 'Main' }, tabs.map(([id, label]) =>
        el('button', { 'aria-current': state.view === id ? 'page' : null, onclick: () => go(id) }, label))))),
    el('main', {}, content));
}
function go(view) { state.view = view; render(); }

/* Schedule */
async function scheduleView() {
  const main = el('div', {});
  const today = ymd(new Date());
  if (!state.weekStart) state.weekStart = mondayOf(today);
  const { bookings } = await api(`/bookings?start=${state.weekStart}&days=7`);
  const shown = bookings.filter((b) => !state.spaceFilter || b.spaceId === state.spaceFilter);
  const spaceSel = el('select', { 'aria-label': 'Space', onchange: (e) => { state.spaceFilter = e.target.value; render(); } },
    el('option', { value: '' }, 'All spaces'), state.spaces.map((s) => el('option', { value: s.id, selected: s.id === state.spaceFilter }, s.name)));
  const last = addDays(state.weekStart, 6);
  main.append(el('div', { class: 'head' },
    el('h2', {}, `${fmt(state.weekStart + 'T12:00:00Z', { month: 'short', day: 'numeric' })} to ${fmt(last + 'T12:00:00Z', { month: 'short', day: 'numeric', year: 'numeric' })}`),
    el('div', { class: 'row' },
      el('button', { class: 'btn alt small', onclick: () => { state.weekStart = addDays(state.weekStart, -7); render(); } }, 'Previous week'),
      el('button', { class: 'btn alt small', onclick: () => { state.weekStart = mondayOf(today); render(); } }, 'This week'),
      el('button', { class: 'btn alt small', onclick: () => { state.weekStart = addDays(state.weekStart, 7); render(); } }, 'Next week'),
      spaceSel)));
  const week = el('div', { class: 'week' });
  for (let i = 0; i < 7; i++) {
    const d = addDays(state.weekStart, i);
    const items = shown.filter((b) => ymd(b.startsAt) === d);
    week.append(el('section', { class: 'day' + (d === today ? ' today' : '') },
      el('h3', {}, dayLabel(`${d}T12:00:00Z`)),
      items.length ? items.map((b) => el('div', { class: 'slot', style: `background:${tint(b.organizationId)}` },
        el('b', {}, `${fmt(b.startsAt, { hour: 'numeric', minute: '2-digit' })} to ${fmt(b.endsAt, { hour: 'numeric', minute: '2-digit' })}`),
        `${b.space}`, el('br'), `${b.organization}: ${b.title}`)) : el('p', { class: 'empty' }, 'Nothing booked')));
  }
  main.append(week);
  if (!bookings.length) main.append(el('p', { class: 'muted' }, 'No approved bookings this week. Use Request time to ask for a slot.'));
  return main;
}

/* Requests */
function datesList(r, canCancel) {
  const all = r.dates;
  const box = el('ul', { class: 'dates' });
  const draw = (limit) => {
    box.replaceChildren(...all.slice(0, limit).map((d) => el('li', {},
      el('span', { class: 'when' }, `${dayLabel(d.startsAt)}, ${timeRange(d.startsAt, d.endsAt)}`),
      d.conflict ? el('span', { class: 'badge conflict' }, 'Space already booked') : null,
      el('span', { class: 'badge ' + d.status }, d.status[0].toUpperCase() + d.status.slice(1)),
      canCancel && d.status === 'confirmed' ? el('button', { class: 'btn danger small', onclick: () => guard(async () => {
        if (!confirm('Cancel this date? The space becomes free for others.')) return;
        await api(`/booking-dates/${d.id}/cancel`, { method: 'POST' }); toast('Date cancelled'); render();
      }) }, 'Cancel date') : null)));
    if (all.length > limit) box.append(el('li', {}, el('button', { class: 'linkbtn', onclick: () => draw(999) }, `Show all ${all.length} dates`)));
  };
  draw(6);
  return box;
}
async function requestsView() {
  const staff = isStaff();
  if (state.reqFilter == null) state.reqFilter = staff ? 'pending' : '';
  const { requests } = await api('/requests' + (state.reqFilter ? `?status=${state.reqFilter}` : ''));
  const filters = [['pending', 'Waiting'], ['approved', 'Approved'], ['declined', 'Declined'], ['', 'All']];
  const wrap = el('div', {}, el('div', { class: 'head' }, el('h2', {}, staff ? 'Requests to review' : 'Your requests'),
    el('div', { class: 'chips' }, filters.map(([v, l]) => el('button', { class: 'chip', 'aria-pressed': String(state.reqFilter === v), onclick: () => { state.reqFilter = v; render(); } }, l)))));
  if (!requests.length) wrap.append(el('div', { class: 'panel empty-big' }, el('h3', {}, state.reqFilter === 'pending' ? 'Nothing waiting' : 'No requests here'),
    el('p', { class: 'muted' }, staff ? 'New requests from clubs and schools show up here.' : 'Use Request time to ask for a slot.')));
  const canCancelFor = (r) => staff || orgAdminIds().includes(r.organization_id);
  for (const r of requests) {
    const conflicts = r.dates.filter((d) => d.conflict).length;
    wrap.append(el('article', { class: 'panel card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('h3', {}, r.title), el('p', { class: 'muted small' }, `${r.organization} asking for ${r.space}${staff ? `, priority ${r.priority_snapshot}` : ''}`)),
        el('span', { class: 'badge ' + r.status }, r.status[0].toUpperCase() + r.status.slice(1))),
      r.notes ? el('p', {}, r.notes) : null,
      conflicts && r.status === 'pending' ? el('p', { class: 'small', style: 'color:var(--flag)' }, `${conflicts} of ${r.dates.length} dates are already taken. Approving will confirm the free dates and mark these as conflicts.`) : null,
      datesList(r, canCancelFor(r)),
      staff && r.status === 'pending' ? el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: () => guard(async () => {
          const d = await api(`/requests/${r.id}/decision`, { method: 'POST', body: { decision: 'approve' } });
          toast(d.flagged ? `${d.confirmed} confirmed, ${d.flagged} conflicts` : `Approved, ${d.confirmed} dates confirmed`); render();
        }) }, 'Approve'),
        el('button', { class: 'btn danger', onclick: () => guard(async () => {
          if (!confirm('Decline this request?')) return;
          await api(`/requests/${r.id}/decision`, { method: 'POST', body: { decision: 'decline' } }); toast('Request declined'); render();
        }) }, 'Decline')) : null));
  }
  return wrap;
}

/* New request */
const DOW = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];
function newRequestView() {
  const orgs = state.orgs.filter((o) => isAdmin() || myOrgIds().includes(o.id));
  if (!orgs.length) return el('div', { class: 'panel empty-big' }, el('h3', {}, 'No organization yet'),
    el('p', { class: 'muted' }, 'Ask the group admin to add you to your club, school or team before requesting time.'));
  const f = { spaceId: '', repeat: false, days: new Set() };
  const pickerHost = el('div', {});
  const drawPicker = () => pickerHost.replaceChildren(pitchPicker(state.spaces, { selected: f.spaceId, onSelect: (s) => { f.spaceId = s.id; drawPicker(); } }));
  drawPicker();
  const org = el('select', { id: 'org' }, orgs.map((o) => el('option', { value: o.id }, o.name)));
  const title = el('input', { type: 'text', id: 'title', maxlength: 200, placeholder: 'U12 practice', required: true });
  const notes = el('textarea', { id: 'notes', placeholder: 'Anything the approvers should know' });
  const date = el('input', { type: 'date', id: 'date', required: true });
  const until = el('input', { type: 'date', id: 'until' });
  const start = el('input', { type: 'time', id: 'start', required: true, value: '18:00' });
  const end = el('input', { type: 'time', id: 'end', required: true, value: '20:00' });
  const repeatBox = el('div', { class: 'hidden field' },
    el('label', {}, 'Repeats on'), el('div', { class: 'chips' }, DOW.map(([l, n]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: (e) => {
      f.days.has(n) ? f.days.delete(n) : f.days.add(n); e.currentTarget.setAttribute('aria-pressed', String(f.days.has(n))); } }, l))),
    el('div', { class: 'field' }, el('label', { for: 'until' }, 'Last date'), until));
  const rep = el('input', { type: 'checkbox', id: 'rep', onchange: (e) => { f.repeat = e.target.checked; repeatBox.classList.toggle('hidden', !f.repeat); } });
  const form = el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); guard(async () => {
    if (!f.spaceId) throw new Error('Pick a field or section first');
    let weekly;
    if (f.repeat) {
      if (!f.days.size || !until.value) throw new Error('Choose the days it repeats on and a last date');
      weekly = { startsOn: date.value, until: until.value, weekdays: [...f.days], startTime: start.value, endTime: end.value };
    } else {
      const dow = new Date(`${date.value}T12:00:00Z`).getUTCDay();
      weekly = { startsOn: date.value, until: date.value, weekdays: [dow], startTime: start.value, endTime: end.value };
    }
    const r = await api('/requests', { method: 'POST', body: { organizationId: org.value, spaceId: f.spaceId, title: title.value, notes: notes.value, weekly } });
    toast(`Request sent, ${r.dateCount} date${r.dateCount === 1 ? '' : 's'}`); state.reqFilter = isStaff() ? 'pending' : ''; go('requests');
  }); } },
    el('div', { class: 'panel' }, el('h3', {}, 'Where'), el('p', { class: 'muted small' }, 'Tap the field, or a section of it.'), pickerHost),
    el('div', { class: 'panel stack' }, el('h3', {}, 'When'),
      el('div', { class: 'grid2' }, el('div', {}, el('label', { for: 'date' }, 'First date'), date), el('div', {}, el('label', { for: 'org' }, 'Asking for'), org)),
      el('div', { class: 'grid2' }, el('div', {}, el('label', { for: 'start' }, 'Starts'), start), el('div', {}, el('label', { for: 'end' }, 'Ends'), end)),
      el('label', { for: 'rep', class: 'row', style: 'font-weight:500' }, rep, 'Repeat every week'), repeatBox),
    el('div', { class: 'panel stack' }, el('h3', {}, 'What for'),
      el('div', {}, el('label', { for: 'title' }, 'Title'), title), el('div', {}, el('label', { for: 'notes' }, 'Notes (optional)'), notes)),
    el('div', {}, el('button', { class: 'btn', type: 'submit' }, 'Send request')));
  return el('div', {}, el('div', { class: 'head' }, el('h2', {}, 'Request time')), form);
}

/* Setup (tenant admin) */
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
  const orgKind = el('select', { 'aria-label': 'Kind' }, ['club', 'school', 'league', 'other'].map((k) => el('option', { value: k }, k[0].toUpperCase() + k.slice(1))));
  const mOrg = el('select', { 'aria-label': 'Organization' }, organizations.map((o) => el('option', { value: o.id }, o.name)));
  const mName = el('input', { type: 'text', placeholder: 'Full name', 'aria-label': 'Full name' });
  const mEmail = el('input', { type: 'email', placeholder: 'email@example.com', 'aria-label': 'Email' });
  const mRole = el('select', { 'aria-label': 'Role' }, el('option', { value: 'booker' }, 'Can request time'), el('option', { value: 'org_admin' }, 'Manages the organization'));

  return el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, 'Setup')),
    el('section', { class: 'panel stack' }, el('h3', {}, 'Fields and sections'),
      state.spaces.length ? pitchPicker(state.spaces, {}) : el('p', { class: 'muted' }, 'No fields yet. Add a facility, then its fields.'),
      el('div', { class: 'row' }, facName, el('button', { class: 'btn alt', onclick: () => facName.value && post('/facilities', { name: facName.value }, 'Facility added') }, 'Add facility')),
      facilities.length ? el('div', { class: 'stack' },
        el('div', { class: 'grid2' }, spFac, spParent), spName,
        el('label', { for: 'lights', class: 'row', style: 'font-weight:500' }, spLights, 'Has lights'),
        el('button', { class: 'btn', onclick: () => spName.value && post('/spaces', { facilityId: spFac.value, parentId: spParent.value || null, name: spName.value, hasLights: spLights.checked }, 'Added') }, 'Add field or section')) : null),
    el('section', { class: 'panel stack' }, el('h3', {}, 'Clubs, schools and teams'),
      organizations.length ? el('ul', {}, organizations.map((o) => el('li', {}, `${o.name} (${o.kind})`))) : el('p', { class: 'muted' }, 'None yet.'),
      el('div', { class: 'row' }, orgName, orgKind, el('button', { class: 'btn alt', onclick: () => orgName.value && post('/organizations', { name: orgName.value, kind: orgKind.value }, 'Organization added') }, 'Add organization')),
      organizations.length ? el('div', { class: 'stack' }, el('h3', {}, 'Invite someone'),
        el('p', { class: 'muted small' }, 'They get an email with a sign-in link.'),
        el('div', { class: 'grid2' }, mOrg, mRole), el('div', { class: 'grid2' }, mName, mEmail),
        el('button', { class: 'btn', onclick: () => post(`/organizations/${mOrg.value}/members`, { fullName: mName.value, email: mEmail.value, role: mRole.value }, 'Invitation sent') }, 'Send invitation')) : null));
}

/* ---------- boot ---------- */
async function loadData() {
  const [{ spaces }, { facilities }, { organizations }] = await Promise.all([api('/spaces'), api('/facilities'), api('/organizations')]);
  state.spaces = spaces; state.facilities = facilities; state.orgs = organizations;
}
async function render() {
  if (!state.me) {
    try { state.me = await (await fetch('/me')).json(); if (!state.me.user) state.me = null; } catch { state.me = null; }
  }
  if (!state.me) return $app.replaceChildren(loginScreen());
  if (!state.tenant) {
    const ids = [...new Set(state.me.memberships.map((m) => m.tenant_id))];
    if (!ids.length) return $app.replaceChildren(el('main', {}, el('p', {}, 'Your email is not part of any group yet. Ask a group admin to add you.')));
    state.tenant = { id: ids[0] }; // multiple groups: first one for now
    state.tenant = await api('/tenant');
    await loadData();
  }
  const views = { schedule: scheduleView, requests: requestsView, new: async () => newRequestView(), setup: setupView };
  let content;
  try { content = await views[state.view](); } catch (e) { content = el('p', { role: 'alert' }, e.message); }
  $app.replaceChildren(shell(content));
}
render();
