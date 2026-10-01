# Warteschlangenrechner · Schnellladepark

Interaktiver Rechner für die Frage: **Wie viel Energie kann ein Schnellladepark höchstens abgeben,
bevor Kunden wegen Wartezeit weiterfahren?**

Der Rechner treibt die Ankunftsrate in der stärksten Stunde der Woche hoch, bis höchstens der Anteil α
der Kunden länger als T Minuten warten müsste. Von dort rechnet er mit dem gemessenen Wochenrhythmus
deutscher DC-Ladepunkte auf Woche und Jahr zurück. Ergebnis in kWh.

## Starten

```bash
python -m http.server 8000 -d web
# -> http://localhost:8000
```

Kein Build-Schritt, keine Abhängigkeiten. Die Seite ist statisch (HTML, CSS, ES-Module, ein Web Worker).

## Einstellbar

| Gruppe | Parameter |
|---|---|
| Park | Ladepunkte (1–40), Leistung je Ladepunkt, Netzanschluss mit dynamischem Lastmanagement, Verfügbarkeit, Wechselzeit |
| Kunden | Ø Lademenge, Ø Ladeleistung der Fahrzeuge (Form der Verteilung aus den Daten), Streuung der Ankünfte (CV) |
| Grenze | Geduld T, erlaubter Churn α |
| Datenbasis | Leistungsklasse und Jahr der Verteilung, Wochenprofil, Auslegung auf Ø Woche oder Spitzenmonat |

Alle Einstellungen stehen in der URL und lassen sich als Link teilen.

## Modell

- **Kunden:** Lademenge und effektive Ladeleistung je Vorgang aus den OBELIS-Histogrammen der gewählten
  Klasse und des gewählten Jahres. Gekoppelt über eine Gauß-Copula, ρ kalibriert auf die gemessene mittlere
  Belegdauer. Die Schieberegler skalieren den Mittelwert, die Form bleibt.
- **Bedienung:** Leistung je Fahrzeug = min(Fahrzeug, Ladepunkt, Water-Filling-Anteil am Netzanschluss).
  Daraus zustandsabhängige Bedienraten μₙ.
- **Warteschlange:** M/M/c+D (feste Geduld T) mit Allen-Cunneen-Korrektur (c_A² + c_S²)/2 und Mischung über
  verfügbare Ladepunkte k ~ Bin(c, A), angelehnt an den
  [Warteschlangenrechner der TU Clausthal](https://www.mathematik.tu-clausthal.de/studium/mathematik-interaktiv/warteschlangentheorie/warteschlangenrechner).
- **Hochrechnung:** λₕ = λ* · nₕ / n_max je Stunde der Woche (punktweise stationär), Monatsindex aus
  Ladevorgängen je Ladepunkt und Tag.
- **Gegenprobe:** Ereignisdiskrete Simulation im Web Worker (`web/js/sim.js`) mit denselben Verteilungen,
  Water-Filling in jedem Moment, zufälligen Ausfällen und Abbruch nach T.

Grenzen und Annahmen stehen ausführlich im Abschnitt „Methodik“ der Seite.

## Daten

`web/data/ladeprofil.json` ist ein Extrakt aus dem Repo
[AuswertungMobilithek](https://github.com/EHHeuer/AuswertungMobilithek) (aggregierte OBELISöffentlich-Daten
der NOW GmbH, CC BY 4.0). Neu erzeugen:

```bash
python pipeline/extract.py --src ../AuswertungMobilithek/web/data/obelis.json
```

## Veröffentlichen

- **GitHub Pages:** `.github/workflows/pages.yml` veröffentlicht `web/` bei jedem Push auf `main`
  (oder manuell über „Run workflow“). Einmalig unter *Settings → Pages → Source* „GitHub Actions“ wählen.
- **GitLab Pages:** `.gitlab-ci.yml` veröffentlicht `web/` aus dem Default-Branch, falls das Repo auf
  GitLab gespiegelt wird.

## Struktur

```
web/index.html        Seite
web/css/style.css     Gestaltung (Tokens, Hell/Dunkel)
web/js/model.js       Verteilungen, analytisches Modell, Hochrechnung
web/js/sim.js         Ereignisdiskrete Simulation
web/js/worker.js      Simulation im Hintergrund
web/js/charts.js      SVG-Diagramme
web/js/app.js         Oberfläche
pipeline/extract.py   Datenextrakt aus AuswertungMobilithek
```
