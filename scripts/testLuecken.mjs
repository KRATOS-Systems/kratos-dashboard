// Prüft die Lücken-Ergänzung des Odoo-Abgleichs gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testLuecken.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "luecken-"));
const env = { ...process.env, MOCK_A01378: "1", MOCK_PORT: "8077", PORT: "3059", DB_PATH: path.join(dir, "t.db"), ODOO_URL: "http://localhost:8077", ODOO_API_KEY: "t", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "" };
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3059${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  await wait(4500);
  console.log("Lücken-Ergänzung beim Odoo-Abgleich (Test-Odoo)");

  // 1. Erster Abgleich: alles Offene ist "bekannt", nichts kommt herein (die alten Aufträge)
  let r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.baseline, true);
  let orders = (await api("GET", "/api/orders")).orders;
  assert.equal(orders.length, 0);
  ok("Erster Abgleich merkt sich die offenen Aufträge, es kommt nichts hinein");

  // 2. Danach erkennt der Abgleich die Lücke: A01365 steht in der Odoo-Planung offen, FA01307 fehlt bei uns. A00958 ist dort schon geliefert.
  r = await api("POST", "/api/odoo/sync", { dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.created.map((c) => c.ref), ["FA01307"]);
  ok("Trockenlauf findet genau FA01307 (Auftrag A01365 steht offen in der Planung), FA01070 (A00958, dort geliefert) nicht");
  assert.equal((await api("GET", "/api/orders")).orders.length, 0);
  ok("Trockenlauf ändert nichts");

  // 3. Ergänzen: Maschine laut Aufgabe ohne "(Kopie)" = M1, nicht 40 EVO
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  orders = (await api("GET", "/api/orders")).orders;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].odoo_ref, "FA01307");
  assert.equal(orders[0].machine, "m1");
  assert.equal(orders[0].source, "A01365");
  assert.ok(orders[0].odoo_id);
  ok("FA01307 ist ergänzt, liegt auf der M1 (Aufgabe ohne „Kopie“), mit Odoo-Verweis");

  // 4. Nicht doppelt
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.deepEqual(r.created, []);
  assert.equal((await api("GET", "/api/orders")).orders.length, 1);
  ok("Zweiter Abgleich legt nichts doppelt an");

  // 5. Bewusst gelöscht: kommt nicht wieder
  const id = orders[0].id;
  const del = await fetch(`http://localhost:3059/api/orders/${id}`, { method: "DELETE" });
  assert.ok(del.ok, "Löschen nicht möglich: " + del.status);
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.deepEqual(r.created, []);
  assert.equal((await api("GET", "/api/orders")).orders.length, 0);
  ok("Gelöschte Position wird nicht erneut ergänzt (nur einmal)");

  // 6. Gezielt nachholen: A01378 steht in keiner Planungsaufgabe, der Abgleich ergänzt sie nicht von selbst
  assert.equal((await api("POST", "/api/odoo/sync", { dryRun: true })).created.length, 0);
  r = await api("POST", "/api/odoo/nachholen", { source: "kaputt" });
  assert.equal(r.status, 400);
  r = await api("POST", "/api/odoo/nachholen", { source: "a01378" });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.created.map((c) => c.ref), ["FA01302"]);
  orders = (await api("GET", "/api/orders")).orders;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].odoo_ref, "FA01302");
  assert.equal(orders[0].machine, "");
  assert.equal(orders[0].source, "A01378");
  assert.ok(orders[0].new_since && orders[0].new_since !== "baseline", "soll als NEU gekennzeichnet sein");
  ok("A01378 nachgeholt: FA01302 liegt in „Noch nicht eingeplant“ und ist als NEU markiert, Fehleingabe wird abgelehnt");

  // 7. Nur einmal, auch wenn der Abgleich weiterläuft oder erneut angefordert wird
  r = await api("POST", "/api/odoo/nachholen", { source: "A01378" });
  assert.deepEqual(r.created, []);
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.deepEqual(r.created, []);
  assert.equal((await api("GET", "/api/orders")).orders.length, 1);
  ok("Nochmaliges Nachholen und weitere Abgleiche legen nichts doppelt an");

  console.log(`\nAlle ${n} Prüfungen bestanden`);
} catch (err) {
  console.error("\nFEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  await wait(800);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Temp-Ordner darf liegen bleiben */
  }
}
