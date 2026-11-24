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

Stufe 2 (später, nur nach Freigabe): Planungsseite und Positionsfenster neu ordnen (Zeitstrahl nach oben, eine Hauptaktion je Fenster).
