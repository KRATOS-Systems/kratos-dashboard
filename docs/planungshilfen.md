# Planungshilfen

## Liefertermin für eine Anfrage
Planung → Reiter **Auslastung** → „Liefertermin für eine Anfrage“. Stunden eingeben (oder Zeichnungsnummer + Menge, dann aus der Kalkulation),
Tage extern, Material-Vorlauf, QS. Die App rechnet mit der echten Belegung je Maschine:
- **hinten anstellen**: der Auftrag kommt ans Ende, niemand verschiebt sich (der ehrliche Termin fürs Angebot)
- **vorziehen**: frühester Platz, an dem kein anderer Auftrag zu spät wird

Liefertermin = Maschine fertig + extern + 1 Werktag QS + 2 Werktage Puffer. Die M1 nur, wenn das Teil dort geht. Talos: `liefertermin_schaetzen`.
Speichert nichts. Code: `server/liefertermin.js`, `src/LieferterminAnfrage.jsx`.

## Feiertage und Abwesenheit aus Odoo
Alle 6 Stunden: globale freie Tage aus Odoo (Arbeitszeiten → freie Tage ohne Ressource, z. B. Feiertage, Betriebsruhe) kommen in die freien
Tage der Planung, je Tag einmal (in der App gelöscht bleibt gelöscht). Abwesenheiten der nächsten 4 Wochen stehen im Reiter Auslastung,
**ohne Grund** (kein „Krankheit“). Die Maschinenleistung ändert sich dadurch nicht von selbst. Code: `server/abwesenheit.js`, `src/Abwesend.jsx`.

## Morgenbericht als Nachricht
Werktags 6:15 Uhr: „Heute zu tun“, Planvorschlag des Tages (Text von Talos, wenn vorhanden), Extern & Wareneingang, offene Freigaben, Link.
Versand über eine Weiterleitung (n8n-Webhook, der die Mail schickt). Ohne Einrichtung wird nichts verschickt; lesbar unter `GET /api/morgenbericht`.
Von Hand nachsenden: `POST /api/morgenbericht/senden` (nur Leitung).

Einrichten beim Hochladen (Hostinger, Dashboard):
| Variable | Wert |
|---|---|
| `MORGENBERICHT_WEBHOOK` | URL des n8n-Webhooks |
| `MORGENBERICHT_AN` | Empfänger, durch Komma getrennt (z. B. Frank) |
| `MORGENBERICHT_KEY` | geteiltes Geheimnis, kommt als `Authorization: Bearer …` beim Webhook an |

n8n: Webhook (POST, Header prüfen) → E-Mail senden (An = `an`, Betreff = `betreff`, Text = `text`).
Code: `server/morgenbericht.js`, Test `scripts/testPlanHilfen.mjs`.
