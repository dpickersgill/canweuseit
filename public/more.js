// Seasons, billing, applications, activity: the views added for larger facilities.
import { payButton, refundBox } from './gaps.js';
import { SPACE_KINDS, kindOf } from './kinds.js';
import { el, api, state, toast, guard, render, go, section, field, cap, dayLabel, hhmm, ymd, isAdmin, isStaff, myOrgIds, canManageOrg, parseTable } from './app.js';

export const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function download(path, name) {
  const res = await fetch(path, { headers: { 'x-tenant-id': state.tenant.id } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const lines = (results) => el('ul', { class: 'plain' }, results.map((r) => el('li', {},
  el('b', {}, `${r.organization}: ${r.title}`), ' ',
  r.skipped ? el('span', { class: 'warn-text' }, r.skipped) : el('span', {}, `${r.confirmed} confirmed${r.flagged ? `, ${r.flagged} taken by a higher priority` : ''}`))));

/* ---------- Seasons (allocation rounds) ---------- */
export async function seasonsView() {
  const { rounds } = await api('/rounds');
  const admin = isAdmin();
  const wrap = el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, 'Seasons')),
    el('p', { class: 'muted' }, 'Open a season so groups send their whole schedule in one window. When it closes, run the allocation: higher priority groups are placed first, and nobody goes over the hours cap.'));
  if (admin) {
    const name = el('input', { type: 'text', placeholder: 'Fall 2027', 'aria-label': 'Season name', maxlength: 120 });
    const opens = el('input', { type: 'datetime-local', 'aria-label': 'Requests open' }), closes = el('input', { type: 'datetime-local', 'aria-label': 'Requests close' });
    const s1 = el('input', { type: 'date', 'aria-label': 'Season starts' }), s2 = el('input', { type: 'date', 'aria-label': 'Season ends' });
    const cap_ = el('input', { type: 'number', min: '1', step: '0.5', placeholder: 'No limit', 'aria-label': 'Hours cap per group' });
    wrap.append(section('Open a season', field('Name', name),
      el('div', { class: 'grid2' }, field('Requests open', opens), field('Requests close', closes)),
      el('div', { class: 'grid2' }, field('Season starts', s1), field('Season ends', s2)),
      field('Most hours one group can be given (optional)', cap_),
      el('button', { class: 'btn', onclick: () => guard(async () => {
        if (!opens.value || !closes.value) throw new Error('Choose when requests open and close');
        await api('/rounds', { method: 'POST', body: { name: name.value, opensAt: new Date(opens.value).toISOString(), closesAt: new Date(closes.value).toISOString(), seasonStart: s1.value, seasonEnd: s2.value, maxHoursPerOrg: cap_.value || null } });
        toast('Season opened'); render();
      }) }, 'Open season')));
  }
  for (const r of rounds) {
    const out = el('div', { role: 'status' });
    const f1 = el('input', { type: 'date', 'aria-label': 'Copy from first day' }), f2 = el('input', { type: 'date', 'aria-label': 'Copy from last day' });
    const show = (title, body) => out.replaceChildren(el('div', { class: 'notice' }, el('p', {}, el('b', {}, title)), body));
    const allocate = (preview) => guard(async () => {
      if (!preview && !confirm('Approve everything that fits, in priority order? Groups are emailed.')) return;
      const d = await api(`/rounds/${r.id}/allocate`, { method: 'POST', body: { preview } });
      show(preview ? `Preview: ${d.confirmedDates} dates would be confirmed, ${d.flaggedDates} lose to a higher priority, ${d.skipped} requests held back` : `Done: ${d.confirmedDates} dates confirmed`, lines(d.results));
      if (!preview) { toast('Allocated'); }
    });
    const rollover = (preview) => guard(async () => {
      if (!f1.value || !f2.value) throw new Error('Choose the first and last day of the season to copy');
      const d = await api(`/rounds/${r.id}/rollover`, { method: 'POST', body: { fromStart: f1.value, fromEnd: f2.value, preview } });
      show(preview ? `Preview: ${d.requests} request${d.requests === 1 ? '' : 's'} would be copied` : `Copied ${d.requests} request${d.requests === 1 ? '' : 's'}, waiting for review`,
        el('p', { class: 'muted small' }, `Each date moves by ${d.shiftedDays} days so the weekday stays the same.`));
    });
    wrap.append(el('article', { class: 'panel card stack' },
      el('div', { class: 'card-head' }, el('div', {}, el('h3', {}, r.name),
        el('p', { class: 'muted small' }, `Season ${r.seasonStart} to ${r.seasonEnd}. Requests ${dayLabel(r.opensAt)} to ${dayLabel(r.closesAt)}${r.maxHoursPerOrg ? `. Cap ${r.maxHoursPerOrg} hours per group` : ''}.`)),
        el('span', { class: 'badge ' + (r.status === 'open' ? 'confirmed' : 'cancelled') }, cap(r.status))),
      el('p', {}, `${r.requests} request${r.requests === 1 ? '' : 's'}, ${r.pending} waiting.`),
      el('div', { class: 'actions' },
        el('button', { class: 'btn alt small', onclick: () => { state.rq = { status: 'pending', round: r.id }; go('requests'); } }, 'See requests'),
        admin ? [el('button', { class: 'btn alt small', onclick: () => allocate(true) }, 'Preview allocation'),
          el('button', { class: 'btn small', onclick: () => allocate(false) }, 'Run allocation'),
          el('button', { class: 'btn alt small', onclick: () => guard(async () => { await api(`/rounds/${r.id}`, { method: 'PATCH', body: { status: r.status === 'open' ? 'closed' : 'open' } }); render(); }) }, r.status === 'open' ? 'Close window' : 'Reopen window')] : null),
      admin ? el('details', {}, el('summary', {}, 'Copy last season\'s schedule into this one'),
        el('p', { class: 'muted small' }, 'Pick the dates of the season to copy. Everything approved in that time is requested again on the same weekdays, for review.'),
        el('div', { class: 'grid2' }, field('From', f1), field('To', f2)),
        el('div', { class: 'actions' }, el('button', { class: 'btn alt small', onclick: () => rollover(true) }, 'Check first'), el('button', { class: 'btn small', onclick: () => rollover(false) }, 'Copy'))) : null,
      out));
  }
  if (!rounds.length) wrap.append(el('div', { class: 'panel empty-big' }, el('p', { class: 'muted' }, 'No seasons yet.')));
  return wrap;
}

