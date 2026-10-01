// Rechenkern: Kundenverteilung aus OBELIS-Histogrammen, analytisches Warteschlangenmodell.
// Alle Zeiten in Stunden, Leistungen in kW, Energien in kWh.

// ---------- Normalverteilung
export function phi(z) {
  // Abramowitz-Stegun 7.1.26 über erf, Fehler < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// ---------- Quantile aus Histogramm
// counts[i] gehört zu [edges[i], edges[i+1]); der letzte Eintrag ist der Überlauf ab edges[last].
export function quantileTable(counts, edges, { geometric = false, size = 2048 } = {}) {
  const n = counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  const cum = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += counts[i]; cum[i] = acc / total; }
  const lo = i => edges[Math.min(i, edges.length - 1)];
  const hi = i => (i + 1 < edges.length ? edges[i + 1] : edges[edges.length - 1] * 1.15);
  const tab = new Float64Array(size);
  let i = 0;
  for (let k = 0; k < size; k++) {
    const u = (k + 0.5) / size;
    while (i < n - 1 && cum[i] < u) i++;
    const prev = i ? cum[i - 1] : 0;
    const f = (u - prev) / Math.max(cum[i] - prev, 1e-12);
    const a = lo(i), b = hi(i);
    tab[k] = geometric && a > 0 ? a * Math.pow(b / a, f) : a + (b - a) * f;
  }
  return tab;
}

export function q(tab, u) {
  const x = u * tab.length - 0.5;
  if (x <= 0) return tab[0];
  if (x >= tab.length - 1) return tab[tab.length - 1];
  const i = Math.floor(x), f = x - i;
  return tab[i] * (1 - f) + tab[i + 1] * f;
}

// ---------- Kundenpopulation: Energie und Fahrzeugleistung, über Gauß-Copula gekoppelt
const G = 36;
const NODES = (() => {
  const z = [], w = [];
  for (let i = 0; i < G; i++) { const x = -3.2 + 6.4 * (i + 0.5) / G; z.push(x); w.push(Math.exp(-x * x / 2)); }
  const s = w.reduce((a, b) => a + b, 0);
  return { z, w: w.map(v => v / s), u: z.map(phi) };
})();

export function makePopulation({ qe, qp, rho, sE = 1, sP = 1 }) {
  const n = G * G;
  const e = new Float64Array(n), p = new Float64Array(n), w = new Float64Array(n);
  const r2 = Math.sqrt(1 - rho * rho);
  const eu = NODES.u.map(u => q(qe, u));
  let k = 0;
  for (let i = 0; i < G; i++) {
    for (let j = 0; j < G; j++) {
      const zp = rho * NODES.z[i] + r2 * NODES.z[j];
      e[k] = eu[i] * sE;
      p[k] = q(qp, phi(zp)) * sP;
      w[k] = NODES.w[i] * NODES.w[j];
      k++;
    }
  }
  return { e, p, w, n };
}

export function popMeans(pop) {
  let me = 0, mp = 0, ms = 0;
  for (let k = 0; k < pop.n; k++) { me += pop.w[k] * pop.e[k]; mp += pop.w[k] * pop.p[k]; ms += pop.w[k] * pop.e[k] / pop.p[k]; }
  return { e: me, p: mp, h: ms };
}

// Kopplung so wählen, dass die mittlere Ladedauer der Daten getroffen wird.
export function calibrateRho(qe, qp, hTarget) {
  const h = rho => popMeans(makePopulation({ qe, qp, rho })).h;
  if (h(0) <= hTarget) return 0;
  let a = 0, b = 0.95;
  if (h(b) > hTarget) return b;
  for (let it = 0; it < 30; it++) { const m = (a + b) / 2; if (h(m) > hTarget) a = m; else b = m; }
  return (a + b) / 2;
}

// ---------- Bedienprozess je Belegungszustand
// n Fahrzeuge laden gleichzeitig. Dynamisches Lastmanagement verteilt den Netzanschluss per
// Water-Filling: jedes Fahrzeug bekommt min(eigene Leistung, Ladepunkt, Füllstand L).
export function buildService(pop, { plp, ppark, setupH, cMax }) {
  const { e, w, n } = pop;
  const p = new Float64Array(n);
  let Ep = 0, Ee = 0;
  for (let k = 0; k < n; k++) { p[k] = Math.min(pop.p[k], plp); Ep += w[k] * p[k]; Ee += w[k] * e[k]; }
  const meanCapped = L => { let s = 0; for (let k = 0; k < n; k++) s += w[k] * Math.min(p[k], L); return s; };
  const mu = new Float64Array(cMax + 1), cs2 = new Float64Array(cMax + 1), level = new Float64Array(cMax + 1);
  const capped = new Uint8Array(cMax + 1);
  for (let c = 1; c <= cMax; c++) {
    let L = Infinity;
    if (Number.isFinite(ppark) && c * Ep > ppark) {
      let a = 0, b = plp;
      for (let it = 0; it < 40; it++) { const m = (a + b) / 2; if (c * meanCapped(m) > ppark) b = m; else a = m; }
      L = (a + b) / 2; capped[c] = 1;
    }
    let m1 = 0, m2 = 0;
    for (let k = 0; k < n; k++) {
      const s = e[k] / Math.min(p[k], L) + setupH;
      m1 += w[k] * s; m2 += w[k] * s * s;
    }
    mu[c] = c / m1;
    cs2[c] = m2 / (m1 * m1) - 1;
    level[c] = L;
  }
  const s1 = 1 / mu[1];
  return { mu, cs2, level, capped, Ee, Ep, S1: s1, cMax };
}

