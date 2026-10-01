import * as M from './model.js';
import { Park, STATE, rng } from './sim.js';
import { plot, heatmap, rampN, fmt, niceTicks, showTip, hideTip } from './charts.js';

const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const C_MAX = 40;
const UNLIMITED = 1e6;
const $ = s => document.querySelector(s);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const hourLabel = h => `${DAYS[Math.floor(h / 24)]} ${h % 24}–${(h % 24) + 1} Uhr`;

// ---------- Parameter
const FIELDS = {
  c:     { label: 'Ladepunkte', min: 1, max: C_MAX, step: 1, def: 8, show: v => fmt.n(v) },
  plp:   { label: 'Leistung je Ladepunkt', min: 50, max: 400, step: 10, def: 300, show: v => `${fmt.n(v)}<small>kW</small>` },
  ppark: { label: 'Netzanschluss des Parks', min: 50, max: 12000, step: 50, def: 1500,
           show: v => v >= S.c * S.plp ? `${fmt.n(S.c * S.plp)}<small>kW · kein Engpass</small>` : `${fmt.n(v)}<small>kW</small>` },
  A:     { label: 'Verfügbarkeit je Ladepunkt', min: 0.9, max: 1, step: 0.005, def: 0.98, show: v => fmt.pct(v, 1) },
  setup: { label: 'Wechselzeit zwischen Fahrzeugen', min: 0, max: 6, step: 0.5, def: 1.5, show: v => `${fmt.n(v, 1)}<small>min</small>` },
  E:     { label: 'Ø Lademenge je Vorgang', min: 10, max: 90, step: 0.5, def: null, show: v => `${fmt.n(v, 1)}<small>kWh</small>` },
  Pv:    { label: 'Ø Ladeleistung der Fahrzeuge', min: 30, max: 250, step: 1, def: null, show: v => `${fmt.n(v)}<small>kW</small>` },
  pmin:  { label: 'Mindestleistung der Fahrzeuge', min: 0, max: 80, step: 5, def: 40, show: v => v > 0 ? `${fmt.n(v)}<small>kW</small>` : 'keine' },
  ca:    { label: 'Streuung der Ankünfte (CV)', min: 0, max: 2, step: 0.05, def: 1, show: v => fmt.n(v, 2) },
  T:     { label: 'Kunden fahren weiter nach', min: 1, max: 30, step: 1, def: 10, show: v => `${fmt.n(v)}<small>min Warten</small>` },
  alpha: { label: 'Erlaubter Anteil, der weiterfährt', min: 0.005, max: 0.2, step: 0.005, def: 0.05, show: v => fmt.pct(v, 1) },
};
const HINTS = {
  ppark: 'Wird über dynamisches Lastmanagement auf die ladenden Fahrzeuge verteilt.',
  A: 'Anteil der Zeit, in der ein Ladepunkt funktioniert.',
  setup: 'Ausparken, Einparken, Stecken, Freischalten.',
  ca: '1 = rein zufällige Ankünfte (Poisson), 0 = gleichmäßiger Takt, > 1 = Pulks.',
  T: 'Wer länger warten müsste, fährt weiter.',
};

const S = { cls: 5, year: null, prof: 5, design: 'avg', scaleMode: 'total' };
let D;               // Datensatz
let R = {};          // Rechenergebnis
let simRes = {};     // Simulationsergebnis
const cache = new Map();

// ---------- Daten
function dataFor(cls, year, pmin = S.pmin) {
  const key = `${cls}-${year}-${pmin}`;
  if (cache.has(key)) return cache.get(key);
  const c = D.classes.find(x => x.id === cls);
  const y = c.years[year] || c.years[latestYear(c)];
  const qe = M.quantileTable(y.kwh, D.edges.kwh);
  const qpAll = M.quantileTable(y.kwavg, D.edges.kwavg, { geometric: true });
  // Kopplung auf dem vollständigen Datensatz kalibrieren, danach langsame Vorgänge entfernen
  const rho = M.calibrateRho(qe, qpAll, y.h_mean);
  const { tab: qp, removed } = M.truncateTable(qpAll, pmin);
  const means = M.popMeans(M.makePopulation({ qe, qp, rho }));
  const meansAll = M.popMeans(M.makePopulation({ qe, qp: qpAll, rho }));
  const v = { cls: c, y, qe, qp, rho, means, meansAll, removed, pmin };
  cache.set(key, v);
  return v;
}
const latestYear = c => Object.keys(c.years).sort().pop();

function profileFor(p) {
  const w = new Array(168).fill(0);
  const add = c => c.week.forEach(([dow, hod, n]) => { w[(dow - 1) * 24 + hod] += n; });
  if (p === 'dc') D.classes.forEach(add); else add(D.classes.find(c => c.id === p));
  const mx = Math.max(...w);
  return { raw: w, norm: w.map(v => v / mx), peakIdx: w.indexOf(mx), peakToAvg: mx / (w.reduce((a, b) => a + b, 0) / 168) };
}

function seasonFor(cls, year) {
  const c = D.classes.find(x => x.id === cls);
  const yrs = Object.keys(c.season).sort();
  const s = c.season[year] || c.season[yrs[yrs.length - 1]];
  return { s, year: c.season[year] ? year : yrs[yrs.length - 1] };
}

// ---------- Rechnen
function compute() {
  const d = dataFor(S.cls, S.year);
  const sE = S.E / d.means.e, sP = S.Pv / d.means.p;
  const pop = M.makePopulation({ qe: d.qe, qp: d.qp, rho: d.rho, sE, sP });
  // Netzanschluss bleibt beim Ändern der Ladepunkte fest; UNLIMITED steht für "kein Engpass"
  const ppark = S.ppark >= UNLIMITED ? Infinity : S.ppark;
  const capped = ppark < S.c * S.plp;
  const pEff = Math.min(ppark, S.c * S.plp);
  const setupH = S.setup / 60, T = S.T / 60, ca2 = S.ca * S.ca;
  const svc = M.buildService(pop, { plp: S.plp, ppark, setupH, cMax: C_MAX });
  const svcFree = M.buildService(pop, { plp: S.plp, ppark: Infinity, setupH, cMax: C_MAX });
  const P = { c: S.c, A: S.A, svc, T, ca2 };
  const prof = profileFor(S.prof);
  const season = seasonFor(S.cls, S.year);
  const wts = season.s.map((v, m) => v * MDAYS[m]);
  const sMean = wts.reduce((a, b) => a + b, 0) / 365;
  const sMax = Math.max(...season.s);
  const ref = S.design === 'peak' ? sMax : sMean;

  const lam = M.findLambda(P, S.alpha);
  const peak = M.evalHour(lam, P);
  const week = M.evalWeek(lam, 1, prof.norm, P);
  const year = M.evalYear(lam, season.s, ref, prof.norm, P);
  const avgWeek = M.evalWeek(lam, sMean / ref, prof.norm, P);

  // Kurve über die Ankunftsrate
  const lMax = Math.max(lam * 1.7, svc.mu[S.c] * 1.15);
  const curve = [];
  for (let i = 0; i <= 90; i++) { const l = lMax * i / 90; curve.push(M.evalHour(l, P)); }

  // Skalierung über die Zahl der Ladepunkte
  const scale = [];
  for (let c = 1; c <= C_MAX; c++) {
    const Pc = { ...P, c }, Pf = { ...P, c, svc: svcFree };
    const lc = M.findLambda(Pc, S.alpha), lf = M.findLambda(Pf, S.alpha);
    scale.push({ c, kwh: M.evalWeek(lc, 1, prof.norm, Pc).kwh, free: M.evalWeek(lf, 1, prof.norm, Pf).kwh, lam: lc });
  }

  R = { d, pop, sE, sP, svc, P, prof, season, ref, sMean, sMax, lam, peak, week, year, avgWeek, curve, lMax, scale, capped, ppark, pEff, setupH, T };
}

