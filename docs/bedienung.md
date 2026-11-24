# Bedienung, Stufe 1 (24.11.2026)

Ziel: einfacher zu bedienen, ohne etwas umzustellen. Alles Neue steht in `src/bedienung.css` (nach `look.css` geladen),
dazu kleine Änderungen in den Komponenten.

## Grundsätze

- **Knöpfe** sind erhaben: Fläche, Rahmen, leichter Schatten, Hand-Zeiger, reagieren beim Darüberfahren.
- **Links** (leise Knöpfe wie „Fehler melden“, „Prio aus“) sind blau und beim Darüberfahren unterstrichen.
- **Etiketten** (Pillen wie „Puffer 14 Tage“, „nicht startklar“) zeigen nur Zustand: flach, eckig, ohne Rahmen.
  Rot nur bei „jetzt handeln“ und auch dann nur getönt, nicht als rote Fläche.
- **Eingabefelder und Auswahllisten** sind heller und leicht vertieft, mit eigenem Pfeil bei Auswahllisten und
  blauem Rahmen beim Anklicken. Nicht änderbare Felder ohne Fläche, gestrichelt.
- **Schrift** eine Stufe größer (einmalig in CSS und JSX umgerechnet: 11 → 12,5, 12 → 13, 13 → 14, 14 → 15 px; Grundschrift 15 px),
  graue Schrift kontrastreicher (`--muted`, `--faint`). Keine Großbuchstaben-Zeilen mehr bei Beschriftungen und Tabellenköpfen.
- **Klartext statt Kürzel**: „AV: 2 von 6 erledigt“, „+3 Tage“, „Puffer 1 Tag“.

## Einzelnes

- Positionsfenster: **„Prio setzen“** steht oben in der ersten Knopfreihe (nur Leitung).
- Versand: **„Jetzt prüfen“** im Fenster der Versand-Spur und im Fenster einer Position im Versand (`GET /api/versand?neu=1`).
- Linke Leiste: Suchen, Hinweise, Assistent bleiben; Hilfe, Feedback, Datensicherung, Hell/Dunkel, Leiste und Look liegen unter
  **„Mehr“** (aufgeklappt bleibt es auf dem Gerät, `localStorage kratos-mehr`). Zähler in der Leiste neutral statt rot.

## Material: eine Aussage statt zwei (`avLib.materialStand`)

Vorher zeigte das Etikett oben Odoos Komponentenstatus („Material fehlt“) und die Laufkarte die AV-Checkliste („Material da“),
auch wenn beides sich widersprach (Beispiel FA01363: in der AV abgehakt, in Odoo Bestand −32, Anfragen nur Entwurf).
Jetzt gilt eine Regel für Etikett, Laufkarte und Hinweise:

| AV-Checkliste | Odoo | Anzeige |
|---|---|---|
| bereit | verfügbar oder nichts | Material da (grün) |
| offen | verfügbar | Material da (Odoo) (grün) |
| bereit | nicht verfügbar | **Material: AV sagt da, Odoo sagt fehlt** (gelb, Laufkarte offen „bitte klären“) |
| offen | nicht verfügbar | Material fehlt (rot) |
| offen | erwartet | Material erwartet (gelb) |
| nicht nötig | egal | kein Etikett |

Alle Widersprüche stehen in der Steuerung unter „Datenqualität“ (Gruppe `material`). Lösen: Liegt die Ware da, in Odoo Wareneingang
bzw. Bestand buchen; fehlt sie, in der AV den Punkt Material zurücksetzen. Test: `scripts/testBedienung.mjs`.

# Bedienung, Stufe 2 (24.11.2026, gleicher PR)

- **Hinweise** (Glocke): nur, was jetzt Handeln braucht, je Auftrag zusammengefasst (Liefertermin gefährdet; startet in 7 Tagen und
  ist nicht bereit; Material klären). Jeder Eintrag lässt sich **für heute ausblenden** (×, je Gerät, `localStorage kratos-hinweise-aus`),
  morgen ist er wieder da, wenn er noch zutrifft. Zähler in der Leiste ohne Ausgeblendete. `Overlays.alertsList`.
- **Planungsseite**: Prio-Leiste, Heute-Liste und die vier Kennzahlen sind eine Zeile (`.ov-strip`); „Heute & Prio zeigen“ klappt
  die beiden Listen auf (gemerkt, `kratos-ueberblick`). Der Zeitstrahl steht damit direkt oben. Klick auf eine Kennzahl hebt wie bisher hervor.
- **Positionsfenster**: oben „Position“ + Nummer, darunter **ein Satz** (wo, wann, was fehlt, ggf. „wird x Tage nach dem Liefertermin
  fertig“), dann die Hauptknöpfe (**Fertig produziert**, Prio setzen, Im Zeitstrahl, AV, Zeichnung). Abschnitte Laufkarte, Plan und Zeiten,
  Zuständig (standardmäßig zu) und Arbeitsvorbereitung lassen sich zuklappen (gemerkt, `kratos-fenster-abschnitte`). Das Etikett
  „nicht startklar“ entfällt, der Satz sagt es.
- **Rückgängig** (6,5 Sekunden im Hinweis unten): nach Fertig produziert, Geprüft, Versendet, Zurück in den Versand und Erledigt.
  Schreibt den alten Zustand zurück, auf einer Maschine auch den alten Platz (`undoFor` in Planning.jsx).
- **Werkstatt**: Auf Touch-Geräten (`pointer: coarse`) sind Knöpfe und Felder mindestens 46 px hoch, Schrift 16 px. Team-Tafel im Vollbild größer.
- **Begriffe**: Fenster zeigt „Position FA…“ und „Auftrag A…“, die Laufkarte heißt „Laufkarte Auftrag A…“.
- **Balken**: Kurztext „noch 12 h · 47 % fertig“, Terminlinie „3 Tage zu spät“ / „15 Tage Puffer“.
- **Kopfzeile**: „Alle Verbindungen laufen“ bzw. „Bitte prüfen: Odoo“; „Odoo abgeglichen 18:05 Uhr“ bzw. „Odoo-Abgleich mit Fehler“.
- **Suche**: Suchfeld oben auf Planung, Steuerung, Dashboard und Team (öffnet die Suche wie Strg K). `Bedienhilfe.jsx`.
- **Hilfe**: „?“ neben jedem Seitentitel mit zwei, drei Sätzen und Link zur ausführlichen Hilfe. Texte in `Bedienhilfe.jsx` (`HILFE`).
