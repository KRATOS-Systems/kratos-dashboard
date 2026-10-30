// Automatische Datensicherung der App-Datenbank.
//
// Einmal am Tag (ab 2 Uhr Berliner Zeit, beim Start sofort, falls noch keine da ist) wird die ganze Datenbank als Datei kopiert (VACUUM INTO: eine
// stimmige Kopie, auch während die App läuft). Die Kopie wird auf Unversehrtheit geprüft, erst dann behalten. Aufbewahrt werden die letzten 14 Tage
// und je der Erste eines Monats für etwa ein halbes Jahr. Ordner: BACKUP_DIR, sonst "backups" neben der Datenbank (liegt also dort, wo auch die
// Datenbank den Neustart übersteht).
//
// Das ist eine Kopie auf demselben Server. Für den Schutz bei einem Serverausfall muss die Datei zusätzlich woanders landen: GET /api/backup/auto/latest
// liefert die neueste, ein n8n-Ablauf kann sie täglich abholen und ablegen.
//   GET  /api/backup/status        Stand und vorhandene Dateien
//   POST /api/backup/run           jetzt sichern
//   GET  /api/backup/auto/:name    "latest" oder ein Dateiname dashboard-JJJJ-MM-TT.db herunterladen
// Wiederherstellen: App anhalten, Datenbankdatei durch die Sicherung ersetzen, App starten (siehe docs/bde.md).

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const KEEP_DAYS = 14;
const KEEP_MONTHLY_DAYS = 200;
const FILE_RE = /^dashboard-(\d{4}-\d{2}-\d{2})\.db$/;
const CHECK_EVERY_MS = 10 * 60 * 1000;
const RUN_AFTER_HOUR = 2;

const berlin = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};
const dayNumber = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86400000);

export default function registerAutoBackup(app, db, { dbPath }) {
  const dir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), "backups");
  mkdirSync(dir, { recursive: true });
  const state = { lastOk: null, lastError: null, running: false };

  const files = () =>
    readdirSync(dir)
      .map((name) => ({ name, m: FILE_RE.exec(name) }))
      .filter((f) => f.m)
      .map((f) => ({ name: f.name, day: f.m[1], size: statSync(path.join(dir, f.name)).size }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));

  function prune() {
    const today = dayNumber(berlin().day);
    files().forEach((f, i) => {
      const age = today - dayNumber(f.day);
      const keep = i < KEEP_DAYS || (f.day.endsWith("-01") && age <= KEEP_MONTHLY_DAYS);
      if (!keep) rmSync(path.join(dir, f.name), { force: true });
    });
  }

  function run() {
    if (state.running) throw new Error("Eine Sicherung läuft gerade");
    state.running = true;
    const name = `dashboard-${berlin().day}.db`;
    const tmp = path.join(dir, `${name}.tmp`);
    try {
      rmSync(tmp, { force: true });
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      // Prüfen, bevor die Kopie zählt: lesbar, in sich stimmig, Aufträge sind drin
      const check = new DatabaseSync(tmp, { readOnly: true });
      try {
        const ic = check.prepare("PRAGMA integrity_check").get();
        if (!ic || ic.integrity_check !== "ok") throw new Error("Die Sicherung ist nicht in Ordnung");
        check.prepare("SELECT COUNT(*) AS n FROM orders").get();
      } finally {
        check.close();
      }
      renameSync(tmp, path.join(dir, name));
      prune();
      state.lastOk = new Date().toISOString();
      state.lastError = null;
      return name;
    } catch (err) {
      rmSync(tmp, { force: true });
      state.lastError = err.message;
      throw err;
    } finally {
      state.running = false;
    }
  }

  // Heute schon gesichert? Sonst ab 2 Uhr sichern; gibt es noch gar keine Sicherung, gleich
  function tick() {
    try {
      const have = files();
      const { day, hour } = berlin();
      if (have.some((f) => f.day === day)) return;
      if (have.length === 0 || hour >= RUN_AFTER_HOUR) run();
    } catch (err) {
      console.error("Automatische Datensicherung fehlgeschlagen:", err.message);
    }
  }
  if (process.env.BACKUP_AUTO !== "0") {
    setTimeout(tick, 30 * 1000);
    setInterval(tick, CHECK_EVERY_MS);
  }

  app.get("/api/backup/status", (req, res) => {
    const list = files();
    res.json({ dir, auto: process.env.BACKUP_AUTO !== "0", lastOk: state.lastOk, lastError: state.lastError, files: list, latest: list[0] || null });
  });

  app.post("/api/backup/run", (req, res) => {
    try {
      const name = run();
      res.json({ ok: true, name, files: files() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/backup/auto/:name", (req, res) => {
    const list = files();
    const want = req.params.name === "latest" ? list[0] && list[0].name : req.params.name;
    if (!want || !FILE_RE.test(want) || !existsSync(path.join(dir, want))) return res.status(404).json({ error: "Keine Sicherung gefunden" });
    res.download(path.join(dir, want), want);
  });
}
