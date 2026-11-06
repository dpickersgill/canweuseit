// Screens for: the field map, teams inside a club's time, giving time back, no-shows, card payments and refunds,
// plan and payments setup, utilization, club-app exports, and your own settings (phone and texts).
import * as L from '/vendor/leaflet/leaflet-src.esm.js';
import { el, api, state, toast, guard, render, section, field, cap, dayLabel, hhmm, isAdmin, isStaff } from './app.js';
import { download, money } from './more.js';

/* ---------- map ---------- */
let cssAdded = false;
const addCss = () => { if (cssAdded) return; cssAdded = true; document.head.append(el('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css' })); };
const ring = (outline) => outline.map(([lng, lat]) => [lat, lng]);
const hasMap = () => state.spaces.some((s) => Array.isArray(s.outline) && s.outline.length >= 3);
export { hasMap };

function baseMap(host, { facilityId } = {}) {
  addCss();
  const m = L.map(host, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
  const t = state.tenant.map || {};
  L.tileLayer(t.tiles, { attribution: t.attribution, maxZoom: 21, maxNativeZoom: 19 }).addTo(m);
  const shapes = state.spaces.filter((s) => s.outline && (!facilityId || s.facility_id === facilityId));
  const fac = (state.facilities || []).find((f) => f.id === facilityId && f.latitude != null) || (state.facilities || []).find((f) => f.latitude != null);
  if (shapes.length) m.fitBounds(L.latLngBounds(shapes.flatMap((s) => ring(s.outline))).pad(0.15));
  else if (fac) m.setView([fac.latitude, fac.longitude], 18);
  else if (state.tenant.latitude != null) m.setView([state.tenant.latitude, state.tenant.longitude], 16);
  else m.setView([39.5, -98.35], 4);
  return m;
}
// Leaflet needs the element on the page before it can size itself.
const whenShown = (node, fn) => { const tick = () => (node.isConnected ? fn() : requestAnimationFrame(tick)); requestAnimationFrame(tick); };

// Pick a field (or a section) by tapping its outline on the satellite view.
export function mapPicker({ selected, onSelect }) {
  const host = el('div', { class: 'fieldmap', role: 'application', 'aria-label': 'Satellite map of the fields. The field list next to it does the same job without a map.' });
  whenShown(host, () => {
    const m = baseMap(host);
    const order = [...state.spaces.filter((s) => s.outline)].sort((a, b) => (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0)); // sections drawn on top
    for (const s of order) {
      const on = s.id === selected;
      L.polygon(ring(s.outline), { color: on ? '#f6c344' : '#ffffff', weight: on ? 4 : 2, fillOpacity: on ? 0.35 : 0.12, fillColor: on ? '#f6c344' : '#1e4b35' })
        .bindTooltip(s.name, { permanent: true, direction: 'center', className: 'map-label' })
        .on('click', () => onSelect(s)).addTo(m);
    }
  });
  return host;
}

// Admins: draw each field's outline, and set where each site is.
export function mapEditor() {
  const facs = state.facilities || [];
  if (!facs.length) return section('Field map', el('p', { class: 'muted' }, 'Add a site and its fields first.'));
  let fid = facs[0].id, m = null, drawing = null;
  const pick = el('select', { 'aria-label': 'Site', onchange: (e) => { fid = e.target.value; draw(); } }, facs.map((f) => el('option', { value: f.id }, f.name)));
  const host = el('div', { class: 'fieldmap tall' });
  const list = el('ul', { class: 'plain' });
  const help = el('p', { class: 'muted small', role: 'status' }, 'Zoom in to the site, then choose Draw next to a field and tap each corner of it on the map.');
  const layers = [];
  const paint = () => {
    layers.splice(0).forEach((l) => l.remove());
    for (const s of state.spaces.filter((x) => x.facility_id === fid && x.outline)) {
      layers.push(L.polygon(ring(s.outline), { color: s.parent_id ? '#f6c344' : '#ffffff', weight: 2, fillOpacity: 0.15 }).bindTooltip(s.name, { permanent: true, direction: 'center', className: 'map-label' }).addTo(m));
    }
  };
  const stop = () => { if (drawing) { drawing.line.remove(); drawing.dots.forEach((d) => d.remove()); m.off('click', drawing.onClick); drawing = null; } };
  const save = (s, pts) => guard(async () => {
    const r = await api(`/spaces/${s.id}`, { method: 'PATCH', body: { outline: pts } });
    Object.assign(state.spaces.find((x) => x.id === s.id), { outline: r.outline });
    toast(pts ? `${s.name} outlined` : `${s.name} outline removed`); stop(); paint(); drawList();
    help.textContent = 'Saved. Choose Draw next to another field, or Redraw to fix one.';
  });
  const start = (s) => {
    stop();
    const pts = [];
    const line = L.polyline([], { color: '#f6c344', weight: 3, dashArray: '6 6' }).addTo(m);
    const dots = [];
    const onClick = (e) => { pts.push([e.latlng.lng, e.latlng.lat]); line.setLatLngs(pts.map(([x, y]) => [y, x])); dots.push(L.circleMarker(e.latlng, { radius: 4, color: '#f6c344' }).addTo(m)); help.textContent = `${pts.length} corner${pts.length === 1 ? '' : 's'} placed for ${s.name}. Finish when you have gone all the way round.`; drawList(); };
    m.on('click', onClick);
    drawing = { s, pts, line, dots, onClick };
    help.textContent = `Drawing ${s.name}: tap each corner on the map.`;
    drawList();
  };
  const drawList = () => list.replaceChildren(...state.spaces.filter((s) => s.facility_id === fid).map((s) => el('li', { class: 'row between' },
    el('span', {}, `${s.parent_id ? '  Section: ' : ''}${s.name}${s.outline ? '' : ' (no outline yet)'}`),
    drawing?.s.id === s.id ? el('span', { class: 'row' },
      el('button', { class: 'btn small', disabled: drawing.pts.length < 3, onclick: () => save(s, drawing.pts) }, 'Finish'),
      el('button', { class: 'btn alt small', onclick: () => { drawing.pts.pop(); drawing.dots.pop()?.remove(); drawing.line.setLatLngs(drawing.pts.map(([x, y]) => [y, x])); drawList(); } }, 'Undo corner'),
      el('button', { class: 'btn alt small', onclick: () => { stop(); drawList(); help.textContent = 'Cancelled.'; } }, 'Cancel'))
      : el('span', { class: 'row' }, el('button', { class: 'btn alt small', onclick: () => start(s) }, s.outline ? 'Redraw' : 'Draw'),
        s.outline ? el('button', { class: 'btn danger small', onclick: () => save(s, null) }, 'Clear') : null))));
  const draw = () => { stop(); if (m) { m.remove(); m = null; } whenShown(host, () => { m = baseMap(host, { facilityId: fid }); paint(); }); drawList(); };
  draw();
  return section('Field map',
    el('p', { class: 'muted small' }, 'Outlines let groups pick a field by tapping it on a satellite view. Sections can be drawn inside their field.'),
    el('div', { class: 'row' }, pick, el('button', { class: 'btn alt small', onclick: () => guard(async () => {
      const c = m.getCenter(); await api(`/facilities/${fid}`, { method: 'PATCH', body: { latitude: Math.round(c.lat * 1e6) / 1e6, longitude: Math.round(c.lng * 1e6) / 1e6 } });
      Object.assign(state.facilities.find((f) => f.id === fid), { latitude: c.lat, longitude: c.lng }); toast('Site location saved'); }) }, 'Save this view as the site location')),
    host, help, list);
}

/* ---------- inside an approved date: teams, giving time back, no-shows ---------- */
export function teamPlanBox(d) {
  const host = el('div', { class: 'note-box stack' }, el('p', { class: 'muted small' }, 'Loading...'));
  guard(async () => {
    const p = await api(`/booking-dates/${d.id}/team-slots`);
    if (!p.teams.length) return host.replaceChildren(el('p', { class: 'muted small' }, p.canEdit ? 'Add your teams under Groups first, then place them here.' : 'No teams placed on this date yet.'));
    if (!p.canEdit) return host.replaceChildren(p.slots.length ? el('ul', { class: 'plain small' }, p.slots.map((s) => el('li', {}, `${s.team}: ${s.space}, ${hhmm(s.startsAt)} to ${hhmm(s.endsAt)}`))) : el('p', { class: 'muted small' }, 'No teams placed on this date yet.'));
    const rows = p.slots.map((s) => ({ teamId: s.teamId, spaceId: s.spaceId, start: hhmm(s.startsAt), end: hhmm(s.endsAt) }));
    const list = el('div', { class: 'stack' });
    const drawRows = () => list.replaceChildren(...rows.map((r, i) => el('div', { class: 'slot-row' },
      el('select', { 'aria-label': `Team, row ${i + 1}`, onchange: (e) => { r.teamId = e.target.value; } }, el('option', { value: '' }, 'Team'), p.teams.map((t) => el('option', { value: t.id, selected: t.id === r.teamId }, t.name))),
      el('select', { 'aria-label': `Field, row ${i + 1}`, onchange: (e) => { r.spaceId = e.target.value; } }, p.spaces.map((s) => el('option', { value: s.id, selected: s.id === r.spaceId }, `${s.parentId ? 'Section: ' : ''}${s.name}`))),
      el('input', { type: 'time', value: r.start, 'aria-label': `Starts, row ${i + 1}`, oninput: (e) => { r.start = e.target.value; } }),
      el('input', { type: 'time', value: r.end, 'aria-label': `Ends, row ${i + 1}`, oninput: (e) => { r.end = e.target.value; } }),
      el('button', { class: 'btn danger small', 'aria-label': `Remove row ${i + 1}`, onclick: () => { rows.splice(i, 1); drawRows(); } }, 'Remove'))));
    drawRows();
    host.replaceChildren(el('p', { class: 'small' }, `Booked: ${p.date.space}, ${hhmm(p.date.startsAt)} to ${hhmm(p.date.endsAt)}. Split it between your teams, by section or by time.`), list,
      el('div', { class: 'actions' },
        el('button', { class: 'btn alt small', onclick: () => { rows.push({ teamId: '', spaceId: p.spaces[0].id, start: hhmm(p.date.startsAt), end: hhmm(p.date.endsAt) }); drawRows(); } }, 'Add a team'),
        el('button', { class: 'btn small', onclick: () => guard(async () => {
          if (rows.some((r) => !r.teamId)) throw new Error('Choose a team on every row, or remove the empty one');
          await api(`/booking-dates/${d.id}/team-slots`, { method: 'PUT', body: { slots: rows } }); toast('Team plan saved');
        }) }, 'Save team plan')));
  });
  return host;
}

export function releaseBox(d) {
  const a = el('input', { type: 'time', value: hhmm(d.startsAt), 'aria-label': 'Keep from' }), b = el('input', { type: 'time', value: hhmm(d.endsAt), 'aria-label': 'Keep until' });
  return el('div', { class: 'note-box stack' },
    el('p', { class: 'small' }, 'Keep only the time you need. The rest is given back so others can book it. To give back the whole date, use Skip.'),
    el('div', { class: 'row' }, el('label', {}, 'Keep from'), a, el('label', {}, 'until'), b,
      el('button', { class: 'btn small', onclick: () => guard(async () => {
        const r = await api(`/booking-dates/${d.id}/release`, { method: 'POST', body: { keepStart: a.value, keepEnd: b.value } });
        toast(r.releasedMinutes ? `Gave back ${r.releasedMinutes} minutes` : 'Nothing changed'); render();
      }) }, 'Give back the rest')));
}

export function noShowButton(d) {
  return el('button', { class: 'btn alt small', onclick: () => guard(async () => {
    const r = await api(`/booking-dates/${d.id}/no-show`, { method: 'POST', body: { noShow: !d.noShow } });
    toast(r.noShow ? 'Marked as a no-show' : 'No-show removed'); render();
  }) }, d.noShow ? 'Undo no-show' : 'No-show');
}

/* ---------- teams and exports for a group ---------- */
export function teamsPanel(o, canEdit) {
  const host = el('div', { class: 'stack' });
  const load = () => guard(async () => {
    const { teams } = await api(`/organizations/${o.id}/teams`);
    const name = el('input', { type: 'text', maxlength: 80, placeholder: 'U12 girls', 'aria-label': `New team for ${o.name}` });
    const fmt = el('select', { 'aria-label': 'Club app' }, [['teamsnap', 'TeamSnap'], ['sportsengine', 'SportsEngine'], ['leagueapps', 'LeagueApps']].map(([v, l]) => el('option', { value: v }, l)));
    const which = el('select', { 'aria-label': 'Which team' }, el('option', { value: '' }, 'All teams'), teams.filter((t) => t.active).map((t) => el('option', { value: t.id }, t.name)));
    const feedOut = el('div', {});
    host.replaceChildren(
      teams.length ? el('ul', { class: 'plain' }, teams.map((t) => el('li', { class: 'row between' }, el('span', {}, `${t.name}${t.active ? '' : ' (retired)'}`),
        canEdit ? el('button', { class: 'btn alt small', onclick: () => guard(async () => { await api(`/teams/${t.id}`, { method: 'PATCH', body: { active: !t.active } }); load(); }) }, t.active ? 'Retire' : 'Bring back') : null))) : el('p', { class: 'muted small' }, 'No teams yet.'),
      canEdit ? el('div', { class: 'row' }, name, el('button', { class: 'btn alt small', onclick: () => guard(async () => { await api(`/organizations/${o.id}/teams`, { method: 'POST', body: { name: name.value } }); toast('Team added'); load(); }) }, 'Add team')) : null,
      el('details', {}, el('summary', {}, 'Send the schedule to your club app'),
        el('div', { class: 'stack' }, el('p', { class: 'muted small' }, 'Download a file your club app can import as practices. TeamSnap: Schedule, Import, Schedule from File. SportsEngine: Competition, Schedule Upload. LeagueApps: Schedule, Import Schedule (events). None of them can follow a live calendar link, so import again after changes.'),
          el('div', { class: 'row' }, which, fmt, el('button', { class: 'btn small', onclick: () => guard(() => download(`/export/club-schedule.csv?${which.value ? `teamId=${which.value}` : `organizationId=${o.id}`}&format=${fmt.value}`, `${o.name}-${fmt.value}.csv`.replace(/[^\w.-]+/g, '-'))) }, 'Download')),
          el('p', { class: 'muted small' }, 'For parents and coaches\' own phones, a calendar link for one team updates by itself:'),
          el('div', { class: 'row' }, el('button', { class: 'btn alt small', onclick: () => guard(async () => {
            if (!which.value) throw new Error('Choose a team first');
            const r = await api('/calendar-feeds', { method: 'POST', body: { teamId: which.value, label: which.selectedOptions[0].textContent } });
            feedOut.replaceChildren(el('input', { type: 'text', readonly: true, value: r.url, 'aria-label': 'Team calendar address', onfocus: (e) => e.target.select() }),
              el('p', { class: 'small' }, el('a', { href: r.pageUrl, target: '_blank', rel: 'noopener' }, 'Open the team schedule page')));
          }) }, 'Make a team calendar link')), feedOut)));
  });
  load();
  return el('div', { class: 'stack' }, el('h4', {}, 'Teams'), host);
}

/* ---------- money: pay by card, refunds, and payments setup ---------- */
export function payButton(i) {
  return el('button', { class: 'btn small', onclick: () => guard(async () => { const r = await api(`/invoices/${i.id}/checkout`, { method: 'POST' }); location.href = r.url; }) }, `Pay ${money(i.amountCents)} by card`);
}
export function refundBox(i) {
  const left = i.amountCents - (i.refundedCents || 0);
  const amt = el('input', { type: 'number', min: '0.01', step: '0.01', max: (left / 100).toFixed(2), value: (left / 100).toFixed(2), 'aria-label': 'Refund amount in dollars' });
  return el('div', { class: 'inline-form' }, amt, el('button', { class: 'btn small', onclick: () => guard(async () => {
    const cents = Math.round(Number(amt.value) * 100);
    if (!confirm(`Refund ${money(cents)}?${i.paidMethod === 'card' ? ' It goes back to the card.' : ' Record it here once you have paid it back.'}`)) return;
    const r = await api(`/invoices/${i.id}/refund`, { method: 'POST', body: { amountCents: cents } });
    toast(r.card ? 'Refunded to the card' : 'Refund recorded'); render();
  }) }, 'Refund'));
}

export async function paymentsPanel() {
  const s = await api('/payments/status');
  const dep = el('input', { type: 'number', min: '0', step: '1', value: (s.depositCents / 100).toFixed(0), 'aria-label': 'Deposit in dollars' });
  const connect = (label) => el('button', { class: 'btn small', onclick: () => guard(async () => { const r = await api('/payments/connect', { method: 'POST' }); location.href = r.url; }) }, label);
  const line = !s.serverReady ? el('p', { class: 'muted' }, 'Card payments are not switched on for this server yet.')
    : !s.planAllows ? el('p', { class: 'muted' }, `Card payments come with the Standard and Pro plans. You are on ${s.plan}.`)
    : !s.connected ? el('div', { class: 'stack' }, el('p', {}, `Connect a Stripe account so groups can pay invoices by card. Money goes straight to your account; CanWeUseIt keeps ${s.platformFeePercent}% of each payment, and Stripe charges its own card fee.`), connect('Connect Stripe'))
    : !s.ready ? el('div', { class: 'stack' }, el('p', {}, 'Stripe needs a few more details before you can take payments.'), connect('Finish Stripe setup'))
    : el('div', { class: 'okbox' }, el('p', {}, `Card payments are on. CanWeUseIt keeps ${s.platformFeePercent}% of each payment.`));
  return section('Payments', line,
    field('Refundable deposit on every approved request (dollars, 0 for none)', el('div', { class: 'row' }, dep, el('button', { class: 'btn alt small', onclick: () => guard(async () => {
      await api('/settings', { method: 'PATCH', body: { depositCents: Math.round(Number(dep.value || 0) * 100) } }); toast('Deposit saved'); }) }, 'Save')),
    'A deposit invoice is created when a request is approved. Refund it from Fees when the season ends.'));
}

export function planPanel() {
  const p = state.tenant.plan;
  if (!p) return null;
  const lim = (n, max, what) => `${n} ${what}${max != null ? ` of ${max}` : ''}`;
  return section('Your plan', el('p', {}, el('b', {}, p.name), p.priceCents ? `, ${money(p.priceCents)} a month` : ', free'),
    el('p', { class: 'muted small' }, `${lim(p.facilities, p.maxFacilities, 'sites')}, ${lim(p.fields, p.maxFields, 'fields')}. ${p.onlinePayments ? 'Card payments included.' : 'Card payments come with Standard and Pro.'}`),
    p.plan === 'free' || p.plan === 'standard' ? el('p', { class: 'small' }, el('a', { href: `mailto:${state.tenant.contact}?subject=${encodeURIComponent(`Upgrade ${state.tenant.name}`)}` }, 'Ask to upgrade'), `: Standard ${money(14900)} a month for 3 sites and 20 fields with card payments; Pro ${money(34900)} a month with no limits.`) : null);
}

/* ---------- utilization ---------- */
export async function utilizationPanel(from, to) {
  const u = await api(`/reports/utilization?from=${from}&to=${to}`);
  const bar = (pct) => el('span', { class: 'meter', role: 'img', 'aria-label': `${pct} percent` }, el('span', { style: `width:${Math.min(pct, 100)}%` }));
  return el('div', { class: 'stack' },
    section('How much of the open time was used',
      u.assumedHours ? el('p', { class: 'muted small' }, `Fields with no opening hours set are counted as open ${u.assumedHours[0]} to ${u.assumedHours[1]}. Set real hours under Setup for a truer figure.`) : null,
      el('div', { class: 'table-wrap', role: 'region', 'aria-label': 'Field use', tabindex: '0' }, el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ['Field', 'Open hours', 'Used', ''].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, u.bySpace.map((s) => el('tr', {}, el('td', {}, s.name), el('td', {}, String(s.openHours)), el('td', {}, `${s.usedHours} h, ${s.percent}%`), el('td', {}, bar(s.percent)))))))),
    section('How well each group used its time',
      el('p', { class: 'muted small' }, `Use = approved hours they actually used, out of everything they were given (including time they gave back).${u.noShowLimit || u.minUsePct ? ` Rules: ${[u.noShowLimit ? `${u.noShowLimit} no-shows a year` : null, u.minUsePct ? `${u.minUsePct}% minimum use` : null].filter(Boolean).join(', ')}. Groups over the no-show limit are placed last in the next season's allocation.` : ' Set use-it-or-lose-it rules under Setup.'}`),
      u.byOrg.length ? el('div', { class: 'table-wrap', role: 'region', 'aria-label': 'Group use', tabindex: '0' }, el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ['Group', 'Given', 'Gave back', 'No-shows', 'Late cancels', 'Use'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, u.byOrg.map((o) => el('tr', { class: o.flags.length ? 'flagged-row' : '' }, el('td', {}, o.name, o.flags.length ? el('div', { class: 'warn-text small' }, o.flags.join('; ')) : null),
          el('td', {}, `${o.givenHours} h`), el('td', {}, `${o.releasedHours} h`), el('td', {}, String(o.noShows)), el('td', {}, String(o.lateCancels)), el('td', {}, o.usePct == null ? '' : `${o.usePct}%`)))))) : el('p', { class: 'muted' }, 'No bookings in these dates.')));
}