/* ---------- Billing ---------- */
export async function billingView() {
  const staff = isStaff(), admin = isAdmin();
  const [{ invoices, payOnline }, rates] = await Promise.all([api('/invoices'), staff ? api('/fee-rates') : { rates: [] }]);
  const wrap = el('div', { class: 'stack' }, el('div', { class: 'head' }, el('h2', {}, staff ? 'Fees and invoices' : 'Your invoices'),
    staff ? el('button', { class: 'btn alt small', onclick: () => guard(() => download('/export/invoices.csv', 'invoices.csv')) }, 'Download CSV') : null));
  const open = invoices.filter((i) => i.status === 'open');
  if (open.length) wrap.append(el('div', { class: 'notice' }, el('p', {}, `${open.length} open invoice${open.length === 1 ? '' : 's'}, ${money(open.reduce((a, i) => a + i.amountCents, 0))} in total.`)));
  wrap.append(section('Invoices', invoices.length ? el('div', { class: 'stack' }, invoices.map((i) => {
    const host = el('div', {});
    const method = el('input', { type: 'text', placeholder: 'Check, cash, transfer', 'aria-label': 'How it was paid' }), ref = el('input', { type: 'text', placeholder: 'Reference', 'aria-label': 'Reference' });
    return el('article', { class: 'item' },
      el('div', { class: 'card-head' }, el('div', {}, el('b', {}, `${i.number}${i.kind === 'deposit' ? ' (deposit)' : ''}, ${i.organization}`), el('p', { class: 'muted small' }, `${money(i.amountCents)}, due ${i.dueOn}${i.paidAt ? `, paid ${dayLabel(i.paidAt)}${i.paidMethod ? ` by ${i.paidMethod}` : ''}` : ''}${i.refundedCents ? `, ${money(i.refundedCents)} refunded` : ''}`)),
        el('span', { class: 'badge ' + (i.status === 'paid' ? 'confirmed' : ['void', 'refunded'].includes(i.status) ? 'cancelled' : (i.dueOn < ymd(new Date()) ? 'conflict' : 'pending')) }, i.status === 'open' && i.dueOn < ymd(new Date()) ? 'Overdue' : cap(i.status))),
      el('ul', { class: 'plain small' }, (i.lines || []).map((l) => el('li', { class: 'row between' }, el('span', {}, l.description), el('span', {}, money(l.amountCents))))),
      !staff && i.status === 'open' && payOnline ? el('div', { class: 'actions' }, payButton(i)) : null,
      staff && i.status === 'paid' ? el('div', { class: 'actions' }, el('button', { class: 'btn alt small', onclick: () => { const on = host.dataset.k === 'r'; host.dataset.k = on ? '' : 'r'; host.replaceChildren(...(on ? [] : [refundBox(i)])); } }, 'Refund')) : null,
      staff && i.status === 'open' ? el('div', { class: 'actions' },
        payOnline ? payButton(i) : null,
        el('button', { class: 'btn small', onclick: () => host.replaceChildren(...(host.childElementCount ? [] : [el('div', { class: 'inline-form' }, method, ref, el('button', { class: 'btn small', onclick: () => guard(async () => {
          await api(`/invoices/${i.id}/pay`, { method: 'POST', body: { method: method.value, reference: ref.value } }); toast('Marked paid'); render(); }) }, 'Save'))])) }, 'Mark paid'),
        el('button', { class: 'btn danger small', onclick: () => guard(async () => { if (!confirm('Void this invoice?')) return; await api(`/invoices/${i.id}/void`, { method: 'POST' }); render(); }) }, 'Void')) : null, host);
  })) : el('p', { class: 'muted' }, staff ? 'No invoices yet. Open an approved request and choose Invoice.' : 'Nothing billed.')));
  if (staff) wrap.append(feeRates(rates.rates, admin));
  return wrap;
}