// ---------- Steuerung
function buildFields() {
  document.querySelectorAll('.field').forEach(box => {
    const k = box.dataset.key, f = FIELDS[k];
    box.innerHTML = `
      <div class="field__top"><label class="field__label" for="in-${k}">${f.label}</label><span class="field__value" id="val-${k}"></span></div>
      <div class="range"><div class="range__track"><div class="range__fill"></div><div class="range__mark" hidden></div></div>
        <input type="range" id="in-${k}" min="${f.min}" max="${f.max}" step="${f.step}"></div>
      <div class="field__hint"><span>${HINTS[k] || ''}</span></div>`;
    const inp = box.querySelector('input');
    inp.addEventListener('input', () => { S[k] = +inp.value; onParam(k); });
  });
  $('#reset').addEventListener('click', () => { setDefaults(); syncControls(); update(); });
}

function setDefaults() {
  for (const [k, f] of Object.entries(FIELDS)) if (f.def != null) S[k] = f.def;
  S.cls = 5; S.prof = 5; S.design = 'avg';
  S.year = latestYear(D.classes.find(c => c.id === 5));
  const d = dataFor(S.cls, S.year);
  S.E = round(d.means.e, 0.5); S.Pv = Math.round(d.means.p);
}
const round = (v, s) => Math.round(v / s) * s;

function onParam(k) {
  if (k === 'pmin') S.Pv = Math.round(dataFor(S.cls, S.year).means.p);
  if (k === 'ppark' && S.ppark > S.c * S.plp - FIELDS.ppark.step) S.ppark = UNLIMITED;
  syncControls();
  scheduleUpdate();
}

function syncControls() {
  const max = S.c * S.plp;
  const pin = $('#in-ppark');
  pin.max = max; pin.min = Math.min(50, max);
  for (const k of Object.keys(FIELDS)) {
    const inp = $(`#in-${k}`);
    inp.value = S[k];
    $(`#val-${k}`).innerHTML = FIELDS[k].show(S[k]);
    const lo = +inp.min, hi = +inp.max;
    const t = (S[k] - lo) / (hi - lo || 1);
    const box = inp.closest('.field');
    box.querySelector('.range__fill').style.width = `${Math.max(0, Math.min(1, t)) * 100}%`;
  }
  // Datenwerte als Marke auf der Skala
  const d = dataFor(S.cls, S.year);
  markData('E', d.means.e, `Daten ${d.y === d.cls.years[S.year] ? S.year : ''}: ${fmt.n(d.means.e, 1)} kWh`);
  markData('Pv', d.means.p, `Daten${S.pmin > 0 ? ` ab ${fmt.n(S.pmin)} kW` : ''}: ${fmt.n(d.means.p)} kW (Energie/Belegdauer)`);
  $('#in-pmin').closest('.field').querySelector('.field__hint').innerHTML = `<span>${S.pmin > 0
    ? `Langsamere Vorgänge werden entfernt: ${fmt.pct(d.removed, 1)} der Daten (Standzeit nach Ladeende, Plug-in-Hybride, gedrosselte Fahrzeuge).`
    : 'Alle gemessenen Vorgänge, auch sehr langsame.'}</span>`;
  segSet('#seg-cls', S.cls); segSet('#seg-prof', S.prof); segSet('#seg-design', S.design);
  $('#sel-year').value = S.year;
  writeUrl();
}

function markData(k, v, text) {
  const inp = $(`#in-${k}`), box = inp.closest('.field');
  const mk = box.querySelector('.range__mark');
  const t = (v - inp.min) / (inp.max - inp.min);
  mk.hidden = false; mk.style.left = `${t * 100}%`;
  const hint = box.querySelector('.field__hint');
  hint.innerHTML = `<span>${text}</span><button type="button">Datenwert</button>`;
  hint.querySelector('button').onclick = () => { S[k] = k === 'E' ? round(v, 0.5) : Math.round(v); syncControls(); scheduleUpdate(); };
}

