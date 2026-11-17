# Extern & Wareneingang

Planung → Reiter **Extern**. Alles aus Odoo, nur gelesen. Bestellt, aber noch nicht da = Wareneingang (WH/IN) nicht validiert.

## Was die App zeigt
- **Handlungsbedarf**: Wareneingang überfällig → „Lieferant anfragen“; angefragt, aber nach 2 Werktagen ohne neuen Termin → „erneut anfragen“; Termin in 2 Werktagen → „vorab nachfragen“. Dazu: welche Fertigungsaufträge und Kundenaufträge daran hängen und ob ein Kundentermin in Gefahr ist.
- **Externer Arbeitsgang ohne Bestellung**: Strahlen, Schleifen, Härten, Oberfläche, Drehen extern laut Arbeitsplan (Arbeitsplatz „… (EXTERN)“), aber keine passende bestätigte Bestellung (Lohnarbeit mit passendem Text oder Zukauf des ganzen Teils, Herkunft FA- oder A-Nummer). Material zum FA zählt nicht. Dringend, wenn die Maschine in 7 Tagen fertig ist.
- **Alle offenen Wareneingänge** mit Termin, Stand und hängenden Positionen.
- **Termintreue je Lieferant** (12 Monate): validierte Wareneingänge gegen den zugesagten Termin, mittlere Verspätung, Durchlauf Bestellung → Wareneingang.
- **Altlasten**: bestätigte Bestellungen ohne Wareneingang, Wareneingänge ohne Bestellung (zum Aufräumen in Odoo).

## Lieferant anfragen
„Mail an Lieferant“ baut die Mail (Bestellnummer, deren Referenz, offene Mengen, Termin), deutsch oder englisch (nach Sprache/Land des Lieferanten in Odoo, umschaltbar), an die Mailadresse aus Odoo (sonst die der Firma). **Die App sendet nichts**, die Mail öffnet sich im Mailprogramm. Danach „Angefragt per Mail/Telefon“ abhaken. Nennt der Lieferant einen neuen Termin: eintragen → gilt sofort in der Planung (Materialtermin der Fertigungsaufträge, Dauer der Fremdfertigung) und bleibt auch nach dem nächsten Odoo-Abgleich. In Odoo ändert sich nichts.

„Heute zu tun“ zeigt überfällige Lieferungen (rot), fehlende Bestellungen und bald fällige Lieferungen. Talos kennt alles über das Werkzeug `extern_offen`.

Code: `server/extern.js`, `src/Extern.jsx`, Test `scripts/testExtern.mjs` (Test-Odoo mit `MOCK_EXTERN=1`). Abschalten des Hintergrund-Ladens: `EXTERN_AUTO=0`.