function feeRates(rates, admin) {
  const kinds = SPACE_KINDS.filter((k) => state.spaces.some((s) => !s.parent_id && s.kind === k.code));
  const target = el('select', { 'aria-label': 'Applies to' }, el('option', { value: '' }, 'Everything'),
    kinds.length > 1 ? el('optgroup', { label: 'Every one of a type' }, kinds.map((k) => el('option', { value: `k:${k.code}` }, `All ${k.plural.toLowerCase()}`))) : null,
    el('optgroup', { label: 'One site' }, (state.facilities || []).map((f) => el('option', { value: `f:${f.id}` }, `All of ${f.name}`))),
    el('optgroup', { label: 'One space' }, state.spaces.map((s) => el('option', { value: `s:${s.id}` }, s.name))));
  const kind = el('select', { 'aria-label': 'Group type' }, el('option', { value: '' }, 'Any group'), ['club', 'school', 'league', 'other'].map((k) => el('option', { value: k }, `${cap(k)} groups`)));
  const price = el('input', { type: 'number', min: '0', step: '0.01', placeholder: '50.00', 'aria-label': 'Dollars per hour' });
  const note = el('input', { type: 'text', placeholder: 'Note, for example school rate', 'aria-label': 'Note', maxlength: 200 });
  const label = (r) => `${r.space || (r.spaceKind ? `All ${kindOf(r.spaceKind).plural.toLowerCase()}` : null) || r.facility || 'Everything'}${r.orgKind ? `, ${r.orgKind} groups` : ''}: ${money(r.centsPerHour)} per hour${r.note ? ` (${r.note})` : ''}`;
  return section('Rates', el('p', { class: 'muted small' }, 'The most specific rate wins: one space beats a type (like all pavilions), which beats a site, which beats a general rate. Fees are by the hour.'),
    rates.length ? el('ul', { class: 'plain' }, rates.map((r) => el('li', { class: 'row between' }, el('span', {}, label(r)),
      admin ? el('button', { class: 'btn danger small', onclick: () => guard(async () => { await api(`/fee-rates/${r.id}`, { method: 'DELETE' }); render(); }) }, 'Remove') : null))) : el('p', { class: 'muted small' }, 'No rates yet.'),
    admin ? el('div', { class: 'stack' }, el('div', { class: 'grid2' }, field('Applies to', target), field('For', kind)), el('div', { class: 'grid2' }, field('Dollars per hour', price), field('Note', note)),
      el('button', { class: 'btn alt', onclick: () => guard(async () => {
        const b = { centsPerHour: Math.round(Number(price.value) * 100), note: note.value || undefined, orgKind: kind.value || undefined };
        if (target.value.startsWith('k:')) b.spaceKind = target.value.slice(2); else if (target.value.startsWith('f:')) b.facilityId = target.value.slice(2); else if (target.value.startsWith('s:')) b.spaceId = target.value.slice(2);
        if (!(Number(price.value) >= 0) || price.value === '') throw new Error('Enter a price per hour');
        await api('/fee-rates', { method: 'POST', body: b }); toast('Rate added'); render();
      }) }, 'Add rate')) : null);
}

