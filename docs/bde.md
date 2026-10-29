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
- Aufgabe vergeben: freiwillig Uhrzeit und „Dringend“. Odoo-Aktivitäten kennen nur ein Datum, beides steht deshalb vorn in der Zusammenfassung („DRINGEND · bis 14:00 · …“), sichtbar auch in Odoo; dringende stehen oben, rot markiert, mit Uhrzeit wird „heute“ nach Ablauf rot.
- Rückfragen: Knopf „Rückfrage“ an eigenen und an „Von mir vergeben“-Aufgaben öffnet darunter einen Verlauf zwischen Empfänger und Vergebendem (aus dem Vermerk „Vergeben von … über Kratos BDE“, sonst Ersteller der Aktivität). Nur diese beiden lesen und schreiben, Leitung kann bei fremden Aufgaben nur lesen; roter Punkt = ungelesen. Gespeichert im Dashboard (`task_messages`, `task_reads`), mit `BDE_WRITE=1` zusätzlich als interne Notiz (`message_post`, Untertyp Notiz, keine E-Mail) am FA, Auftrag oder Mitarbeiter. Am Handy nur lesen.
- Zeiten ohne Auftrag: Reiter „Ohne Auftrag“ (auch im kleinen Fenster) mit den Aufgaben des Odoo-Projekts „Gemeinkosten“ (per Name geladen, neue erscheinen von selbst); auch über „Suchen“ und unter „Zuletzt“. Gebucht als Stundenzettel (`account.analytic.line`, `server/bdeOverhead.js`): Start legt einen Eintrag mit Dauer 0 und „läuft seit 08:51 · Kratos BDE“ an (Startzeit = Anlegezeitpunkt in Odoo), Stopp/Pause trägt die echte Dauer ohne Rundung ein und schreibt „08:51–10:15 · Kratos BDE“. Odoos Stundenzettel-Timer wird nicht genutzt (gehört dem Odoo-Benutzer des Dashboard-Zugangs, nur einer je Benutzer, rundet auf 15 min). Es läuft immer nur eine Personentätigkeit: Auftrag ↔ Gemeinkosten beenden sich gegenseitig, Maschinenläufe laufen parallel weiter; Weiter setzt fort, was zuletzt lief; Gehen am Kiosk beendet auch Gemeinkosten. Laufende Einträge zählen nur als laufend (bis jetzt), nie als fertige Buchung. Wochenübersicht: „Ohne Auftrag gebucht“, „Nicht gebucht“ = Anwesenheit − Aufträge − ohne Auftrag.
- Meine nächsten Teile: Positionen, bei denen der Mitarbeiter für Programmierung, Rüsten, Fräsen (Reihenfolge des Zeitstrahls) oder QS (Positionen in der QS) zuständig ist, mit Bild, Liefertermin, AV-Status, Zeichnung und „… starten“ (mit `BDE_WRITE`). Erledigte Arbeitsgänge (Odoo) fallen weg. Darunter seine offene Arbeitsvorbereitung; wer die Planung hat, sieht die Zahl der nicht eingeplanten Positionen; die Leitung dezent die offene AV.
- Zuständigkeiten (Planung → Einstellungen und Schublade „Zuständig“): Stammbediener je Maschine (DMU 40 Nino, M1 Frank, H800U Aurel) für Programmierung, Rüsten, Fräsen; QS Aurel, Arbeitsvorbereitung Nino, Planung Frank; Abweichung je Position und Tätigkeit. Fotos und Namen an Maschinenzeile und Balken. Gespeichert in `staff_defaults` und `order_staff` (im Backup), Regeln in `src/staffLib.js`.
- Mitarbeiterfotos aus Odoo (`hr.employee.image_128`, nur lesen) auf Tafel, Anmeldung, Begrüßung, Kiosk und in der Planung, ohne Foto Initialen.
- Begrüßung beim Anmelden/Kommen („Guten Morgen, Aurel!“) und Verabschiedung beim Abmelden/Gehen („Schönen Feierabend“, freitags/samstags „Schönes Wochenende“, mitten am Tag „Bis später“).

