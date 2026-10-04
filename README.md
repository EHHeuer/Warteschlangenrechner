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
| Dynamische Preise (optional) | Hochpreis- und Rabatt-Stunden je Tag, Anteil der ausweicht, Anteil der wegbleibt, Grundpreis, Aufschlag, Rabatt. Ergebnis zusätzlich in € im Vergleich zum Einheitspreis |

Alle Einstellungen stehen in der URL und lassen sich als Link teilen.

## Seite 2: Bedarf in Deutschland

`bedarf.html` rechnet hoch, wie viele Schnellladepunkte Deutschland für Pkw braucht:
Pkw-Bestand (KBA, 1.1.2026) × Veränderung × E-Anteil × Fahrleistung × Verbrauch × Anteil Schnellladen
÷ Energie je Ladepunkt ÷ Nähe zum Optimum. Die Energie je Ladepunkt kommt aus der Parkrechnung von Seite 1
(`web/js/park.js`, gleiche URL-Parameter). Beide Seiten teilen sich die Adresszeile, Einstellungen bleiben beim
Wechseln erhalten.

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
- **Dynamische Preise:** In den N stärksten Stunden jedes Tages weicht ein Anteil in die schwächsten Stunden
  desselben Tages aus (verteilt nach Abstand zum Tagesmaximum), ein Anteil bleibt weg. Danach wird der Park für
  das geglättete Profil erneut auf die Grenze gelegt. Umsatz = Σ Energie × Preis der Stunde (brutto). Startwert
  des Grundpreises: Median der Ad-hoc-Preise an DC-Ladepunkten aus OBELIS.
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

Der Bestand an Schnellladepunkten auf Seite 2 kommt aus dem Ladesäulenregister der Bundesnetzagentur
(Stand 1.9.2026). `web/data/ladesaeulen.json` ist eine Zusammenfassung (Leistungsklassen, Zubau je
Inbetriebnahmejahr, Bundesländer). Neu erzeugen:

```bash
curl -L -o data/raw/ladesaeulen_2026-09-01.csv \
  https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenregister_BNetzA_2026-09-01.csv
python pipeline/bnetza.py --src data/raw/ladesaeulen_2026-09-01.csv
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
web/js/app.js         Oberfläche Seite 1
web/bedarf.html       Seite 2: Bedarf in Deutschland
web/js/bedarf.js      Oberfläche Seite 2
web/js/park.js        Parkrechnung ohne Oberfläche (für Seite 2)
pipeline/extract.py   Datenextrakt aus AuswertungMobilithek
pipeline/bnetza.py    Zusammenfassung des Ladesäulenregisters
```
