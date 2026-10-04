// Seite 2: Bedarf an Schnellladepunkten in Deutschland.
// Energie je Ladepunkt kommt aus der Parkrechnung von Seite 1 (gleiche URL-Parameter).
import { plot, fmt } from './charts.js';
import { readPark, parkYear, PARK_KEYS } from './park.js';

const $ = s => document.querySelector(s);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// Ausgangswerte mit Quelle; alles andere sind einstellbare Annahmen
const BASE = {
  pkw: 49486487,            // KBA, Pkw-Bestand am 1.1.2026 (PM 09/2026)
  bev: 2034260,             // KBA, BEV-Bestand am 1.1.2026
  kmKba: 10616,             // KBA, Verkehr in Kilometern 2025, Ø Pkw (laut Pressemeldung)
};

const FIELDS = {
  bdelta: { label: 'Veränderung des Pkw-Bestands', min: -0.5, max: 0.1, step: 0.01, def: 0, show: v => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt.pct(Math.abs(v), 0)}` },
  ea:     { label: 'Anteil E-Pkw am Bestand', min: 0.05, max: 1, step: 0.01, def: 1, show: v => fmt.pct(v, 0) },
  km:     { label: 'Ø Fahrleistung je Pkw', min: 6000, max: 20000, step: 100, def: 10600, show: v => `${fmt.n(v)}<small>km/Jahr</small>` },
  vb:     { label: 'Verbrauch inkl. Ladeverluste', min: 15, max: 25, step: 0.5, def: 20, show: v => `${fmt.n(v, 1)}<small>kWh/100 km</small>` },
  sl:     { label: 'Anteil Schnellladen am Ladestrom', min: 0, max: 0.6, step: 0.01, def: 0.2, show: v => fmt.pct(v, 0) },
  opt:    { label: 'Nähe zum Optimum', min: 0.2, max: 1, step: 0.05, def: 0.7, show: v => fmt.pct(v, 0) },
};
const HINTS = {
  bdelta: `Ausgang: ${fmt.n(BASE.pkw / 1e6, 2)} Mio. Pkw (KBA, 1.1.2026).`,
  ea: `Heute: ${fmt.n(BASE.bev / 1e6, 2)} Mio. reine E-Pkw, ${fmt.pct(BASE.bev / BASE.pkw, 1)} des Bestands (KBA, 1.1.2026).`,
  km: `KBA: Ø ${fmt.n(BASE.kmKba)} km je Pkw im Jahr 2025.`,
  vb: 'Strom ab Ladepunkt je 100 km, also inklusive Lade- und Wandlungsverlusten.',
  sl: 'Von allem Strom, den E-Pkw laden (zu Hause, Arbeit, öffentlich), kommt dieser Anteil aus DC-Schnellladen.',
  opt: '100 % = jeder Ladepunkt läuft an der Churn-Grenze aus Seite 1. 50 % = doppelt so viele Ladepunkte. Etwas Überkapazität hält Wartezeiten und Preise niedrig.',
};
const KEYS = Object.keys(FIELDS);
const S = {};
let D, park, P, L;
S.ab = '150';

function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const [k, f] of Object.entries(FIELDS)) {
    const v = p.has(k) ? +p.get(k) : f.def;
    S[k] = Number.isFinite(v) ? Math.max(f.min, Math.min(f.max, v)) : f.def;
  }
  if (['50', '150', '300'].includes(p.get('ab'))) S.ab = p.get('ab');
}
function writeUrl() {
  const p = new URLSearchParams(location.search);
  for (const k of KEYS) p.set(k, S[k]);
  p.set('ab', S.ab);
  history.replaceState(null, '', `?${p}`);
  // Zurück zu Seite 1 mit deren Parametern (und unseren, damit sie erhalten bleiben)
  document.querySelectorAll('[data-page="park"]').forEach(a => { a.href = `index.html?${p}`; });
  $('#park-link').href = `index.html?${p}`;
}

function buildFields() {
  document.querySelectorAll('.field').forEach(box => {
    const k = box.dataset.key, f = FIELDS[k];
    box.innerHTML = `
      <div class="field__top"><label class="field__label" for="in-${k}">${f.label}</label><span class="field__value" id="val-${k}"></span></div>
      <div class="range"><div class="range__track"><div class="range__fill"></div><div class="range__mark" hidden></div></div>
        <input type="range" id="in-${k}" min="${f.min}" max="${f.max}" step="${f.step}"></div>
      <div class="field__hint"><span>${HINTS[k] || ''}</span></div>`;
    const inp = box.querySelector('input');
    inp.addEventListener('input', () => { S[k] = +inp.value; sync(); render(); });
  });
  // Marken für Ist-Werte
  mark('ea', BASE.bev / BASE.pkw);
  mark('km', BASE.kmKba);
  $('#reset').addEventListener('click', () => { for (const [k, f] of Object.entries(FIELDS)) S[k] = f.def; S.ab = '150'; sync(); render(); });
  $('#seg-ab').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.ab = b.dataset.v; sync(); render(); });
}
function mark(k, v) {
  const inp = $(`#in-${k}`), f = FIELDS[k];
  const m = inp.closest('.field').querySelector('.range__mark');
  m.hidden = false; m.style.left = `${(v - f.min) / (f.max - f.min) * 100}%`;
}
function sync() {
  for (const [k, f] of Object.entries(FIELDS)) {
    const inp = $(`#in-${k}`);
    inp.value = S[k];
    $(`#val-${k}`).innerHTML = f.show(S[k]);
    const t = (S[k] - f.min) / (f.max - f.min);
    inp.closest('.field').querySelector('.range__fill').style.width = `${Math.max(0, Math.min(1, t)) * 100}%`;
  }
  document.querySelectorAll('#seg-ab button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === S.ab)));
  writeUrl();
}

// ---------- Rechnen
function calc(s = S) {
  const pkw = BASE.pkw * (1 + s.bdelta);
  const epkw = pkw * s.ea;
  const kwh = epkw * s.km * s.vb / 100;          // Ladestrom aller E-Pkw
  const fast = kwh * s.sl;                       // davon DC-Schnellladen
  const lpOpt = fast / park.perLp;               // Ladepunkte an der Grenze
  const lp = lpOpt / s.opt;                      // mit Abstand zum Optimum
  return { pkw, epkw, kwh, fast, lpOpt, lp, parks: lp / P.c, perLp: park.perLp * s.opt };
}

const big = v => v >= 1e6 ? `${fmt.n(v / 1e6, 2)} Mio.` : fmt.n(v);
const twh = v => `${fmt.n(v / 1e9, 1)} TWh`;

function render() {
  const r = calc();
  // Ergebnis
  $('#summary').innerHTML = `${fmt.n(r.epkw / 1e6, 1)} Mio. E-Pkw laden im Jahr <b>${twh(r.kwh)}</b>. Kommen ${fmt.pct(S.sl, 0)} davon aus Schnellladen, sind das <b>${twh(r.fast)}</b>. Dafür braucht Deutschland rund <b>${fmt.n(Math.round(r.lp / 100) * 100)} Schnellladepunkte</b> bei ${fmt.pct(S.opt, 0)} Nähe zum Optimum, am Optimum wären es ${fmt.n(Math.round(r.lpOpt / 100) * 100)}.`;
  const have = L.ab[S.ab];
  const lastFull = String(+L.stand.slice(-4) - 1);
  const pace = L.years[lastFull]?.[S.ab] || 0;
  const gap = r.lp - have;
  $('#kpis').innerHTML = [
    kpi('Schnellladepunkte', fmt.n(Math.round(r.lp / 100) * 100), '', `Am Optimum: ${fmt.n(Math.round(r.lpOpt / 100) * 100)}`),
    kpi('Schnellladestrom', fmt.n(r.fast / 1e9, 1), 'TWh/Jahr', `von ${twh(r.kwh)} Ladestrom der E-Pkw`),
    kpi('E-Pkw je Schnellladepunkt', fmt.n(r.epkw / r.lp, 0), '', `${fmt.n(r.lp / r.epkw * 1000, 2)} Ladepunkte je 1.000 E-Pkw`),
    kpi(`Parks à ${P.c} Ladepunkte`, fmt.n(Math.round(r.parks / 10) * 10), '', `Je Ladepunkt ${fmt.n(r.perLp / 1000, 0)} MWh im Jahr`),
  ].join('');
  $('#kpis-have').innerHTML = [
    kpi(`Bestand ab ${S.ab} kW`, fmt.n(have), '', `Ladesäulenregister, Stand ${L.stand}`),
    kpi('Ausbaugrad', fmt.pct(have / r.lp, 0), '', `vom Bedarf · am Optimum ${fmt.pct(have / r.lpOpt, 0)}`),
    kpi(gap > 0 ? 'Fehlen noch' : 'Überdeckung', fmt.n(Math.abs(Math.round(gap / 100) * 100)), '', gap > 0 ? `Ladepunkte ab ${S.ab} kW` : 'mehr als der Bedarf'),
    kpi(`Zubau ${lastFull}`, fmt.n(pace), '', gap > 0 && pace > 0 ? `In diesem Tempo noch <b>${fmt.n(gap / pace, 1)} Jahre</b>` : 'Ladepunkte im Jahr'),
  ].join('');
  $('#compare').innerHTML = `Nur Betreiber mit abgeschlossenem Anzeigeverfahren sind im Register, der tatsächliche Bestand ist etwas größer. Ein Ladepunkt zählt mit der höchsten Steckerleistung. Die Energie je Ladepunkt stammt aus dem Park von Seite 1 (${fmt.n(P.plp)} kW je Ladepunkt).`;

  // Wo stehen wir: Bestand kumuliert nach Inbetriebnahmejahr
  const yrs = Object.keys(L.years).filter(y => /^\d{4}$/.test(y) && +y >= 2016).sort();
  let acc = Object.entries(L.years).filter(([y]) => !/^\d{4}$/.test(y) || +y < 2016).reduce((a, [, v]) => a + v[S.ab], 0);
  const cum = yrs.map(y => (acc += L.years[y][S.ab]));
  const s1c = css('--s1');
  plot($('#ch-have'), {
    height: 270, aria: 'Bestand an Schnellladepunkten nach Jahr und Bedarf', margin: { l: 52 },
    x: { domain: [0, yrs.length], band: yrs.length, ticks: yrs.map((y, i) => ({ i, label: y === L.stand.slice(-4) ? `${y}*` : y })) },
    y: { domain: [0, Math.max(r.lp, cum[cum.length - 1]) * 1.12], fmt: v => fmt.n(v / 1000), label: 'Tsd. Ladepunkte' },
    layers: [
      { type: 'bars', data: cum, color: s1c, gap: 8, radius: 3 },
      { type: 'hline', y: r.lp, label: `Bedarf ${fmt.n(Math.round(r.lp / 100) * 100)}` },
      { type: 'hline', y: r.lpOpt, label: `am Optimum ${fmt.n(Math.round(r.lpOpt / 100) * 100)}`, below: true },
    ],
    tip: { html: i => `<div class="head">Ende ${yrs[i]}${yrs[i] === L.stand.slice(-4) ? ` (Stand ${L.stand})` : ''}</div>
      <div class="row"><span>Bestand ab ${S.ab} kW</span><b>${fmt.n(cum[i])}</b></div>
      <div class="row"><span>Zubau im Jahr</span><b>${fmt.n(L.years[yrs[i]][S.ab])}</b></div>
      <div class="row"><span>Anteil am Bedarf</span><b>${fmt.pct(cum[i] / r.lp, 0)}</b></div>` },
  });
  $('#have-note').textContent = `* ${L.stand.slice(-4)} bis ${L.stand}. Gezählt sind Ladepunkte, die heute im Register stehen, nach ihrem Inbetriebnahmedatum; stillgelegte Ladepunkte fehlen in früheren Jahren.`;

  // Rechenweg
  const lpR = v => fmt.n(Math.round(v / 100) * 100);
  const steps = [
    ['Pkw-Bestand', fmt.n(r.pkw / 1e6, 2), 'Mio.', S.bdelta ? `KBA 1.1.2026 ${S.bdelta > 0 ? '+' : '−'} ${fmt.pct(Math.abs(S.bdelta), 0)}` : 'KBA, 1.1.2026'],
    ['E-Pkw', fmt.n(r.epkw / 1e6, 2), 'Mio.', `× ${fmt.pct(S.ea, 0)} elektrisch`],
    ['Ladestrom', fmt.n(r.kwh / 1e9, 1), 'TWh', `× ${fmt.n(S.km)} km × ${fmt.n(S.vb, 1)} kWh/100 km`],
    ['Schnellladen', fmt.n(r.fast / 1e9, 1), 'TWh', `× ${fmt.pct(S.sl, 0)}`],
    ['Am Optimum', lpR(r.lpOpt), 'Ladepunkte', `÷ ${fmt.n(park.perLp / 1000, 0)} MWh je Ladepunkt`],
    ['Bedarf', lpR(r.lp), 'Ladepunkte', `÷ ${fmt.pct(S.opt, 0)} Nähe zum Optimum`],
  ];
  $('#steps').innerHTML = steps.map(([l, v, u, h], i) => `<li class="step${i === steps.length - 1 ? ' step--last' : ''}"><span class="step__label">${l}</span><span class="step__value"><b>${v}</b> <small>${u}</small></span><span class="step__how">${h}</span></li>`).join('');

  // Empfindlichkeit: Schnellladeanteil
  const s1 = css('--s1'), s3 = css('--s3');
  const xs = Array.from({ length: 61 }, (_, i) => i / 100);
  const line = opt => xs.map(x => [x, calc({ ...S, sl: x, opt }).lp / 1000]);
  const cur = line(S.opt), best = line(1);
  $('#leg-sl').innerHTML = legendHtml([[`${fmt.pct(S.opt, 0)} Nähe zum Optimum`, s1], ['am Optimum', s3]]);
  plot($('#ch-sl'), {
    height: 260, aria: 'Ladepunkte nach Schnellladeanteil',
    x: { domain: [0, 0.6], fmt: v => fmt.pct(v, 0), label: 'Anteil Schnellladen am Ladestrom', ticks: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
    y: { domain: [0, Math.max(...cur.map(p => p[1])) * 1.08], fmt: v => fmt.n(v), label: 'Tsd. Ladepunkte' },
    layers: [
      { type: 'vline', x: S.sl, label: fmt.pct(S.sl, 0), anchor: S.sl > 0.45 ? 'end' : 'start' },
      { type: 'line', data: best, color: s3 },
      { type: 'line', data: cur, color: s1 },
      { type: 'dots', data: [[S.sl, r.lp / 1000]], color: s1, r: 5 },
    ],
    tip: {
      nearest: x => Math.max(0, Math.min(60, Math.round(x * 100))), xOf: i => i / 100,
      html: i => `<div class="head">${fmt.pct(i / 100, 0)} Schnellladen</div>
        <div class="row"><span>${fmt.pct(S.opt, 0)} Nähe zum Optimum</span><b>${fmt.n(cur[i][1] * 1000)}</b></div>
        <div class="row"><span>am Optimum</span><b>${fmt.n(best[i][1] * 1000)}</b></div>`,
    },
  });

  // Nähe zum Optimum: 1/x
  const os = Array.from({ length: 81 }, (_, i) => 0.2 + i / 100);
  const oc = os.map(o => [o, r.lpOpt / o / 1000]);
  plot($('#ch-opt'), {
    height: 260, aria: 'Ladepunkte nach Nähe zum Optimum',
    x: { domain: [0.2, 1], fmt: v => fmt.pct(v, 0), label: 'Nähe zum Optimum', ticks: [0.2, 0.4, 0.6, 0.8, 1] },
    y: { domain: [0, Math.max(...oc.map(p => p[1])) * 1.05], fmt: v => fmt.n(v), label: 'Tsd. Ladepunkte' },
    layers: [
      { type: 'vline', x: S.opt, label: `${fmt.n(Math.round(r.lp / 100) * 100)} LP`, anchor: S.opt > 0.75 ? 'end' : 'start' },
      { type: 'line', data: oc, color: s1 },
      { type: 'dots', data: [[S.opt, r.lp / 1000]], color: s1, r: 5 },
    ],
    tip: {
      nearest: x => Math.max(0, Math.min(80, Math.round((x - 0.2) * 100))), xOf: i => os[i],
      html: i => `<div class="head">${fmt.pct(os[i], 0)} Nähe zum Optimum</div>
        <div class="row"><span>Ladepunkte</span><b>${fmt.n(oc[i][1] * 1000)}</b></div>
        <div class="row"><span>Energie je Ladepunkt</span><b>${fmt.n(park.perLp * os[i] / 1000, 0)} MWh</b></div>`,
    },
  });

  // Parkannahmen aus Seite 1
  $('#park-info').innerHTML = `${fmt.n(P.c)} Ladepunkte à ${fmt.n(P.plp)} kW${P.ppark < P.c * P.plp ? ` an ${fmt.n(P.ppark)} kW` : ''}, Kunden ${park.classLabel} ${park.dataYear}, Geduld ${fmt.n(P.T)} min, ${fmt.pct(P.alpha, 0)} Churn. Daraus: <b>${fmt.n(park.perLp / 1000, 1)} MWh je Ladepunkt und Jahr</b> an der Grenze.`;
}

const kpi = (l, v, u, s) => `<div class="kpi"><p class="kpi__label">${l}</p><p class="kpi__value">${v}${u ? `<span class="kpi__unit">${u}</span>` : ''}</p><p class="kpi__sub">${s}</p></div>`;
const legendHtml = items => items.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');

function theme() {
  const btn = $('#theme');
  try { const t = localStorage.getItem('wsr-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* egal */ }
  btn.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('wsr-theme', next); } catch { /* egal */ }
    render();
  });
}

async function main() {
  theme();
  [D, L] = await Promise.all([fetch('data/ladeprofil.json').then(r => r.json()), fetch('data/ladesaeulen.json').then(r => r.json())]);
  P = readPark(D, location.search);
  park = parkYear(D, P);
  readUrl();
  buildFields();
  sync();
  render();
}
main().catch(e => { console.error(e); $('#summary').textContent = `Fehler beim Laden: ${e.message}`; });
void PARK_KEYS;