**Version 2 (Bedienen, nur mit `BDE_WRITE=1`)**
- Knöpfe Wechseln (Zuletzt, Als Nächstes, Helfen, Suchen), Unterbrechen/Weiter, Stopp; auf der eigenen Karte der Tafel Unterbrechen und Stopp.
- Personentätigkeiten sind exklusiv, Maschinenlauf läuft parallel weiter. Helfen = laufende Tätigkeit eines Kollegen wählen.
- Maschinenlauf beenden „jetzt“ oder „Maschine war fertig um …“ (nicht vor dem Start, nicht in der Zukunft). Vermerk in der Beschreibung des Zeiteintrags: „Endzeit nachgetragen: …(BDE)“. Liste für die Leitung: `/api/bde/endzeiten`.
- Jeder bedient nur seine Buchungen; die Leitung darf fremde beenden. Am Handy keine Bedienung.
- Büro-PC: Mehr → Kleines Fenster (Chrome/Edge). Tabtitel „⏱ 0:38 Programmierung FA01262“. ⇄ im kleinen Fenster klappt dort die Auswahl auf (Zuletzt, Nächste 5, Suchen nach FA/Auftrag/Artikel), das Fenster wird dafür größer und danach wieder klein; Helfen gibt es in „Mein Arbeitsplatz“. Darunter ungelesene Odoo-Nachrichten (Einzel- und Gruppenchats, Posteingang mit Erwähnungen) des Angemeldeten: nur die eigenen, nur Anzeige (Absender, erste Worte), Klick öffnet Odoo; nichts wird gespeichert (`server/bdeMessages.js`). Das Fenster nimmt die eigene Karte aus `mine` der Team-Antwort, damit es auch für Leitung ohne Platz auf der Tafel die laufende Zeit zeigt.

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
| `BDE_GEMEINKOSTEN_PROJEKT` | nein | Odoo-Projekt für Zeiten ohne Auftrag, Standard `Gemeinkosten` |

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

## Programmlaufzeit je Aufspannung (Fräsen)

Für die Nachkalkulation: je Aufspannung die Programmlaufzeit eines vollen Durchlaufs, vom Mitarbeiter an der Maschine abgelesen. Mehrere Aufspannungen bleiben **ein** Arbeitsgang „Fräsen“ in Odoo, es entstehen keine zusätzlichen Arbeitsgänge, die Zeiterfassung (`mrp.workcenter.productivity`) wird nicht geändert und nicht für Laufzeiten benutzt. Code: `server/bdeLaufzeit.js`, `src/Laufzeit.jsx`, Test `scripts/testLaufzeit.mjs`.

**Wo die Zeiten stehen:** als interne Notizen im Verlauf des **Fertigungsauftrags** in Odoo (wie früher von Hand), eine Zeile je Eintrag in festem Aufbau. Es gibt keine eigenen Odoo-Felder oder -Modelle, in Odoo muss nichts eingerichtet werden.

```
Aufspannungen: 3 (Aurel Rama, 29.10.2026)
Laufzeit Aufspannung 2: 12:00 Min:Sek für 2 Teile = 6:00 je Stück (Aurel Rama, 29.10.2026)
Laufzeit Aufspannung 1: 6:00 Min:Sek für 1 Teil = 6:00 je Stück (Aurel Rama, 29.10.2026, Programm geändert)
```

- Je Aufspannung gilt die **neueste** Notiz, ebenso bei der Anzahl. Eine Korrektur ist einfach eine neue Zeile, die alte bleibt im Verlauf stehen.
- Hinter dem Namen steht optional „Programm geändert“ oder „unverändert“ (Laufzeit vom früheren Auftrag übernommen).
- Die Laufzeit je Stück rechnet die App (Minuten ÷ Teile), die Summe aller Aufspannungen ebenso.
- Eine Notiz, die jemand so umschreibt, dass sie nicht mehr lesbar ist, wird von der App ignoriert; die App fragt dann einfach neu.
- Notizen sind interne Notizen (`message_post` mit `mail.mt_note`, keine E-Mail, keine Empfänger).

