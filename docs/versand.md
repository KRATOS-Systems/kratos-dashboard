# Versand und Abrechnung

Stand 21.11.2026 (Zweig `versand-abrechnung`).

## Ablauf

Fertigung → QS → (Oberfläche extern) → **Versand** → Erledigt

- Positionen eines Kundenauftrags (A-Nummer) gehen nach „Geprüft“ (QS), nach „Zurück, in den Versand“ (Extern) bzw. nach
  „Fertig produziert“ ohne QS in die neue Spur **VERSAND**. Positionen ohne Kundenauftrag sind wie bisher direkt erledigt.
- **Versendet** ist eine Position, sobald die Lieferung in Odoo bestätigt ist: Die Auftragsposition mit demselben Artikel ist
  vollständig geliefert (oder der ganze Kundenauftrag). Dann ist sie erledigt, Versanddatum = Datum der letzten Lieferung.
  Teillieferung: „20 von 50 geliefert (Teillieferung)“ steht an der Position, sie bleibt im Versand. Geprüft wird alle 10 Minuten
  und auf „Jetzt prüfen“. Ohne Odoo-Bezug (z. B. Abholung): Knopf „Versendet“.
- Der Odoo-Abgleich schlägt Positionen im Versand nicht zum Schließen vor (der Fertigungsauftrag ist dort meist schon erledigt).

## Zu berechnen

Je Auftragsposition: geliefert (höchstens die bestellte Menge) minus berechnet. Odoos eigenes „zu berechnen“ taugt nicht, weil nach
bestellter Menge abgerechnet wird. Dienstleistungen zählen nicht. Kundenaufträge ab `ORDERS_SINCE` (Standard 2026-01-01).

**Aufgabe in Odoo:** Für jeden neuen Lieferstand legt die App am Kundenauftrag eine Aktivität „Rechnung stellen: A0…“ an (To-do,
fällig heute, für `RECHNUNG_USER_ID`, Standard 2 = Alexander). Nur mit `BDE_WRITE=1`, abschaltbar mit `VERSAND_AUFGABE=0`, nur für
Lieferungen ab dem ersten Start dieser Funktion (`plan_settings.versand_start`). Ältere Fälle stehen nur in der Liste. Die App
schreibt keine Rechnungen und sonst nichts in Odoo.

## Erledigt

Reiter „Erledigt“: Aufträge mit erledigten Positionen (Standard 30 Tage, Suche über alle) mit Versanddatum, Liefertermin,
pünktlich/später, Anzahl Lieferungen und Rechnung (berechnet / offen mit Wert).

## Bedienung

- Klick in die Listen unter dem Zeitstrahl öffnet nur das Fenster rechts, die Seite bleibt stehen. „Im Zeitstrahl zeigen“ springt.
- QS, Fertigung extern, Oberfläche extern und Versand öffnen dasselbe große Fenster (Laufkarte, AV, Zuständig) mit dem Bereich des Ortes
  (Termine, Knöpfe, bei Extern die Bestellung mit Termin laut Lieferant, beim Versand der Lieferstand).

## Technik

`server/versand.js` (GET /api/versand, POST /api/versand/:id/versendet, GET /api/erledigt), `src/Versand.jsx`, `src/Erledigt.jsx`,
Spur `versand` in `src/planLogic.js`, Spalten `orders.shipped_date`, `orders.ship_info`, Tabelle `versand_rechnung`.
Test: `node scripts/testVersand.mjs` (Test-Odoo mit `MOCK_VERSAND=1`).

## Automatik nach dem Wareneingang (Stand 21.11.2026 abends, `server/automatik.js`)

Was Odoo eindeutig weiß, übernimmt die App selbst (alle 10 Minuten, `AUTOMATIK_AUTO=0` schaltet ab, Knopf über POST /api/automatik/lauf):

- **Fertigung extern** (Position mit Einkaufsbestellung `po_id`): Wareneingang gebucht (Bestellung komplett eingegangen oder die
  Zeile mit demselben Artikel vollständig) → weiter, Standard **QS** (Wareneingangsprüfung). Teil-Wareneingang: „12 von 20
  eingegangen“ an der Position (`orders.ext_info`), sie bleibt.
- **Oberfläche extern**: Lohnarbeit-Bestellung, deren Herkunft die FA-Nummer nennt, eingegangen → weiter, Standard **Versand**.
- Ziel umstellbar im Reiter Versand („Automatisch nach dem Wareneingang“, `plan_settings.auto_nach_fremd` / `auto_nach_oberflaeche`).
  Ohne Kundenauftrag statt Versand: erledigt.
- **Vollständig ausgeliefert** (Schließvorschlag des Odoo-Abgleichs mit diesem Grund): schließt die App selbst. Storno usw. bleiben Vorschläge.
- Schließvorschläge der Fremdfertigung gibt es nur noch, solange die Position in „Fertigung extern“ liegt.
- Protokoll: Tabelle `automatik_log`, sichtbar im Reiter Versand und in „Heute zu tun“.

Darstellung: Überfällige Balken (QS, Fertigung extern, Oberfläche extern) werden bis heute durchgezogen und rot mit „x Tage über
Termin“, sonst „bis TT.MM.“ bzw. der Teil-Wareneingang; im Kopf der Zeile stehen Anzahl und „x überfällig“ getrennt.

## Zu berechnen, genauer (gleicher Stand)

Zusätzlich zu den Mengen je Zeile vergleicht die App den Wert des Gelieferten mit den gebuchten Rechnungsbeträgen (Rechnungen minus
Gutschriften) – auch über Duplikate hinweg (gleicher Kunde und gleiche Bestellnummer des Kunden, z. B. A01233/A01091). Decken die
Rechnungen das Gelieferte, fällt der Auftrag heraus (z. B. A01086 mit unverknüpfter Rechnungszeile). Aufträge über 0 € und Zeilen
ohne Preis zählen nicht.

## Heute zu tun / Morgenrunde

Neue Punkte: versandbereit (gelb ab 2 Tagen), geliefert aber nicht berechnet (mit Summe), was seit gestern automatisch weiterging.
Talos (Werkzeug „heute“), der Morgenbericht um 6:15 und der KI-Planer lesen dieselbe Liste.