function segSet(sel, v) {
  document.querySelectorAll(`${sel} button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === String(v))));
}

function buildSegs() {
  const dc = D.classes;
  $('#seg-cls').innerHTML = dc.map(c => `<button type="button" data-v="${c.id}">${c.label}</button>`).join('');
  $('#seg-prof').innerHTML = dc.map(c => `<button type="button" data-v="${c.id}">${c.label}</button>`).join('') + '<button type="button" data-v="dc">alle DC</button>';
  const fillYears = () => {
    const c = dc.find(x => x.id === S.cls);
    const ys = Object.keys(c.years).sort().reverse();
    $('#sel-year').innerHTML = ys.map(y => `<option value="${y}">${y}</option>`).join('');
    if (!c.years[S.year]) S.year = ys[0];
  };
  fillYears();
  const resetCustomers = () => { const d = dataFor(S.cls, S.year); S.E = round(d.means.e, 0.5); S.Pv = Math.round(d.means.p); };
  $('#seg-cls').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.cls = +b.dataset.v; fillYears(); resetCustomers(); syncControls(); scheduleUpdate();
  });
  $('#sel-year').addEventListener('change', e => { S.year = e.target.value; resetCustomers(); syncControls(); scheduleUpdate(); });
  $('#seg-prof').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.prof = b.dataset.v === 'dc' ? 'dc' : +b.dataset.v; syncControls(); scheduleUpdate();
  });
  $('#seg-scale').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.scaleMode = b.dataset.v; segSet('#seg-scale', S.scaleMode); renderScale();
  });
  $('#seg-design').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.design = b.dataset.v; syncControls(); scheduleUpdate();
  });
}

// ---------- URL
const URL_KEYS = ['c', 'plp', 'ppark', 'A', 'setup', 'E', 'Pv', 'pmin', 'ca', 'T', 'alpha', 'cls', 'year', 'prof', 'design'];
function writeUrl() {
  const p = new URLSearchParams();
  for (const k of URL_KEYS) p.set(k, S[k]);
  history.replaceState(null, '', `?${p}${location.hash}`);
}
function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const k of URL_KEYS) {
    if (!p.has(k)) continue;
    const v = p.get(k);
    if (k === 'year' || k === 'design') S[k] = v;
    else if (k === 'prof') S[k] = v === 'dc' ? 'dc' : +v;
    else if (Number.isFinite(+v)) S[k] = +v;
  }
  if (!D.classes.some(c => c.id === S.cls)) S.cls = 5;
  const cl = D.classes.find(c => c.id === S.cls);
  if (!cl.years[S.year]) S.year = latestYear(cl);
  // Fehlende Kundenwerte aus der verlinkten Datenbasis, nicht aus der Standardklasse
  const d = dataFor(S.cls, S.year);
  if (!p.has('E')) S.E = round(d.means.e, 0.5);
  if (!p.has('Pv')) S.Pv = Math.round(d.means.p);
  for (const [k, f] of Object.entries(FIELDS)) if (k !== 'ppark') S[k] = Math.max(f.min, Math.min(f.max, S[k]));
  S.ppark = Math.max(50, S.ppark);
}

// ---------- Aktualisieren
let tUpd = 0, tSim = 0;
function scheduleUpdate() {
  cancelAnimationFrame(tUpd);
  tUpd = requestAnimationFrame(update);
}
function update() {
  compute();
  simRes = {};
  renderPparkHint();
  renderSummary();
  renderDock();
  renderEdge();
  renderWeek();
  renderYear();
  renderCustomers();
  renderScale();
  renderMethod();
  restartLive();
  segSet('#seg-scale', S.scaleMode);
  clearTimeout(tSim);
  $('#sim-note').textContent = 'Simulation läuft …';
  tSim = setTimeout(runSim, 450);
}

// ---------- 01 Ergebnis
function renderSummary() {
  const { peak, week, year, prof, lam, capped } = R;
  const parkTxt = S.c === 1 ? `Ein Ladepunkt mit ${fmt.n(S.plp)} kW` : `${fmt.n(S.c)} Ladepunkte à ${fmt.n(S.plp)} kW`;
  const netzTxt = capped ? ` an ${fmt.n(R.pEff)} kW Netzanschluss` : '';
  $('#summary').innerHTML = `${parkTxt}${netzTxt} ${S.c === 1 ? 'verträgt' : 'vertragen'} in der Spitzenstunde (<i>${DAYS_LONG[Math.floor(prof.peakIdx / 24)]} ${prof.peakIdx % 24}–${prof.peakIdx % 24 + 1} Uhr</i>) rund <b>${fmt.n(lam, 1)} Ankünfte</b> und geben dabei <b>${fmt.n(peak.kwh)} kWh</b> ab. Zurückgerechnet sind das <b>${fmt.n(week.kwh / 1000, 1)} MWh</b> in der Woche und <b>${fmt.n(year.kwh / 1e6, 2)} GWh</b> im Jahr.`;
  const perLpDay = year.kwh / 365 / S.c;
  const busyWeek = week.hours.reduce((a, h) => a + h.busy, 0) / 168 / S.c;
  const peakPow = peak.kwh; // kWh in einer Stunde = mittlere kW
  const netz = R.capped ? `${fmt.pct(peakPow / R.pEff, 0)} des Netzanschlusses` : `${fmt.pct(peakPow / (S.c * S.plp), 0)} der Nennleistung`;
  const wkLabel = S.design === 'peak' ? 'Woche im Spitzenmonat' : 'Durchschnittswoche';
  $('#kpis').innerHTML = [
    kpi('Spitzenstunde', fmt.n(peak.kwh), 'kWh', `<b>${fmt.n(peak.served, 1)}</b> Ladevorgänge · Ø Warten <b>${fmt.n(peak.wq * 60, 1)} min</b> · ${netz}`),
    kpi(wkLabel, fmt.n(week.kwh / 1000, 1), 'MWh', `<b>${fmt.n(week.n)}</b> Ladevorgänge · ${fmt.pct(week.churn, 1)} fahren weiter`),
    kpi('Jahr', fmt.n(year.kwh / 1000, 0), 'MWh', `<b>${fmt.n(year.n)}</b> Ladevorgänge · ${fmt.pct(year.churn, 1)} fahren weiter`),
    kpi('Je Ladepunkt und Tag', fmt.n(perLpDay, 0), 'kWh', `Belegt <b>${fmt.pct(busyWeek, 0)}</b> der Zeit · ${fmt.n(year.n / 365 / S.c, 1)} Vorgänge/Tag`),
  ].join('');
  // Normiert auf einen Ladepunkt
  const c = S.c;
  $('#kpis-lp').innerHTML = [
    kpi('Spitzenstunde', fmt.n(peak.kwh / c, 1), 'kWh', `${fmt.n(peak.served / c, 2)} Ladevorgänge · ${fmt.pct(peak.kwh / c / S.plp, 0)} der Ladepunktleistung`),
    kpi(wkLabel, fmt.n(week.kwh / c, 0), 'kWh', `${fmt.n(week.n / c, 0)} Ladevorgänge`),
    kpi('Jahr', fmt.n(year.kwh / c / 1000, 1), 'MWh', `${fmt.n(year.n / c, 0)} Ladevorgänge`),
    kpi('Auslastung Nennleistung', fmt.pct(year.kwh / c / (S.plp * 8760), 1), '', `Energie im Jahr ÷ (${fmt.n(S.plp)} kW × 8.760 h)`),
  ].join('');
}
function renderDock() {
  let d = $('#dock');
  if (!d) { d = document.createElement('a'); d.id = 'dock'; d.className = 'dock'; d.href = '#ergebnis'; document.body.appendChild(d); }
  d.innerHTML = `<span><small>Spitzenstunde</small><b>${fmt.n(R.peak.kwh)} kWh</b></span><span><small>Woche</small><b>${fmt.n(R.week.kwh / 1000, 1)} MWh</b></span><span><small>Jahr</small><b>${fmt.n(R.year.kwh / 1000, 0)} MWh</b></span><span><small>Je LP und Jahr</small><b>${fmt.n(R.year.kwh / 1000 / S.c, 1)} MWh</b></span>`;
}
// Hinweis unter dem Netzanschluss: was je Ladepunkt übrig bleibt
function renderPparkHint() {
  const box = $('#in-ppark').closest('.field').querySelector('.field__hint');
  const { svc } = R;
  if (!R.capped) {
    box.innerHTML = `<span>Kein Engpass: Jeder Ladepunkt kann seine vollen ${fmt.n(S.plp)} kW abgeben.</span>`;
    return;
  }
  const share = R.pEff / S.c;
  let first = 0;
  for (let n = 1; n <= S.c; n++) if (svc.capped[n]) { first = n; break; }
  const L = svc.level[S.c];
  const extra = first
    ? ` Ab ${first} gleichzeitig ladenden Fahrzeugen wird gedrosselt. Bei voller Belegung bekommen schnelle Fahrzeuge bis zu ${fmt.n(L)} kW, weil langsame ihren Anteil nicht ausschöpfen.`
    : ` Das reicht im Mittel auch bei voller Belegung, die Fahrzeuge ziehen im Schnitt ${fmt.n(svc.Ep)} kW.`;
  box.innerHTML = `<span><b>${fmt.n(share)} kW je Ladepunkt</b>, wenn alle ${S.c} laden (${fmt.n(R.pEff)} kW ÷ ${S.c}).${extra}</span>`;
}
const kpi = (l, v, u, s) => `<div class="kpi"><p class="kpi__label">${l}</p><p class="kpi__value">${v}<span class="kpi__unit">${u}</span></p><p class="kpi__sub">${s}</p></div>`;

// ---------- 03 Kipppunkt
function legend(items) {
  return items.map(([name, color, kind]) => `<span><i class="${kind || ''}" style="background:${color}"></i>${name}</span>`).join('');
}
function renderEdge() {
  const { curve, lam, lMax, svc } = R;
  const s1 = css('--s1'), s2 = css('--s2');
  const sim = simRes.edge?.points || [];
  $('#leg-edge').innerHTML = legend([['Analytik', s1], ['Simulation', s2, 'dot']]);
  const yMax = Math.max(S.alpha * 4, 0.2);
  const near = x => { let b = 0; curve.forEach((p, i) => { if (Math.abs(p.lambda - x) < Math.abs(curve[b].lambda - x)) b = i; }); return b; };
  const tipEdge = i => {
    const p = curve[i];
    const s = sim.find(q => Math.abs(q.lambda - p.lambda) / lMax < 0.02);
    return `<div class="head">${fmt.n(p.lambda, 1)} Ankünfte je Stunde</div>
      <div class="row"><span>Weitergefahren</span><b>${fmt.pct(p.churn)}</b></div>
      ${s ? `<div class="row"><span>Simulation</span><b>${fmt.pct(s.churn)}</b></div>` : ''}
      <div class="row"><span>Ø Warten der Bedienten</span><b>${fmt.n(p.wq * 60, 1)} min</b></div>
      <div class="row"><span>Energie</span><b>${fmt.n(p.kwh)} kWh</b></div>
      <div class="row"><span>Belegte Ladepunkte</span><b>${fmt.n(p.busy, 1)}</b></div>`;
  };
  plot($('#ch-churn'), {
    height: 260, aria: 'Churn über Ankunftsrate',
    x: { domain: [0, lMax], label: 'Ankünfte je Stunde' },
    y: { domain: [0, yMax], fmt: v => fmt.pct(v, 0), fixed: true },
    layers: [
      { type: 'hline', y: S.alpha, label: `Grenze ${fmt.pct(S.alpha, 1)}` },
      { type: 'vline', x: lam, label: `${fmt.n(lam, 1)} / h`, anchor: lam > lMax * 0.7 ? 'end' : 'start' },
      { type: 'line', data: curve.map(p => [p.lambda, p.churn]), color: s1 },
      { type: 'dots', data: sim.map(p => [p.lambda, p.churn]), color: s2 },
    ],
    tip: { nearest: near, xOf: i => curve[i].lambda, html: tipEdge },
  });
  const cap = svc.mu[S.c] * S.A * svc.Ee;
  const yT = Math.max(...curve.map(p => p.kwh), cap) * 1.08;
  plot($('#ch-thru'), {
    height: 260, aria: 'Energie über Ankunftsrate',
    x: { domain: [0, lMax], label: 'Ankünfte je Stunde' },
    y: { domain: [0, yT], fmt: v => fmt.n(v) },
    layers: [
      { type: 'hline', y: cap, label: `Kapazität ${fmt.n(cap)} kWh/h`, below: true, anchor: 'start' },
      ...(R.capped ? [{ type: 'hline', y: R.pEff, label: `Netzanschluss ${fmt.n(R.pEff)} kW`, anchor: 'start' }] : []),
      { type: 'vline', x: lam, label: `${fmt.n(R.peak.kwh)} kWh`, anchor: 'end', bottom: true },
      { type: 'line', data: curve.map(p => [p.lambda, p.kwh]), color: s1 },
      { type: 'dots', data: sim.map(p => [p.lambda, p.kwhPerH]), color: s2 },
    ],
    tip: { nearest: near, xOf: i => curve[i].lambda, html: tipEdge },
  });
}

// ---------- 04 Woche
const dayTicks = () => DAYS.map((d, i) => ({ i: i * 24, label: d, at: 'start', rule: i > 0 }));
function renderWeek() {
  const { week, prof } = R;
  const s1 = css('--s1'), s2 = css('--s2');
  const simW = simRes.week?.hours;
  $('#leg-week').innerHTML = legend([['Analytik', s1, 'bar'], ...(simW ? [['Simulation', s2]] : [])]);
  const vals = week.hours.map(h => h.kwh);
  const yMax = Math.max(...vals, ...(simW ? simW.map(h => h.kwh) : [0])) * 1.1;
  plot($('#ch-week'), {
    height: 280, aria: 'Energie je Stunde der Woche',
    margin: { l: 44 },
    x: { domain: [0, 168], band: 168, ticks: dayTicks() },
    y: { domain: [0, yMax], fmt: v => fmt.n(v), label: 'kWh je Stunde' },
    layers: [
      { type: 'bars', data: vals, color: s1, gap: 1, radius: 1.5, colorAt: i => i === prof.peakIdx ? css('--ink') : s1 },
      ...(simW ? [{ type: 'line', data: simW.map((h, i) => [i, h.kwh]), color: s2, width: 1.5 }] : []),
      { type: 'label', x: prof.peakIdx, y: vals[prof.peakIdx], dy: -8, text: `Spitze ${fmt.n(vals[prof.peakIdx])} kWh`, anchor: prof.peakIdx > 120 ? 'end' : 'start' },
    ],
    tip: {
      html: i => {
        const h = week.hours[i], s = simW?.[i];
        return `<div class="head">${hourLabel(i)}</div>
          <div class="row"><span>Energie</span><b>${fmt.n(h.kwh)} kWh</b></div>
          <div class="row"><span>je Ladepunkt</span><b>${fmt.n(h.kwh / S.c, 1)} kWh</b></div>
          ${s ? `<div class="row"><span>Simulation</span><b>${fmt.n(s.kwh)} kWh</b></div>` : ''}
          <div class="row"><span>Ankünfte</span><b>${fmt.n(h.lambda, 1)}</b></div>
          <div class="row"><span>Weitergefahren</span><b>${fmt.pct(h.churn, 2)}</b></div>
          <div class="row"><span>Belegt</span><b>${fmt.n(h.busy, 1)} von ${S.c}</b></div>
          <div class="row"><span>Gemessene Starts</span><b>${fmt.pct(prof.norm[i], 0)} der Spitze</b></div>`;
      },
    },
  });
  // Heatmap Belegung
  const seq = rampN([css('--seq-0'), css('--seq-mid'), css('--seq-1')]);
  const values = DAYS.map((_, d) => Array.from({ length: 24 }, (_, h) => week.hours[d * 24 + h].busy / S.c));
  heatmap($('#ch-heat'), {
    values, rows: DAYS, cols: Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? String(h) : '')),
    color: seq, aria: 'Belegung je Wochentag und Stunde',
    tipHtml: (r, c) => { const h = week.hours[r * 24 + c]; return `<div class="head">${hourLabel(r * 24 + c)}</div><div class="row"><span>Belegt</span><b>${fmt.pct(h.busy / S.c, 0)}</b></div><div class="row"><span>Ladepunkte</span><b>${fmt.n(h.busy, 1)} von ${S.c}</b></div>`; },
  });
  $('#heat-key').innerHTML = `<span>0 %</span><span class="bar" style="background:linear-gradient(90deg, ${seq(0)}, ${seq(0.5)}, ${seq(1)})"></span><span>100 % der Ladepunkte belegt (inkl. Wechselzeit)</span>`;
  tables.week = () => table(['Stunde', 'Ankünfte', 'Energie kWh', 'kWh je LP', 'Weitergefahren', 'Belegt'],
    week.hours.map((h, i) => [hourLabel(i), fmt.n(h.lambda, 2), fmt.n(h.kwh, 1), fmt.n(h.kwh / S.c, 1), fmt.pct(h.churn, 2), fmt.n(h.busy, 2)]));
  refreshTable('week');
}

// ---------- 05 Jahr
function renderYear() {
  const { year, ref, sMax, season } = R;
  const s1 = css('--s1'), s3 = css('--s3');
  const v = year.months.map(m => m.kwh / 1000);
  const over = year.months.map(m => m.peakChurn > S.alpha * 1.02);
  const designM = S.design === 'peak' ? season.s.indexOf(sMax) : -1;
  plot($('#ch-year'), {
    height: 250, aria: 'Energie je Monat',
    x: { domain: [0, 12], band: 12, ticks: MONTHS.map((m, i) => ({ i, label: m })) },
    y: { domain: [0, Math.max(...v) * 1.15], fmt: x => fmt.n(x), label: 'MWh je Monat' },
    layers: [
      { type: 'bars', data: v, color: s1, gap: 10, radius: 4, colorAt: i => over[i] ? s3 : s1 },
      ...(designM >= 0 ? [{ type: 'label', x: designM, y: v[designM], dy: -8, text: 'Auslegung', anchor: 'middle' }] : []),
    ],
    tip: {
      html: i => {
        const m = year.months[i];
        return `<div class="head">${MONTHS[i]} ${season.year}</div>
          <div class="row"><span>Energie</span><b>${fmt.n(m.kwh / 1000, 1)} MWh</b></div>
          <div class="row"><span>je Ladepunkt</span><b>${fmt.n(m.kwh / S.c / 1000, 2)} MWh</b></div>
          <div class="row"><span>Nachfrage ggü. Auslegung</span><b>${fmt.pct(m.factor, 0)}</b></div>
          <div class="row"><span>Weitergefahren im Monat</span><b>${fmt.pct(m.churn, 2)}</b></div>
          <div class="row"><span>… in der Spitzenstunde</span><b>${fmt.pct(m.peakChurn, 1)}</b></div>`;
      },
    },
  });
  const legendHtml = legend([['Spitzenstunde innerhalb der Grenze', s1, 'bar'], ['Spitzenstunde über der Grenze', s3, 'bar']]);
  const cap = $('#jahr .card__title');
  cap.querySelector('.legend')?.remove();
  cap.insertAdjacentHTML('beforeend', `<span class="legend">${legendHtml}</span>`);
  cap.appendChild(cap.querySelector('.link-btn'));
  tables.year = () => table(['Monat', 'Nachfrage ggü. Auslegung', 'Energie MWh', 'MWh je LP', 'Ladevorgänge', 'Weitergefahren', 'Spitzenstunde'],
    year.months.map((m, i) => [MONTHS[i], fmt.pct(m.factor, 0), fmt.n(m.kwh / 1000, 1), fmt.n(m.kwh / 1000 / S.c, 2), fmt.n(m.n), fmt.pct(m.churn, 2), fmt.pct(m.peakChurn, 1)]));
  refreshTable('year');
  void ref;
}

// ---------- 06 Kunden
function renderCustomers() {
  const { d, sE, sP, svc } = R;
  const r = rng(99);
  const N = 30000, eA = new Float64Array(N), pA = new Float64Array(N), sA = new Float64Array(N);
  const L = svc.level[S.c];
  const r2 = Math.sqrt(1 - d.rho * d.rho);
  for (let i = 0; i < N; i++) {
    const z1 = gauss(r), z2 = gauss(r);
    eA[i] = M.q(d.qe, M.phi(z1)) * sE;
    pA[i] = M.q(d.qp, M.phi(d.rho * z1 + r2 * z2)) * sP;
    sA[i] = (eA[i] / Math.min(pA[i], S.plp, L) + R.setupH) * 60;
  }
  const s1 = css('--s1');
  hist($('#ch-e'), eA, { step: 2.5, max: 150, unit: 'kWh', color: s1, refs: [{ x: S.E, label: `Ø ${fmt.n(S.E, 1)}` }] });
  const capShare = pA.reduce((a, v) => a + (v > S.plp ? 1 : 0), 0) / N;
  hist($('#ch-p'), pA, { step: 10, max: 420, unit: 'kW', color: s1, refs: [{ x: S.Pv, label: `Ø ${fmt.n(S.Pv)}` }, ...(S.pmin > 0 ? [{ x: S.pmin * R.sP, label: `ab ${fmt.n(S.pmin * R.sP)}`, anchor: 'end' }] : []), { x: S.plp, label: `Ladepunkt${capShare > 0.005 ? ` · ${fmt.pct(capShare, 0)} gedeckelt` : ''}`, anchor: 'end' }] });
  const sMean = sA.reduce((a, b) => a + b, 0) / N;
  hist($('#ch-s'), sA, { step: 2, max: 120, unit: 'min', color: s1, refs: [{ x: sMean, label: `Ø ${fmt.n(sMean, 0)} min${R.capped && Number.isFinite(L) ? ' bei voller Belegung' : ''}` }] });
}
function gauss(r) { let u = r(); while (u < 1e-12) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function hist(box, arr, { step, max, unit, color, refs }) {
  const n = Math.ceil(max / step), bins = new Array(n).fill(0);
  for (const v of arr) bins[Math.min(n - 1, Math.floor(v / step))]++;
  const share = bins.map(b => b / arr.length);
  const ticks = niceTicks(0, max, 4).ticks.filter(v => v <= max).map(v => ({ i: v / step, label: fmt.n(v) }));
  plot(box, {
    height: 190, margin: { l: 38 },
    x: { domain: [0, n], band: n, ticks: ticks.map(t => ({ ...t, i: t.i - 0.5 })) },
    y: { domain: [0, Math.max(...share) * 1.15], fmt: v => fmt.pct(v, 0), n: 3 },
    layers: [
      { type: 'bars', data: share, color, gap: 1, radius: 1.5 },
      ...refs.map((r, k) => ({ type: 'vline', x: r.x / step - 0.5, label: r.label, dy: k * 15, anchor: r.anchor || (r.x > max * 0.6 ? 'end' : 'start') })),
    ],
    tip: { html: i => `<div class="head">${fmt.n(i * step)}–${fmt.n((i + 1) * step)} ${unit}${i === n - 1 ? ' und mehr' : ''}</div><div class="row"><span>Anteil</span><b>${fmt.pct(share[i], 1)}</b></div>` },
  });
}

// ---------- 07 Skalierung
function renderScale() {
  const { scale } = R;
  const capped = Number.isFinite(R.ppark);
  const perLp = S.scaleMode === 'lp';
  // Gesamt: MWh je Woche. Je Ladepunkt: kWh je Ladepunkt und Tag
  const val = (kwh, c) => perLp ? kwh / 7 / c : kwh / 1000;
  const unit = perLp ? 'kWh' : 'MWh';
  $('#scale-title').textContent = perLp ? 'Energie je Ladepunkt und Tag nach Zahl der Ladepunkte' : 'Energie je Woche nach Zahl der Ladepunkte';
  const s1 = css('--s1'), s3 = css('--s3');
  $('#leg-scale').innerHTML = legend(capped
    ? [[`Netzanschluss ${fmt.n(R.ppark)} kW`, s1], ['ohne Engpass am Netz', s3]]
    : [['ohne Engpass am Netz', s1]]);
  const yMax = Math.max(...scale.map(s => val(s.free, s.c))) * 1.08;
  const cur = scale[S.c - 1];
  plot($('#ch-scale'), {
    height: 280, aria: 'Energie je Woche nach Ladepunktzahl',
    x: { domain: [1, C_MAX], label: 'Ladepunkte', ticks: [1, 5, 10, 15, 20, 25, 30, 35, 40] },
    y: { domain: [0, yMax], fmt: v => fmt.n(v), label: perLp ? 'kWh je Ladepunkt und Tag' : 'MWh je Woche' },
    layers: [
      { type: 'vline', x: S.c, label: `${S.c} LP · ${fmt.n(val(cur.kwh, cur.c), perLp ? 0 : 1)} ${unit}`, anchor: S.c > 28 ? 'end' : 'start', bottom: perLp },
      ...(capped ? [{ type: 'line', data: scale.map(s => [s.c, val(s.free, s.c)]), color: s3, width: 2 }] : []),
      { type: 'line', data: scale.map(s => [s.c, val(s.kwh, s.c)]), color: s1 },
      { type: 'dots', data: [[S.c, val(cur.kwh, cur.c)]], color: s1, r: 5 },
    ],
    tip: {
      nearest: x => Math.max(0, Math.min(C_MAX - 1, Math.round(x) - 1)), xOf: i => i + 1,
      html: i => { const s = scale[i]; return `<div class="head">${s.c} Ladepunkte</div>
        <div class="row"><span>Energie je Woche</span><b>${fmt.n(s.kwh / 1000, 1)} MWh</b></div>
        ${capped ? `<div class="row"><span>ohne Engpass am Netz</span><b>${fmt.n(s.free / 1000, 1)} MWh</b></div>` : ''}
        <div class="row"><span>je Ladepunkt und Tag</span><b>${fmt.n(s.kwh / 7 / s.c)} kWh</b></div>
        <div class="row"><span>je Ladepunkt und Jahr (× 52,14)</span><b>${fmt.n(s.kwh * 365 / 7 / s.c / 1000, 1)} MWh</b></div>
        <div class="row"><span>Ankünfte Spitzenstunde</span><b>${fmt.n(s.lam, 1)}</b></div>`; },
    },
  });
  tables.scale = () => table(['Ladepunkte', 'MWh je Woche', 'ohne Engpass', 'kWh je LP und Tag', 'Ankünfte Spitze'],
    scale.map(s => [s.c, fmt.n(s.kwh / 1000, 2), fmt.n(s.free / 1000, 2), fmt.n(s.kwh / 7 / s.c), fmt.n(s.lam, 1)]));
  refreshTable('scale');
}

// ---------- Tabellen
const tables = {};
function table(head, rows) {
  return `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function refreshTable(k) { const b = $(`#tb-${k}`); if (b && !b.hidden) b.innerHTML = tables[k](); }
document.addEventListener('click', e => {
  const b = e.target.closest('[data-table]'); if (!b) return;
  const k = b.dataset.table, box = $(`#tb-${k}`);
  box.hidden = !box.hidden;
  b.textContent = box.hidden ? 'Tabelle' : 'Tabelle ausblenden';
  if (!box.hidden) box.innerHTML = tables[k]();
});

// ---------- Simulation im Worker
let worker, jobId = 0;
function simBase() {
  const d = R.d;
  return { c: S.c, plp: S.plp, ppark: R.ppark, setupH: R.setupH, A: S.A, mdtH: 4, T: R.T, ca: S.ca, qe: d.qe, qp: d.qp, rho: d.rho, sE: R.sE, sP: R.sP };
}
function runSim() {
  if (worker) worker.terminate();
  try { worker = new Worker('js/worker.js', { type: 'module' }); }
  catch { $('#sim-note').textContent = 'Simulation in diesem Browser nicht verfügbar.'; return; }
  const id = ++jobId;
  const base = simBase();
  const lams = [0.4, 0.65, 0.85, 1, 1.15, 1.3, 1.5].map(f => f * R.lam).filter(l => l < R.lMax);
  worker.onmessage = e => {
    const m = e.data; if (m.id !== id) return;
    if (m.kind === 'edge-progress') { simRes.edge = { points: m.points }; renderEdge(); }
    if (m.kind === 'edge-done') {
      simRes.edge = m; renderEdge();
      const dev = m.lambdaSim / R.lam - 1;
      $('#sim-note').innerHTML = `Simulation: Grenze bei <b>${fmt.n(m.lambdaSim, 1)}</b> Ankünften je Stunde (${dev >= 0 ? '+' : ''}${fmt.pct(dev, 1)} ggü. Analytik), dabei ${fmt.n(m.at.kwhPerH)} kWh je Stunde, Ø Warten ${fmt.n(m.at.wq * 60, 1)} min. Simuliert wurden ${fmt.n(m.at.hours)} Stunden. Ausfälle dauern im Mittel 4 h.${Math.abs(dev) > 0.15 ? ' <b>Die Abweichung ist groß:</b> Die analytische Näherung ist hier unsicher (sehr kurze Geduld im Verhältnis zur Belegdauer, sehr kleiner Park oder stark gepulste Ankünfte). Die Simulation ist dann maßgeblich.' : ''}`;
      const weekly = R.week.demand;
      const weeks = Math.max(4, Math.min(40, Math.round(60000 / Math.max(weekly, 1))));
      worker.postMessage({ id, kind: 'week', base, profile: R.prof.norm.map(v => v * R.lam), factor: 1, weeks });
    }
    if (m.kind === 'week-done') { simRes.week = m; renderWeek(); }
  };
  worker.postMessage({ id, kind: 'edge', base, lambdas: lams, lambdaGuess: R.lam, alpha: S.alpha });
}

// ---------- 02 Live-Park
// Zeigt genau eine Spitzenstunde. Vorher läuft eine unsichtbare Stunde zum Einschwingen,
// damit die gezeigte Stunde mit einem typisch belegten Park beginnt.
const live = { park: null, speed: 1, load: 1, playing: true, last: 0, visible: true, raf: 0, frame: 0, done: false, churned: [] };
function restartLive() {
  live.park = new Park({ ...simBase(), rate: R.lam * live.load, seed: (Math.random() * 1e9) | 0 });
  live.park.advance(1);
  live.park.reset();
  live.park.events.length = 0;
  live.t0 = live.park.t;
  live.churned = [];
  live.done = false;
  setPlay(!matchMedia('(prefers-reduced-motion: reduce)').matches);
  $('#load-note').innerHTML = loadNote();
  drawPark();
}
function loadNote() {
  const lam = R.lam * live.load;
  const rel = live.load === 1 ? 'genau die berechnete Grenze' : live.load < 1 ? `${fmt.pct(1 - live.load, 0)} unter der Grenze` : `${fmt.pct(live.load - 1, 0)} über der Grenze`;
  return `Nachfrage ${fmt.pct(live.load, 0)}: ${fmt.n(lam, 1)} Ankünfte in der Stunde, ${rel}. Analytisch erwartet: ${fmt.pct(M.evalHour(lam, R.P).churn, 1)} fahren weiter. Eine einzelne Stunde streut stark, der Mittelwert über viele Stunden steht im Kipppunkt (03).`;
}
function setPlay(on) {
  live.playing = on;
  const b = $('#play');
  b.textContent = live.done ? 'Neue Stunde' : on ? 'Pause' : 'Weiter';
  b.setAttribute('aria-pressed', String(on));
}
function liveLoop(ts) {
  live.raf = requestAnimationFrame(liveLoop);
  if (!live.playing || !live.visible || !live.park || live.done) { live.last = ts; return; }
  const dt = Math.min(0.1, (ts - (live.last || ts)) / 1000);
  live.last = ts;
  const p = live.park;
  const tEnd = live.t0 + 1;
  p.advance(Math.min(tEnd, p.t + dt * live.speed / 60));
  for (const e of p.events) if (e.type === 'churn') live.churned.push(e);
  p.events.length = 0;
  if (p.t >= tEnd - 1e-9) { live.done = true; setPlay(false); drawPark(); return; }
  if ((live.frame++ & 1) === 0) drawPark();
}
function carGlyph(x, y, w, fill, op = 1) {
  const h = w * 0.62;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.26}" fill="${fill}" opacity="${op}"/>` +
    `<rect x="${x + w * 0.2}" y="${y + h * 0.18}" width="${w * 0.6}" height="${h * 0.24}" rx="1.5" fill="var(--surface)" opacity=".75"/>`;
}
function drawPark() {
  const p = live.park; if (!p) return;
  const box = $('#park');
  const W = Math.max(box.clientWidth, 300);
  const n = p.lps.length;
  const narrow = W < 560;
  const cols = Math.min(n, narrow ? 5 : 10);
  const rows = Math.ceil(n / cols);
  const gap = 8, bayW = Math.min(64, (W - gap * (cols - 1)) / cols), bayH = Math.min(86, bayW * 1.45);
  const top = narrow ? 104 : 58;
  const laneH = 50;
  const lanesY = top + rows * (bayH + 26) + 10;
  const H = lanesY + 2 * laneH + 4;
  const ch = css('--charge'), su = css('--setup'), dn = css('--down'), wt = css('--wait'), cr = css('--churn'), ink = css('--ink'), hair = css('--hair'), surf = css('--surface-2');
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Animierte Spitzenstunde im Ladepark">`;

  // Uhr der Spitzenstunde mit Fortschritt
  const pk = R.prof.peakIdx, day = DAYS[Math.floor(pk / 24)], h0 = pk % 24;
  const el = Math.max(0, Math.min(1, p.t - live.t0)), min = Math.floor(el * 60);
  const half = narrow ? W : W * 0.48;
  s += `<text x="0" y="14" class="lbl">Spitzenstunde ${day} ${h0}–${h0 + 1} Uhr</text>`;
  const clock = live.done ? `${String(h0 + 1).padStart(2, '0')}:00 · Stunde vorbei` : `${String(h0).padStart(2, '0')}:${String(Math.min(59, min)).padStart(2, '0')}`;
  s += `<text x="0" y="34" class="clock">${day} ${clock}</text>`;
  const cl = narrow ? W : half - 24;
  s += `<rect x="0" y="44" width="${cl}" height="4" rx="2" fill="${surf}"/><rect x="0" y="44" width="${cl * el}" height="4" rx="2" fill="${ink}"/>`;
  // Parkleistung: rechts daneben, mobil in eigener Zeile
  const pmax = R.pEff, pw = p.power || 0;
  const gx = narrow ? 0 : half, gw = W - gx, gy = narrow ? 46 : 0;
  s += `<text x="${gx}" y="${gy + 14}" class="lbl">Parkleistung</text><text x="${W}" y="${gy + 34}" text-anchor="end" class="lp-kw">${fmt.n(pw)} / ${fmt.n(pmax)} kW</text>`;
  s += `<rect x="${gx}" y="${gy + 44}" width="${gw}" height="4" rx="2" fill="${surf}"/><rect x="${gx}" y="${gy + 44}" width="${gw * Math.min(1, pw / pmax)}" height="4" rx="2" fill="${ch}"/>`;

  // Ladepunkte
  p.lps.forEach((l, i) => {
    const cx = (i % cols) * (bayW + gap), cy = top + Math.floor(i / cols) * (bayH + 26);
    s += `<rect x="${cx}" y="${cy}" width="${bayW}" height="${bayH}" rx="7" fill="none" stroke="${hair}" stroke-width="1.2"/>`;
    if (l.st === STATE.CHARGE || l.st === STATE.SETUP) {
      const prog = l.v ? 1 - l.v.e / l.v.e0 : 1;
      const fillH = (bayH - 8) * (l.st === STATE.SETUP ? 1 : prog);
      s += `<rect x="${cx + 4}" y="${cy + bayH - 4 - fillH}" width="${bayW - 8}" height="${fillH}" rx="4" fill="${l.st === STATE.SETUP ? su : ch}" opacity="${l.st === STATE.SETUP ? 1 : 0.9}"/>`;
      const vw = bayW * 0.5;
      s += carGlyph(cx + (bayW - vw) / 2, cy + 8, vw, ink, l.st === STATE.SETUP ? 0.35 : 0.85);
    } else if (l.st === STATE.DOWN) {
      s += `<path d="M${cx + bayW * 0.3},${cy + bayH * 0.35}L${cx + bayW * 0.7},${cy + bayH * 0.65}M${cx + bayW * 0.7},${cy + bayH * 0.35}L${cx + bayW * 0.3},${cy + bayH * 0.65}" stroke="${dn}" stroke-width="2.2" stroke-linecap="round"/>`;
    }
    const lab = l.st === STATE.CHARGE ? `${fmt.n(l.p)} kW` : l.st === STATE.SETUP ? 'Wechsel' : l.st === STATE.DOWN ? 'Störung' : 'frei';
    s += `<text x="${cx + bayW / 2}" y="${cy + bayH + 15}" text-anchor="middle" class="${l.st === STATE.CHARGE ? 'lp-kw' : 'lp-label'}">${lab}</text>`;
  });

  // Spur 1: Warteschlange, Balken unter jedem Auto zeigt die Wartezeit bis zur Geduldsgrenze T
  const cw = 26, step = 34, maxCars = Math.max(1, Math.floor((W - 4) / step));
  const qn = p.queue.length;
  s += `<line x1="0" x2="${W}" y1="${lanesY - 4}" y2="${lanesY - 4}" stroke="${hair}"/>`;
  s += `<text x="0" y="${lanesY + 10}" class="lbl">Warteschlange · ${qn}</text>`;
  if (!qn) s += `<text x="0" y="${lanesY + 32}" class="lp-label">niemand wartet</text>`;
  p.queue.slice(0, maxCars).forEach((v, i) => {
    const x = i * step, y = lanesY + 18;
    const w = Math.min(1, (p.t - v.arr) / R.T);
    s += carGlyph(x, y, cw, wt);
    s += `<rect x="${x}" y="${y + 20}" width="${cw}" height="3" rx="1.5" fill="${surf}"/><rect x="${x}" y="${y + 20}" width="${cw * w}" height="3" rx="1.5" fill="${w > 0.8 ? cr : wt}"/>`;
  });
  if (qn > maxCars) s += `<text x="${W}" y="${lanesY + 10}" text-anchor="end" class="lp-label">+${qn - maxCars} weitere</text>`;

  // Spur 2: Weitergefahren in dieser Stunde, ein rotes Auto je Kunde
  const ly = lanesY + laneH;
  const cn = live.churned.length;
  s += `<text x="0" y="${ly + 10}" class="lbl">Weitergefahren nach ${fmt.n(S.T)} min · ${cn}</text>`;
  if (!cn) s += `<text x="0" y="${ly + 32}" class="lp-label">noch niemand</text>`;
  live.churned.slice(-maxCars).forEach((e, i) => {
    const fresh = Math.max(0, 1 - (p.t - e.t) * 60 / 1.5);   // 1,5 Minuten hervorgehoben
    s += carGlyph(i * step, ly + 18, cw, cr, 0.55 + 0.45 * fresh);
  });
  if (cn > maxCars) s += `<text x="${W}" y="${ly + 10}" text-anchor="end" class="lp-label">${cn - maxCars} weitere</text>`;
  s += '</svg>';
  box.innerHTML = s;

  // Kennzahlen dieser Stunde
  const st = p.summary();
  const ok = st.hours > 0.02;
  $('#live-stats').innerHTML = [
    ['Ankünfte', fmt.n(p.stats.arr)],
    ['Weitergefahren', p.stats.arr ? `${fmt.n(p.stats.churn)} · ${fmt.pct(p.stats.churn / p.stats.arr, 1)}` : '0'],
    ['Ø Warten', `${fmt.n(st.wq * 60, 1)} min`],
    ['Geladen', `${fmt.n(p.stats.kwh)} kWh`],
    ['Belegt Ø', ok ? `${fmt.n(st.busy, 1)} von ${S.c}` : '–'],
  ].map(([a, b]) => `<div>${a}<b>${b}</b></div>`).join('');
}
function liveControls() {
  segSet('#seg-speed', live.speed); segSet('#seg-load', live.load);
  $('#seg-speed').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; live.speed = +b.dataset.v; segSet('#seg-speed', live.speed); });
  $('#seg-load').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; live.load = +b.dataset.v; segSet('#seg-load', live.load); restartLive(); });
  $('#play').addEventListener('click', () => { if (live.done) restartLive(); else setPlay(!live.playing); });
  new IntersectionObserver(es => { live.visible = es[0].isIntersecting; }).observe($('#park'));
  live.raf = requestAnimationFrame(liveLoop);
}

