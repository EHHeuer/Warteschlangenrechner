"""Fasst das Ladesäulenregister der Bundesnetzagentur für Seite 2 zusammen.

    python pipeline/bnetza.py --src data/raw/ladesaeulen_2026-09-01.csv

Je Ladepunkt zählt die höchste Steckerleistung dieses Ladepunkts ("150; 150" -> 150).
Ergebnis: web/data/ladesaeulen.json (Leistungsklassen, Ausbau nach Inbetriebnahmejahr, Bundesländer).
"""
import argparse
import csv
import json
import re
from collections import defaultdict
from pathlib import Path

URL = ("https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/ElektrizitaetundGas/"
       "E-Mobilitaet/Ladesaeulenregister_BNetzA_2026-09-01.csv")
BINS = [("le22", "bis 22 kW", 0, 22), ("dc23", "23–49 kW", 22, 50), ("dc50", "50–149 kW", 50, 150),
        ("dc150", "150–299 kW", 150, 300), ("dc300", "ab 300 kW", 300, 1e9)]
THRESH = [50, 150, 300]


def nums(s):
    out = []
    for part in (s or "").split(";"):
        try:
            out.append(float(part.strip().replace(",", ".")))
        except ValueError:
            pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", default="web/data/ladesaeulen.json")
    ap.add_argument("--url", default=URL)
    a = ap.parse_args()

    with open(a.src, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f, delimiter=";"))
    stand = next((m.group(1) for r in rows[:15] for m in [re.search(r"(\d{2}\.\d{2}\.\d{4})", r[0] if r else "")] if m), None)
    hi = next(i for i, r in enumerate(rows) if r and r[0] == "Ladeeinrichtungs-ID")
    h = rows[hi]
    ix = {k: i for i, k in enumerate(h)}
    data = [r for r in rows[hi + 1:] if r and r[0].strip()]

    bins = {k: 0 for k, *_ in BINS}
    by_year = defaultdict(lambda: {t: 0 for t in THRESH})
    by_land = defaultdict(lambda: {t: 0 for t in THRESH})
    stations = {"normal": 0, "schnell": 0}
    status = defaultdict(int)
    total = 0
    for r in data:
        status[r[ix["Status"]]] += 1
        stations["schnell" if r[ix["Art der Ladeeinrichtung"]].startswith("Schnell") else "normal"] += 1
        n = int(float(r[ix["Anzahl Ladepunkte"]] or 0))
        p_site = (nums(r[ix["Nennleistung Ladeeinrichtung [kW]"]]) or [0])[0]
        d = r[ix["Inbetriebnahmedatum"]]
        year = d[-4:] if len(d) >= 4 and d[-4:].isdigit() else "unbekannt"
        land = r[ix["Bundesland"]] or "unbekannt"
        for k in range(1, n + 1):
            v = nums(r[ix.get(f"Nennleistung Stecker{k}", -1)]) if k <= 6 else []
            p = max(v) if v else p_site
            total += 1
            for key, _, lo, hi_ in BINS:
                if lo < p <= hi_ if key == "le22" else lo <= p < hi_:
                    bins[key] += 1
                    break
            for t in THRESH:
                if p >= t:
                    by_year[year][t] += 1
                    by_land[land][t] += 1

    out = {
        "stand": stand, "source": "Bundesnetzagentur, Ladesäulenregister", "url": a.url,
        "note": "Enthält nur Betreiber mit abgeschlossenem Anzeigeverfahren; der tatsächliche Bestand ist größer.",
        "ladepunkte": total, "stations": stations, "status": dict(status),
        "bins": [{"key": k, "label": l, "n": bins[k]} for k, l, *_ in BINS],
        "ab": {str(t): sum(v[t] for v in by_year.values()) for t in THRESH},
        "years": {y: {str(t): v[t] for t in THRESH} for y, v in sorted(by_year.items())},
        "laender": {l: {str(t): v[t] for t in THRESH} for l, v in sorted(by_land.items())},
    }
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{a.out}: Stand {stand}, {total} Ladepunkte, ab 50/150/300 kW: {out['ab']}")


if __name__ == "__main__":
    main()
