import express from "express";
import cors from "cors";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const DIST_PATH = path.join(__dirname, "..", "dist");

const MACHINES = ["dmu40", "m1", "h800u"];
// Orte neben den Maschinen: QS, Extern Fertigung, Extern Oberfläche ("extern")
const LANES = ["qs", "extern_fert", "extern"];
const DEFAULT_CAPACITY = 40;

// DB_PATH sollte außerhalb des per Git deployten App-Ordners liegen,
// sonst wird die Datenbank bei jedem Redeploy zurückgesetzt.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "dashboard.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

// Gesamtzählerstände je Ablesedatum und Maschine. Die Wochenstunden werden
// im Frontend aus der Differenz zweier Ablesungen berechnet.
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    reading_date TEXT NOT NULL,
    machine TEXT NOT NULL,
    machine_total REAL,
    spindle_total REAL,
    PRIMARY KEY (reading_date, machine)
  );

  CREATE TABLE IF NOT EXISTS settings (
    machine TEXT PRIMARY KEY,
    capacity_hours REAL NOT NULL
  );

  -- Arbeitsfreie Tage für die Planung (Feiertage, Betriebsurlaub), zählen wie Sonntage.
  -- free_days_seeded merkt sich die Jahre, für die die Feiertage schon eingetragen wurden,
  -- damit gelöschte Feiertage nicht wieder auftauchen.
  CREATE TABLE IF NOT EXISTS free_days (
    date TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS free_days_seeded (
    year INTEGER PRIMARY KEY
  );

  -- Schichtmodell (Betriebszeit in Stunden) für die Woche, die am Datum der
  -- Ablesung beginnt, für alle Maschinen. Die Stunden zwischen zwei Ablesungen
  -- werden mit dem Wert der früheren Ablesung bewertet.
  CREATE TABLE IF NOT EXISTS week_capacity (
    reading_date TEXT PRIMARY KEY,
    capacity_hours REAL NOT NULL
  );

  -- Aufträge je Maschine für die Planung (machine '' = noch nicht eingeplant,
  -- hours = Gesamtstunden, done_hours = bereits gelaufen, position =
  -- Reihenfolge, odoo_ref/source/product/quantity stammen aus dem Odoo-Import)
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine TEXT NOT NULL,
    order_no TEXT NOT NULL DEFAULT '',
    hours REAL NOT NULL DEFAULT 0,
    done_hours REAL NOT NULL DEFAULT 0,
    due_date TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    odoo_ref TEXT,
    source TEXT,
    product TEXT,
    quantity REAL,
    extern_tags TEXT NOT NULL DEFAULT '[]',
    extern_days INTEGER NOT NULL DEFAULT 7,
    extern_start TEXT
  );

  -- Allgemeine Einstellungen der Planung (z. B. tight_days = Mindestpuffer)
  CREATE TABLE IF NOT EXISTS plan_settings (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL
  );

  -- Eigene Wochenleistung der Planung; ohne Zeile gilt der Durchschnitt
  CREATE TABLE IF NOT EXISTS plan_rates (
    machine TEXT PRIMARY KEY,
    weekly_hours REAL NOT NULL
  );
