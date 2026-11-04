# Odoo-Regeln für Stücklisten (von Hand in Odoo einzurichten)

Hintergrund: Ein Fertigungsauftrag entsteht beim Bestätigen der Bestellung, oft bevor die Arbeitsvorbereitung Maschine und Arbeitsgänge kennt.
Damit nie ein Auftrag ohne Arbeitsgänge bleibt, bekommt jeder Fertigungsauftrag sofort eine Stückliste: die des Artikels oder eine Musterstückliste.
Die Musterstückliste hat die Referenz **MUSTER**, allgemeine Arbeitsplätze (RÜSTEN, FRÄSEN) und 0 Minuten. Das Dashboard kennzeichnet solche Aufträge
mit „Zeit ungeprüft (Muster)". Die Arbeitsvorbereitung ändert Maschine, Zeiten und Arbeitsgänge danach am Auftrag oder an der Stückliste;
wer die Referenz MUSTER entfernt, nimmt die Kennzeichnung weg.

Wichtig: Die Arbeitsgänge werden beim Eintragen der Stückliste in den Auftrag **kopiert**. Spätere Änderungen an der Stückliste ändern
einen schon angelegten Auftrag nicht. Dort wird am Auftrag selbst geändert (Maschine umhängen geht im Dashboard).

**Stand 4.11.2026:** Beide Regeln sind in Odoo eingerichtet und aktiv (Automatisierungsregeln Nr. 17 und 18, per Browser angelegt, weil die Schnittstelle (MCP)
Automatisierungsregeln sperrt). Getestet mit einem Test-Fertigungsauftrag ohne Stückliste: Regel 1 hat die Musterstückliste mit vier Arbeitsgängen angelegt
und eingetragen (Test danach storniert, Musterstückliste archiviert). Regel 2 ist ungetestet; sie greift praktisch nur noch, wenn eine Stückliste
angelegt wird, während ein Entwurf ohne Stückliste existiert.

Im Regelcode sind Zuweisungen wie `mo.bom_id = bom` in Odoo verboten (Validierungsfehler „forbidden opcode STORE_ATTR"), deshalb `mo.write({...})`.

Neu einrichten (falls nötig) von Hand:
Odoo → Einstellungen → Entwicklermodus aktivieren → Technisch → Automatisierung → Automatisierungsregeln → Neu.

## Regel 1: Fertigungsauftrag ohne Stückliste

- Name: Fertigungsauftrag ohne Stückliste: Stückliste des Artikels eintragen oder Muster anlegen
- Modell: Fertigungsauftrag
- Auslöser: Bei Erstellung
- Anwenden auf (Filter): `[("bom_id", "=", False)]`
- Aktion: Python-Code ausführen

```python
for mo in records:
    try:
        if mo.bom_id or not mo.product_id:
            continue
        tmpl = mo.product_id.product_tmpl_id
        bom = env['mrp.bom'].search([('product_tmpl_id', '=', tmpl.id), '|', ('product_id', '=', False), ('product_id', '=', mo.product_id.id)], order='sequence, id', limit=1)
        if not bom:
            ops = [('Programmieren', 6, 20), ('Rüsten', 10, 30), ('Fräsen', 1, 40), ('QS Endprüfung', 5, 70)]
            bom = env['mrp.bom'].create({
                'product_tmpl_id': tmpl.id,
                'product_qty': 1.0,
                'type': 'normal',
                'code': 'MUSTER',
                'operation_ids': [(0, 0, {'name': n, 'workcenter_id': w, 'sequence': s, 'time_mode': 'manual', 'time_cycle_manual': 0.0}) for (n, w, s) in ops],
            })
        mo.write({'bom_id': bom.id})
    except Exception as e:
        log('Musterstückliste fehlgeschlagen für %s: %s' % (mo.display_name, e), level='error')
```

Die Nummern in `ops` sind die Arbeitsplätze: 6 CAM-PROGRAMMIERUNG, 10 RÜSTEN, 1 FRÄSEN, 5 QUALITÄTSSICHERUNG (QS).
Der Code fängt jeden Fehler ab und schreibt ihn nur ins Protokoll (Einstellungen → Technisch → Protokollierung), damit das Anlegen eines Fertigungsauftrags
(und damit das Bestätigen der Bestellung) nie daran scheitert. Keine Chatter-Nachricht, sonst würde die Regel „Talos: Nachricht im Kanal KI Fertigung" auslösen.

## Regel 2: Stückliste kommt später

- Name: Neue Stückliste in offene Entwurfs-Fertigungsaufträge desselben Artikels eintragen
- Modell: Stückliste
- Auslöser: Bei Erstellung
- Aktion: Python-Code ausführen

```python
for bom in records:
    try:
        tmpl = bom.product_tmpl_id
        if not tmpl:
            continue
        mos = env['mrp.production'].search([('product_id.product_tmpl_id', '=', tmpl.id), ('bom_id', '=', False), ('state', '=', 'draft')])
        for mo in mos:
            mo.write({'bom_id': bom.id})
    except Exception as e:
        log('Stückliste in Entwürfe eintragen fehlgeschlagen für %s: %s' % (bom.display_name, e), level='error')
```

Nur Entwürfe: bei bestätigten oder laufenden Aufträgen entstehen die Arbeitsgänge nicht mehr nachträglich.

## Prüfen

1. Einen Test-Fertigungsauftrag für einen Artikel ohne Stückliste anlegen (Entwurf): er muss die Musterstückliste mit vier Arbeitsgängen bekommen.
2. Für denselben Artikel eine zweite Bestellung: kein zweites Muster, sondern dieselbe Stückliste.
3. Stückliste eines anderen Artikels neu anlegen, während ein Entwurf ohne Stückliste existiert: der Entwurf bekommt sie.
4. Im Dashboard nach dem nächsten Abgleich (alle 10 Minuten): „Zeit ungeprüft (Muster)" bei Aufträgen mit Musterstückliste.

Hinweis zur Kalkulation: „Stückliste anlegen" in der Kalkulation legt nur an, wenn der Artikel noch keine hat. Eine Musterstückliste muss dort vorher archiviert werden.
