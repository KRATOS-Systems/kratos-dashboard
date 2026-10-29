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
  BDE_SECRET: "testgeheimnis",
  ODOO_URL: "",
  ODOO_API_KEY: "",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, cwd: root, stdio: "inherit" }), spawn("node", ["server/index.js"], { env, cwd: root, stdio: "inherit" })];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
console.log(`Test-Umgebung: App http://localhost:${APP_PORT}, Test-Odoo http://localhost:${ODOO_PORT}`);
