# Die App lernt: Programme, Soll/Ist, Autopilot

## Programme aus dem Auftragsordner
`auftragsordner/programme_melden.py` (läuft im Haus, liest nur Odoo und K:) meldet je offenem Fertigungsauftrag:
eigene Mastercam-Programme im Auftragsordner (`…/<A-Nr>/Programmierung/<Artikel>/`) und Altprogramme desselben Artikels aus früheren Aufträgen.
Das AV-Paket schlägt daraufhin vor:
- **eigenes Programm** → Hinweis mit Datei und Stand, „Programm: bereit“ (beim Freigeben, nur wenn der Punkt noch offen ist)
- **Altprogramm** → Hinweis „Altprogramm aus A…: Zeichnungsindex prüfen, Programm in den Auftrag übernehmen“ (Status bleibt)

Einrichten: im Dashboard `PROGRAMME_KEY` (mind. 24 Zeichen); in `auftragsordner/config.json` `"dashboard": {"url": "https://dashboard.kratos-precision.de", "key": "<PROGRAMME_KEY>"}`;
geplante Aufgabe „KRATOS Programme melden“ alle 15 Minuten: `python programme_melden.py`. Probe ohne Senden: `python programme_melden.py --probe`.
Der Auftragsordner-Dienst selbst bleibt unverändert.

## Soll/Ist lernen
Jede Position merkt sich, woher ihre Stunden kamen (Kalkulation, frühere Aufträge, Odoo-Arbeitsplan, von Hand). Ist sie erledigt, holt die App
die gestempelte Zeit (Rüsten + Fräsen) aus Odoo. Kennzahlen → „Schätzgenauigkeit“ zeigt je Quelle Ist/Soll und den Anteil innerhalb ±20 %.
Ab 5 Vergleichen korrigiert die App Stunden aus der Kalkulation um den gelernten Faktor (je Maschine, sonst gesamt; begrenzt auf 0,6–1,8)
und schreibt im AV-Paket dazu, warum.

## Autopilot
Kennzahlen → „Autopilot“. Arten: AV-Pakete mit Stunden aus früheren Aufträgen, mit Kalkulations-Ist-Zeiten, nur mit Hinweisen; Planvorschlag
am Morgen (nur ohne zusätzliche Verspätung). Einschalten kann nur die Leitung (PIN), und erst wenn Menschen diese Art in 90 Tagen mindestens
10-mal entschieden und mindestens 90 % unverändert freigegeben haben. Mit Warnung gibt der Autopilot nie frei. Im Verlauf steht „Autopilot“.

Code: `server/programme.js`, `server/sollIst.js`, Autopilot in `server/freigaben.js`, Test `scripts/testLernen.mjs`.

## Zeichnung lesen
Für jede Position mit AV-Paket holt Talos (odoo-mcp, `POST /talos/zeichnung`) die Zeichnung (PDF) des Artikels aus Odoo und lässt sie von Claude lesen:
Werkstoff, Oberfläche, Wärmebehandlung, Allgemeintoleranz, engste Toleranz, Passungen, Gewinde, Rauheit, Abmessungen, Besonderheiten (z. B. Werkstoffzeugnis 3.1).
Das AV-Paket gleicht ab und warnt:
- Oberfläche/Härte laut Zeichnung, aber der Schritt fehlt im Arbeitsplan (steht dort nur „Oberflächenbehandlung“ allgemein: Hinweis)
- Werkstoff laut Zeichnung passt nicht zur Kalkulation
- Oberfläche passt nicht zum Werkstoff (z. B. Eloxieren bei Edelstahl)

Toleranzen, Passungen, Rauheit und Besonderheiten stehen als Hinweis im Paket. Je Lauf (15 min) werden höchstens 3 neue Zeichnungen gelesen;
das Ergebnis wird gespeichert, neu gelesen nur auf „Zeichnung neu lesen“ (PIN). Kosten: je Zeichnung einige Cent.
Voraussetzung: `TALOS_KEY_DASHBOARD` (gibt es schon) und odoo-mcp mit `/talos/zeichnung` (KRATOS-Systems/odoo-mcp#2). Abschalten: `ZEICHNUNG_AUTO=0`
(nur noch auf Knopfdruck) oder `ZEICHNUNG_AUS=1` (ganz aus). In Odoo ändert sich nichts.