// ---------- Hero-Bild: der Wochenrhythmus als Bergkette
function renderHero() {
  const prof = profileFor(5);
  const svg = $('#hero-art');
  const W = 420, H = 180, base = 150;
  const pts = prof.norm.map((v, i) => [i / 167 * W, base - v * 118]);
  const sm = pts.map((p, i) => { const a = pts[Math.max(0, i - 1)][1], b = pts[Math.min(167, i + 1)][1]; return [p[0], (a + 2 * p[1] + b) / 4]; });
  const d = sm.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const pk = sm[prof.peakIdx];
  const lim = base - 118;
  svg.innerHTML = `
    <path d="${d}L${W},${base}L0,${base}Z" fill="var(--s1-soft)"/>
    <path d="${d}" fill="none" stroke="var(--s1)" stroke-width="1.6" stroke-linejoin="round"/>
    <line x1="0" x2="${W}" y1="${lim}" y2="${lim}" stroke="var(--ink-2)" stroke-dasharray="3 3"/>
    <text x="0" y="${lim - 7}" font-size="11" fill="var(--ink-2)">Grenze ohne Churn</text>
    <circle cx="${pk[0]}" cy="${lim}" r="4.5" fill="var(--ink)" stroke="var(--page)" stroke-width="2"/>
    <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--axis)"/>
    ${DAYS.map((t, i) => `<text x="${i * 60 + 4}" y="${base + 16}" font-size="11" fill="var(--muted)">${t}</text>`).join('')}
    <text x="${pk[0] - 10}" y="${lim - 7}" text-anchor="end" font-size="11" fill="var(--ink)" font-weight="600">Spitzenstunde</text>`;
}

