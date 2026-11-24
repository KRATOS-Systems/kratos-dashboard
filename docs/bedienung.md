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

Stufe 2 (später, nur nach Freigabe): Planungsseite und Positionsfenster neu ordnen (Zeitstrahl nach oben, eine Hauptaktion je Fenster).
