// Shared building blocks: brand mark, menus, sheets, empty states, loading skeletons, theme, group colors.
import { el } from './app.js';
import { icon } from './icons.js';
export { icon };

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids); return n; };

// The CanWeUseIt mark: a pitch with halfway line and centre circle, and a check.
export function brandMark(size = 28) {
  return svgEl('svg', { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': 'true' },
    svgEl('rect', { width: 64, height: 64, rx: 14, fill: '#2a6a49' }),
    svgEl('rect', { x: 11, y: 15, width: 42, height: 34, rx: 3, fill: 'none', stroke: '#fff', 'stroke-width': 3 }),
    svgEl('line', { x1: 32, y1: 15, x2: 32, y2: 49, stroke: '#fff', 'stroke-width': 3 }),
    svgEl('circle', { cx: 32, cy: 32, r: 6, fill: 'none', stroke: '#fff', 'stroke-width': 3 }),
    svgEl('path', { d: 'M38 40l6 6 12-14', fill: 'none', stroke: '#f2c230', 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

// A small field drawing for empty states.
export function fieldArt(size = 96) {
  return svgEl('svg', { width: size, height: size * 0.7, viewBox: '0 0 120 84', class: 'art', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linejoin': 'round' },
    svgEl('rect', { x: 6, y: 6, width: 108, height: 72, rx: 6 }), svgEl('line', { x1: 60, y1: 6, x2: 60, y2: 78 }), svgEl('circle', { cx: 60, cy: 42, r: 12 }),
    svgEl('rect', { x: 6, y: 26, width: 14, height: 32 }), svgEl('rect', { x: 100, y: 26, width: 14, height: 32 }));
}

export function emptyState(title, text, action) {
  return el('div', { class: 'panel empty-state' }, fieldArt(), el('h3', {}, title), text ? el('p', {}, text) : null, action || null);
}

export function skeleton() {
  return el('div', { 'aria-busy': 'true', 'aria-label': 'Loading' }, el('div', { class: 'sk sk-title' }), el('div', { class: 'sk sk-line' }), el('div', { class: 'sk sk-line', style: 'width:70%' }),
    el('div', { class: 'sk sk-card' }), el('div', { class: 'sk sk-card' }));
}

// A button that opens a small menu. items: [{ label, icon, onSelect, href, danger }] or 'sep'. Closes on outside click and Escape.
let openMenu = null;
const closeOpen = () => { if (openMenu) { openMenu(); openMenu = null; } };
document.addEventListener('click', (e) => { if (openMenu && !e.target.closest('.menu-wrap')) closeOpen(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpen(); });
export function menu(label, items, { trigger, up } = {}) {
  const live = items.filter(Boolean);
  if (!live.length) return null;
  const btn = trigger || el('button', { type: 'button', class: 'icon-btn' }, icon('ellipsis', { label }));
  btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
  if (!btn.getAttribute('aria-label') && !trigger) btn.setAttribute('aria-label', label);
  const wrap = el('div', { class: 'menu-wrap' }, btn);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const was = btn.getAttribute('aria-expanded') === 'true';
    closeOpen();
    if (was) return;
    const pop = el('div', { class: 'menu-pop' + (up ? ' up' : ''), role: 'menu', 'aria-label': label }, live.map((it) => {
      if (it === 'sep') return el('div', { class: 'menu-sep', role: 'separator' });
      if (it.head) return el('div', { class: 'menu-head' }, it.head);
      const kids = [it.icon ? icon(it.icon, { size: 18 }) : null, it.label];
      const go = () => { closeOpen(); it.onSelect && it.onSelect(); };
      return it.href ? el('a', { class: 'menu-item', role: 'menuitem', href: it.href, target: it.target || null, rel: it.target ? 'noopener' : null, onclick: () => closeOpen() }, ...kids)
        : el('button', { type: 'button', class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', onclick: go }, ...kids);
    }));
    pop.addEventListener('keydown', (ev) => {
      const list = [...pop.querySelectorAll('.menu-item')]; const i = list.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length].focus(); }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    });
    wrap.append(pop); btn.setAttribute('aria-expanded', 'true');
    pop.querySelector('.menu-item')?.focus();
    openMenu = () => { pop.remove(); btn.setAttribute('aria-expanded', 'false'); btn.focus(); };
  });
  return wrap;
}

// A sheet: a bottom sheet on phones, a centred dialog on desktop. Returns { close }.
export function sheet(title, body) {
  const dlg = el('dialog', { class: 'sheet', 'aria-label': title });
  const close = () => { dlg.close(); };
  dlg.append(el('div', { class: 'sheet-head' }, el('h3', {}, title), el('button', { type: 'button', class: 'icon-btn', onclick: close }, icon('x', { label: 'Close' }))),
    el('div', { class: 'sheet-body' }, typeof body === 'function' ? body(close) : body));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg); dlg.showModal();
  return { close };
}

// Group colors: eight strong hues, picked by the group's id so a group keeps its color everywhere.
const HUES = ['#2f6fb0', '#c2621a', '#7a4fb5', '#2c8a57', '#b8394a', '#8a7a12', '#1f8a8a', '#a14d8f'];
export const groupColor = (id, index = -1) => HUES[index >= 0 ? index % HUES.length : [...(id || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
// "Owen J Roberts Lacrosse" -> "OJR"
export const shortOrg = (name) => (name || '').split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w) && !/^(of|the|and|&)$/i.test(w)).map((w) => w[0].toUpperCase()).join('').slice(0, 3) || (name || '').slice(0, 3);
// "Friendship Lower Field" at "Friendship" -> "Lower Field"
export const shortSpace = (name, facility) => (facility && name.toLowerCase().startsWith(facility.toLowerCase() + ' ') ? name.slice(facility.length + 1) : name);

// Theme: system, light or dark, remembered per browser.
export function applyTheme(mode) {
  const dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
export const savedTheme = () => { try { return localStorage.getItem('cwui-theme') || 'system'; } catch { return 'system'; } };
export const saveTheme = (m) => { try { localStorage.setItem('cwui-theme', m); } catch { /* private window */ } applyTheme(m); };
applyTheme(savedTheme());
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(savedTheme()));

export const isPhone = () => matchMedia('(max-width: 900px)').matches;

// The sign-in picture: a week of field bookings, drawn (no screenshot, works in dark mode too).
export function productArt() {
  const t = (x, y, s, o = {}) => svgEl('text', { x, y, 'font-family': 'Instrument Sans, system-ui, sans-serif', 'font-size': 13, fill: '#55655a', ...o }, s);
  const rows = [['Mon', [[70, 90, '#2f6fb0'], [180, 70, '#c2621a']]], ['Tue', [[110, 120, '#2c8a57']]], ['Wed', [[60, 80, '#7a4fb5'], [160, 100, '#2f6fb0', true]]],
    ['Thu', [[90, 150, '#c2621a']]], ['Fri', [[70, 60, '#2c8a57'], [150, 120, '#b8394a']]]];
  const g = svgEl('svg', { viewBox: '0 0 460 330', role: 'img', 'aria-label': 'A week of field bookings, each club in its own color' },
    svgEl('rect', { x: 0, y: 0, width: 460, height: 330, rx: 18, fill: '#ffffff' }),
    t(24, 40, 'Friendship Field, this week', { 'font-size': 16, 'font-weight': 700, fill: '#17261d' }),
    t(24, 62, '4 clubs, 9 bookings, no clashes'),
    svgEl('rect', { x: 340, y: 24, width: 96, height: 28, rx: 14, fill: '#dff0e4' }), t(356, 43, 'All approved', { fill: '#1f6b3e', 'font-weight': 700, 'font-size': 12 }));
  rows.forEach(([d, bars], i) => {
    const y = 92 + i * 46;
    g.append(t(24, y + 20, d, { 'font-weight': 600, fill: '#17261d' }), svgEl('rect', { x: 70, y, width: 366, height: 30, rx: 6, fill: '#f0f3ee' }));
    for (const [x, w, c, pend] of bars) g.append(svgEl('rect', { x: x + 10, y: y + 3, width: w, height: 24, rx: 5, fill: c, 'fill-opacity': pend ? 0.25 : 0.85, stroke: c, 'stroke-dasharray': pend ? '4 3' : '0' }));
  });
  return g;
}