`);

// Die Dauer der externen Bearbeitung wird in Tagen gespeichert (früher in Wochen)
const columnsOf = () => db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
if (columnsOf().includes("extern_weeks")) {
  db.exec("ALTER TABLE orders RENAME COLUMN extern_weeks TO extern_days");
  db.exec("UPDATE orders SET extern_days = extern_days * 7");
}

// Bestehende orders-Tabellen um später hinzugekommene Spalten ergänzen
const orderColumns = columnsOf();
[
  ["done_hours", "REAL NOT NULL DEFAULT 0"],
  ["odoo_ref", "TEXT"],
  ["source", "TEXT"],
  ["product", "TEXT"],
  ["quantity", "REAL"],
  ["extern_tags", "TEXT NOT NULL DEFAULT '[]'"],
  ["extern_days", "INTEGER NOT NULL DEFAULT 7"],
  ["odoo_id", "INTEGER"],
  ["earliest_start", "TEXT"],
  ["component_status", "TEXT"],
  ["hours_plan", "REAL"],
  ["qs_required", "INTEGER NOT NULL DEFAULT 1"],
  ["is_split", "INTEGER NOT NULL DEFAULT 0"],
  ["part_label", "TEXT"],
  ["part_group", "TEXT"],
  ["parent_ref", "TEXT"],
  ["qs_days", "INTEGER NOT NULL DEFAULT 2"],
  ["from_machine", "TEXT"],
  ["produced_date", "TEXT"],
  ["checked_date", "TEXT"],
  ["done_date", "TEXT"],
  ["progress_date", "TEXT"],
  ["extern_start", "TEXT"],
].forEach(([name, type]) => {
  if (!orderColumns.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
});
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS orders_odoo_ref ON orders (odoo_ref)");

// Kapazität mit Standardwert vorbelegen, falls noch nicht vorhanden
const insertDefaultCapacity = db.prepare(
  "INSERT OR IGNORE INTO settings (machine, capacity_hours) VALUES (?, ?)"
);
MACHINES.forEach((m) => insertDefaultCapacity.run(m, DEFAULT_CAPACITY));

const isDate = (s) =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isTotal = (v) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

const app = express();

// Passwortschutz: Ist APP_PASSWORD gesetzt (z. B. in den Umgebungsvariablen bei Hostinger),
// fragt der Browser beim Öffnen nach Benutzername und Passwort. Ohne Variable (lokal) ist alles offen.
const APP_USER = process.env.APP_USER || "kratos";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
if (APP_PASSWORD) {
  const sha = (s) => createHash("sha256").update(String(s)).digest();
  const expectedUser = sha(APP_USER);
  const expectedPass = sha(APP_PASSWORD);
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const i = decoded.indexOf(":");
      const user = i < 0 ? decoded : decoded.slice(0, i);
      const pass = i < 0 ? "" : decoded.slice(i + 1);
      const okUser = timingSafeEqual(sha(user), expectedUser);
      const okPass = timingSafeEqual(sha(pass), expectedPass);
      if (okUser && okPass) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Kratos Produktion", charset="UTF-8"');
    res.status(401).send("Anmeldung erforderlich");
  });
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/readings", (req, res) => {
  const rows = db
    .prepare("SELECT reading_date, machine, machine_total, spindle_total FROM readings ORDER BY reading_date")
    .all();
  res.json({
    readings: rows.map((r) => ({
      date: r.reading_date,
      machine: r.machine,
      machine_total: r.machine_total,
      spindle_total: r.spindle_total,
    })),
  });
});

app.put("/api/readings", (req, res) => {
  const { date, machine, machine_total, spindle_total } = req.body || {};

  if (!isDate(date) || !MACHINES.includes(machine) || !isTotal(machine_total) || !isTotal(spindle_total)) {
    return res.status(400).json({ error: "invalid payload" });
  }

  if (machine_total === null && spindle_total === null) {
    db.prepare("DELETE FROM readings WHERE reading_date = ? AND machine = ?").run(date, machine);
  } else {
    db.prepare(
      `INSERT INTO readings (reading_date, machine, machine_total, spindle_total)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (reading_date, machine)
       DO UPDATE SET machine_total = excluded.machine_total, spindle_total = excluded.spindle_total`
    ).run(date, machine, machine_total, spindle_total);
  }

  res.json({ date, machine, machine_total, spindle_total });
});

const freeDaysOut = () => ({
  days: db.prepare("SELECT date, name FROM free_days ORDER BY date").all(),
  seeded_years: db.prepare("SELECT year FROM free_days_seeded ORDER BY year").all().map((r) => r.year),
});

app.get("/api/free-days", (req, res) => res.json(freeDaysOut()));

// Mehrere Tage eintragen. Mit seed_year (automatische Feiertage) werden vorhandene Tage nicht
// überschrieben und das Jahr als eingetragen gemerkt, sonst wird der Name aktualisiert.
app.post("/api/free-days", (req, res) => {
  const { days, seed_year } = req.body || {};
  const valid =
    Array.isArray(days) &&
    days.length > 0 &&
    days.length <= 400 &&
    days.every((d) => d && isDate(d.date) && typeof d.name === "string" && d.name.trim() && d.name.length <= 60) &&
    (seed_year === undefined || (Number.isInteger(seed_year) && seed_year >= 2000 && seed_year <= 2100));
  if (!valid) return res.status(400).json({ error: "invalid payload" });

  const sql =
    seed_year !== undefined
      ? "INSERT OR IGNORE INTO free_days (date, name) VALUES (?, ?)"
      : "INSERT INTO free_days (date, name) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET name = excluded.name";
  const insert = db.prepare(sql);
  db.exec("BEGIN");
  try {
    days.forEach((d) => insert.run(d.date, d.name.trim()));
    if (seed_year !== undefined) db.prepare("INSERT OR IGNORE INTO free_days_seeded (year) VALUES (?)").run(seed_year);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.json(freeDaysOut());
});

app.delete("/api/free-days/:date", (req, res) => {
  if (!isDate(req.params.date)) return res.status(400).json({ error: "invalid date" });
  db.prepare("DELETE FROM free_days WHERE date = ?").run(req.params.date);
  res.json(freeDaysOut());
});

app.delete("/api/week-capacity/:date", (req, res) => {
  if (!isDate(req.params.date)) return res.status(400).json({ error: "invalid date" });
  db.prepare("DELETE FROM week_capacity WHERE reading_date = ?").run(req.params.date);
  res.json({ date: req.params.date });
});

app.get("/api/week-capacity", (req, res) => {
  const capacities = {};
  db.prepare("SELECT reading_date, capacity_hours FROM week_capacity").all().forEach((r) => {
    capacities[r.reading_date] = r.capacity_hours;
  });
  res.json({ capacities });
});

app.put("/api/week-capacity", (req, res) => {
  const { date, capacity_hours } = req.body || {};
  const hours = Number(capacity_hours);
  if (!isDate(date) || !Number.isFinite(hours) || hours < 0 || hours > 168) {
    return res.status(400).json({ error: "invalid payload" });
  }
  db.prepare(
    "INSERT INTO week_capacity (reading_date, capacity_hours) VALUES (?, ?) ON CONFLICT (reading_date) DO UPDATE SET capacity_hours = excluded.capacity_hours"
  ).run(date, hours);
  res.json({ date, capacity_hours: hours });
});

app.get("/api/settings", (req, res) => {
  const rows = db.prepare("SELECT machine, capacity_hours FROM settings").all();
  const capacities = {};
  rows.forEach((r) => {
    capacities[r.machine] = r.capacity_hours;
  });
  res.json({ capacities });
});

app.put("/api/settings", (req, res) => {
  const { machine, capacity_hours } = req.body || {};

  if (!MACHINES.includes(machine) || !Number.isFinite(Number(capacity_hours))) {
    return res.status(400).json({ error: "invalid payload" });
  }

  db.prepare(
    "INSERT INTO settings (machine, capacity_hours) VALUES (?, ?) ON CONFLICT (machine) DO UPDATE SET capacity_hours = excluded.capacity_hours"
  ).run(machine, Math.max(0, Number(capacity_hours)));

  res.json({ machine, capacity_hours: Math.max(0, Number(capacity_hours)) });
});

const orderOut = (r) => ({
  id: r.id,
  machine: r.machine,
  order_no: r.order_no,
  hours: r.hours,
  done_hours: r.done_hours,
  due: r.due_date,
  position: r.position,
  done: r.done === 1,
  odoo_ref: r.odoo_ref,
  odoo_id: r.odoo_id,
  earliest_start: r.earliest_start,
  component_status: r.component_status,
  hours_plan: r.hours_plan,
  qs_required: r.qs_required === 1,
  is_split: r.is_split === 1,
  part_label: r.part_label,
  qs_days: r.qs_days,
  from_machine: r.from_machine,
  produced_date: r.produced_date,
  checked_date: r.checked_date,
  done_date: r.done_date,
  progress_date: r.progress_date,
  source: r.source,
  product: r.product,
  quantity: r.quantity,
  extern_tags: JSON.parse(r.extern_tags || "[]"),
  extern_days: r.extern_days,
  extern_start: r.extern_start,
});

const nextPosition = (machine) =>
  db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM orders WHERE machine = ?").get(machine).p;

app.get("/api/orders", (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY machine, position, id").all();
  res.json({ orders: rows.map(orderOut) });
});

app.post("/api/orders", (req, res) => {
  const { machine } = req.body || {};
  if (!MACHINES.includes(machine) && !LANES.includes(machine)) return res.status(400).json({ error: "invalid machine" });

  const info = db.prepare("INSERT INTO orders (machine, position, extern_days) VALUES (?, ?, 7)").run(machine, nextPosition(machine));
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(Number(info.lastInsertRowid));
  res.json(orderOut(row));
});

app.put("/api/orders/:id", (req, res) => {
  const id = Number(req.params.id);
  const { order_no, hours, done_hours, due, done, machine, extern_tags, extern_days, extern_start, earliest_start, hours_plan, progress_date, qs_required, qs_days, from_machine, produced_date, checked_date, done_date, source, product, quantity } = req.body || {};
  const sets = [];
  const values = [];

  // Stichpunkte für die externe Weiterverarbeitung (z. B. Eloxieren) und deren Dauer in Wochen
  if (extern_tags !== undefined) {
    const valid =
      Array.isArray(extern_tags) &&
      extern_tags.length <= 10 &&
      extern_tags.every((t) => typeof t === "string" && t.trim().length > 0 && t.length <= 40);
    if (!valid) return res.status(400).json({ error: "invalid extern_tags" });
    sets.push("extern_tags = ?");
    values.push(JSON.stringify(extern_tags.map((t) => t.trim())));
  }
  if (extern_days !== undefined) {
    if (!Number.isInteger(extern_days) || extern_days < 1 || extern_days > 120) {
      return res.status(400).json({ error: "invalid extern_days" });
    }
    sets.push("extern_days = ?");
    values.push(extern_days);
  }
  // Beginn der externen Bearbeitung (Tag, an dem die Position in die Zeile "Extern" gelegt wurde)
  // Ursprüngliche Schätzung (für den Mehraufwand) und Datum, an dem der Fortschritt zuletzt eingetragen wurde
  if (hours_plan !== undefined) {
    if (hours_plan !== null && (typeof hours_plan !== "number" || !Number.isFinite(hours_plan) || hours_plan < 0)) {
      return res.status(400).json({ error: "invalid hours_plan" });
    }
    sets.push("hours_plan = ?");
    values.push(hours_plan);
  }
  if (progress_date !== undefined) {
    if (progress_date !== null && !isDate(progress_date)) return res.status(400).json({ error: "invalid progress_date" });
    sets.push("progress_date = ?");
    values.push(progress_date);
  }

  // Frühester Start auf der Maschine (z. B. wenn Rohmaterial und Werkzeuge da sind), leer = sobald die Maschine frei ist
  if (earliest_start !== undefined) {
    if (earliest_start !== null && !isDate(earliest_start)) return res.status(400).json({ error: "invalid earliest_start" });
    sets.push("earliest_start = ?");
    values.push(earliest_start);
  }

  if (extern_start !== undefined) {
    if (extern_start !== null && !isDate(extern_start)) return res.status(400).json({ error: "invalid extern_start" });
    sets.push("extern_start = ?");
    values.push(extern_start);
  }

  // Zuweisen einer Maschine ("" = nicht eingeplant) oder eines Ortes (qs, extern_fert, extern = Oberfläche)
  // hängt den Auftrag hinten an
  if (machine !== undefined) {
    if (machine !== "" && !LANES.includes(machine) && !MACHINES.includes(machine)) {
      return res.status(400).json({ error: "invalid machine" });
    }
    sets.push("machine = ?", "position = ?");
    values.push(machine, nextPosition(machine));
  }

  if (order_no !== undefined) {
    if (typeof order_no !== "string" || order_no.length > 40) return res.status(400).json({ error: "invalid order_no" });
    sets.push("order_no = ?");
    values.push(order_no);
  }
  if (hours !== undefined) {
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0) return res.status(400).json({ error: "invalid hours" });
    sets.push("hours = ?");
    values.push(hours);
  }
  if (done_hours !== undefined) {
    if (typeof done_hours !== "number" || !Number.isFinite(done_hours) || done_hours < 0) {
      return res.status(400).json({ error: "invalid done_hours" });
    }
    sets.push("done_hours = ?");
    values.push(done_hours);
  }
  if (due !== undefined) {
    if (due !== null && !isDate(due)) return res.status(400).json({ error: "invalid due" });
    sets.push("due_date = ?");
    values.push(due);
  }
  // Von Hand angelegte Positionen: Auftrag (Quelle, z. B. A01234), Beschreibung/Lieferant und Menge
  if (source !== undefined) {
    if (source !== null && (typeof source !== "string" || source.length > 40)) return res.status(400).json({ error: "invalid source" });
    sets.push("source = ?");
    values.push(source === null ? null : source.trim() || null);
  }
  if (product !== undefined) {
    if (product !== null && (typeof product !== "string" || product.length > 200)) return res.status(400).json({ error: "invalid product" });
    sets.push("product = ?");
    values.push(product === null ? null : product.trim() || null);
  }
  if (quantity !== undefined) {
    if (quantity !== null && (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0)) {
      return res.status(400).json({ error: "invalid quantity" });
    }
    sets.push("quantity = ?");
    values.push(quantity);
  }

  // QS-Ablauf: QS nötig, Dauer der Prüfung, Herkunftsmaschine, Daten
  if (qs_required !== undefined) {
    if (typeof qs_required !== "boolean") return res.status(400).json({ error: "invalid qs_required" });
    sets.push("qs_required = ?");
    values.push(qs_required ? 1 : 0);
  }
  if (qs_days !== undefined) {
    if (!Number.isInteger(qs_days) || qs_days < 1 || qs_days > 120) return res.status(400).json({ error: "invalid qs_days" });
    sets.push("qs_days = ?");
    values.push(qs_days);
  }
  if (from_machine !== undefined) {
    if (from_machine !== null && !MACHINES.includes(from_machine)) return res.status(400).json({ error: "invalid from_machine" });
    sets.push("from_machine = ?");
    values.push(from_machine);
  }
  for (const [name, value] of [
    ["produced_date", produced_date],
    ["checked_date", checked_date],
    ["done_date", done_date],
  ]) {
    if (value === undefined) continue;
    if (value !== null && !isDate(value)) return res.status(400).json({ error: `invalid ${name}` });
    sets.push(`${name} = ?`);
    values.push(value);
  }
  if (done !== undefined) {
    if (typeof done !== "boolean") return res.status(400).json({ error: "invalid done" });
    sets.push("done = ?");
    values.push(done ? 1 : 0);
  }
  if (!Number.isInteger(id) || sets.length === 0) return res.status(400).json({ error: "invalid payload" });

  const info = db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  if (info.changes === 0) return res.status(404).json({ error: "not found" });
  res.json(orderOut(db.prepare("SELECT * FROM orders WHERE id = ?").get(id)));
});

app.delete("/api/orders/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });
  db.prepare("DELETE FROM orders WHERE id = ?").run(id);
  res.json({ id });
});

// Odoo-Import: gleicht die Fertigungsaufträge über die FA-Nummer ab. Neue landen
// ohne Maschine in der Liste "nicht eingeplant" (die Frist aus Odoo ist nur der
// Startwert), vorhandene bekommen Menge und Produkt aus Odoo, ihre Frist bleibt
// unverändert (die Fristen der Fertigungsaufträge folgen Terminänderungen im
// Verkaufsauftrag nicht verlässlich). Offene Aufträge mit Odoo-Nummer, die im
// Export fehlen, werden auf erledigt gesetzt. Mit dryRun wird nur berechnet, was
// passieren würde.
app.post("/api/orders/import", (req, res) => {
  const { items, dryRun } = req.body || {};
  const text = (v, max) => v === null || (typeof v === "string" && v.length <= max);
  const valid =
    Array.isArray(items) &&
    items.length > 0 &&
    items.length <= 2000 &&
    items.every(
      (i) =>
        i &&
        typeof i.odoo_ref === "string" &&
        i.odoo_ref.length > 0 &&
        i.odoo_ref.length <= 40 &&
        text(i.source, 40) &&
        text(i.product, 200) &&
        (i.component_status === undefined || text(i.component_status, 60)) &&
        (i.odoo_id === undefined || i.odoo_id === null || (Number.isInteger(i.odoo_id) && i.odoo_id > 0)) &&
        (i.quantity === null || (typeof i.quantity === "number" && Number.isFinite(i.quantity))) &&
        (i.due === null || isDate(i.due))
    );
  if (!valid) return res.status(400).json({ error: "invalid payload" });

  const incoming = new Map(items.map((i) => [i.odoo_ref, i]));
  const existing = new Map(
    db.prepare("SELECT odoo_ref, done FROM orders WHERE odoo_ref IS NOT NULL").all().map((r) => [r.odoo_ref, r])
  );
  const created = [...incoming.keys()].filter((ref) => !existing.has(ref));
  const updated = [...incoming.keys()].filter((ref) => existing.has(ref));
  const closed = [...existing.values()].filter((r) => r.done === 0 && !incoming.has(r.odoo_ref)).map((r) => r.odoo_ref);

  if (!dryRun) {
    const insert = db.prepare(
      "INSERT INTO orders (machine, order_no, due_date, position, odoo_ref, source, product, quantity, odoo_id, component_status, extern_days) VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, 7)"
    );
    // Komponentenstatus wird nur überschrieben, wenn die Spalte im Export enthalten war
    const update = db.prepare(
      "UPDATE orders SET source = ?, product = ?, quantity = CASE WHEN is_split = 1 THEN quantity ELSE ? END, odoo_id = COALESCE(?, odoo_id), component_status = CASE WHEN ? = 1 THEN ? ELSE component_status END WHERE odoo_ref = ?"
    );
    // Neue Positionen eines bekannten Auftrags übernehmen dessen aktuellen Liefertermin (den frühesten der offenen Positionen)
    const dueBySource = new Map(
      db
        .prepare(
          "SELECT source, MIN(due_date) AS d FROM orders WHERE source IS NOT NULL AND done = 0 AND due_date IS NOT NULL GROUP BY source"
        )
        .all()
        .map((r) => [r.source, r.d])
    );
    const close = db.prepare(
      "UPDATE orders SET done = 1, done_date = COALESCE(done_date, date('now')) WHERE odoo_ref = ? OR parent_ref = ?"
    );
    db.exec("BEGIN");
    try {
      let position = nextPosition("");
      created.forEach((ref) => {
        const i = incoming.get(ref);
        insert.run(
          ref,
          (i.source && dueBySource.get(i.source)) || i.due,
          position++,
          ref,
          i.source,
          i.product,
          i.quantity,
          i.odoo_id ?? null,
          i.component_status ?? null
        );
      });
      updated.forEach((ref) => {
        const i = incoming.get(ref);
        update.run(i.source, i.product, i.quantity, i.odoo_id ?? null, i.component_status === undefined ? 0 : 1, i.component_status ?? null, ref);
      });
      closed.forEach((ref) => close.run(ref, ref));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  res.json({ created, updated, closed });
});

// Liefertermin eines ganzen Auftrags: setzt die Frist für mehrere Positionen auf einmal
// Frühester Start für mehrere Positionen auf einmal (ganzer Auftrag)
app.post("/api/orders/earliest", (req, res) => {
  const { ids, earliest_start } = req.body || {};
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 500 ||
    !ids.every(Number.isInteger) ||
    (earliest_start !== null && !isDate(earliest_start))
  ) {
    return res.status(400).json({ error: "invalid payload" });
  }
  const update = db.prepare("UPDATE orders SET earliest_start = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    ids.forEach((id) => update.run(earliest_start, id));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.json({ ids, earliest_start });
});

app.post("/api/orders/due", (req, res) => {
  const { ids, due } = req.body || {};
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 500 ||
    !ids.every(Number.isInteger) ||
    (due !== null && !isDate(due))
  ) {
    return res.status(400).json({ error: "invalid payload" });
  }
  const update = db.prepare("UPDATE orders SET due_date = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    ids.forEach((id) => update.run(due, id));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.json({ ids, due });
});

app.post("/api/orders/reorder", (req, res) => {
  const { machine, ids } = req.body || {};
  if (!MACHINES.includes(machine) || !Array.isArray(ids) || !ids.every(Number.isInteger)) {
    return res.status(400).json({ error: "invalid payload" });
  }
  // Setzt Reihenfolge und Maschine, so lassen sich Aufträge auch zwischen Maschinen verschieben
  const update = db.prepare("UPDATE orders SET machine = ?, position = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    ids.forEach((id, index) => update.run(machine, index, id));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.json({ machine, ids });
});

// Mindestpuffer in Tagen: darunter wird ein Auftrag gelb markiert
const DEFAULT_TIGHT_DAYS = 3;

// Nutzung der Betriebszeit in %: Die Planung rechnet mit Schichtmodell (Stunden pro Woche) x Nutzung
const DEFAULT_UTILIZATION = 80;

const planSettingsOut = () => {
  const get = (key, fallback) => {
    const row = db.prepare("SELECT value FROM plan_settings WHERE key = ?").get(key);
    return row ? row.value : fallback;
  };
  return { tight_days: get("tight_days", DEFAULT_TIGHT_DAYS), utilization: get("utilization", DEFAULT_UTILIZATION) };
};

app.get("/api/plan-settings", (req, res) => res.json(planSettingsOut()));

app.put("/api/plan-settings", (req, res) => {
  const { tight_days, utilization } = req.body || {};
  const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  if (
    (tight_days === undefined && utilization === undefined) ||
    (tight_days !== undefined && !num(tight_days, 0, 60)) ||
    (utilization !== undefined && !num(utilization, 1, 100))
  ) {
    return res.status(400).json({ error: "invalid payload" });
  }
  const save = db.prepare(
    "INSERT INTO plan_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
  );
  if (tight_days !== undefined) save.run("tight_days", tight_days);
  if (utilization !== undefined) save.run("utilization", utilization);
  res.json(planSettingsOut());
});

app.get("/api/plan-rates", (req, res) => {
  const rates = {};
  db.prepare("SELECT machine, weekly_hours FROM plan_rates").all().forEach((r) => {
    rates[r.machine] = r.weekly_hours;
  });
  res.json({ rates });
});

app.put("/api/plan-rates", (req, res) => {
  const { machine, weekly_hours } = req.body || {};
  const valid = weekly_hours === null || (typeof weekly_hours === "number" && Number.isFinite(weekly_hours) && weekly_hours > 0);
  if (!MACHINES.includes(machine) || !valid) return res.status(400).json({ error: "invalid payload" });

  if (weekly_hours === null) {
    db.prepare("DELETE FROM plan_rates WHERE machine = ?").run(machine);
  } else {
    db.prepare(
      "INSERT INTO plan_rates (machine, weekly_hours) VALUES (?, ?) ON CONFLICT (machine) DO UPDATE SET weekly_hours = excluded.weekly_hours"
    ).run(machine, weekly_hours);
  }
  res.json({ machine, weekly_hours });
});

// Teillieferung: `n` Stück werden als neue Position (Teil N) mit anteiligen Stunden abgespalten und stehen in der
// Maschinenreihe direkt vor der ursprünglichen Position ("Rest"). Gleiche Nummer, gleicher Odoo-Link, eigener Liefertermin.
const round1 = (x) => Math.round(x * 10) / 10;
function splitOrder(row, n, due) {
  const ratio = n / row.quantity;
  const part = (v) => (v == null ? null : round1(v * ratio));
  const newHours = part(row.hours) ?? 0;
  const newDone = part(row.done_hours) ?? 0;
  const newPlan = part(row.hours_plan);
  const group = row.part_group || row.odoo_ref || row.parent_ref || `id:${row.id}`;
  const parts = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE part_group = ? AND part_label LIKE 'Teil %'").get(group).c;
  const label = `Teil ${parts + 1}`;

  db.prepare("UPDATE orders SET position = position + 1 WHERE machine = ? AND position >= ?").run(row.machine, row.position);
  const info = db
    .prepare(
      `INSERT INTO orders (machine, order_no, hours, done_hours, due_date, position, done, odoo_ref, source, product, quantity,
         extern_tags, extern_days, extern_start, odoo_id, earliest_start, component_status, hours_plan, progress_date,
         qs_required, qs_days, from_machine, is_split, part_label, part_group, parent_ref)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(
      row.machine,
      row.order_no,
      newHours,
      newDone,
      due ?? row.due_date,
      row.position,
      row.source,
      row.product,
      n,
      row.extern_tags,
      row.extern_days,
      row.extern_start,
      row.odoo_id,
      row.earliest_start,
      row.component_status,
      newPlan,
      row.progress_date,
      row.qs_required,
      row.qs_days,
      row.from_machine,
      label,
      group,
      row.odoo_ref || row.parent_ref
    );
  db.prepare(
    `UPDATE orders SET quantity = ?, hours = ?, done_hours = ?, hours_plan = ?, is_split = 1, part_group = ?,
       part_label = COALESCE(part_label, 'Rest') WHERE id = ?`
  ).run(
    round1(row.quantity - n),
    Math.max(0, round1(row.hours - newHours)),
    Math.max(0, round1(row.done_hours - newDone)),
    row.hours_plan == null ? null : Math.max(0, round1(row.hours_plan - newPlan)),
    group,
    row.id
  );
  return Number(info.lastInsertRowid);
}

