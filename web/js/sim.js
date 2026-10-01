// Ereignisdiskrete Simulation eines Schnellladeparks.
// Fahrzeuge kommen an, laden mit Water-Filling unter dem Netzanschluss, belegen danach den
// Ladepunkt für die Wechselzeit. Wer länger als T wartet, fährt weiter (Churn).
import { phi, q } from './model.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r) {
  let u = r(); while (u <= 1e-12) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function gamma(r, k) {
  if (k < 1) return gamma(r, k + 1) * Math.pow(r() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

const IDLE = 0, CHARGE = 1, SETUP = 2, DOWN = 3;

export class Park {
  // o: { c, plp, ppark, setupH, A, mdtH, T, ca, qe, qp, rho, sE, sP, seed,
  //      rate: λ (konstant) oder Funktion stundeDerWoche -> λ, bins: 168 für Wochenstatistik }
  constructor(o) {
    this.o = o;
    this.r = rng(o.seed ?? 1);
    this.t = 0;
    this.k = o.ca > 0 ? 1 / (o.ca * o.ca) : 1;
    this.lps = Array.from({ length: o.c }, (_, i) => ({ i, st: IDLE, v: null, p: 0, until: 0, failAt: this.nextFail(0), pending: false }));
    this.queue = [];
    this.id = 0;
    this.stats = this.blankStats();
    this.events = [];                 // für die Animation: zuletzt passierte Ereignisse
    this.u = 0;                       // operationale Zeit für zeitvariable Ankünfte
    this.nextArr = this.drawArrival(0);
    this.dirty = true;
  }

  blankStats() {
    const b = this.o.bins || 0;
    return {
      T0: this.t, arr: 0, churn: 0, served: 0, kwh: 0, wsum: 0, waited: 0, busyInt: 0, powInt: 0, qInt: 0, peakPow: 0,
      bin: b ? { arr: new Float64Array(b), churn: new Float64Array(b), kwh: new Float64Array(b), busy: new Float64Array(b), dur: new Float64Array(b) } : null,
    };
  }

  reset() { this.stats = this.blankStats(); }

  nextFail(t) {
    const { A, mdtH } = this.o;
    if (!(A < 1)) return Infinity;
    const mtbf = mdtH * A / (1 - A);
    return t - Math.log(this.r() || 1e-12) * mtbf;
  }

  rateAt(t) {
    const R = this.o.rate;
    return typeof R === 'function' ? R(Math.floor(t) % 168) : R;
  }

  drawArrival(t) {
    // Erneuerungsprozess mit Variationskoeffizient ca in operationaler Zeit, Zeittransformation über λ(t)
    let need = gamma(this.r, this.k) / this.k;
    const R = this.o.rate;
    if (typeof R !== 'function') return R > 0 ? t + need / R : Infinity;
    let s = t;
    for (let guard = 0; guard < 2000; guard++) {
      const lam = this.rateAt(s);
      const end = Math.floor(s) + 1;
      const cap = lam * (end - s);
      if (cap >= need) return s + need / lam;
      need -= cap; s = end;
    }
    return Infinity;
  }

  vehicle() {
    const { qe, qp, rho, sE, sP } = this.o;
    const z1 = normal(this.r), z2 = normal(this.r);
    const e = q(qe, phi(z1)) * sE;
    const pv = q(qp, phi(rho * z1 + Math.sqrt(1 - rho * rho) * z2)) * sP;
    return { id: ++this.id, e, e0: e, pv: Math.min(pv, this.o.plp), arr: this.t, bin: this.binOf(this.t) };
  }

  binOf(t) { return this.o.bins ? Math.floor(t) % this.o.bins : 0; }

  allocate() {
    const ch = this.lps.filter(l => l.st === CHARGE);
    const P = this.o.ppark;
    let need = 0;
    for (const l of ch) need += l.v.pv;
    if (!Number.isFinite(P) || need <= P) { for (const l of ch) l.p = l.v.pv; }
    else {
      // Water-Filling
      const s = ch.map(l => l.v.pv).sort((a, b) => a - b);
      let rest = P, L = Infinity;
      for (let i = 0; i < s.length; i++) {
        const share = rest / (s.length - i);
        if (s[i] <= share) rest -= s[i]; else { L = share; break; }
      }
      for (const l of ch) l.p = Math.min(l.v.pv, L);
    }
    this.power = ch.reduce((a, l) => a + l.p, 0);
    this.dirty = false;
  }

  start(l, v) {
    l.st = CHARGE; l.v = v; v.start = this.t;
    const w = this.t - v.arr;
    const s = this.stats;
    s.served++; s.wsum += w; if (w > 1e-9) s.waited++;
    this.events.push({ t: this.t, type: 'start', lp: l.i, id: v.id });
    this.dirty = true;
  }

  advance(tEnd) {
    const o = this.o;
    let guard = 0;
    while (this.t < tEnd && guard++ < 5e6) {
      if (this.dirty) this.allocate();
      // nächstes Ereignis
      let tn = Math.min(tEnd, this.nextArr), kind = tn === this.nextArr ? 'arr' : 'end', who = null;
      for (const l of this.lps) {
        let te = Infinity;
        if (l.st === CHARGE) te = l.p > 0 ? this.t + l.v.e / l.p : Infinity;
        else if (l.st === SETUP || l.st === DOWN) te = l.until;
        if (te < tn) { tn = te; kind = 'lp'; who = l; }
        if (l.st === IDLE && l.failAt < tn) { tn = l.failAt; kind = 'fail'; who = l; }
      }
      if (this.queue.length) {
        const tr = this.queue[0].arr + o.T;
        if (tr < tn) { tn = tr; kind = 'renege'; }
      }
      if (o.bins) { const hb = Math.floor(this.t) + 1; if (hb < tn) { tn = hb; kind = 'tick'; } }
      this.integrate(tn - this.t);
      this.t = tn;
      if (kind === 'end' || kind === 'tick') continue;
      if (kind === 'arr') {
        const v = this.vehicle();
        this.stats.arr++; if (this.stats.bin) this.stats.bin.arr[v.bin]++;
        this.events.push({ t: this.t, type: 'arr', id: v.id });
        const free = this.lps.find(l => l.st === IDLE);
        if (free && !this.queue.length) this.start(free, v); else this.queue.push(v);
        this.nextArr = this.drawArrival(this.t);
      } else if (kind === 'renege') {
        const v = this.queue.shift();
        this.stats.churn++; if (this.stats.bin) this.stats.bin.churn[v.bin]++;
        this.events.push({ t: this.t, type: 'churn', id: v.id });
      } else if (kind === 'fail') {
        who.st = DOWN; who.until = this.t - Math.log(this.r() || 1e-12) * o.mdtH;
        this.events.push({ t: this.t, type: 'down', lp: who.i });
      } else if (kind === 'lp') {
        const l = who;
        if (l.st === CHARGE) {
          l.v.e = 0;
          this.events.push({ t: this.t, type: 'done', lp: l.i, id: l.v.id });
          l.st = SETUP; l.until = this.t + o.setupH; l.p = 0; this.dirty = true;
          if (o.setupH <= 0) l.until = this.t;
        } else {
          if (l.st === DOWN) { l.failAt = this.nextFail(this.t); this.events.push({ t: this.t, type: 'up', lp: l.i }); }
          l.st = IDLE; l.v = null;
          if (l.failAt <= this.t) { l.st = DOWN; l.until = this.t - Math.log(this.r() || 1e-12) * o.mdtH; continue; }
          if (this.queue.length) this.start(l, this.queue.shift());
        }
      }
    }
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  integrate(dt) {
    if (dt <= 0) return;
    const s = this.stats;
    let busy = 0, pow = 0;
    for (const l of this.lps) {
      if (l.st === CHARGE) { const de = Math.min(l.v.e, l.p * dt); l.v.e -= de; pow += de; busy++; }
      else if (l.st === SETUP) busy++;
    }
    s.kwh += pow; s.busyInt += busy * dt; s.qInt += this.queue.length * dt;
    if (pow / dt > s.peakPow) s.peakPow = pow / dt;
    if (s.bin) { const b = this.binOf(this.t); s.bin.kwh[b] += pow; s.bin.busy[b] += busy * dt; s.bin.dur[b] += dt; }
  }

  summary() {
    const s = this.stats, H = Math.max(this.t - s.T0, 1e-9);
    return {
      hours: H,
      arrivals: s.arr,
      churn: s.arr ? s.churn / s.arr : 0,
      kwhPerH: s.kwh / H,
      servedPerH: s.served / H,
      wq: s.served ? s.wsum / s.served : 0,
      pWait: s.served ? s.waited / s.served : 0,
      busy: s.busyInt / H,
      queue: s.qInt / H,
    };
  }
}

export const STATE = { IDLE, CHARGE, SETUP, DOWN };
