// Kleine SVG-Diagrammbibliothek: ein Plot-Typ für Balken, Linien, Punkte und Referenzen,
// dazu Heatmap. Farben kommen aus CSS-Tokens, Text immer in Texttokens.
const NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

export const fmt = {
  n: (v, d = 0) => Number.isFinite(v) ? v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–',
  pct: (v, d = 1) => Number.isFinite(v) ? (v * 100).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' %' : '–',
};

export function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const span = hi - lo;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || 10 * mag;
  const t = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) t.push(+v.toFixed(10));
  return { ticks: t, step, hi: Math.ceil(hi / step - 1e-9) * step };
}

// ---------- Tooltip
let tip;
function tooltip() {
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'status'); document.body.appendChild(tip); }
  return tip;
}
export function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html; t.style.opacity = 1;
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 10;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 16;
  t.style.transform = `translate(${Math.round(left + window.scrollX)}px, ${Math.round(top + window.scrollY)}px)`;
}
export function hideTip() { if (tip) tip.style.opacity = 0; }

// ---------- Responsives Zeichnen
const observers = new WeakMap();
export function mount(container, draw) {
  container._draw = draw;
  if (!observers.has(container)) {
    let w0 = 0;
    const ro = new ResizeObserver(() => {
      const w = Math.round(container.clientWidth);
      if (w !== w0) { w0 = w; container._draw && container._draw(w); }
    });
    ro.observe(container);
    observers.set(container, ro);
  }
  const w = Math.round(container.clientWidth);
  if (w > 0) draw(w);
}

