// Small SVG charts: one hue, thin marks, recessive axes, hover tooltips.
import { h, mount, tooltipFollow } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const k of kids) el.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return el;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
function fmtTick(v) { return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v)); }

/** Vertical bars with an optional overlaid line series (e.g. a trailing average). */
export function barChart(container, { labels, values, line = null, lineName = '', barName = 'Spent', format = (v) => v }) {
  const W = 600, H = 220, L = 40, R = 10, T = 12, B = 28;
  const max = niceMax(Math.max(...values, ...(line ? line.filter((v) => v != null) : []), 0) * 1.05);
  const n = labels.length; const iw = (W - L - R) / Math.max(n, 1); const bw = Math.min(iw * 0.6, 48);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const grid = s('g', { class: 'grid' }); const axis = s('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i; grid.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    axis.append(s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmtTick(v)));
  }
  svg.append(grid, axis);
  const bars = s('g', {});
  labels.forEach((lab, i) => {
    const x = L + iw * i + (iw - bw) / 2; const v = values[i] || 0;
    const hgt = Math.max(0, y(0) - y(v));
    bars.append(s('rect', { class: 'bar', x, y: y(v), width: bw, height: hgt, rx: 3, 'data-i': i }));
    if (n <= 14 || i % Math.ceil(n / 14) === 0) axis.append(s('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, lab));
  });
  svg.append(bars);
  if (line) {
    const pts = line.map((v, i) => v == null ? null : [L + iw * i + iw / 2, y(v)]).filter(Boolean);
    if (pts.length > 1) svg.append(s('path', { class: 'line2', d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ') }));
    pts.forEach((p) => svg.append(s('circle', { class: 'dot2', cx: p[0], cy: p[1], r: 3.5 })));
  }
  const wrap = h('div', { class: 'chart' }, svg);
  tooltipFollow(wrap, (e) => {
    const rect = svg.getBoundingClientRect(); const px = (e.clientX - rect.left) / rect.width * W;
    const i = Math.floor((px - L) / iw); if (i < 0 || i >= n) return '';
    return `${labels[i]}: ${format(values[i] || 0)}${line && line[i] != null ? ` · ${lineName} ${format(line[i])}` : ''}`;
  });
  return h('div', {}, wrap, line ? h('div', { class: 'legend' }, h('span', {}, h('i'), barName), h('span', {}, h('i', { class: 'two' }), lineName)) : null);
}

/** Line chart over ordered points; up to two series. */
export function lineChart(container, { series, format = (v) => v, xLabel = (x) => x }) {
  const W = 600, H = 220, L = 44, R = 12, T = 12, B = 28;
  const all = series.flatMap((sr) => sr.points);
  if (!all.length) return h('div', { class: 'empty' }, 'No data for this range yet.');
  const xs = [...new Set(all.map((p) => p.x))].sort();
  const max = niceMax(Math.max(...all.map((p) => p.y), 0) * 1.08);
  const xi = (x) => xs.length === 1 ? (W - L - R) / 2 + L : L + (W - L - R) * (xs.indexOf(x) / (xs.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const grid = s('g', { class: 'grid' }); const axis = s('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; grid.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v) })); axis.append(s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmtTick(v))); }
  const step = Math.ceil(xs.length / 8);
  xs.forEach((x, i) => { if (i % step === 0 || i === xs.length - 1) axis.append(s('text', { x: xi(x), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle' }, xLabel(x))); });
  svg.append(grid, axis);
  series.forEach((sr, k) => {
    const pts = sr.points.slice().sort((a, b) => (a.x < b.x ? -1 : 1));
    svg.append(s('path', { class: k ? 'line2' : 'line', d: pts.map((p, i) => `${i ? 'L' : 'M'}${xi(p.x)},${y(p.y)}`).join(' ') }));
    pts.forEach((p) => svg.append(s('circle', { class: k ? 'dot2' : 'dot', cx: xi(p.x), cy: y(p.y), r: 3.5 })));
  });
  const wrap = h('div', { class: 'chart' }, svg);
  tooltipFollow(wrap, (e) => {
    const rect = svg.getBoundingClientRect(); const px = (e.clientX - rect.left) / rect.width * W;
    let best = null, bd = 1e9; for (const x of xs) { const d = Math.abs(xi(x) - px); if (d < bd) { bd = d; best = x; } }
    if (best == null || bd > 40) return '';
    return `${xLabel(best)}: ` + series.map((sr) => { const p = sr.points.find((q) => q.x === best); return p ? `${sr.name ? sr.name + ' ' : ''}${format(p.y)}` : null; }).filter(Boolean).join(' · ');
  });
  return h('div', {}, wrap, series.length > 1 ? h('div', { class: 'legend' }, series.map((sr, k) => h('span', {}, h('i', { class: k ? 'two' : '' }), sr.name))) : null);
}

/** Horizontal bars, labels on the left, values on the right. */
export function hBars(rows, { format = (v) => v } = {}) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return h('div', {}, rows.map((r) => h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(84px, 38%) 1fr auto', gap: '10px', alignItems: 'center', padding: '5px 0', fontSize: '.9rem' } },
    h('span', { style: { overflowWrap: 'break-word', lineHeight: 1.25 }, title: r.label }, r.label),
    h('div', { style: { background: 'var(--paper)', height: '10px', borderRadius: '3px' } }, h('div', { style: { width: `${(r.value / max) * 100}%`, height: '100%', background: 'var(--chart-1)', borderRadius: '3px', minWidth: r.value > 0 ? '3px' : 0 } })),
    h('span', { class: 'amt', style: { whiteSpace: 'nowrap' } }, format(r.value)))));
}
