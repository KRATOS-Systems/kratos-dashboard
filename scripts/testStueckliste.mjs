// Prüft die Stücklisten-Kennzeichnung des Odoo-Abgleichs gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testStueckliste.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "stueckliste-"));
const env = { ...process.env, MOCK_PORT: "8078", PORT: "3060", DB_PATH: path.join(dir, "t.db"), ODOO_URL: "http://localhost:8078", ODOO_API_KEY: "t", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "" };
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3060${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const mock = async (model, method, p) => {
  const r = await fetch(`http://localhost:8078/json/2/${model}/${method}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "bearer t" }, body: JSON.stringify(p) });
  assert.ok(r.ok, `Test-Odoo ${model}.${method}: ${r.status}`);
  return r.json();
};
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  await wait(4500);
  console.log("Stücklisten-Kennzeichnung beim Odoo-Abgleich (Test-Odoo)");

  // Erster Abgleich: das Vorhandene ist bekannt. Danach legt das Test-Odoo sechs neue Fertigungsaufträge an.
  let r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));

  const mo = (id, name, state, bom) => ({ id, name, product_id: 2901, state, origin: `A0${id}`, product_qty: 1, ...(bom ? { bom_id: bom } : {}) });
  // Das Test-Odoo vergibt die Nummern selbst, deshalb die zurückgegebenen Nummern verwenden
  const [id1, id2, id3, , , id6, id7] = await mock("mrp.production", "create", {
    vals_list: [mo(1401, "FA01401", "confirmed", 901), mo(1402, "FA01402", "confirmed", 902), mo(1403, "FA01403", "confirmed"), mo(1404, "FA01404", "confirmed", 901), mo(1405, "FA01405", "draft"), mo(1406, "FA01406", "draft", 901), mo(1407, "FA01407", "confirmed")],
  });
  const wo = (production_id) => ({ name: "Fräsen", sequence: 2, production_id, workcenter_id: 14, product_id: 2901, state: "blocked", duration_expected: 60, duration: 0 });
  await mock("mrp.workorder", "create", { vals_list: [wo(id1), wo(id2), wo(id6), wo(id7)] });
  ok("Test-Odoo hat sieben neue Fertigungsaufträge: ok, Muster, ohne Stückliste, Stückliste ohne Arbeitsgänge, zwei Entwürfe und einer mit Arbeitsgängen ohne Stückliste-Eintrag");

  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  const orders = (await api("GET", "/api/orders")).orders;
  const bom = (ref) => orders.find((o) => o.odoo_ref === ref)?.odoo_bom;
  assert.equal(bom("FA01401"), "ok");
  assert.equal(bom("FA01402"), "muster");
  assert.equal(bom("FA01403"), "none");
  assert.equal(bom("FA01404"), "leer");
  assert.equal(bom("FA01407"), "ok"); // hat Arbeitsgänge, nur kein Stückliste-Eintrag (wie ein älterer, laufender Auftrag): kein Hinweis
  ok("Die bestätigten Aufträge sind richtig gekennzeichnet: ok, muster, none, leer; Arbeitsgänge ohne Stückliste-Eintrag geben keinen Hinweis");
  assert.ok(!orders.some((o) => o.odoo_ref === "FA01405" || o.odoo_ref === "FA01406"), "Entwürfe dürfen nicht in die Planung kommen");
  ok("Entwürfe kommen nicht in die Planung");

  const s = await api("GET", "/api/odoo/status");
  assert.equal(s.status, 200);
  assert.equal(s.bomCheck.drafts, 2);
  assert.deepEqual(s.bomCheck.draftsNoBom, ["FA01405"]);
  const mine = (a) => a.filter((x) => x.startsWith("FA014")); // FA01307 und FA01070 gehören zum Grundbestand des Test-Odoo
  assert.deepEqual(mine(s.bomCheck.none), ["FA01403"]);
  assert.deepEqual(mine(s.bomCheck.leer), ["FA01404"]);
  assert.deepEqual(mine(s.bomCheck.muster), ["FA01402"]);
  ok("Der Status meldet 2 Entwürfe (einer ohne Stückliste), 1 ohne Stückliste, 1 ohne Arbeitsgänge, 1 mit Musterwerten");

  // Wird die Stückliste in Odoo nachgetragen, ist der Hinweis beim nächsten Abgleich weg
  await mock("mrp.production", "write", { ids: [id3], vals: { bom_id: 901 } });
  await mock("mrp.workorder", "create", { vals_list: [wo(id3)] });
  await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.ok(!(await api("GET", "/api/odoo/status")).bomCheck.none.includes("FA01403"));
  assert.equal((await api("GET", "/api/orders")).orders.find((o) => o.odoo_ref === "FA01403").odoo_bom, "ok");
  ok("Nach dem Nachtragen der Stückliste in Odoo verschwindet der Hinweis beim nächsten Abgleich");

  console.log(`\nAlle ${n} Prüfungen bestanden.`);
} catch (err) {
  console.error("\nFEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  await wait(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
