// Simulation im Hintergrund: Gegenprobe zur Analytik.
import { Park } from './sim.js';

let job = 0;

self.onmessage = e => {
  const { id, kind, base, lambdas, lambdaGuess, alpha, profile, factor, weeks } = e.data;
  job = id;
  if (kind === 'edge') runEdge(id, base, lambdas, lambdaGuess, alpha);
  else if (kind === 'week') runWeek(id, base, profile, factor, weeks);
};

function stationary(base, lambda, hours, seed) {
  const park = new Park({ ...base, rate: lambda, seed });
  park.advance(6);          // Einschwingen
  park.reset();
  park.advance(6 + hours);
  return park.summary();
}

function hoursFor(lambda, base) {
  // Genug Ankünfte für eine stabile Churn-Schätzung, aber begrenzte Rechenzeit
  return Math.min(4000, Math.max(300, 25000 / Math.max(lambda, 1)));
}

function runEdge(id, base, lambdas, guess, alpha) {
  const points = [];
  for (const lam of lambdas) {
    const r = stationary(base, lam, hoursFor(lam, base), 7);
    points.push({ lambda: lam, ...r });
    self.postMessage({ id, kind: 'edge-progress', points });
  }
  // Bisektion auf Churn = α mit festen Zufallszahlen (gemeinsame Zufallszahlen glätten die Kurve)
  let a = guess * 0.5, b = guess * 1.6;
  for (let it = 0; it < 12; it++) {
    const m = (a + b) / 2;
    const r = stationary(base, m, hoursFor(m, base) * 0.6, 11);
    if (r.churn > alpha) b = m; else a = m;
  }
  const lam = (a + b) / 2;
  const at = stationary(base, lam, hoursFor(lam, base), 13);
  self.postMessage({ id, kind: 'edge-done', points, lambdaSim: lam, at });
}

function runWeek(id, base, profile, factor, weeks) {
  const park = new Park({ ...base, rate: h => profile[h] * factor, bins: 168, seed: 21 });
  park.advance(24);
  park.reset();
  const step = 168;
  for (let w = 0; w < weeks; w++) {
    park.advance(24 + step * (w + 1));
  }
  const b = park.stats.bin;
  const n = weeks;
  const hours = Array.from({ length: 168 }, (_, h) => ({
    kwh: b.kwh[h] / n,
    arr: b.arr[h] / n,
    churn: b.arr[h] ? b.churn[h] / b.arr[h] : 0,
    busy: b.dur[h] ? b.busy[h] / b.dur[h] : 0,
  }));
  self.postMessage({ id, kind: 'week-done', hours, summary: park.summary(), weeks });
}
