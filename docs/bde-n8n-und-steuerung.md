# BDE: Vorschläge n8n und Steuerungsanbindung

Nur Beschreibungen. Gebaut wird erst nach Freigabe.

## 1. Sicherheitsnetz beim Ausstempeln (n8n)

Ziel: Egal wo ausgestempelt wird (BDE-Kiosk, Odoo-Kiosk, Odoo-Backend), enden alle noch laufenden Personentätigkeiten des Mitarbeiters zur Ausstempelzeit. Maschinenläufe bleiben unberührt.

- **Trigger:** Zeitplan alle 2 Minuten (Odoo Online kann keine eigenen Webhooks ohne Studio/Automatisierung; mit einer Odoo-Automatisierungsregel „bei Änderung von hr.attendance, check_out gesetzt → Webhook“ geht es auch sofort).
- **Abfrage 1:** `hr.attendance.search_read` mit `check_out >= letzter Lauf` → Mitarbeiter und `check_out`.
- **Abfrage 2:** je Mitarbeiter `mrp.workcenter.productivity.search_read` mit `employee_id = …`, `date_end = false` → laufende Buchungen mit Arbeitsplatz.
- **Filter:** nur Personentätigkeiten (Arbeitsplatz enthält nicht FRÄSEN/DREHEN/EXTERN).
- **Aktion:** je Buchung `mrp.workorder.stop_employee(employee_ids=[…])` am Arbeitsgang, danach am gerade geschlossenen Zeiteintrag `write` mit `date_end = check_out` und Vermerk „Automatisch beendet beim Ausstempeln (n8n)“, falls zwischen Ausstempeln und Lauf Zeit vergangen ist.
- **Merken:** Zeitpunkt des letzten Laufs in einer n8n-Datentabelle.

## 2. Erinnerungen über Talos (n8n)

- **Trigger:** alle 30 Minuten, Mo–Sa 6–22 Uhr.
- **Abfrage:** `GET https://<dashboard>/api/bde/reminders` mit Kopfzeile `x-bde-reminder-key` (Umgebungsvariable `BDE_REMINDER_KEY`). Antwort: vergessene, doppelte und zu lange Buchungen mit Odoo-Benutzer-ID, dazu die Leitung.
- **Aktion:** Nachricht über den Talos-Bot im Odoo-Chat an den Mitarbeiter („Programmierung FA01262 läuft seit gestern 15:10 – noch richtig?“), bei über 24 Stunden zusätzlich an die Leitung. Je Buchung nur einmal am Tag (n8n-Datentabelle).

## 3. Automatische Maschinenzeit (Ausblick)

Die App erkennt Maschinenlauf am Arbeitsplatz, nicht an der Quelle. Eine Steuerungsanbindung kann die manuelle Fräsbuchung deshalb ersetzen, ohne die Oberfläche zu ändern:

- **Je Maschine ein Arbeitsplatz in Odoo** (z. B. „FRÄSEN DMU 40“), Zuordnung über `BDE_MACHINES`.
- **Sammler** (kleiner Dienst im Firmennetz, liest OPC UA bzw. MTConnect): Programmstart, Programmende, Programmname mit Auftragsnummer (z. B. `FA01212_OP1`).
- **Buchen:** bei Programmstart `start_employee` am Fräs-Arbeitsgang des Auftrags mit einem Maschinen-Mitarbeiter („DMU 40“) oder dem zuletzt eingestempelten Bediener, bei Programmende `stop_employee`; Vermerk „Quelle: Steuerung“ in der Beschreibung.
- **Umschalten je Maschine:** sobald eine Maschine automatisch bucht, blendet die App für diesen Arbeitsplatz den manuellen Fräsen-Start aus (Einstellung je Maschine), die Rückfrage am Kiosk entfällt.
- Die Maschinenzeit-Prüfung bleibt als Kontrolle bestehen.