// An approved request: preview the fee, then create the invoice.
export function invoiceBox(r) {
  const host = el('div', { class: 'stack note-box' });
  const days = el('input', { type: 'number', min: '0', max: '365', value: '30', 'aria-label': 'Days until due' });
  const draw = (p) => host.replaceChildren(
    el('ul', { class: 'plain' }, p.lines.map((l) => el('li', { class: 'row between' }, el('span', {}, l.description), el('span', {}, money(l.amountCents))))),
    el('p', {}, el('b', {}, `Total ${money(p.totalCents)}`)), p.unpriced ? el('p', { class: 'warn-text' }, `${p.unpriced} date${p.unpriced === 1 ? ' has' : 's have'} no rate and ${p.unpriced === 1 ? 'is' : 'are'} not charged.`) : null,
    el('div', { class: 'row' }, el('label', {}, 'Due in (days)'), days, el('button', { class: 'btn small', onclick: () => guard(async () => {
      const inv = await api(`/requests/${r.id}/invoice`, { method: 'POST', body: { dueDays: Number(days.value) } }); toast(`Invoice ${inv.number} created`); state.view = 'billing'; render(); }) }, 'Create invoice')));
  guard(async () => draw(await api(`/requests/${r.id}/invoice`, { method: 'POST', body: { preview: true } })));
  return host;
}

/* ---------- Applications from new groups ---------- */
export async function applicationsPanel() {
  const { applications } = await api('/applications');
  const link = `${location.origin}/apply/${state.tenant.slug}`;
  const copy = () => navigator.clipboard?.writeText(link).then(() => toast('Copied'), () => toast('Select and copy the address', true));
  return section('New group applications',
    el('p', { class: 'muted small' }, 'Share this page so a new club or school can ask to join. You review each one here.'),
    el('div', { class: 'row' }, el('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Application page address', onfocus: (e) => e.target.select() }), el('button', { class: 'btn alt small', onclick: copy }, 'Copy')),
    applications.length ? el('ul', { class: 'plain' }, applications.map((a) => {
      const tier = el('select', { 'aria-label': 'Priority' }, [5, 4, 3, 2, 1].map((n) => el('option', { value: n, selected: n === 3 }, `Priority ${n}`)));
      return el('li', { class: 'stack' }, el('div', {}, el('b', {}, a.name), ` (${a.kind}) ${a.contactName}, ${a.contactEmail}`, a.notes ? el('p', { class: 'muted small' }, a.notes) : null),
        isAdmin() ? el('div', { class: 'row' }, tier,
          el('button', { class: 'btn small', onclick: () => guard(async () => { await api(`/applications/${a.id}/decision`, { method: 'POST', body: { decision: 'approve', tier: Number(tier.value) } }); toast('Group added and invited'); await (await import('./app.js')).reload(); }) }, 'Approve'),
          el('button', { class: 'btn danger small', onclick: () => guard(async () => { const note = prompt('Reason to include in the email (optional)') ?? null; if (note === null) return; await api(`/applications/${a.id}/decision`, { method: 'POST', body: { decision: 'decline', note } }); render(); }) }, 'Decline')) : el('p', { class: 'muted small' }, 'An admin decides.'));
    })) : el('p', { class: 'muted small' }, 'Nothing waiting.'));
}

/* ---------- Activity log ---------- */
export async function activityPanel() {
  const { entries } = await api('/audit?limit=40');
  return section('Recent activity', entries.length ? el('ul', { class: 'plain small' }, entries.map((e) => el('li', {}, `${dayLabel(e.at)} ${hhmm(e.at)}  ${e.actor || 'System'}: ${e.action.replace(/[._]/g, ' ')}`))) : el('p', { class: 'muted' }, 'Nothing yet.'));
}
