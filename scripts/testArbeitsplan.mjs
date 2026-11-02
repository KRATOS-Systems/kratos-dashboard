// Prüft das Umstellen der Maschine im Odoo-Arbeitsplan beim Ziehen einer Karte, die Arbeitsplan-Ansicht und die Ampel gegen das Test-Odoo
// (scripts/mockOdoo.mjs mit MOCK_ARBEITSPLAN=1), nie gegen die echte Instanz.
// Start:  node scripts/testArbeitsplan.mjs   (startet Test-Odoo und Server selbst auf Port 8073 und 3057, mit leerer Wegwerf-Datenbank)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const ODOO_PORT = 8073;
const APP_PORT = 3057;
const dir = mkdtempSync(path.join(tmpdir(), "arbeitsplan-"));
const dbPath = path.join(dir, "test.db");
const env = {
  ...process.env,
  MOCK_PORT: String(ODOO_PORT),
  MOCK_ARBEITSPLAN: "1",
  PORT: String(APP_PORT),
  DB_PATH: dbPath,
  BACKUP_AUTO: "0",
  BDE_ODOO_URL: `http://localhost:${ODOO_PORT}`,
  BDE_ODOO_API_KEY: "test",
  BDE_WRITE: "1",
  BDE_SECRET: "testgeheimnis",
  ODOO_URL: "",
  ODOO_API_KEY: "",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const odoo = (p) => fetch(`http://localhost:${ODOO_PORT}${p}`).then((r) => r.json());
let cookie = "";
async function api(method, url, body) {
  const r = await fetch(`http://localhost:${APP_PORT}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
let n = 0;
const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);

const db = () => new DatabaseSync(dbPath);
function addCard(machine, ref, odooId) {
  const d = db();
  const info = d.prepare("INSERT INTO orders (machine, order_no, position, odoo_ref, odoo_id, extern_days) VALUES (?, ?, 0, ?, ?, 7)").run(machine, ref, ref, odooId);
  d.close();
  return Number(info.lastInsertRowid);
}
function setCard(id, machine) {
  const d = db();
  d.prepare("UPDATE orders SET machine = ? WHERE id = ?").run(machine, id);
  d.close();
}
// Arbeitsplan eines Fertigungsauftrags als { Schritt/Nr: Arbeitsplatz }
async function plan(pid) {
  const r = await api("GET", `/api/planung/arbeitsplaene?ids=${pid}`);
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.plans[pid].map((s) => `${s.step}@${s.machine}`);
}

try {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://localhost:${APP_PORT}/api/bde/session`);
      await odoo("/__log");
      break;
    } catch {
      await wait(250);
    }
  }
  console.log("Maschine im Arbeitsplan beim Ziehen (Test-Odoo)");

  const c1310 = addCard("dmu40", "FA01310", 1310);
  const c1311 = addCard("dmu40", "FA01311", 1311);
  const c1312 = addCard("dmu40", "FA01312", 1312);
  const c1313 = addCard("dmu40", "FA01313", 1313);
  const c1314 = addCard("dmu40", "FA01314", 1314);

  assert.deepEqual(await plan(1310), ["Rüsten@DMU 40 EVO Rüsten", "Fräsen@DMU 40 EVO", "QS@QUALITÄTSSICHERUNG (QS)"]);
  const all = (await api("GET", "/api/planung/arbeitsplaene?ids=1310,1311,1312")).plans;
  assert.equal(Object.keys(all).length, 3);
  assert.deepEqual(all[1311].map((s) => s.state), ["done", "progress"]);
  ok("Arbeitsplan aus Odoo wird gelesen: Reihenfolge, Arbeitsplatz, Status, mehrere Aufträge in einem Abruf");

  // Noch nichts begonnen: Karte DMU 40 EVO -> M1 stellt Rüsten und Fräsen in Odoo um, QS bleibt
  let r = await api("POST", "/api/orders/reorder", { machine: "m1", ids: [c1310] });
  assert.equal(r.status, 200);
  assert.equal(r.odoo.length, 1);
  assert.equal(r.odoo[0].status, "umgestellt", JSON.stringify(r.odoo));
  assert.match(r.odoo[0].text, /DMU 40 EVO auf DMG M1/);
  assert.deepEqual(await plan(1310), ["Rüsten@DMG M1 Rüsten", "Fräsen@DMG M1", "QS@QUALITÄTSSICHERUNG (QS)"]);
  const calls = (await odoo("/__log")).map((l) => l.call);
  assert.ok(calls.some((c) => c.includes("message_post") && c.includes("Maschine in der Planung geändert")));
  ok("Karte auf M1 gezogen: Rüsten und Fräsen in Odoo auf M1, QS bleibt, Notiz im Fertigungsauftrag");

  // Schon begonnen (Fräsen läuft mit Zeit): Odoo bleibt, App meldet es
  r = await api("POST", "/api/orders/reorder", { machine: "m1", ids: [c1311] });
  assert.equal(r.odoo[0].status, "begonnen");
  assert.match(r.odoo[0].text, /schon begonnen/);
  assert.deepEqual(await plan(1311), ["Rüsten@DMU 40 EVO Rüsten", "Fräsen@DMU 40 EVO"]);
  ok("Begonnener Auftrag wird in Odoo nicht angefasst und die App meldet es");

  // Zwei Fräsen: nur das auf der bisherigen Maschine (DMU 40 EVO) wird umgestellt, das auf der M1 bleibt
  r = await api("POST", "/api/orders/reorder", { machine: "dmu50", ids: [c1312] });
  assert.equal(r.odoo[0].status, "umgestellt", JSON.stringify(r.odoo));
  assert.deepEqual(await plan(1312), ["Rüsten@DMU 50 Rüsten", "Fräsen@DMU 50", "Rüsten@DMG M1 Rüsten", "Fräsen@DMG M1"]);
  ok("Zwei Fräsen im Auftrag: nur das auf der bisherigen Maschine wird umgestellt");

  // Sammelplätze FRÄSEN und RÜSTEN: auf die Maschine samt Rüst-Arbeitsplatz
  r = await api("POST", "/api/orders/reorder", { machine: "h800u", ids: [c1313] });
  assert.equal(r.odoo[0].status, "umgestellt", JSON.stringify(r.odoo));
  assert.deepEqual(await plan(1313), ["Rüsten@POS H 800 U Rüsten", "Fräsen@POS H 800 U"]);
  ok("Sammelplätze FRÄSEN und RÜSTEN werden auf die Maschine und ihren Rüst-Arbeitsplatz umgestellt");

  // Nur Reihenfolge, Lane und Rückgängig: nichts in Odoo
  const writesBefore = (await odoo("/__log")).filter((l) => /workorder\.write/.test(l.call)).length;
  r = await api("POST", "/api/orders/reorder", { machine: "dmu40", ids: [c1314] });
  assert.deepEqual(r.odoo, []);
  r = await api("PUT", `/api/orders/${c1314}`, { machine: "qs" });
  assert.deepEqual(r.odoo, []);
  r = await api("PUT", `/api/orders/${c1314}`, { machine: "" });
  assert.deepEqual(r.odoo, []);
  assert.equal((await odoo("/__log")).filter((l) => /workorder\.write/.test(l.call)).length, writesBefore);
  ok("Gleiche Maschine, QS und Zurück in die Liste ändern in Odoo nichts");

  // Aus der Liste „nicht eingeplant“ auf eine Maschine: Odoo steht dort noch auf der EVO und wird umgestellt
  r = await api("PUT", `/api/orders/${c1314}`, { machine: "dmu50" });
  assert.equal(r.status, 200);
  assert.equal(r.odoo[0].status, "umgestellt", JSON.stringify(r.odoo));
  assert.deepEqual(await plan(1314), ["Rüsten@DMU 50 Rüsten", "Fräsen@DMU 50", "QS@QUALITÄTSSICHERUNG (QS)"]);
  ok("Einplanen aus der Liste auf eine Maschine stellt Odoo von der EVO auf diese Maschine");

  // Nachträglich angleichen (Knopf in der Arbeitsvorbereitung)
  setCard(c1310, "dmu40"); // Karte sagt EVO, Odoo steht auf M1
  r = await api("POST", "/api/planung/odoo-maschine", { orderId: c1310, from: "m1" });
  assert.equal(r.status, "umgestellt", JSON.stringify(r));
  assert.deepEqual(await plan(1310), ["Rüsten@DMU 40 EVO Rüsten", "Fräsen@DMU 40 EVO", "QS@QUALITÄTSSICHERUNG (QS)"]);
  r = await api("POST", "/api/planung/odoo-maschine", { orderId: c1310, from: "m1" });
  assert.equal(r.status, "passt");
  assert.equal((await api("POST", "/api/planung/odoo-maschine", { orderId: 99999 })).status, 404);
  setCard(c1314, "");
  assert.equal((await api("POST", "/api/planung/odoo-maschine", { orderId: c1314 })).status, 400);
  ok("„In Odoo umstellen“ gleicht eine abweichende Karte an, ein zweiter Klick sagt „passt“, ohne Maschine oder unbekannt wird abgelehnt");

  // Ampel: gestempelt wird auf den Arbeitsgang in Odoo (EVO), die Karte steht auf der M1 -> die Lampe der M1 leuchtet
  assert.equal((await api("POST", "/api/bde/login", { id: 2, pin: "2222" })).status, 200);
  setCard(c1311, "m1");
  r = await api("POST", "/api/bde/act", { action: "start", workorderId: 7201 });
  assert.equal(r.status, 200, JSON.stringify(r));
  const lamp = await api("GET", "/api/maschinen/ampel?fresh=1");
  assert.equal(lamp.machines.m1.state, "lauf", JSON.stringify(lamp.machines));
  assert.notEqual(lamp.machines.dmu40.state, "lauf");
  ok("Ampel folgt der Karte: Läuft das Fräsen eines gezogenen Auftrags noch auf dem alten Arbeitsplatz, leuchtet die Maschine der Karte");

  console.log(`\nAlle ${n} Prüfungen bestanden`);
} catch (err) {
  console.error("FEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  await wait(800);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Wegwerfordner im Temp-Verzeichnis, darf liegen bleiben */
  }
}
