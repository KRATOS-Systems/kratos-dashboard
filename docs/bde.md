# Betriebsdatenerfassung (BDE)

Neue Bereiche im Produktionsdashboard. Odoo bleibt die einzige Wahrheit: Die App speichert keine Zeiten, sie liest aus Odoo und bucht über Odoos eigene Methoden.

| Bereich | Adresse | Für wen |
|---|---|---|
| Team-Tafel | `#team`, am Tablet ohne Seitenleiste `#team/vollbild` | alle, am Handy nur lesend |
| Mein Arbeitsplatz | `#platz` | jeder Mitarbeiter mit PIN |
| Kiosk Kommen/Gehen | `#kiosk` | Terminal mit Chipleser |

## Funktionen

**Version 1 (Anzeige)**
- Tafel: grün = da und Buchung läuft, grau = da, nichts gebucht, orange = doppelt gestempelt, rot = Personentätigkeit vergessen (über 12 Stunden oder seit gestern), ohne Farbe = nicht da. Grüner Punkt am Kürzel = anwesend.
- Alle laufenden Buchungen stehen untereinander. Zwei Personentätigkeiten gleichzeitig = „Doppelt gestempelt“; Personentätigkeit plus Maschinenlauf ist erlaubt.
- Maschinenlauf (Fräsen, Drehen): „Läuft länger als geplant“ über Vorgabezeit + 20 %, ohne Vorgabezeit ab 24 Stunden. Maschinenläufe werden nie rot (nachts mannlos ist erlaubt).
- Offene Reklamationen zum Artikel stehen auf der Karte.
- Mein Arbeitsplatz: laufende Tätigkeit mit Uhr, Woche (anwesend, auf Aufträge gebucht, nicht gebucht), Resturlaub, Zuletzt.
- Leitung (Frank, Alex): Hinweise (vergessen, doppelt, Maschine zu lang), Daten der anderen ansehen.
- Meine Aufgaben: offene Odoo-Aktivitäten des Angemeldeten nach Frist (rot überfällig, gelb heute), mit Verweis in Odoo; bei Fertigungsaufträgen „Stempeln“ (öffnet die Auswahl mit dem Auftrag). „Erledigt“ nur mit `BDE_WRITE=1`, nur eigene, über `mail.activity.action_feedback` mit Vermerk „Erledigt über Kratos BDE von …“. Ohne Odoo-Benutzer keine Aufgaben.
- Rückfragen: Knopf „Rückfrage“ an eigenen und an „Von mir vergeben“-Aufgaben öffnet darunter einen Verlauf zwischen Empfänger und Vergebendem (aus dem Vermerk „Vergeben von … über Kratos BDE“, sonst Ersteller der Aktivität). Nur diese beiden lesen und schreiben, Leitung kann bei fremden Aufgaben nur lesen; roter Punkt = ungelesen. Gespeichert im Dashboard (`task_messages`, `task_reads`), mit `BDE_WRITE=1` zusätzlich als interne Notiz (`message_post`, Untertyp Notiz, keine E-Mail) am FA, Auftrag oder Mitarbeiter. Am Handy nur lesen.
- Meine nächsten Teile: Positionen, bei denen der Mitarbeiter für Programmierung, Rüsten, Fräsen (Reihenfolge des Zeitstrahls) oder QS (Positionen in der QS) zuständig ist, mit Bild, Liefertermin, AV-Status, Zeichnung und „… starten“ (mit `BDE_WRITE`). Erledigte Arbeitsgänge (Odoo) fallen weg. Darunter seine offene Arbeitsvorbereitung; wer die Planung hat, sieht die Zahl der nicht eingeplanten Positionen; die Leitung dezent die offene AV.
- Zuständigkeiten (Planung → Einstellungen und Schublade „Zuständig“): Stammbediener je Maschine (DMU 40 Nino, M1 Frank, H800U Aurel) für Programmierung, Rüsten, Fräsen; QS Aurel, Arbeitsvorbereitung Nino, Planung Frank; Abweichung je Position und Tätigkeit. Fotos und Namen an Maschinenzeile und Balken. Gespeichert in `staff_defaults` und `order_staff` (im Backup), Regeln in `src/staffLib.js`.
- Mitarbeiterfotos aus Odoo (`hr.employee.image_128`, nur lesen) auf Tafel, Anmeldung, Begrüßung, Kiosk und in der Planung, ohne Foto Initialen.
- Begrüßung beim Anmelden/Kommen („Guten Morgen, Aurel!“) und Verabschiedung beim Abmelden/Gehen („Schönen Feierabend“, freitags/samstags „Schönes Wochenende“, mitten am Tag „Bis später“).

