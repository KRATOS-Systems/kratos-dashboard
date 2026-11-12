// Lokale Testumgebung für die Betriebsdatenerfassung: Test-Odoo (scripts/mockOdoo.mjs) und die App zusammen, mit leerer Wegwerf-Datenbank.
// Spricht nie mit der echten Instanz (die Zugangsdaten aus .env werden mit dem Test-Odoo überschrieben).
//
//   node scripts/devTest.mjs        App auf http://localhost:3056 (läuft aus dist/, vorher "npm run build")
//   Anmeldung: Aurel (PIN 2222), Alex (1111), Frank (3333, Leitung), Nino (4444)

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ODOO_PORT = 8072;
const APP_PORT = 3056;
const dir = mkdtempSync(path.join(tmpdir(), "devtest-"));
const env = {
  ...process.env,
  MOCK_PORT: String(ODOO_PORT),
  PORT: String(APP_PORT),
  DB_PATH: path.join(dir, "test.db"),
  BDE_ODOO_URL: `http://localhost:${ODOO_PORT}`,
  BDE_ODOO_API_KEY: "test",
  BDE_WRITE: "1",
  MOCK_ARBEITSPLAN: "1",
  BDE_SECRET: "testgeheimnis",
  ODOO_URL: "",
  ODOO_API_KEY: "",
  // Eingang für den Maschinen-Dienst (nur lokal; im Dienst config.json → dashboard: url http://localhost:3056, key wie hier)
  MASCHINEN_KEY: process.env.MASCHINEN_KEY || "devtest-maschinen-schluessel-01",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, cwd: root, stdio: "inherit" }), spawn("node", ["server/index.js"], { env, cwd: root, stdio: "inherit" })];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
console.log(`Test-Umgebung: App http://localhost:${APP_PORT}, Test-Odoo http://localhost:${ODOO_PORT}`);

// Testdaten, damit die Seiten gefüllt aussehen: Aufträge je Maschine (mit Fristen, Stunden, Fortschritt) und neun Wochen Zählerstände. Nur in dieser Wegwerf-Datenbank.
setTimeout(async () => {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(env.DB_PATH);
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const add = db.prepare("INSERT INTO orders (machine, order_no, position, odoo_ref, source, product, quantity, hours, done_hours, due_date, extern_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 7)");
    const rows = [
      ["dmu40", "A01335", 0, "FA01335", "A01335", "Motorplatte für RFID", 40, 132, 55, 3],
      ["dmu40", "A01443", 1, "FA01443", "A01443", "Grundplatte Bauteilaufnahme", 12, 28, 0, 20],
      ["dmu50", "A01368", 0, "FA01368", "A01368", "Spannplatte", 6, 0.5, 0, -10],
      ["dmu50", "A01397", 1, "FA01397", "A01397", "Halter Sensor", 25, 14, 0, 9],
      ["dmu50", "A01442", 2, "FA01442", "A01442", "Gehäuse 212-12", 8, 40, 12, 13],
      ["m1", "A01334", 0, "FA01334", "A01334", "Deckel Pumpe", 10, 60, 7, 11],
      ["m1", "A01392", 1, "FA01392", "A01392", "Flansch DN40", 30, 26, 0, 16],
      ["m1", "A01418", 2, "FA01418", "A01418", "Lagerbock", 4, 33, 0, 22],
      ["h800u", "A01335", 0, "FA01335-2", "A01335", "Motorplatte für RFID", 40, 38, 20, 3],
      ["h800u", "A01332", 1, "FA01332", "A01332", "Montageplatte", 5, 24, 16, -13],
      ["h800u", "A01348", 2, "FA01348", "A01348", "Blende Frontplatte", 15, 48, 0, 12],
      ["h800u", "A01433", 3, "FA01433", "A01433", "Kühlkörper", 60, 105, 0, 30],
      ["", "A01451", 0, "FA01451", "A01451", "Welle gefräst", 20, 18, 0, 25],
      ["", "A01455", 1, "FA01455", "A01455", "Adapter M12", 100, 72, 0, 28],
    ];
    rows.forEach(([m, no, pos, ref, src, prod, qty, h, dh, due]) => add.run(m, no, pos, ref, src, prod, qty, h, dh, day(due)));
    db.close();
    // Zählerstände: neun Montage, daraus rechnet die App die Wochenwerte
    const quotes = { dmu40: [0.64, 0.62, 0.69, 0.76, 0.61, 0.68, 0.65, 0.66], dmu50: [0.54, 0.57, 0.7, 0.47, 0.55, 0.5, 0.56, 0.55], m1: [0.55, 0.66, 0.72, 0.47, 0.25, 0.35, 0.48, 0.76], h800u: [0.52, 0.6, 0.54, 0.63, 0.56, 0.47, 0.56, 0.41] };
    const monday = (n) => {
      const d = new Date();
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7 * n);
      return d.toISOString().slice(0, 10);
    };
    for (const m of Object.keys(quotes)) {
      let total = 4000, spindle = 3000;
      for (let i = 0; i < 9; i++) {
        if (i > 0) {
          const q = quotes[m][i - 1];
          total += 75 * (q + 0.1);
          spindle += 75 * q;
        }
        await fetch(`http://localhost:${APP_PORT}/api/readings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: monday(8 - i), machine: m, machine_total: Math.round(total * 10) / 10, spindle_total: Math.round(spindle * 10) / 10 }) });
      }
    }
  } catch (err) {
    console.error("Testdaten konnten nicht angelegt werden:", err.message);
  }
}, 4000);

// Beispielkarten für die Arbeitsvorbereitung (FA01310 bis FA01314, siehe MOCK_ARBEITSPLAN in scripts/mockOdoo.mjs): 1310 steht auf der M1, in Odoo noch auf der EVO
setTimeout(async () => {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(env.DB_PATH);
    const add = db.prepare("INSERT INTO orders (machine, order_no, position, odoo_ref, odoo_id, product, quantity, hours, extern_days) VALUES (?, ?, ?, ?, ?, 'Motorplatte für RFID', 5, 5, 7)");
    [["m1", 1310], ["dmu40", 1311], ["dmu50", 1312], ["dmu40", 1313], ["h800u", 1314]].forEach(([m, id], i) => add.run(m, `FA0${id}`, i, `FA0${id}`, id));
    db.close();
  } catch (err) {
    console.error("Beispielkarten konnten nicht angelegt werden:", err.message);
  }
}, 5000);
