const code = location.pathname.split('/').filter(Boolean)[1] || '';
const pm = document.getElementById('pm');
const el = (t, a = {}, ...k) => { const n = document.createElement(t); for (const [x, v] of Object.entries(a)) { if (v != null) n.setAttribute(x, v); } n.append(...k.flat().filter((y) => y != null)); return n; };
const r = await fetch(`/permit-api/${encodeURIComponent(code)}`);
if (!r.ok) pm.replaceChildren(el('h1', {}, 'Permit not found'), el('p', { class: 'muted' }, 'This code does not match a permit. Ask the group for a current one.'));
else {
  const p = await r.json();
  const f = (d, o) => new Intl.DateTimeFormat('en-US', { timeZone: p.timezone, ...o }).format(new Date(d));
  document.title = `Permit ${p.number}`;
  pm.replaceChildren(
    el('p', { class: 'muted' }, p.tenant), el('h1', {}, `Field permit ${p.number}`),
    el('p', {}, el('span', { class: 'stamp ' + (p.valid ? 'ok' : 'no') }, p.valid ? 'VALID' : 'NOT VALID')),
    el('p', {}, el('b', {}, p.organization), ` · ${p.title}`),
    el('table', {}, el('thead', {}, el('tr', {}, ['Date', 'Time', 'Field', 'Team'].map((h) => el('th', {}, h)))),
      el('tbody', {}, p.dates.map((d) => el('tr', {}, el('td', {}, f(d.startsAt, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })),
        el('td', {}, `${f(d.startsAt, { hour: 'numeric', minute: '2-digit' })} to ${f(d.endsAt, { hour: 'numeric', minute: '2-digit' })}`), el('td', {}, `${d.space}, ${d.facility}`), el('td', {}, d.label || '')))) ),
    p.dates.length ? null : el('p', { class: 'muted' }, 'No confirmed dates.'),
    el('p', { class: 'muted small' }, `Issued ${f(p.issuedAt, { month: 'long', day: 'numeric', year: 'numeric' })}. Keep this page on hand while the field is in use. Permits cannot be transferred.`),
    el('button', { class: 'btn alt noprint', onclick: () => window.print() }, 'Print'));
}