**Version 2 (Bedienen, nur mit `BDE_WRITE=1`)**
- Knöpfe Wechseln (Zuletzt, Als Nächstes, Helfen, Suchen), Unterbrechen/Weiter, Stopp; auf der eigenen Karte der Tafel Unterbrechen und Stopp.
- Personentätigkeiten sind exklusiv, Maschinenlauf läuft parallel weiter. Helfen = laufende Tätigkeit eines Kollegen wählen.
- Maschinenlauf beenden „jetzt“ oder „Maschine war fertig um …“ (nicht vor dem Start, nicht in der Zukunft). Vermerk in der Beschreibung des Zeiteintrags: „Endzeit nachgetragen: …(BDE)“. Liste für die Leitung: `/api/bde/endzeiten`.
- Jeder bedient nur seine Buchungen; die Leitung darf fremde beenden. Am Handy keine Bedienung.
- Büro-PC: Mehr → Kleines Fenster (Chrome/Edge). Tabtitel „⏱ 0:38 Programmierung FA01262“. ⇄ im kleinen Fenster klappt dort die Auswahl auf (Zuletzt, Nächste 5, Suchen nach FA/Auftrag/Artikel), das Fenster wird dafür größer und danach wieder klein; Helfen gibt es in „Mein Arbeitsplatz“.

**Version 3 (Kiosk, mit `BDE_WRITE=1` und `BDE_KIOSK_KEY`)**
- Chip an den Leser (tippt Nummer + Enter), Abgleich mit der Ausweisnummer in Odoo.
- Gehen: Personentätigkeiten enden, je laufendem Maschinenlauf die Frage „Läuft weiter / Beenden“, dann ausgestempelt. Kommen: eingestempelt. Keine Antwort nach 60 Sekunden = nichts gebucht.
- Danach 5 Sekunden Stundenkarte: heute, Woche mit Soll und Balken, Überstunden, Resturlaub.

## Odoo-Methoden

| Zweck | Methode |
|---|---|
| Tätigkeit starten | `mrp.workorder.start_employee(employee_id)` |
| Beenden / Unterbrechen | `mrp.workorder.stop_employee(employee_ids)` |
| Endzeit Maschinenlauf | `mrp.workcenter.productivity.write`, nur `date_end` und `description` |
| Kommen / Gehen | Kiosk-Weg `/hr_attendance/attendance_barcode_scanned` mit dem Kiosk-Schlüssel der Firma |
| Aufgabe erledigt | `mail.activity.action_feedback(feedback)` |

Alles andere ist in `server/odooClient.js` gesperrt. Ohne `BDE_WRITE=1` schreibt die App nichts.

## Einrichtung bei Hostinger

Im hPanel unter Websites → Website → Umgebungsvariablen:

