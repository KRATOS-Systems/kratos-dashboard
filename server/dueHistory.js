// Terminverlauf: Wird ein Liefertermin verschoben, bleibt der ursprüngliche Termin erhalten und jede Änderung steht im Verlauf
// (wann, von wem, alter und neuer Termin, Grund).
//
// - Das erste Eintragen eines Termins und das Löschen sind keine Verschiebung.
// - orders.due_original = Liefertermin vor der ersten Verschiebung, orders.due_shifts = Anzahl der Verschiebungen.
// - Korrekturen kurz nacheinander durch dieselbe Person (z. B. beim Tippen des Datums) zählen als eine Änderung. Landet die Korrektur
//   wieder beim alten Termin, verschwindet der Eintrag.
// - change() wird VOR dem Speichern des neuen Termins aufgerufen (liest den alten Stand selbst).

const MERGE_MS = 10 * 60 * 1000;

export default function setupDueHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS due_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      old_due TEXT NOT NULL,
      new_due TEXT NOT NULL,
      at TEXT NOT NULL,
      by_name TEXT,
      reason TEXT,
      via TEXT
    );
    CREATE INDEX IF NOT EXISTS due_history_order ON due_history (order_id);
  `);
  const cols = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
  if (!cols.includes("due_original")) db.exec("ALTER TABLE orders ADD COLUMN due_original TEXT");
  if (!cols.includes("due_shifts")) db.exec("ALTER TABLE orders ADD COLUMN due_shifts INTEGER NOT NULL DEFAULT 0");

  function change(id, newDue, { by = null, reason = null, via = null } = {}) {
    const row = db.prepare("SELECT due_date, due_shifts FROM orders WHERE id = ?").get(id);
    if (!row) return;
    const old = row.due_date;
    if (!old || !newDue || old === newDue) return;
    const now = new Date();
    const last = db.prepare("SELECT * FROM due_history WHERE order_id = ? ORDER BY id DESC LIMIT 1").get(id);
    if (last && last.new_due === old && now.getTime() - Date.parse(last.at) < MERGE_MS && (last.by_name || null) === (by || null) && (last.via || null) === (via || null)) {
      if (last.old_due === newDue) {
        db.prepare("DELETE FROM due_history WHERE id = ?").run(last.id);
        db.prepare("UPDATE orders SET due_shifts = MAX(0, due_shifts - 1), due_original = CASE WHEN due_shifts <= 1 THEN NULL ELSE due_original END WHERE id = ?").run(id);
      } else {
        db.prepare("UPDATE due_history SET new_due = ?, at = ?, reason = COALESCE(?, reason) WHERE id = ?").run(newDue, now.toISOString(), reason, last.id);
      }
      return;
    }
    db.prepare("INSERT INTO due_history (order_id, old_due, new_due, at, by_name, reason, via) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, old, newDue, now.toISOString(), by, reason ? String(reason).slice(0, 300) : null, via);
    db.prepare("UPDATE orders SET due_original = COALESCE(due_original, ?), due_shifts = due_shifts + 1 WHERE id = ?").run(old, id);
  }

  // Verlauf eines Auftrags: alle Positionen mit derselben Auftragsnummer, gleiche Änderungen (gemeinsam gesetzt) nur einmal
  function history(orderId) {
    const row = db.prepare("SELECT id, source FROM orders WHERE id = ?").get(orderId);
    if (!row) return null;
    const ids = row.source ? db.prepare("SELECT id FROM orders WHERE source = ?").all(row.source).map((r) => r.id) : [row.id];
    const all = db.prepare(`SELECT old_due, new_due, at, by_name, reason, via FROM due_history WHERE order_id IN (${ids.map(() => "?").join(",")}) ORDER BY at, id`).all(...ids);
    const seen = new Set();
    return all.filter((h) => {
      const k = `${h.old_due}|${h.new_due}|${h.at.slice(0, 16)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function register(app) {
    app.get("/api/orders/:id/due-history", (req, res) => {
      const list = history(Number(req.params.id));
      if (!list) return res.status(404).json({ error: "not found" });
      res.json({ history: list.map((h) => ({ from: h.old_due, to: h.new_due, at: h.at, by: h.by_name, reason: h.reason, via: h.via })) });
    });
  }

  return { change, history, register };
}
