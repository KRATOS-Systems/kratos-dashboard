// Zuständigkeiten der Planung speichern: Stammbediener je Maschine, Rollen (QS, Arbeitsvorbereitung, Planung)
// und Abweichungen je Position und Tätigkeit. Die Regeln stehen in src/staffLib.js.

import { STAFF, STAFF_DEFAULTS, STAFF_KEYS, STAFF_EMPTY_OK, ACTIVITIES } from "../src/staffLib.js";

const NAMES = new Set(STAFF.map((s) => s.name));
const ACT_IDS = new Set(ACTIVITIES.map((a) => a.id));

export default function registerStaff(app, db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_defaults (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    -- Zur Info: Arbeit von "source" (scope "av" = Arbeitsvorbereitung, "teile" = Teile) wird "target" zur Information gezeigt
    CREATE TABLE IF NOT EXISTS staff_info (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      scope TEXT NOT NULL,
      PRIMARY KEY (source, target, scope)
    );
    CREATE TABLE IF NOT EXISTS order_staff (
      order_id INTEGER NOT NULL,
      activity TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (order_id, activity)
    );
  `);

  const defaults = () => {
    const out = { ...STAFF_DEFAULTS };
    db.prepare("SELECT key, name FROM staff_defaults").all().forEach((r) => {
      if (STAFF_KEYS.includes(r.key)) out[r.key] = r.name;
    });
    return out;
  };
  // Einmalig: Frank arbeitet Nino in der Arbeitsvorbereitung ein (Stand 22.10.2026)
  if (!db.prepare("SELECT 1 FROM plan_settings WHERE key = 'staff_info_seeded'").get()) {
    db.prepare("INSERT OR IGNORE INTO staff_info (source, target, scope) VALUES ('Nino', 'Frank', 'av')").run();
    db.prepare("INSERT INTO plan_settings (key, value) VALUES ('staff_info_seeded', 1) ON CONFLICT (key) DO UPDATE SET value = 1").run();
  }
  const info = () => db.prepare("SELECT source, target, scope FROM staff_info ORDER BY target, source, scope").all();
  const overrides = () => new Map(db.prepare("SELECT order_id, activity, name FROM order_staff").all().map((r) => [`${r.order_id}|${r.activity}`, r.name]));

  app.get("/api/staff", (req, res) => {
    res.json({ defaults: defaults(), orders: db.prepare("SELECT order_id, activity, name FROM order_staff").all(), info: info() });
  });

  // Standard ändern; leerer Name nur dort, wo er etwas bedeutet (Programmierung = Stammbediener, AV-Programm = wie Programmierung)
  app.put("/api/staff/defaults", (req, res) => {
    const { key, name } = req.body || {};
    if (!STAFF_KEYS.includes(key)) return res.status(400).json({ error: "invalid key" });
    if (name === "" && STAFF_EMPTY_OK.includes(key)) {
      db.prepare("INSERT INTO staff_defaults (key, name) VALUES (?, '') ON CONFLICT (key) DO UPDATE SET name = ''").run(key);
    } else if (NAMES.has(name)) {
      db.prepare("INSERT INTO staff_defaults (key, name) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET name = excluded.name").run(key, name);
    } else return res.status(400).json({ error: "invalid name" });
    res.json({ defaults: defaults() });
  });

  // Abweichung je Position und Tätigkeit; name = null entfernt sie (dann gilt der Standard)
  app.put("/api/staff/order", (req, res) => {
    const { order_id, activity, name } = req.body || {};
    if (!Number.isInteger(order_id) || !ACT_IDS.has(activity) || !(name === null || NAMES.has(name))) return res.status(400).json({ error: "invalid payload" });
    if (!db.prepare("SELECT 1 FROM orders WHERE id = ?").get(order_id)) return res.status(404).json({ error: "not found" });
    if (name === null) db.prepare("DELETE FROM order_staff WHERE order_id = ? AND activity = ?").run(order_id, activity);
    else db.prepare("INSERT INTO order_staff (order_id, activity, name) VALUES (?, ?, ?) ON CONFLICT (order_id, activity) DO UPDATE SET name = excluded.name").run(order_id, activity, name);
    res.json({ ok: true });
  });

  // Zur Info hinzufügen oder entfernen (remove: true)
  app.post("/api/staff/info", (req, res) => {
    const { source, target, scope, remove } = req.body || {};
    if (!NAMES.has(source) || !NAMES.has(target) || source === target || !["av", "teile"].includes(scope)) return res.status(400).json({ error: "invalid payload" });
    if (remove) db.prepare("DELETE FROM staff_info WHERE source = ? AND target = ? AND scope = ?").run(source, target, scope);
    else db.prepare("INSERT OR IGNORE INTO staff_info (source, target, scope) VALUES (?, ?, ?)").run(source, target, scope);
    res.json({ info: info() });
  });

  return { defaults, overrides, info };
}