| Variable | Pflicht | Inhalt |
|---|---|---|
| `BDE_SECRET` | ja | langer Zufallswert, signiert die Anmeldungen |
| `BDE_ODOO_API_KEY` | empfohlen | eigener Odoo-Schlüssel „BDE“, sonst gilt `ODOO_API_KEY` |
| `BDE_WRITE` | für V2/V3 | `1` schaltet Bedienen und Kiosk frei |
| `BDE_KIOSK_KEY` | für V3 | Gerätschlüssel, einmal am Terminal eingeben |
| `BDE_TEAM` | nein | IDs der Tafel, Standard `3,2,11,5,14,10` |
| `BDE_LEITUNG` | nein | Standard `3,1` |
| `BDE_MACHINES` | nein | Arbeitsplatz → Maschine, z. B. `dmu40:15,m1:16,h800u:17` |
| `BDE_REMINDER_KEY` | nein | Schlüssel für Erinnerungen über n8n/Talos |
| `BDE_HIDE_ACTIVITY_TYPES` | nein | Aktivitätstypen, die in „Meine Aufgaben“ nicht erscheinen, Standard `6` (Odoos „Ausnahme“) |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Danach auf `main` pushen (Variable speichern allein löst bei Hostinger einen fehlerhaften Rebuild aus).

Empfohlene Reihenfolge: erst ohne `BDE_WRITE` live (nur Anzeige) und eine Woche vergleichen, dann `BDE_WRITE=1` mit einem Mitarbeiter am Büro-PC, zuletzt den Kiosk.

In Odoo nötig: PIN (4–8 Ziffern) und Ausweisnummer je Mitarbeiter; je Maschine ein eigener Arbeitsplatz für die Maschinenzeit je Maschine; Arbeitsvorbereitung (archiviert) und Produktionsplanung (fehlt) als Arbeitsplätze in die Arbeitspläne aufnehmen.

## Maschinenzeit prüfen (vorerst ausgeblendet)

Ausgeblendet über `SHOW_MASCHINENZEIT` in `src/Arbeitsplatz.jsx`, Schnittstelle `/api/bde/maschinenzeit` bleibt. Wieder einschalten, wenn jede Maschine in Odoo einen eigenen Arbeitsplatz hat und einige Wochen live gestempelt wurde; dann eher als eine Kennzahl im Dashboard.

| Gebucht | Ampel | Hinweis |
|---|---|---|
| unter 80 % der Spindelstunden | rot | Buchungen fehlen |
| 80–95 % der Spindelstunden | gelb | Buchungen fehlen |
| 95 % Spindel bis Maschine an | grün | |
| bis 15 % über Maschine an | gelb | Zu spät gestoppt oder zu großzügig gebucht |
| mehr als 15 % über Maschine an | rot | Zu spät gestoppt oder zu großzügig gebucht |

## Rechnen

UTC aus Odoo, Anzeige Europe/Berlin, Woche ab Montag 0 Uhr. Anwesend = Odoos Arbeitszeit (Pausen abgezogen). Auf Aufträge gebucht = nur Personentätigkeiten, Überschneidungen einmal. Nicht gebucht = Anwesenheit minus Personenzeit. Resturlaub = gültige Zuteilungen minus genommen.

## Sicherheit

Schlüssel nur auf dem Server; PIN wird nie gelesen, nur geprüft (5 Fehlversuche = 5 Minuten Sperre); signiertes Cookie (12 h, Tablet 2 Minuten ohne Berührung); Stunden nur für den Angemeldeten und die Leitung; Kiosk nur auf freigeschalteten Geräten mit 90 Sekunden gültigem Beleg; Odoo höchstens alle 25 Sekunden für alle Geräte; die App liegt weiter hinter `APP_PASSWORD`.

## Lokal testen

- Echtes Odoo nur lesend: `.env` mit `BDE_ODOO_URL`, `BDE_ODOO_API_KEY`, `BDE_SECRET`, dann `npm run dev`.
- Bedienen und Kiosk: `node scripts/mockOdoo.mjs` (Test-Odoo auf Port 8069, Test-PINs und Chips in der Datei), Server mit `BDE_ODOO_URL=http://localhost:8069 BDE_ODOO_API_KEY=test BDE_WRITE=1 BDE_KIOSK_KEY=… BDE_SECRET=…` und einer Datenbankkopie (`DB_PATH`). `GET http://localhost:8069/__log` zeigt alle Schreibaufrufe.

Vorschläge für n8n und die Steuerungsanbindung: `docs/bde-n8n-und-steuerung.md`.
