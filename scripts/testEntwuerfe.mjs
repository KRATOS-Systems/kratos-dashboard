// Prüft, dass Fertigungsaufträge im Entwurf mit bestätigtem Kundenauftrag in die Arbeitsvorbereitung kommen,
// gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testEntwuerfe.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "entwuerfe-"));
const env = { ...process.env, MOCK_ENTWURF: "1", MOCK_PORT: "8078", PORT: "3060", DB_PATH: path.join(dir, "t.db"), ODOO_URL: "http://localhost:8078", ODOO_API_KEY: "t", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "" };
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3060${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const odooWrite = (model, ids, vals) =>
  fetch(`http://localhost:8078/json/2/${model}/write`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "bearer t" }, body: JSON.stringify({ ids, vals }) });
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  await wait(4500);
  console.log("Entwürfe in der Arbeitsvorbereitung (Test-Odoo)");

  // 1. Erster Abgleich: der frische Entwurf mit bestätigtem Kundenauftrag kommt als neu herein
  let r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  let orders = (await api("GET", "/api/orders")).orders;
  let fa = orders.filter((o) => o.odoo_ref === "FA01322");
  assert.equal(fa.length, 1, JSON.stringify(orders.map((o) => o.odoo_ref)));
  assert.equal(fa[0].odoo_draft, true);
  assert.equal(fa[0].source, "A01422");
  assert.equal(fa[0].machine, "");
  ok("Entwurf FA01322 (A01422 bestätigt) steht in der Liste, gekennzeichnet als Entwurf");

  // 2. Entwurf mit nur angebotenem Kundenauftrag und Altlast von 2025 bleiben draußen, werden aber gezählt
  assert.ok(!orders.some((o) => o.odoo_ref === "FA01323"), "Angebot darf nicht hinein");
  assert.ok(!orders.some((o) => o.odoo_ref === "FA00364"), "Altlast darf nicht hinein");
  const st = await api("GET", "/api/odoo/status");
  assert.equal(st.bomCheck.drafts, 2, JSON.stringify(st.bomCheck));
  ok("Entwurf zu einem Angebot und Altlast bleiben draußen, der Hinweis zählt nur diese zwei");

  // 3. AV-Punkt abhaken, dann in Odoo bestätigen: dieselbe Zeile, Kennzeichnung weg, AV-Stand bleibt
  const id = fa[0].id;
  r = await api("PUT", "/api/av", { order_id: id, item: "material", status: "bereit" });
  assert.equal(r.item, "material", JSON.stringify(r)); // Antwort enthält selbst ein Feld status (AV-Status)
  await odooWrite("mrp.production", [1322], { state: "confirmed" });
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.created.filter((c) => c.ref === "FA01322").length, 0);
  orders = (await api("GET", "/api/orders")).orders;
  fa = orders.filter((o) => o.odoo_ref === "FA01322");
  assert.equal(fa.length, 1);
  assert.equal(fa[0].id, id);
  assert.equal(fa[0].odoo_draft, false);
  const checks = (await api("GET", "/api/av")).checks.filter((c) => c.order_id === id && c.item === "material");
  assert.equal(checks[0].status, "bereit");
  ok("Nach dem Bestätigen in Odoo bleibt es dieselbe Zeile, AV-Stand erhalten, Entwurf-Kennzeichnung weg");

  // 4. Nichts zum Schließen vorgeschlagen
  assert.equal(r.closing.filter((c) => c.ref === "FA01322").length, 0);
  ok("Kein Schließvorschlag für den bestätigten Auftrag");

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
