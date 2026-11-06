const slug = location.pathname.split('/').filter(Boolean)[1] || '';
const box = document.getElementById('box');
const el = (t, a = {}, ...k) => { const n = document.createElement(t); for (const [x, v] of Object.entries(a)) { if (x.startsWith('on')) n.addEventListener(x.slice(2), v); else if (v != null) n.setAttribute(x, v); } n.append(...k.flat().filter((y) => y != null)); return n; };
const r = await fetch(`/apply-api/${encodeURIComponent(slug)}`);
if (!r.ok) { document.getElementById('intro').textContent = 'This page was not found. Check the link you were given.'; }
else {
  const { name } = await r.json();
  document.title = `Apply to ${name}`;
  document.getElementById('intro').textContent = `${name} approves every request for its fields, courts and rooms. Tell us about your group and we will email you when it is approved.`;
  const f = {}; const msg = el('p', { role: 'status' });
  const inp = (k, label, type = 'text', req = true) => { f[k] = el(type === 'textarea' ? 'textarea' : 'input', { id: k, type: type === 'textarea' ? null : type, required: req ? '' : null, maxlength: type === 'textarea' ? 1000 : 120 }); return el('div', { class: 'field' }, el('label', { for: k }, label), f[k]); };
  f.kind = el('select', { id: 'kind' }, ['club', 'school', 'league', 'other'].map((k) => el('option', { value: k }, k[0].toUpperCase() + k.slice(1))));
  const form = el('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const res = await fetch(`/apply-api/${encodeURIComponent(slug)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name.value, kind: f.kind.value, contactName: f.contactName.value, email: f.email.value, notes: f.notes.value }) });
    const d = await res.json().catch(() => ({}));
    msg.textContent = res.ok ? d.message : (d.error || 'Something went wrong');
    if (res.ok) form.replaceChildren(msg);
  } }, inp('name', 'Group name'), el('div', { class: 'field' }, el('label', { for: 'kind' }, 'Kind'), f.kind), inp('contactName', 'Your name'), inp('email', 'Your email', 'email'),
    inp('notes', 'Anything we should know (ages, teams, what you book today)', 'textarea', false), el('button', { class: 'btn', type: 'submit' }, 'Send application'), msg);
  box.append(form);
}
