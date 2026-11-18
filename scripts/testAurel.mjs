// Prüft Aurels Wünsche: Laufzeit bei abgeschlossenem Fräsen nachtragen (#4) und Fehler im Auftrag als Aufgabe melden (#1).
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testAurel.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "aurel-"));
const env = { ...process.env, MOCK_ENTWURF: "1", MOCK_PORT: "8085", PORT: "3073", DB_PATH: path.join(dir, "t.db"), ODOO_URL: "", ODOO_API_KEY: "", BDE_ODOO_URL: "http://localhost:8085", BDE_ODOO_API_KEY: "test", BDE_WRITE: "1", BDE_SECRET: "testgeheimnis", APP_PASSWORD: "" };
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = {};
const api = async (who, m, u, b) => {
  const r = await fetch(`http://localhost:3073${u}`, { method: m, headers: { "Content-Type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}) }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) jar[who] = set.split(";")[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const odooLog = () => fetch("http://localhost:8085/__log").then((x) => x.json());
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3073/api/orders"), fetch("http://localhost:8085/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Aurels Wünsche: Laufzeit nachtragen, Fehler melden (Test-Odoo)");
  assert.equal((await api("aurel", "POST", "/api/bde/login", { id: 2, pin: "2222" })).status, 200);
  assert.equal((await api("nino", "POST", "/api/bde/login", { id: 11, pin: "4444" })).status, 200);
  assert.equal((await api("frank", "POST", "/api/bde/login", { id: 3, pin: "3333" })).status, 200);

  // 1. Liste: abgeschlossenes Fräsen, bei dem die Laufzeit fehlt (Aurel hat darauf gestempelt, Nino nicht, die Leitung sieht alle)
  let r = await api("aurel", "GET", "/api/bde/nachtragen");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.items.map((i) => i.fa), ["FA01050"], JSON.stringify(r.items));
  assert.equal(r.items[0].anzahl, 0);
  assert.deepEqual((await api("nino", "GET", "/api/bde/nachtragen")).items, []);
  assert.ok((await api("frank", "GET", "/api/bde/nachtragen")).items.some((i) => i.fa === "FA01050"));
  ok("Abgeschlossenes Fräsen ohne Laufzeit erscheint bei dem, der gestempelt hat, und bei der Leitung, nicht bei anderen");

  // 2. Ohne Nachtragen bleibt es gesperrt; Nino darf nicht nachtragen; Aurel trägt Anzahl und Laufzeit nach
  r = await api("aurel", "POST", "/api/bde/laufzeit/anzahl", { workorderId: 5051, anzahl: 1 });
  assert.equal(r.status, 400);
  assert.match(r.error, /schon abgeschlossen/);
  r = await api("nino", "POST", "/api/bde/laufzeit/anzahl", { workorderId: 5051, anzahl: 1, nachtragen: true });
  assert.equal(r.status, 400, JSON.stringify(r));
  r = await api("aurel", "POST", "/api/bde/laufzeit/anzahl", { workorderId: 5051, anzahl: 1, nachtragen: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  r = await api("aurel", "POST", "/api/bde/laufzeit/save", { workorderId: 5051, aufspannung: 1, sekunden: 3600, teile: 1, nachtragen: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.complete, true, JSON.stringify(r));
  const notes = (await odooLog()).map((l) => l.call).filter((c) => /message_post/.test(c));
  assert.ok(notes.some((c) => /Aufspannungen \(DMU 40 EVO\): 1 \(Aurel Rama, [\d.]+, nachgetragen\)/.test(c)), notes.join(" | "));
  assert.ok(notes.some((c) => /Laufzeit Aufspannung 1 \(DMU 40 EVO\): 60:00 .*nachgetragen/.test(c)), notes.join(" | "));
  assert.ok(!(await odooLog()).some((l) => /mrp\.workorder\.(write|button_finish)/.test(l.call)), "Am Arbeitsgang selbst ändert sich nichts");
  assert.deepEqual((await api("aurel", "GET", "/api/bde/nachtragen")).items, []);
  ok("Laufzeit nachtragen: nur mit Nachtragen und nur wer gestempelt hat, als Notiz „nachgetragen“, Arbeitsgang unverändert, danach aus der Liste");

  // 3. Fehler melden: Aufgabe in Odoo am Fertigungsauftrag für Frank, Text beginnt mit "Fehler:"
  const before = (await odooLog()).length;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  r = await api("aurel", "POST", "/api/bde/aufgaben/neu", { to: 3, summary: "Fehler: Arbeitsplan sagt Eloxieren, Teil ist Edelstahl", deadline: tomorrow, ref: "FA01122" });
  assert.equal(r.status, 200, JSON.stringify(r));
  const added = (await odooLog()).slice(before).map((l) => l.call);
  assert.ok(added.some((c) => /mrp\.production\.activity_schedule\(FA01122, user 25, "Fehler: Arbeitsplan sagt Eloxieren/.test(c)), added.join(" | "));
  r = await fetch("http://localhost:3073/api/bde/aufgaben/neu", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: 3, summary: "Fehler: x", deadline: tomorrow }) });
  assert.equal(r.status, 401, "Ohne PIN-Anmeldung kann niemand melden");
  ok("Fehler melden legt eine Odoo-Aufgabe am Fertigungsauftrag für Frank an, ohne Anmeldung geht es nicht");

  console.log(`Alle ${n} Prüfungen bestanden.`);
} catch (err) {
  console.error("FEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  await wait(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