// ---------- Plot
// spec: { height, x: {domain, ticks, fmt, label, band}, y: {domain, fmt, label}, layers: [...], tip: fn(i) }
// layer: { type: 'bars'|'line'|'dots'|'area'|'hline'|'vline', data, color, name, ... }
export function plot(container, spec) {
  mount(container, width => {
    container.innerHTML = '';
    const H = spec.height || 260;
    const m = { t: 18, r: 14, b: spec.x.label ? 42 : 28, l: 48, ...(spec.margin || {}) };
    const W = Math.max(width, 240);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', role: 'img', 'aria-label': spec.aria || '' }, container);
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const [x0, x1] = spec.x.domain;
    const yt = niceTicks(spec.y.domain[0], spec.y.domain[1], spec.y.n || 4);
    const y0 = spec.y.domain[0], y1 = spec.y.fixed ? spec.y.domain[1] : yt.hi;
    const band = spec.x.band;  // Anzahl Kategorien bei Balken
    const sx = band ? (i => m.l + (i + 0.5) * iw / band) : (v => m.l + (v - x0) / (x1 - x0) * iw);
    const sy = v => m.t + ih - (v - y0) / (y1 - y0) * ih;
    const g = el('g', {}, svg);

    // Gitter und Achsen (zurückhaltend)
    for (const v of yt.ticks.filter(v => v >= y0 && v <= y1)) {
      el('line', { x1: m.l, x2: m.l + iw, y1: sy(v), y2: sy(v), class: v === y0 ? 'axis' : 'grid' }, g);
      const t = el('text', { x: m.l - 8, y: sy(v) + 4, class: 'tick', 'text-anchor': 'end' }, g);
      t.textContent = (spec.y.fmt || fmt.n)(v);
    }
    const xt = spec.x.ticks || niceTicks(x0, x1, Math.max(3, Math.floor(iw / 80))).ticks;
    for (const v of xt) {
      const xx = band ? sx(v.i ?? v) : sx(v);
      const t = el('text', { x: band && v.at === 'start' ? xx - iw / band / 2 : xx, y: m.t + ih + 18, class: 'tick', 'text-anchor': band && v.at === 'start' ? 'start' : 'middle' }, g);
      t.textContent = v.label ?? (spec.x.fmt || fmt.n)(v);
      if (v.rule) el('line', { x1: xx - iw / band / 2, x2: xx - iw / band / 2, y1: m.t, y2: m.t + ih, class: 'grid grid--v' }, g);
    }
    if (spec.x.label) { const t = el('text', { x: m.l + iw, y: H - 6, class: 'axis-label', 'text-anchor': 'end' }, g); t.textContent = spec.x.label; }
    if (spec.y.label) { const t = el('text', { x: m.l - 40, y: m.t - 6, class: 'axis-label' }, g); t.textContent = spec.y.label; }

    const clamp = v => Math.max(y0, Math.min(y1, v));
    for (const L of spec.layers) {
      if (L.type === 'bars') {
        const bw = Math.max(1, iw / band - (L.gap ?? 2));
        L.data.forEach((v, i) => {
          if (!(v > 0)) return;
          const h = sy(y0) - sy(clamp(v));
          const x = sx(i) - bw / 2, y = sy(clamp(v));
          const r = Math.min(L.radius ?? 2, bw / 2, h);
          el('path', { d: roundTop(x, y, bw, h, r), fill: L.colorAt ? L.colorAt(i) : L.color, class: 'mark', 'data-i': i }, g);
        });
      } else if (L.type === 'area' || L.type === 'line') {
        const pts = L.data.filter(p => Number.isFinite(p[1]));
        if (pts.length < 2) continue;
        const X = p => band ? sx(p[0]) : sx(p[0]);
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)},${sy(clamp(p[1])).toFixed(1)}`).join('');
        if (L.type === 'area') el('path', { d: `${d}L${X(pts[pts.length - 1])},${sy(y0)}L${X(pts[0])},${sy(y0)}Z`, fill: L.color, opacity: L.opacity ?? 0.14 }, g);
        else el('path', { d, fill: 'none', stroke: L.color, 'stroke-width': L.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': L.dash || null }, g);
      } else if (L.type === 'dots') {
        for (const p of L.data) {
          if (!Number.isFinite(p[1])) continue;
          el('circle', { cx: sx(p[0]), cy: sy(clamp(p[1])), r: L.r || 4.5, fill: L.color, stroke: 'var(--surface)', 'stroke-width': 2 }, g);
        }
      } else if (L.type === 'hline') {
        if (L.y < y0 || L.y > y1) continue;
        el('line', { x1: m.l, x2: m.l + iw, y1: sy(L.y), y2: sy(L.y), class: 'ref' }, g);
        if (L.label) { const st = L.anchor === 'start'; const t = el('text', { x: st ? m.l + 6 : m.l + iw - 2, y: sy(L.y) + (L.below ? 15 : -6), class: 'ref-label', 'text-anchor': st ? 'start' : 'end' }, g); t.textContent = L.label; }
      } else if (L.type === 'vline') {
        const xx = sx(L.x);
        el('line', { x1: xx, x2: xx, y1: m.t, y2: m.t + ih, class: 'ref' }, g);
        if (L.label) { const t = el('text', { x: xx + (L.anchor === 'end' ? -6 : 6), y: (L.bottom ? m.t + ih - 8 : m.t + 10) + (L.dy || 0), class: 'ref-label', 'text-anchor': L.anchor || 'start' }, g); t.textContent = L.label; }
      } else if (L.type === 'label') {
        const t = el('text', { x: sx(L.x) + (L.dx || 0), y: sy(L.y) + (L.dy || 0), class: 'direct-label', 'text-anchor': L.anchor || 'start' }, g);
        t.textContent = L.text;
      }
    }

    // Hover-Ebene
    if (spec.tip) {
      const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', opacity: 0 }, svg);
      const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
      const n = band || spec.tip.n;
      const pick = ev => {
        const r = svg.getBoundingClientRect();
        const px = (ev.clientX - r.left) * W / r.width;
        if (band) return Math.max(0, Math.min(band - 1, Math.floor((px - m.l) / iw * band)));
        return spec.tip.nearest((px - m.l) / iw * (x1 - x0) + x0);
      };
      const move = ev => {
        const i = pick(ev);
        if (i == null || i < 0) return;
        const xv = band ? sx(i) : sx(spec.tip.xOf(i));
        cross.setAttribute('x1', xv); cross.setAttribute('x2', xv); cross.setAttribute('opacity', 1);
        svg.querySelectorAll('.mark').forEach(b => b.classList.toggle('dim', b.dataset.i != String(i)));
        showTip(spec.tip.html(i), ev.clientX, ev.clientY);
      };
      const leave = () => { cross.setAttribute('opacity', 0); svg.querySelectorAll('.mark.dim').forEach(b => b.classList.remove('dim')); hideTip(); };
      hit.addEventListener('pointermove', move);
      hit.addEventListener('pointerdown', move);
      hit.addEventListener('pointerleave', leave);
      void n;
    }
  });
}

function roundTop(x, y, w, h, r) {
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// ---------- Heatmap 7 × 24
export function heatmap(container, { values, rows, cols, color, fmtV, tipHtml, aria }) {
  mount(container, width => {
    container.innerHTML = '';
    const m = { t: 6, r: 4, b: 24, l: 30 };
    const W = Math.max(width, 280);
    const cw = (W - m.l - m.r) / cols.length;
    const ch = Math.min(26, Math.max(16, cw * 0.9));
    const H = m.t + m.b + ch * rows.length;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', role: 'img', 'aria-label': aria || '' }, container);
    rows.forEach((rl, r) => {
      const t = el('text', { x: m.l - 8, y: m.t + r * ch + ch / 2 + 4, class: 'tick', 'text-anchor': 'end' }, svg); t.textContent = rl;
      cols.forEach((_, c) => {
        const v = values[r][c];
        const cell = el('rect', { x: m.l + c * cw + 1, y: m.t + r * ch + 1, width: Math.max(cw - 2, 1), height: ch - 2, rx: 2, fill: color(v), class: 'cell' }, svg);
        cell.addEventListener('pointermove', ev => showTip(tipHtml(r, c), ev.clientX, ev.clientY));
        cell.addEventListener('pointerleave', hideTip);
      });
    });
    cols.forEach((cl, c) => {
      if (!cl) return;
      const t = el('text', { x: m.l + c * cw + cw / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, svg); t.textContent = cl;
    });
    void fmtV;
  });
}

// Sequenzielle Rampe über mehrere Hex-Stufen (in linearem RGB gemischt)
export function rampN(stops) {
  const parts = stops.slice(1).map((s, i) => ramp(stops[i], s, 1));
  return t => { t = Math.max(0, Math.min(1, t)); const k = Math.min(parts.length - 1, Math.floor(t * parts.length)); return parts[k](t * parts.length - k); };
}
export function ramp(a, b, gammaT = 0.85) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const A = p(a), B = p(b);
  const g = c => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'); };
  return t => { t = Math.max(0, Math.min(1, t)); return '#' + A.map((x, i) => g(x + (B[i] - x) * Math.pow(t, gammaT))).join(''); };
}