// ---------- M/M/k + D(T): Kunden fahren weiter, wenn sie länger als T warten müssten
// Virtuelle Wartezeit V: Dichte λ·π(k-1)·exp(-(μk-λ)v) für v < T, danach exp(-μk(v-T)).
// G/G/k-Korrektur nach Allen-Cunneen: Wartezeiten skalieren mit f = (ca² + cs²)/2, umgesetzt als T/f.
function mmkd(lambda, k, svc, T, ca2) {
  if (k <= 0) return { churn: 1, busy: 0, wq: 0, pw: 1 };
  if (lambda <= 0) return { churn: 0, busy: 0, wq: 0, pw: 0 };
  const mu = svc.mu;
  // Geburts-Todes-Prozess bis k-1, unnormiert, mit Umskalierung gegen Überlauf
  let last = 1, sum = 1, busy = 0;
  for (let n = 1; n < k; n++) {
    last = last * lambda / mu[n];
    if (last > 1e200) { last /= 1e200; sum /= 1e200; busy /= 1e200; }
    sum += last; busy += n * last;
  }
  const muk = mu[k];
  const f = Math.max((ca2 + svc.cs2[k]) / 2, 0.05);
  const Te = T / f;
  const d = muk - lambda;
  if (-d * Te > 600) {
    // starke Überlast: Warteraum läuft voll, es bleibt ein Verlustsystem mit Durchsatz μk
    return { churn: 1 - muk / lambda, busy: k, wq: T, pw: 1 };
  }
  const a = lambda * last;
  const inner = Math.abs(d) < 1e-9 ? a * Te : a * (1 - Math.exp(-d * Te)) / d;
  const tail = a * Math.exp(-d * Te) / muk;
  const vpos = inner + tail;
  const total = sum + vpos;
  const churn = tail / total;
  // Mittlere Wartezeit der Bedienten (in realer Zeit, also ×f)
  let wqi;
  if (Math.abs(d) < 1e-9) wqi = a * Te * Te / 2;
  else wqi = a * (1 - Math.exp(-d * Te) * (1 + d * Te)) / (d * d);
  const served = 1 - churn;
  const wq = served > 0 ? (wqi / total) / served * f : 0;
  // Belegte Ladepunkte: unter k wie Geburts-Todes-Prozess, sonst alle k
  const busyAll = (busy + k * vpos) / total;
  return { churn, busy: busyAll, wq, pw: vpos / total };
}

// Mischung über verfügbare Ladepunkte k ~ Bin(c, A)
export function evalHour(lambda, P) {
  const { c, A, svc, T, ca2 } = P;
  let churn = 0, busy = 0, wq = 0, pw = 0, wsum = 0;
  const lnC = lgammaTable(c);
  for (let k = c; k >= 0; k--) {
    const lw = lnC[c] - lnC[k] - lnC[c - k] + k * Math.log(A) + (c - k) * (A < 1 ? Math.log(1 - A) : (c === k ? 0 : -Infinity));
    const wk = Math.exp(lw);
    if (wk < 1e-7 && k < c) { if (wsum > 0.9999) break; else continue; }
    const r = mmkd(lambda, k, svc, T, ca2);
    churn += wk * r.churn; busy += wk * r.busy; wq += wk * r.wq * (1 - r.churn); pw += wk * r.pw; wsum += wk;
  }
  churn /= wsum; busy /= wsum; pw /= wsum;
  wq = wq / wsum / Math.max(1 - churn, 1e-9);
  const served = lambda * (1 - churn);
  return { lambda, churn, busy, wq, pw, served, kwh: served * svc.Ee };
}

const LG = [0];
function lgammaTable(n) {
  for (let i = LG.length; i <= n; i++) LG[i] = LG[i - 1] + Math.log(i);
  return LG;
}

// Größte Ankunftsrate, bei der der Churn gerade noch ≤ α bleibt
export function findLambda(P, alpha) {
  const muMax = P.svc.mu[P.c];
  let a = 0, b = muMax * 2.5;
  if (evalHour(b, P).churn <= alpha) return b;
  for (let it = 0; it < 34; it++) {
    const m = (a + b) / 2;
    if (evalHour(m, P).churn > alpha) b = m; else a = m;
  }
  return a;
}

// ---------- Hochrechnung auf Woche und Jahr
// profile: 168 Gewichte (Mo 0 Uhr bis So 23 Uhr), normiert auf Maximum 1.
// Jede Stunde wird als eingeschwungen betrachtet (punktweise stationäre Näherung).
export function evalWeek(lambdaPeak, factor, profile, P) {
  const hours = new Array(168);
  let kwh = 0, n = 0, lost = 0, demand = 0;
  for (let h = 0; h < 168; h++) {
    const lam = lambdaPeak * factor * profile[h];
    const r = evalHour(lam, P);
    hours[h] = r;
    kwh += r.kwh; n += r.served; lost += lam * r.churn; demand += lam;
  }
  return { hours, kwh, n, lost, demand, churn: demand > 0 ? lost / demand : 0 };
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function evalYear(lambdaPeak, season, ref, profile, P) {
  // season: 12 Monatsindizes (Ladevorgänge je Ladepunkt und Tag), ref: Bezugswert der Auslegung
  const months = season.map((s, m) => {
    const wk = evalWeek(lambdaPeak, s / ref, profile, P);
    const weeks = DAYS[m] / 7;
    return { m, factor: s / ref, kwh: wk.kwh * weeks, n: wk.n * weeks, lost: wk.lost * weeks, churn: wk.churn, peakChurn: Math.max(...wk.hours.map(h => h.churn)) };
  });
  const kwh = months.reduce((a, b) => a + b.kwh, 0);
  const n = months.reduce((a, b) => a + b.n, 0);
  const lost = months.reduce((a, b) => a + b.lost, 0);
  return { months, kwh, n, lost, churn: lost / (n + lost) };
}