// ---------- 08 Methodik
function renderMethod() {
  const { d, prof, season, svc } = R;
  const yd = d.y;
  const pkTxt = hourLabel(prof.peakIdx);
  const lvl = svc.level[S.c];
  $('#method').innerHTML = `
    <h3>Frage</h3>
    <p>Wie viel Energie kann ein Schnellladepark mit gegebener Technik höchstens abgeben, wenn die Nachfrage nicht der Engpass ist? Hier wird „höchstens“ als „gerade noch ohne nennenswerten Kundenverlust“ gelesen. In der Spitzenstunde der Woche darf höchstens der Anteil α der Kunden länger als T warten müssen. Wer länger warten müsste, fährt weiter (Churn).</p>

    <h3>Vorgehen</h3>
    <ol>
      <li><b>Kunden aus Daten.</b> Lademenge und effektive Ladeleistung (Energie durch Belegdauer) stammen aus den Histogrammen der Klasse ${d.cls.label}, Jahr ${S.year} (${fmt.n(yd.n)} Ladevorgänge an ${fmt.n(yd.lps)} Ladepunkten). Beide Größen sind in den Daten nur einzeln verfügbar. Gekoppelt werden sie über eine Gauß-Copula mit ρ = ${fmt.n(d.rho, 2)}. ρ ist so kalibriert, dass die mittlere Belegdauer der Daten (${fmt.n(yd.h_mean * 60, 1)} min) getroffen wird.${S.pmin > 0 ? ` Danach werden Vorgänge mit weniger als ${fmt.n(S.pmin)} kW effektiver Leistung entfernt (${fmt.pct(d.removed, 1)}): Fahrzeuge, die über einen DC-Ladevorgang im Mittel darunter bleiben, sind am Markt kaum vertreten. Solche Werte entstehen in den Daten vor allem durch Standzeit nach Ladeende. Die mittlere Leistung steigt dadurch von ${fmt.n(d.meansAll.p, 1)} auf ${fmt.n(d.means.p, 1)} kW.` : ''} Größere Ladungen gehen damit eher mit höherer Leistung einher. Die Schieberegler skalieren die Verteilungen auf einen neuen Mittelwert, die Form bleibt.</li>
      <li><b>Bedienzeit je Belegung.</b> Ein Fahrzeug lädt mit min(eigene Leistung, Ladepunkt, Anteil am Netzanschluss). Sind n Ladepunkte belegt und reicht der Netzanschluss nicht, verteilt das Lastmanagement per Water-Filling: Langsame Fahrzeuge bekommen, was sie können, der Rest wird gleich auf die übrigen aufgeteilt.${R.capped && Number.isFinite(lvl) ? ` Bei voller Belegung liegt die Obergrenze je Fahrzeug aktuell bei ${fmt.n(lvl)} kW.` : ''} Nach dem Laden folgt die Wechselzeit, in der der Ladepunkt belegt bleibt, aber keine Energie liefert.</li>
      <li><b>Warteschlange.</b> Analytisch als M/M/c+D: Geburts-Todes-Prozess mit zustandsabhängiger Bedienrate μ<sub>n</sub> = n / E[S<sub>n</sub>] und fester Geduld T. Die Verteilung der Bedienzeit (Variationskoeffizient c<sub>S</sub>) und die Streuung der Ankünfte (c<sub>A</sub>) gehen über den Allen-Cunneen-Faktor ein: Wartezeiten skalieren mit (c<sub>A</sub>² + c<sub>S</sub>²)/2. Ausfälle werden als Mischung über die verfügbaren Ladepunkte k ~ Bin(c, A) gerechnet. Das ist dieselbe Modellfamilie wie im <a href="https://www.mathematik.tu-clausthal.de/studium/mathematik-interaktiv/warteschlangentheorie/warteschlangenrechner" target="_blank" rel="noopener">Warteschlangenrechner der TU Clausthal</a> (G/G/c mit c<sub>A</sub>, c<sub>S</sub> und Verfügbarkeit).</li>
      <li><b>Optimum.</b> Die Ankunftsrate λ* der Spitzenstunde wird per Bisektion gesucht, bis P(Warten &gt; T) = α.</li>
      <li><b>Zurückrechnen.</b> Jede Stunde h der Woche bekommt λ<sub>h</sub> = λ* · n<sub>h</sub> / n<sub>max</sub>, wobei n<sub>h</sub> die gemessenen Ladestarts sind. Jede Stunde wird für sich als eingeschwungen gerechnet. Spitzenstunde im gewählten Profil: ${pkTxt}, das ${fmt.n(prof.peakToAvg, 2)}-Fache der Durchschnittsstunde. Für das Jahr skaliert der Monatsindex (Ladevorgänge je Ladepunkt und Tag, ${season.year}) die Woche. Bei „Ø Woche“ liegt die Grenze auf der Durchschnittswoche, bei „Spitzenmonat“ auf dem stärksten Monat.</li>
      <li><b>Gegenprobe.</b> Eine ereignisdiskrete Simulation zieht jedes Fahrzeug einzeln aus denselben Verteilungen, teilt den Netzanschluss in jedem Moment neu auf, lässt Ladepunkte zufällig ausfallen (mittlere Störungsdauer 4 h) und schickt Kunden nach T Wartezeit weg. Sie läuft im Hintergrund und wird als Punkte bzw. Linie eingeblendet.</li>
    </ol>
    <div class="formula">P(W &gt; T) = λ·π<sub>c−1</sub>·e<sup>−(μ<sub>c</sub>−λ)T/f</sup> / μ<sub>c</sub> &nbsp;/&nbsp; Σ … &nbsp;&nbsp; mit f = (c<sub>A</sub>² + c<sub>S</sub>²)/2 &nbsp;&nbsp; aktuell c<sub>S</sub>² = ${fmt.n(svc.cs2[S.c], 2)}</div>

    <h3>Annahmen, die du kennen solltest</h3>
    <ul>
      <li><b>Nachfrage ist beliebig steigerbar.</b> Der Rechner zeigt die Kapazität des Parks, nicht die Nachfrage am Standort. Ob es genug Kunden gibt, ist eine eigene Frage.</li>
      <li><b>Der Wochenrhythmus ist fest.</b> Das Profil ist über alle Jahre und alle meldenden Ladepunkte der Klasse aggregiert. Ein einzelner Standort (Autobahn, Innenstadt, Logistikhof) kann deutlich abweichen.</li>
      <li><b>Die Ladeleistung ist ein Mittelwert je Vorgang.</b> Ladekurven sind nicht modelliert. Die effektive Leistung enthält in den Daten auch Standzeit nach Ladeende. Lademenge und Leistung werden mit einer kalibrierten Kopplung verbunden, die echte gemeinsame Verteilung ist nicht veröffentlicht.</li>
      <li><b>Geduld ist für alle gleich (T).</b> In Wirklichkeit streut sie. Wer den Park schon voll sieht, fährt eventuell sofort weiter.</li>
      <li><b>Punktweise stationär.</b> Jede Stunde wird für sich als eingeschwungen betrachtet. Die Warteschlange aus der Vorstunde wird nicht mitgenommen. In steilen Flanken ist das leicht optimistisch.</li>
      <li><b>Ergebnis in kWh.</b> Ohne Preise, Kosten oder Marge.</li>
    </ul>

    <h3>Daten</h3>
    <p>${D.meta.source}. Zeitraum ${D.meta.range[0]} bis ${D.meta.range[1]}. Aufbereitet im Projekt <a href="https://ehheuer.github.io/AuswertungMobilithek/" target="_blank" rel="noopener">Ladebilanz · AuswertungMobilithek</a> (Plausibilisierung, Leistungsklassen nach Nennleistung des Ladepunkts). Übernommen werden nur die aggregierten Verteilungen der DC-Klassen. Stand des Extrakts: ${D.meta.generated}.</p>
    <table>
      <tr><th>Klasse ${d.cls.label}, ${S.year}</th><th>Wert</th></tr>
      <tr><td>Ø Lademenge</td><td>${fmt.n(yd.e_mean, 1)} kWh</td></tr>
      <tr><td>Ø effektive Leistung je Vorgang</td><td>${fmt.n(yd.kw_mean, 1)} kW (Median ${fmt.n(yd.kw_med, 1)} kW)</td></tr>
      <tr><td>Ø Belegdauer</td><td>${fmt.n(yd.h_mean * 60, 1)} min</td></tr>
      <tr><td>Spitzenbelegung DC ${S.year} (bundesweit)</td><td>${D.occupancy_dc[S.year] ? `${fmt.pct(D.occupancy_dc[S.year].share, 1)} am ${D.occupancy_dc[S.year].ts}` : '–'}</td></tr>
    </table>`;
  $('#foot-source').innerHTML = `Daten: ${D.meta.source}. Methodik angelehnt an den Warteschlangenrechner der TU Clausthal.`;
}

// ---------- Theme
function theme() {
  const btn = $('#theme');
  const saved = (() => { try { return localStorage.getItem('wsr-theme'); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  btn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('wsr-theme', next); } catch { /* egal */ }
    renderHero(); update();
  });
}

// ---------- Navigation markieren
function navSpy() {
  const links = [...document.querySelectorAll('.nav a')];
  const io = new IntersectionObserver(es => {
    es.forEach(e => { if (e.isIntersecting) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === `#${e.target.id}`)); });
  }, { rootMargin: '-40% 0px -55% 0px' });
  document.querySelectorAll('.block').forEach(b => io.observe(b));
}

// ---------- Start
async function main() {
  theme();
  D = await (await fetch('data/ladeprofil.json')).json();
  setDefaults();
  readUrl();
  buildFields();
  buildSegs();
  syncControls();
  liveControls();
  renderHero();
  update();
  navSpy();
  window.addEventListener('resize', () => drawPark());
}
main().catch(err => {
  console.error(err);
  document.querySelector('#summary').textContent = `Fehler beim Laden: ${err.message}`;
});
void showTip; void hideTip;
