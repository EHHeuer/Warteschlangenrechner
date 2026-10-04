// Parkergebnis ohne Oberfläche: dieselbe Rechnung wie Seite 1 (Ergebnis, Jahr), für Seite 2.
// Eingaben sind die URL-Parameter von Seite 1; fehlende Werte bekommen dieselben Startwerte.
import * as M from './model.js?v=202610040744';

export const PARK_DEFAULTS = {
  c: 8, plp: 300, ppark: 1500, A: 0.98, setup: 1.5, pmin: 40, ca: 1, T: 10, alpha: 0.05,
  cls: 5, year: null, prof: 5, design: 'avg',
  dyn: false, dynN: 3, dynLow: 6, dynShift: 0.25, dynLoss: 0, price: 57, dynUp: 10, dynDown: 10,
};
export const PARK_KEYS = ['c', 'plp', 'ppark', 'A', 'setup', 'E', 'Pv', 'pmin', 'ca', 'T', 'alpha', 'cls', 'year', 'prof', 'design',
  'dyn', 'dynN', 'dynLow', 'dynShift', 'dynLoss', 'price', 'dynUp', 'dynDown'];

const latestYear = c => Object.keys(c.years).sort().pop();

export function readPark(D, search) {
  const p = new URLSearchParams(search);
  const S = { ...PARK_DEFAULTS };
  for (const k of PARK_KEYS) {
    if (!p.has(k)) continue;
    const v = p.get(k);
    if (k === 'year' || k === 'design') S[k] = v;
    else if (k === 'dyn') S.dyn = v === '1';
    else if (k === 'prof') S[k] = v === 'dc' ? 'dc' : +v;
    else if (Number.isFinite(+v)) S[k] = +v;
  }
  if (!D.classes.some(c => c.id === S.cls)) S.cls = 5;
  const cl = D.classes.find(c => c.id === S.cls);
  if (!cl.years[S.year]) S.year = latestYear(cl);
  const d = dataFor(D, S.cls, S.year);
  if (!Number.isFinite(S.E)) S.E = Math.round(d.eMean * 2) / 2;
  if (!Number.isFinite(S.Pv)) S.Pv = Math.round(M.tabMean(M.truncateTable(d.qpAll, S.pmin).tab));
  return S;
}

const cache = new Map();
function dataFor(D, cls, year) {
  const key = `${cls}-${year}`;
  if (cache.has(key)) return cache.get(key);
  const c = D.classes.find(x => x.id === cls);
  const y = c.years[year] || c.years[latestYear(c)];
  const qe = M.quantileTable(y.kwh, D.edges.kwh);
  const qpAll = M.quantileTable(y.kwavg, D.edges.kwavg, { geometric: true });
  const rho = M.calibrateRho(qe, qpAll, y.h_mean);
  const v = { cls: c, y, qe, qpAll, rho, eMean: M.tabMean(qe) };
  cache.set(key, v);
  return v;
}

function profileFor(D, p) {
  const w = new Array(168).fill(0);
  const add = c => c.week.forEach(([dow, hod, n]) => { w[(dow - 1) * 24 + hod] += n; });
  if (p === 'dc') D.classes.forEach(add); else add(D.classes.find(c => c.id === p));
  return w;
}

const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function parkYear(D, S) {
  const d = dataFor(D, S.cls, S.year);
  const fit = M.fitPower(d.qpAll, S.pmin, S.Pv);
  const pop = M.makePopulation({ qe: d.qe, qp: fit.tab, rho: d.rho, sE: S.E / d.eMean, sP: fit.s });
  const svc = M.buildService(pop, { plp: S.plp, ppark: S.ppark, setupH: S.setup / 60, cMax: 40 });
  const P = { c: S.c, A: S.A, svc, T: S.T / 60, ca2: S.ca * S.ca };
  let raw = profileFor(D, S.prof), price;
  if (S.dyn) {
    const sh = M.shiftProfile(raw, { nPeak: S.dynN, nLow: S.dynLow, shift: S.dynShift, loss: Math.min(S.dynLoss, 1 - S.dynShift) });
    raw = sh.raw;
    price = sh.tier.map(t => (S.price + (t > 0 ? S.dynUp : t < 0 ? -S.dynDown : 0)) / 100);
  }
  const mx = Math.max(...raw);
  const norm = raw.map(v => v / mx);
  const c = d.cls;
  const yrs = Object.keys(c.season).sort();
  const season = c.season[S.year] || c.season[yrs[yrs.length - 1]];
  const sMean = season.reduce((a, v, m) => a + v * MDAYS[m], 0) / 365;
  const ref = S.design === 'peak' ? Math.max(...season) : sMean;
  const lam = M.findLambda(P, S.alpha);
  const year = M.evalYear(lam, season, ref, norm, P, price);
  return { lam, year, perLp: year.kwh / S.c, revPerLp: price ? year.rev / S.c : null, classLabel: c.label, dataYear: S.year };
}
