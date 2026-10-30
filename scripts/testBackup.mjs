// Prüft die automatische Datensicherung (server/backupAuto.js) mit einer eigenen Test-Datenbank, nie mit echten Daten.
// Start: node scripts/testBackup.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(path.join(tmpdir(), "backup-"));
const backupDir = path.join(dir, "sicherungen");
const env = { ...process.env, PORT: "3058", DB_PATH: path.join(dir, "t.db"), BACKUP_DIR: backupDir, BACKUP_AUTO: "0", ODOO_URL: "", ODOO_API_KEY: "", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "" };
const server = spawn("node", ["server/index.js"], { env, stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (m, u) => fetch(`http://localhost:3058${u}`, { method: m });
const json = async (m, u) => {
  const r = await call(m, u);
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const dayOf = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  await wait(3500);
  console.log("Automatische Datensicherung (Test-Datenbank)");

  let s = await json("GET", "/api/backup/status");
  assert.equal(s.status, 200);
  assert.equal(s.files.length, 0);
  assert.equal(s.auto, false);
  ok("Zu Beginn gibt es keine Sicherung");

  assert.equal((await call("GET", "/api/backup/auto/latest")).status, 404);
  ok("Ohne Sicherung liefert 'latest' 404");

  // Ein Auftrag in der Datenbank, damit man sieht, dass der Inhalt mitkommt
  const live = new DatabaseSync(path.join(dir, "t.db"));
  const before = live.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  live.close();

  let r = await json("POST", "/api/backup/run");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.match(r.name, /^dashboard-\d{4}-\d{2}-\d{2}\.db$/);
  ok(`Sicherung angelegt (${r.name})`);

  const file = path.join(backupDir, r.name);
  assert.equal(readFileSync(file).subarray(0, 15).toString(), "SQLite format 3");
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM orders").get().n, before);
  assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  copy.close();
  ok("Die Datei ist eine vollständige, geprüfte SQLite-Datenbank mit denselben Aufträgen");

  assert.equal(readdirSync(backupDir).filter((f) => f.endsWith(".tmp")).length, 0);
  ok("Keine halbfertigen Dateien übrig");

  const dl = await call("GET", "/api/backup/auto/latest");
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), "SQLite format 3");
  assert.equal((await call("GET", `/api/backup/auto/${r.name}`)).status, 200);
  assert.equal((await call("GET", "/api/backup/auto/..%2Ft.db")).status, 404);
  assert.equal((await call("GET", "/api/backup/auto/dashboard-2020-01-01.db")).status, 404);
  ok("Herunterladen geht (latest und mit Namen), fremde Pfade und unbekannte Namen nicht");

  s = await json("GET", "/api/backup/status");
  assert.equal(s.files.length, 1);
  assert.ok(s.lastOk);
  assert.equal(s.latest.name, r.name);
  ok("Status zeigt letzte Sicherung und Dateiliste");

  // Aufbewahrung: 20 ältere Tagesdateien + alte Monatsanfänge + eine uralte
  const fake = (name) => writeFileSync(path.join(backupDir, name), "x");
  for (let i = 1; i <= 20; i++) fake(`dashboard-${dayOf(i)}.db`);
  const monthly = `dashboard-${dayOf(150).slice(0, 8)}01.db`; // Monatserster vor ~5 Monaten: bleibt
  const monthlyOld = `dashboard-${dayOf(400).slice(0, 8)}01.db`; // über 200 Tage: weg
  const midMonth = `dashboard-${dayOf(151).slice(0, 8)}15.db`; // kein Monatserster, alt: weg
  fake(monthly);
  fake(monthlyOld);
  fake(midMonth);
  fake("notizen.txt"); // fremde Datei bleibt unberührt
  r = await json("POST", "/api/backup/run");
  assert.equal(r.status, 200);
  const left = readdirSync(backupDir).filter((f) => /^dashboard-/.test(f));
  const daily = left.filter((f) => f !== monthly);
  assert.equal(daily.length, 14, left.join(","));
  assert.ok(left.includes(monthly));
  assert.ok(!left.includes(monthlyOld));
  assert.ok(!left.includes(midMonth));
  assert.ok(readdirSync(backupDir).includes("notizen.txt"));
  ok("Aufbewahrung: 14 Tagesdateien, alter Monatserster bleibt, uralte und beliebige alte fliegen raus, fremde Dateien bleiben");
} catch (err) {
  console.error("FEHLER:", err.message);
  process.exitCode = 1;
} finally {
  server.kill();
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
}
if (!process.exitCode) console.log(`\nAlle ${n} Prüfungen bestanden`);
