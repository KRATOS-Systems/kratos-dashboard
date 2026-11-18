// Soll/Ist lernen: Wie gut waren die Stunden, mit denen geplant wurde?
//
// Jede Position merkt sich, woher ihre Stunden kamen (orders.hours_basis): kalkulation, historie (frühere Aufträge), odoo (Arbeitsplan), hand.
// Ist eine Position erledigt, holt die App aus Odoo die gestempelte Zeit (Rüsten + Fräsen) des Fertigungsauftrags und legt Soll und Ist ab
// (Tabelle soll_ist). Daraus:
//   - Schätzgenauigkeit je Quelle und Maschine (Kennzahlen): Median Ist/Soll, Anteil innerhalb ±20 %
//   - Korrekturfaktor für Stunden aus der Kalkulation, sobald es genug Vergleiche gibt (mind. MIN_N): AV-Pakete schlagen dann
//     die korrigierten Stunden vor und sagen, warum.
// Odoo wird nur gelesen.

import { MACHINES, addDays, todayStr } from "../src/lib.js";

const MIN_N = 5;
const EVERY = 6 * 3600 * 1000;
const short = (id) => (MACHINES.find((m) => m.id === id) || {}).short || id;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Quelle der Stunden aus dem Text eines Vorschlags
export const basisOf = (src) => (/kalkulation/i.test(src || "") ? "kalkulation" : /früher|aus FA|historie/i.test(src || "") ? "historie" : "hand");

export function statsOf(rows) {
  const groups = new Map();
  const add = (key, r) => {
    const g = groups.get(key) || { ratios: [], n: 0 };
    g.ratios.push(r.ist / r.soll);
    g.n++;
    groups.set(key, g);
  };
  rows.forEach((r) => {
    if (!(r.soll > 0) || !(r.ist > 0)) return;
    add(`${r.basis}|*`, r);
    if (r.machine) add(`${r.basis}|${r.machine}`, r);
  });
  return [...groups.entries()]
    .map(([key, g]) => {
      const [basis, machine] = key.split("|");
      return {
        basis,
        machine: machine === "*" ? null : machine,
        maschine: machine === "*" ? "alle" : short(machine),
        n: g.n,
        faktor: Math.round(median(g.ratios) * 100) / 100,
        genau: Math.round((g.ratios.filter((x) => x >= 0.8 && x <= 1.2).length / g.n) * 100),
      };
    })
    .sort((a, b) => a.basis.localeCompare(b.basis) || (a.machine === null ? -1 : b.machine === null ? 1 : a.maschine.localeCompare(b.maschine)));
}

export default function registerSollIst(app, db) {
  db.exec(`CREATE TABLE IF NOT EXISTS soll_ist (
    order_id INTEGER PRIMARY KEY,
    fa TEXT,
    product TEXT,
    machine TEXT,
    basis TEXT NOT NULL,
    soll REAL NOT NULL,
    ist REAL,
    done_date TEXT,
    at TEXT NOT NULL
  )`);
  const cols = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
  if (!cols.includes("hours_basis")) db.exec("ALTER TABLE orders ADD COLUMN hours_basis TEXT");

  async function collect() {
    const read = app.locals.odooRead;
    if (!read) return 0;
    const since = addDays(todayStr(), -180);
    const rows = db
      .prepare(
        `SELECT o.id, o.odoo_id, o.odoo_ref, o.product, o.machine, o.from_machine, o.hours_plan, o.hours, o.hours_basis, o.done_date
         FROM orders o LEFT JOIN soll_ist s ON s.order_id = o.id
         WHERE o.done = 1 AND o.is_split = 0 AND o.odoo_id IS NOT NULL AND COALESCE(o.hours_plan, o.hours) > 0 AND COALESCE(o.done_date, '') >= ? AND s.order_id IS NULL
         LIMIT 200`
      )
      .all(since);
    if (!rows.length) return 0;
    const ids = rows.map((r) => r.odoo_id);
    const wos = await read("mrp.workorder", { domain: [["production_id", "in", ids], ["state", "=", "done"], "|", ["name", "ilike", "Fräs"], ["name", "ilike", "Rüst"]], fields: ["production_id", "duration"], limit: 3000 });
    const ist = new Map();
    wos.forEach((w) => {
      const pid = Array.isArray(w.production_id) ? w.production_id[0] : null;
      if (pid) ist.set(pid, (ist.get(pid) || 0) + (Number(w.duration) || 0));
    });
    const ins = db.prepare("INSERT OR IGNORE INTO soll_ist (order_id, fa, product, machine, basis, soll, ist, done_date, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const ids2 = MACHINES.map((m) => m.id);
    let n = 0;
    for (const r of rows) {
      const minutes = ist.get(r.odoo_id) || 0;
      const machine = ids2.includes(r.machine) ? r.machine : ids2.includes(r.from_machine) ? r.from_machine : null;
      // ohne Stempel kein Vergleich (Ist bleibt leer, wird nicht gewertet)
      ins.run(r.id, r.odoo_ref, r.product, machine, r.hours_basis || "unbekannt", r.hours_plan || r.hours, minutes > 0 ? Math.round((minutes / 60) * 100) / 100 : null, r.done_date, new Date().toISOString());
      n++;
    }
    return n;
  }

  const stats = () => statsOf(db.prepare("SELECT * FROM soll_ist WHERE ist IS NOT NULL").all());
  // Korrekturfaktor für eine Quelle auf einer Maschine (Maschine vor "alle"), nur mit genug Vergleichen
  function faktor(basis, machine) {
    const s = stats();
    const hit = s.find((x) => x.basis === basis && x.machine === machine && x.n >= MIN_N) || s.find((x) => x.basis === basis && x.machine === null && x.n >= MIN_N);
    if (!hit) return null;
    return { ...hit, faktor: Math.min(1.8, Math.max(0.6, hit.faktor)) };
  }

  app.get("/api/soll-ist", async (req, res) => {
    try {
      if (req.query.neu === "1") await collect();
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
    res.json({ stats: stats(), letzte: db.prepare("SELECT * FROM soll_ist WHERE ist IS NOT NULL ORDER BY done_date DESC, order_id DESC LIMIT 30").all(), minN: MIN_N });
  });
  app.locals.sollIst = { stats, faktor, collect };

  if (process.env.SOLLIST_AUTO !== "0") {
    const run = () => collect().catch((err) => console.error("Soll/Ist:", err.message));
    setTimeout(run, 100 * 1000).unref();
    setInterval(run, EVERY).unref();
  }
}