**Ablauf in der App** (nur Arbeitsgang Fräsen)
- Nach dem Stopp der **Programmierung**: „Programmierung fertig?“ Ja → „Wie viele Aufspannungen?“ (Vorschlag vom letzten gleichen Artikel).
- Beim **Beenden des Fräsens** (eigener Lauf, nicht wenn die Leitung für andere beendet): ist die Anzahl noch leer, zuerst die Anzahl. Dann Pflichtfrage „Aufspannung fertig? Ja/Nein“. Ja → Aufspannung wählen (die nächste offene ist hervorgehoben), Programmlaufzeit in Minuten:Sekunden, Teile je Aufspannung (zuletzt benutzter Wert, sonst 1). Mitarbeiter und Datum automatisch.
- **Wiederholteil**: Die App sucht im zuletzt erledigten Fräsen-Arbeitsgang desselben Artikels nach solchen Notizen und schlägt die Werte vor („Wie beim letzten Mal (FA01100): 7:30 für 1 Teil“). „Laufzeit unverändert“ übernimmt sie, „Andere Zeit eingeben“ setzt den Haken „Programm geändert“ vor.
- **Stand**: Knopf „Laufzeiten“ an der Maschinenzeile des laufenden Fräsens (auf Team und Mein Arbeitsplatz): welche Aufspannung hat welche Zeit, wer, wann, welche sind offen.
- **Noch nicht fertig gemeldet**: Auf Mein Arbeitsplatz steht eine Liste der eigenen Arbeitsgänge der letzten 14 Tage, die gestoppt, aber nicht fertig gemeldet sind (nicht, solange sie laufen); beim Fräsen mit „Eintragen“, wenn Laufzeiten fehlen. Sie fängt auf, was der Dialog nicht erreicht: Beenden am Kiosk, das kleine Fenster, eine weggeklickte Frage.
- **Fräsen fertig melden** (`mrp.workorder.button_finish`) geht in der App nur, wenn die Anzahl feststeht und jede Aufspannung eine Laufzeit hat und keine Zeit mehr läuft. Alle weiteren Schritte: siehe unten.
- **Plausibilität**: Summe Laufzeit je Stück × Stückzahl darf die gestempelte Zeit des Arbeitsgangs nicht übersteigen, sonst Warnung („Minuten und Sekunden vertauscht?“) mit „Korrigieren“ oder „Trotzdem speichern“.

**Schreibrechte** (`server/odooClient.js`): am Fertigungsauftrag nur `message_post` als interne Notiz, am Arbeitsgang nur Starten, Stoppen und `button_finish`. Kein Löschen, keine Zeiten, kein Status. Ohne `BDE_WRITE=1` wird nichts geschrieben.

**Auslesen für die Kalkulationssoftware** (JSON-2, nur lesen): Notizen des Fertigungsauftrags, `mail.message` mit `model = mrp.production`, `res_id` = Fertigungsauftrag und Text „Laufzeit Aufspannung“. Die Zeilen sind wie oben aufgebaut.

