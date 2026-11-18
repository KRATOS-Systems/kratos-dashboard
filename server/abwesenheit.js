// Feiertage, Betriebsruhe und Abwesenheiten aus Odoo (nur lesen).
//   - Globale freie Tage (Odoo: Arbeitszeiten -> Freie Tage ohne Ressource, z. B. Feiertage, Betriebsurlaub) kommen in die freien Tage der
//     Planung, einmal je Tag: Löscht jemand den Tag in der App wieder, kommt er nicht zurück.
//   - Urlaub und Abwesenheit je Mitarbeiter (genehmigt oder beantragt) der nächsten 4 Wochen als Hinweis in der Auslastung.
//     Den Grund (Urlaub, Krankheit …) zeigt die App bewusst nicht, nur "abwesend". Die Maschinenleistung ändert sich dadurch nicht von selbst.

import { addDays, todayStr } from "../src/lib.js";

const EVERY = 6 * 3600 * 1000;
const dayPart = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
// Odoo speichert UTC: 2026-10-31 23:00 ist der 01.11. in Deutschland
const berlinDay = (v) => {
  if (typeof v !== "string") return null;
  const d = new Date(v.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? dayPart(v) : d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
};

export default function registerAbwesenheit(app, db) {
  db.exec("CREATE TABLE IF NOT EXISTS free_days_odoo (date TEXT PRIMARY KEY, name TEXT, at TEXT NOT NULL)");
  let cache = { at: 0, abwesend: [], neu: [] };

  async function sync() {
    const read = app.locals.odooRead;
    if (!read) return cache;
    const today = todayStr();
    const until = addDays(today, 180);
    const global = await read("resource.calendar.leaves", {
      domain: [["resource_id", "=", false], ["date_to", ">=", today + " 00:00:00"], ["date_from", "<=", until + " 23:59:59"]],
      fields: ["name", "date_from", "date_to", "time_type"],
      limit: 300,
    });
    const known = new Set(db.prepare("SELECT date FROM free_days_odoo").all().map((r) => r.date));
    const ins = db.prepare("INSERT OR IGNORE INTO free_days (date, name) VALUES (?, ?)");
    const mark = db.prepare("INSERT OR IGNORE INTO free_days_odoo (date, name, at) VALUES (?, ?, ?)");
    const neu = [];
    for (const g of global) {
      if (g.time_type && g.time_type !== "leave") continue;
      const from = berlinDay(g.date_from);
      const to = berlinDay(g.date_to);
      if (!from || !to) continue;
      for (let d = from; d <= to && d <= until; d = addDays(d, 1)) {
        if (d < today || known.has(d)) continue;
        if (new Date(d + "T00:00:00Z").getUTCDay() === 0) continue; // Sonntag ist ohnehin frei
        const name = String(g.name || "Frei (Odoo)").slice(0, 60);
        if (ins.run(d, name).changes) neu.push({ date: d, name });
        mark.run(d, name, new Date().toISOString());
        known.add(d);
      }
    }
    // Abwesenheiten je Mitarbeiter, nächste 4 Wochen, ohne Grund
    const leaves = await read("hr.leave", {
      domain: [["state", "in", ["validate", "validate1", "confirm"]], ["date_to", ">=", today + " 00:00:00"], ["date_from", "<=", addDays(today, 28) + " 23:59:59"]],
      fields: ["employee_id", "date_from", "date_to", "number_of_days", "state"],
      limit: 300,
    });
    const abwesend = leaves
      .map((l) => ({
        name: Array.isArray(l.employee_id) ? String(l.employee_id[1]) : "?",
        von: berlinDay(l.date_from),
        bis: berlinDay(l.date_to),
        tage: l.number_of_days || null,
        beantragt: l.state === "confirm",
      }))
      .sort((a, b) => (a.von || "").localeCompare(b.von || ""));
    cache = { at: Date.now(), abwesend, neu };
    return cache;
  }

  app.get("/api/abwesenheit", async (req, res) => {
    try {
      if (req.query.neu === "1" || Date.now() - cache.at > EVERY) await sync();
      res.json({ stand: cache.at ? new Date(cache.at).toISOString() : null, abwesend: cache.abwesend, neueFreieTage: cache.neu });
    } catch (err) {
      res.status(502).json({ error: "Odoo nicht lesbar: " + err.message });
    }
  });
  app.locals.abwesenheit = () => cache.abwesend;

  if (process.env.ABWESENHEIT_AUTO !== "0") {
    const run = () => sync().catch((err) => console.error("Abwesenheit:", err.message));
    setTimeout(run, 75 * 1000).unref();
    setInterval(run, EVERY).unref();
  }
}
