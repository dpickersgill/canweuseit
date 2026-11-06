const $ = (id) => document.getElementById(id);
const zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'Europe/London'];
const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
for (const z of zones.includes(here) ? zones : [here, ...zones]) $('tz').append(new Option(z.replace('_', ' '), z, false, z === here));
let touched = false;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
let timer;
const check = () => { clearTimeout(timer); timer = setTimeout(async () => {
  const s = $('slug').value; if (s.length < 3) { $('slug-help').textContent = 'At least 3 characters.'; return; }
  const r = await fetch(`/signup-api/slug/${encodeURIComponent(s)}`).then((x) => x.json()).catch(() => ({}));
  $('slug-help').textContent = r.available ? `Your groups will apply at ${location.origin}/apply/${s}` : 'That short name is taken or not allowed.';
}, 300); };
$('name').addEventListener('input', () => { if (!touched) { $('slug').value = slugify($('name').value); check(); } });
$('slug').addEventListener('input', () => { touched = true; $('slug').value = slugify($('slug').value); check(); });
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true; $('msg').textContent = '';
  const body = { name: $('name').value, slug: $('slug').value, timezone: $('tz').value, fullName: $('full').value, email: $('email').value, agree: $('agree').checked };
  const res = await fetch('/signup-api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  btn.disabled = false;
  if (!res.ok) { $('msg').className = 'notice'; $('msg').textContent = out.error || 'Something went wrong'; return; }
  $('f').replaceChildren(Object.assign(document.createElement('div'), { className: 'okbox', textContent: `${out.message} It can take a minute to arrive.` }));
});

// the price list, from the server so it always matches
fetch('/plans').then((r) => r.json()).then(({ plans }) => {
  const box = document.getElementById('plans');
  const money = (c) => `$${(c / 100).toLocaleString('en-US')}`;
  for (const p of plans) {
    const card = document.createElement('div'); card.className = 'plan-card';
    const h = document.createElement('b'); h.textContent = p.name;
    const pr = document.createElement('p'); pr.className = 'price'; pr.textContent = p.priceCents ? `${money(p.priceCents)} a month` : 'Free';
    const yr = document.createElement('p'); yr.className = 'muted small'; yr.textContent = p.priceCents ? `or ${money(p.annualCents)} a year` : 'No card needed';
    const bl = document.createElement('p'); bl.className = 'small'; bl.textContent = p.blurb || '';
    card.append(h, pr, yr, bl); box.append(card);
  }
}).catch(() => {});