app.post("/api/orders/split", (req, res) => {
  const { id, quantity, due } = req.body || {};
  if (!Number.isInteger(id) || typeof quantity !== "number" || !(quantity > 0) || (due !== null && due !== undefined && !isDate(due))) {
    return res.status(400).json({ error: "invalid payload" });
  }
  const row = db.prepare("SELECT * FROM orders WHERE id = ? AND done = 0").get(id);
  if (!row) return res.status(404).json({ error: "not found" });
  if (!(row.quantity > 0)) return res.status(400).json({ error: "Die Position hat keine Stückzahl" });
  if (!(quantity < row.quantity)) return res.status(400).json({ error: "Die Teilmenge muss kleiner als die Stückzahl sein" });
  db.exec("BEGIN");
  try {
    splitOrder(row, quantity, due);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.json({ ok: true });
});

// Teillieferung für alle offenen Positionen eines Auftrags (Quelle): Positionen mit höchstens der Teilmenge
// liefern vollständig mit der ersten Lieferung und werden nicht geteilt
app.post("/api/orders/split-many", (req, res) => {
  const { source, quantity, due } = req.body || {};
  if (typeof source !== "string" || !source || typeof quantity !== "number" || !(quantity > 0) || (due !== null && due !== undefined && !isDate(due))) {
    return res.status(400).json({ error: "invalid payload" });
  }
  const rows = db.prepare("SELECT * FROM orders WHERE source = ? AND done = 0 ORDER BY id").all(source);
  let split = 0;
  let whole = 0;
  db.exec("BEGIN");
  try {
    rows.forEach((row) => {
      if (row.quantity > quantity) {
        splitOrder(db.prepare("SELECT * FROM orders WHERE id = ?").get(row.id), quantity, due);
        split++;
      } else {
        // liefert vollständig mit der ersten Lieferung: nur der frühere Termin
        if (due) db.prepare("UPDATE orders SET due_date = ? WHERE id = ?").run(due, row.id);
        whole++;
      }
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.json({ split, whole });
});

// Datensicherung: alle Daten als lesbare JSON-Datei zum Herunterladen
app.get("/api/backup", (req, res) => {
  const all = (sql) => db.prepare(sql).all();
  const created = new Date().toISOString();
  const backup = {
    app: "kratos-dashboard",
    version: 1,
    created,
    readings: all("SELECT * FROM readings ORDER BY reading_date, machine"),
    orders: all("SELECT * FROM orders ORDER BY id"),
    settings: all("SELECT * FROM settings ORDER BY machine"),
    week_capacity: all("SELECT * FROM week_capacity ORDER BY reading_date"),
    free_days: all("SELECT * FROM free_days ORDER BY date"),
    free_days_seeded: all("SELECT * FROM free_days_seeded ORDER BY year"),
    plan_rates: all("SELECT * FROM plan_rates ORDER BY machine"),
    plan_settings: all("SELECT * FROM plan_settings ORDER BY key"),
  };
  res.setHeader("Content-Disposition", `attachment; filename="kratos-backup-${created.slice(0, 10)}.json"`);
  res.type("json").send(JSON.stringify(backup, null, 2));
});

// Backup einspielen: ersetzt ALLE aktuellen Daten durch den Inhalt der Backup-Datei (in einer Transaktion).
// Mit dryRun wird nur gezählt, was in der Datei steht.
const RESTORE_TABLES = [
  "readings",
  "orders",
  "settings",
  "plan_rates",
  "plan_settings",
  "week_capacity",
  "free_days",
  "free_days_seeded",
];
app.post("/api/restore", (req, res) => {
  const { backup, dryRun } = req.body || {};
  const isRow = (r) =>
    r && typeof r === "object" && !Array.isArray(r) && Object.values(r).every((v) => v === null || ["string", "number"].includes(typeof v));
  const valid =
    backup &&
    backup.app === "kratos-dashboard" &&
    Array.isArray(backup.readings) &&
    Array.isArray(backup.orders) &&
    RESTORE_TABLES.every((t) => backup[t] === undefined || (Array.isArray(backup[t]) && backup[t].length <= 20000 && backup[t].every(isRow)));
  if (!valid) return res.status(400).json({ error: "Die Datei ist kein gültiges Backup" });

  const counts = {};
  RESTORE_TABLES.forEach((t) => {
    counts[t] = Array.isArray(backup[t]) ? backup[t].length : 0;
  });
  if (dryRun) return res.json({ counts, created: backup.created || null });

  db.exec("BEGIN");
  try {
    RESTORE_TABLES.forEach((t) => {
      if (!Array.isArray(backup[t])) return;
      const columns = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      db.exec(`DELETE FROM ${t}`);
      backup[t].forEach((row) => {
        const cols = Object.keys(row).filter((c) => columns.includes(c));
        if (cols.length === 0) return;
        db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
      });
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("Backup einspielen fehlgeschlagen", err);
    return res.status(400).json({ error: "Das Backup konnte nicht eingespielt werden, es wurde nichts geändert" });
  }
  res.json({ counts });
});

if (existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(DIST_PATH, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Kratos Dashboard läuft auf http://localhost:${PORT}`);
});
