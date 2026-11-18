# Planen im Chat

Claude (Claude Code oder claude.ai) bekommt eine eigene Verbindung zur Planung: denselben Planungs-MCP wie Talos, aber mit eigenem Schlüssel
`PLAN_CHAT_SECRET` und zusätzlichen Werkzeugen, die etwas ändern:

| Werkzeug | Was |
|---|---|
| `position_verschieben` | Position oder ganzen Auftrag auf eine Maschine an einen Platz (wie Ziehen; Odoo-Arbeitsplan stellt sich mit um) |
| `stunden_setzen` | Stunden einer Position |
| `liefertermin_setzen` | Liefertermin eines Auftrags, mit Grund; der ursprüngliche Termin bleibt im Terminverlauf |
| `position_fixieren` | Position festhalten oder lösen |
| `freigabe_entscheiden` | Vorschlag aus der Freigabe-Liste freigeben oder ablehnen |
| `freigaben_vorbereiten` | AV-Pakete und Planvorschlag neu rechnen |
| `lieferant_status_setzen` | Lieferant angefragt (Mail/Telefon) und/oder neuer Termin vom Lieferanten |
| `lieferant_mail_entwurf` | Mail-Entwurf an den Lieferanten (sendet nichts) |

Dazu alle lesenden Werkzeuge (Planübersicht, Simulation, Platz finden, Heute zu tun, Freigaben, Extern).

**Regel:** Jedes ändernde Werkzeug rechnet ohne `bestaetigt: true` nur vor und ändert nichts. Claude nennt die Folgen und führt erst nach
deinem ausdrücklichen „ja“ aus. Jede Änderung steht im Verlauf als `PLAN_CHAT_NAME` (Standard „Chat (Alexander)“).
Talos (Schlüssel `TALOS_PLAN_SECRET`) bekommt diese Werkzeuge nicht.

## Einrichten beim Hochladen
1. Auf Hostinger beim Dashboard `PLAN_CHAT_SECRET` setzen (zufällig, mind. 24 Zeichen), optional `PLAN_CHAT_NAME`.
2. In Claude Code als MCP-Server eintragen (Typ http): `https://dashboard.kratos-precision.de/mcp/<PLAN_CHAT_SECRET>`, Name `kratos-planung`.
   Der Schlüssel steht nur in der Claude-Konfiguration, nicht im Repository.

Code: `server/chatPlan.js`, Schlüsselwahl in `server/talosPlan.js`, Test `scripts/testChatPlan.mjs`.