**Testen:** `node scripts/testLaufzeit.mjs` (automatische Prüfung gegen das Test-Odoo) und `node scripts/devTest.mjs` (App auf http://localhost:3056 mit Test-Odoo zum Ausprobieren). Live geht es erst nach Freigabe mit dem Deploy der App, in Odoo ist nichts vorzubereiten (nur `BDE_WRITE=1`, wie für das übrige Bedienen).

## Arbeitsgänge fertig melden, Fertigungsauftrag abschließen, weiterer Arbeitsschritt

Code: `server/bdeLaufzeit.js` (Wege `/api/bde/fertig`, `/api/bde/auftrag`, `/api/bde/auftrag/abschliessen`, `/api/bde/schritt`, `/api/bde/offen`), `src/Laufzeit.jsx`, Test `scripts/testLaufzeit.mjs`.

**Schritt eines Arbeitsgangs** erkennt die App am **Namen des Arbeitsgangs** (Programmierung, Rüsten, Fräsen, Qualitätssicherung = „QS“), nicht am Arbeitsplatz. Das Fräsen läuft bei uns mal auf dem Sammelplatz FRÄSEN, mal direkt auf DMU 40 EVO, DMG M1 oder POS H 800 U. Jede gestempelte Buchung trägt dafür `step` und `machine` (`server/bde.js`, `stepOf`).

**Ablauf**
- Nach dem Stopp einer eigenen Buchung fragt die App je nach Schritt: Programmierung „fertig?“ (Ja meldet den Arbeitsgang fertig, dann die Anzahl der Aufspannungen), Fräsen die Laufzeit je Aufspannung (am Ende „Fräsen fertig melden“), Rüsten und QS „… fertig?“.
- „Fertig melden“ ruft `mrp.workorder.button_finish` auf. Odoo gibt den nächsten Arbeitsgang selbst frei. Gesperrt, solange noch eine Zeit läuft, beim Fräsen zusätzlich, solange Anzahl oder Laufzeiten fehlen.
- Ist die QS fertig und alle Arbeitsgänge des Auftrags sind es auch, fragt die App „Fertigungsauftrag abschließen?“. Das setzt die produzierte Menge auf die Auftragsmenge und ruft `mrp.production.button_mark_done` auf (Odoo bucht Material und fertiges Teil). Stellt Odoo eine Rückfrage (Assistent), bleibt der Auftrag offen und die App verweist auf Odoo.
- **Weiterer Arbeitsschritt** („Weiterer Arbeitsschritt“ nach dem Fräsen, im Stand-Dialog und vor dem Abschluss): Maschine wählen (alle Arbeitsplätze mit passendem „… Rüsten“-Arbeitsplatz sowie FRÄSEN/RÜSTEN), geplante Stunden optional. Die App legt „Rüsten“ und „Fräsen“ der Maschine an, hängt sie vor die QS und lässt die QS auf das neue Fräsen warten. Solange der Fertigungsauftrag nicht abgeschlossen ist, geht das beliebig oft. Eine Notiz im Fertigungsauftrag hält es fest.
- Die Liste **„Noch nicht fertig gemeldet“** auf Mein Arbeitsplatz zeigt eigene Arbeitsgänge der letzten 14 Tage, die gestoppt, aber nicht fertig gemeldet sind (Kiosk, kleines Fenster und weggeklickte Fragen fragen nicht selbst).
- **Aus der Planung** (Dashboard, Arbeitsgänge einer Position): Hat die Position einen Odoo-Fertigungsauftrag, legt das Haken „Auch in Odoo anlegen“ im Dialog „Arbeitsgänge“ die Arbeitsschritte an (`POST /api/planung/odoo-schritte`, Maschinen: dmu40 = DMU 40 EVO, dmu50 = DMU 50, m1 = DMG M1, h800u = POS H 800 U). Der erste Arbeitsgang gehört zum Fräsen, das der Auftrag schon hat. Für jeden weiteren, den es auf dieser Maschine in Odoo noch nicht gibt, entstehen Rüsten und Fräsen (geplante Zeit = Stunden des Arbeitsgangs) vor der QS. Die Planung wird zuerst gespeichert. Klappt Odoo nicht (z. B. `BDE_WRITE` aus oder Arbeitsplatz fehlt), bleibt die Planung bestehen und die App meldet, was fehlt.
- **DMU 50**: In Odoo gibt es noch keine Arbeitsplätze „DMU 50“ und „DMU 50 Rüsten“. Sobald sie angelegt sind, erscheint die DMU 50 von selbst bei der Maschinenwahl und in der Planung; bis dahin sagt die App, welcher Arbeitsplatz fehlt, und legt nichts an.
- Laufzeiten und Anzahl der Aufspannungen gelten **je Fräsen-Arbeitsgang, also je Maschine**. Die Notizen tragen die Maschine in Klammern.

**Schreibrechte** (`server/odooClient.js`), zusätzlich zu oben: `mrp.workorder` `create` nur mit Name, Arbeitsplatz, Fertigungsauftrag, Reihenfolge, Plandauer, Abhängigkeit; `write` nur Reihenfolge und Abhängigkeit; `mrp.production` `write` nur `qty_producing`, dazu `button_mark_done`. Keine Zeiten, kein Status, kein Löschen.

**Nur gegen das Test-Odoo geprüft.** Offen vor dem Livegang an einem echten Auftrag: ob Odoo beim Anlegen der Arbeitsgänge die Abhängigkeit (`blocked_by_workorder_ids`) so annimmt, ob die QS danach tatsächlich auf das neue Fräsen wartet, und ob `button_mark_done` bei euch ohne Rückfrage durchläuft.
