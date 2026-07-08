import express from "express";
import cors from "cors";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const DIST_PATH = path.join(__dirname, "..", "dist");

const MACHINES = ["dmu40", "m1", "h800u"];
const DEFAULT_CAPACITY = 40;
const WEEKS_HISTORY = 8;

// DB_PATH sollte außerhalb des per Git deployten App-Ordners liegen,
// sonst wird die Datenbank bei jedem Redeploy zurückgesetzt.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "dashboard.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    year INTEGER NOT NULL,
    week TEXT NOT NULL,
    machine TEXT NOT NULL,
    on_hours REAL NOT NULL DEFAULT 0,
    spindle REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (year, week, machine)
  );

  CREATE TABLE IF NOT EXISTS settings (
    machine TEXT PRIMARY KEY,
    capacity_hours REAL NOT NULL
  );
`);

// Kapazität mit Standardwert vorbelegen, falls noch nicht vorhanden
const insertDefaultCapacity = db.prepare(
  "INSERT OR IGNORE INTO settings (machine, capacity_hours) VALUES (?, ?)"
);
MACHINES.forEach((m) => insertDefaultCapacity.run(m, DEFAULT_CAPACITY));

// ISO Kalenderwoche und zugehöriges ISO Jahr einer Datumsangabe
function isoWeekInfo(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

function weekKey(year, week) {
  return `${year}-${week}`;
}

// Liste der letzten n Kalenderwochen, älteste zuerst
function lastWeeks(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i * 7);
    const { week, year } = isoWeekInfo(d);
    out.push({ key: weekKey(year, week), year, week, label: `KW ${week}` });
  }
  return out;
}

// Vorbefüllte Beispieldaten für die letzten sechs Wochen, damit der Trend
// beim ersten Start sofort etwas zeigt
const SEED = {
  dmu40: [
    { on: 34, spindle: 21 },
    { on: 38, spindle: 25 },
    { on: 36, spindle: 24 },
    { on: 39, spindle: 28 },
    { on: 40, spindle: 29 },
    { on: 38, spindle: 26 },
  ],
  m1: [
    { on: 28, spindle: 18 },
    { on: 31, spindle: 22 },
    { on: 26, spindle: 17 },
    { on: 33, spindle: 24 },
    { on: 30, spindle: 21 },
    { on: 32, spindle: 23 },
  ],
  h800u: [
    { on: 30, spindle: 15 },
    { on: 35, spindle: 19 },
    { on: 33, spindle: 20 },
    { on: 31, spindle: 17 },
    { on: 36, spindle: 22 },
    { on: 34, spindle: 19 },
  ],
};

const entryCount = db.prepare("SELECT COUNT(*) AS n FROM entries").get().n;
if (entryCount === 0) {
  const seedWeeks = lastWeeks(6);
  const insert = db.prepare(
    "INSERT INTO entries (year, week, machine, on_hours, spindle) VALUES (@year, @week, @machine, @on_hours, @spindle)"
  );
  db.exec("BEGIN");
  try {
    seedWeeks.forEach(({ year, week }, wi) => {
      MACHINES.forEach((m) => {
        const seed = SEED[m][wi];
        insert.run({ year, week: String(week), machine: m, on_hours: seed.on, spindle: seed.spindle });
      });
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/entries", (req, res) => {
  const weeks = lastWeeks(WEEKS_HISTORY);
  const placeholders = weeks.map(() => "(year = ? AND week = ?)").join(" OR ");
  const params = weeks.flatMap((w) => [w.year, String(w.week)]);

  let rows = [];
  if (weeks.length > 0) {
    rows = db.prepare(`SELECT * FROM entries WHERE ${placeholders}`).all(...params);
  }

  const data = {};
  weeks.forEach((w) => {
    data[w.key] = {};
  });
  rows.forEach((r) => {
    const key = weekKey(r.year, Number(r.week));
    if (!data[key]) data[key] = {};
    data[key][r.machine] = { on: r.on_hours, spindle: r.spindle };
  });

  res.json({ weeks, entries: data });
});

app.put("/api/entries", (req, res) => {
  const { year, week, machine, on_hours, spindle } = req.body || {};

  if (
    !MACHINES.includes(machine) ||
    !Number.isFinite(Number(year)) ||
    week === undefined ||
    week === null ||
    !Number.isFinite(Number(on_hours)) ||
    !Number.isFinite(Number(spindle))
  ) {
    return res.status(400).json({ error: "invalid payload" });
  }

  const upsert = db.prepare(`
    INSERT INTO entries (year, week, machine, on_hours, spindle)
    VALUES (@year, @week, @machine, @on_hours, @spindle)
    ON CONFLICT (year, week, machine)
    DO UPDATE SET on_hours = excluded.on_hours, spindle = excluded.spindle
  `);

  upsert.run({
    year: Number(year),
    week: String(week),
    machine,
    on_hours: Math.max(0, Number(on_hours)),
    spindle: Math.max(0, Number(spindle)),
  });

  res.json({
    year: Number(year),
    week: String(week),
    machine,
    on: Math.max(0, Number(on_hours)),
    spindle: Math.max(0, Number(spindle)),
  });
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

if (existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(DIST_PATH, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Kratos Dashboard (v1.0.1) läuft auf http://localhost:${PORT}`);
});
