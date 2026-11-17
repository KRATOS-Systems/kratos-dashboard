# KI-Planer: Die App bereitet vor, ein Mensch gibt frei

Ziel: Arbeitsvorbereitung und Planung macht die App, Menschen prüfen und geben frei. Ändern tut die App erst mit der Freigabe.

## Was die App von selbst vorbereitet

| Was | Wann | Inhalt |
|---|---|---|
| AV-Paket je Position | alle 15 Minuten (und auf „Neu vorbereiten“) | Stunden (frühere Aufträge, sonst Kalkulation), Maschine (Odoo-Arbeitsplan oder Kalkulation), Werkstoff und Rohteil, Hinweise vom Wiederholteil (Programm, Werkzeuge, Spannmittel), Plausibilität (z. B. Eloxieren bei Edelstahl), offene Punkte (Entwurf, Musterwerte, Material nicht bestellt) |
| Planvorschlag des Tages | werktags ab 6 Uhr (und auf „Neu vorbereiten“) | neue Positionen einplanen, Reihenfolge verbessern (ohne Maschinenwechsel), vorher/nachher; Text von Talos, wenn erreichbar, sonst kurzer Regeltext |
| Hinweise von Talos | wenn Talos etwas vorschlägt (Werkzeug `freigabe_vorschlagen`) | Text mit Begründung; ändert nichts |
| Fortschritt aus dem Stempeln | bei jedem Odoo-Abgleich | gestempelte Zeit auf Rüsten und Fräsen wird „erledigte Stunden“ (höchstens 95 %, nie weniger als von Hand eingetragen) |

Zu finden: Planung → „Heute zu tun“ → „Vorschläge warten auf Freigabe“, oder direkt die Karte „KI-Vorschläge zur Freigabe“. Das AV-Paket einer Position steht auch in der Arbeitsvorbereitung beim Aufklappen der Position.

## Was beim Freigeben passiert

- **AV-Paket**: Stunden werden eingetragen (nur wenn noch keine da sind), Hinweise kommen in die leeren AV-Notizen (vorhandene Notizen werden nie überschrieben). Rechnet die Kalkulation das Teil auf der M1, gilt es als „passt auf M1“.
- **Planvorschlag**: Die Reihenfolge wird genau so gesetzt wie vorgeschlagen. Hat sich die Planung seit dem Vorschlag geändert (jemand hat gezogen, gestempelt, Odoo-Abgleich), wird nichts übernommen, sondern neu gerechnet und noch einmal gezeigt. Positionen, die auf eine Maschine kommen, stellen in Odoo den noch nicht begonnenen Arbeitsplan um (wie beim Ziehen einer Karte).
- **Hinweis**: „Erledigt“ hakt ab, sonst passiert nichts.
- **Ablehnen** (mit Grund, freiwillig): Der Vorschlag kommt für diese Position nicht wieder.

Freigeben kann jeder, der unter „Mein Arbeitsplatz“ mit PIN angemeldet ist. Festgehalten wird wer, wann und was (Verlauf in der Karte).

## Kalkulation

Die App liest aus der Kalkulation (kalkulation.kratos-precision.de, Schnittstelle `/api/ext`): Zeiten, Werkstoff, Rohteil, Maschine, Zeitbasis. Ist ein Teil dort noch nicht kalkuliert, legt die App es nur an, wenn jemand im AV-Paket auf „In der Kalkulation berechnen“ drückt (STEP-Analyse, bis zu 3 Minuten). In Odoo schreibt die Kalkulation dabei nichts.

## Kennzahlen (Planung → Reiter „Kennzahlen“)

- Liefertreue je Monat: geliefert (Odoo) gegen den ersten zugesagten Termin
- Stunden für AV und Planung je Woche: Stempel auf Odoo-Aufgabe 699 „AV / Planung allgemein“
- KI-Vorschläge: übernommen, abgelehnt, Quote (30 Tage)

## Einrichtung beim Hochladen (Hostinger, Umgebungsvariablen des Dashboards)

| Variable | Wert |
|---|---|
| `KALKULATION_API_KEY` | derselbe Schlüssel wie beim Odoo-MCP (Talos) für die Kalkulation, mind. 32 Zeichen |
| `KALKULATION_URL` | optional, Standard `https://kalkulation.kratos-precision.de` |
| `AV_TASK_ID` | optional, Standard 699 |
| `FREIGABEN_AUTO` | optional, `0` schaltet das Vorbereiten im Hintergrund ab |

Ohne `KALKULATION_API_KEY` läuft alles, nur ohne Zeiten aus der Kalkulation.

Talos: Der Planungs-MCP (`/mcp/<TALOS_PLAN_SECRET>`) hat vier neue Werkzeuge: `plan_heute`, `plan_vorschlag`, `freigaben_offen`, `freigabe_vorschlagen`. Die Anleitung von Talos dazu liegt im Odoo-MCP (eigener Zweig).

## Code

- `server/freigaben.js` – Tabelle `freigaben`, AV-Pakete, Planvorschlag, Freigeben/Ablehnen, Hintergrund
- `server/kalkClient.js` – Zugriff auf die Kalkulation
- `server/kennzahlen.js` – Kennzahlen
- `server/odooSync.js` – Fortschritt aus dem Stempeln
- `server/talosPlan.js` – Talos-Werkzeuge (`kiTools`)
- `src/Freigaben.jsx`, `src/Kennzahlen.jsx` – Oberfläche
- Test: `scripts/testKiPlaner.mjs` (Test-Odoo und nachgebaute Kalkulation)
