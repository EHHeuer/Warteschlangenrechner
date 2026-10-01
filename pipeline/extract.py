"""Extrahiert die Kennwerte für den Warteschlangenrechner aus der OBELIS-Auswertung.

Quelle ist die aggregierte Datei web/data/obelis.json aus dem Repo AuswertungMobilithek
(Datensatz OBELISöffentlich, NOW GmbH, CC BY 4.0). Es werden nur DC-Klassen übernommen.

    python pipeline/extract.py --src ../AuswertungMobilithek/web/data/obelis.json
"""
import argparse
import calendar
import json
from datetime import datetime
from pathlib import Path

DC = [3, 4, 5]  # 23-50 kW, 51-150 kW, > 150 kW


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="../AuswertungMobilithek/web/data/obelis.json")
    ap.add_argument("--out", default="web/data/ladeprofil.json")
    a = ap.parse_args()
    d = json.loads(Path(a.src).read_text(encoding="utf-8"))

    classes = {c["id"]: c for c in d["classes"]}
    cols = d["series"]["cols"]
    ix = {k: i for i, k in enumerate(cols)}

    out = {
        "meta": {
            "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "source": d["meta"]["source"],
            "source_url": d["meta"]["source_url"],
            "range": d["meta"]["range"],
            "demo": d["meta"].get("demo", False),
            "note": "Wochenprofil über alle Jahre aggregiert (Startzeitpunkte). "
                    "Verteilungen je Jahr und Klasse als Histogramme (Randverteilungen, keine Kopplung).",
        },
        "edges": {k: d["hist"][k]["edges"] for k in ("kwh", "kwavg", "h")},
        "classes": [],
    }

    for cid in DC:
        c = classes[cid]
        week = sorted(d["week"]["data"][str(cid)], key=lambda r: (r[0], r[1]))
        years = {}
        for y, per_cls in d["hist"]["kwh"]["data"].items():
            if str(cid) not in per_cls:
                continue
            row = next((r for r in d["series"]["year"]
                        if r[ix["dim"]] == "all" and r[ix["cls"]] == cid and r[ix["p"]].startswith(y)), None)
            if row is None or row[ix["n"]] < 5000:
                continue
            years[y] = {
                "n": row[ix["n"]],
                "lps": row[ix["lps"]],
                "e_mean": row[ix["e_mean"]],
                "h_mean": row[ix["h_mean"]],
                "kw_mean": row[ix["kw_mean"]],
                "kw_med": row[ix["kw_med"]],
                "kwh": d["hist"]["kwh"]["data"][y][str(cid)],
                "kwavg": d["hist"]["kwavg"]["data"][y][str(cid)],
                "h": d["hist"]["h"]["data"][y][str(cid)],
            }
        # Saison: Ladevorgänge je meldendem Ladepunkt und Tag, je Monat
        season = {}
        for r in d["series"]["month"]:
            if r[ix["dim"]] != "all" or r[ix["cls"]] != cid or not r[ix["lps"]]:
                continue
            y, m = int(r[0][:4]), int(r[0][5:7])
            days = calendar.monthrange(y, m)[1]
            season.setdefault(str(y), [None] * 12)[m - 1] = round(r[ix["n"]] / r[ix["lps"]] / days, 3)
        season = {y: v for y, v in season.items() if all(x is not None for x in v)}
        out["classes"].append({
            "id": cid, "key": c["key"], "label": c["label"],
            "week": [[r[0], r[1], r[2], r[3], r[4]] for r in week],  # dow(1=Mo), hod, n, e_mean, h_mean
            "years": years,
            "season": season,
        })

    peaks = d.get("occupancy", {}).get("peaks", {})
    out["occupancy_dc"] = {y: v["dc"] for y, v in peaks.items() if "dc" in v}

    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{a.out}: {Path(a.out).stat().st_size/1024:.0f} kB, Klassen {[c['id'] for c in out['classes']]}, "
          f"Jahre {[list(c['years']) for c in out['classes']]}")


if __name__ == "__main__":
    main()