/* ---------- your settings ---------- */
export async function profileView() {
  const p = await api('/profile');
  const name = el('input', { type: 'text', id: 'pf-name', value: p.fullName, maxlength: 120, autocomplete: 'name' });
  const phone = el('input', { type: 'tel', id: 'pf-phone', value: p.phone || '', placeholder: '610-555-0123', autocomplete: 'tel' });
  const opt = el('input', { type: 'checkbox', id: 'pf-sms', checked: p.smsOptIn });
  return el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, 'Your settings')),
    el('form', { class: 'panel stack', onsubmit: (e) => { e.preventDefault(); guard(async () => {
      await api('/profile', { method: 'PATCH', body: { fullName: name.value, phone: phone.value, smsOptIn: opt.checked } }); toast('Saved');
      state.me.user.full_name = name.value; render();
    }); } },
      el('div', {}, el('label', { for: 'pf-name' }, 'Your name'), name),
      el('div', {}, el('label', {}, 'Email'), el('p', {}, p.email)),
      el('div', {}, el('label', { for: 'pf-phone' }, 'Mobile number (optional)'), phone),
      el('label', { for: 'pf-sms', class: 'row inline-check' }, opt, el('span', {}, 'Text me when a field closes or my booking is cancelled, and when a slot I am waiting for opens. Message and data rates may apply. Reply STOP to stop.')),
      p.textsAvailable ? null : el('p', { class: 'muted small' }, 'Texts are not switched on for this server yet; your choice is saved for when they are.'),
      el('div', {}, el('button', { class: 'btn', type: 'submit' }, 'Save'))));
}
export { cap, dayLabel, isAdmin, isStaff };
