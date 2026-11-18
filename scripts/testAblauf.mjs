// Prüft Schritt 1–3 der Planung/AV: Material „nur angefragt“ zählt nicht als da, startklar, AV-Paket gleich für neue Aufträge,
// Programm aus dem Auftragsordner -> bereit, Maschinenabgleich mit zwei Fräsen, AV-Aktionen (Zeiten aus der Kalkulation,
// Material nach AV001 anlegen und eintragen, Fertigungsauftrag bestätigen) samt der engen Odoo-Freigaben.
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs) und eine nachgestellte Kalkulation, nie gegen echte Daten.
// Start: node scripts/testAblauf.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { materialOptionen, werkstoffAV001 } from "../server/avAktionen.js";
import { startklar } from "../src/avLib.js";

const dir = mkdtempSync(path.join(tmpdir(), "ablauf-"));
const KEY = "k".repeat(40);
const PROG_KEY = "p".repeat(30);
const env = {
  ...process.env,
  MOCK_ENTWURF: "1",
  MOCK_ABLAUF: "1",
  MOCK_PORT: "8109",
  PORT: "3088",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8109",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8109",
  BDE_ODOO_API_KEY: "test",
  BDE_WRITE: "1",
  BDE_SECRET: "testgeheimnis",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  KALKULATION_URL: "http://localhost:8093",
  KALKULATION_API_KEY: KEY,
  PROGRAMME_KEY: PROG_KEY,
  EXTERN_AUTO: "0",
  SOLLIST_AUTO: "0",
  ABWESENHEIT_AUTO: "0",
  ZEICHNUNG_AUTO: "0",
};
const kalk = createServer((req, res) => {
  const send = (code, data) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "Schlüssel" });
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/ext/products") return send(200, { products: u.searchParams.get("q") === "042-69-099" ? [{ id: 2907, code: "042-69-099", partId: 601 }] : [] });
  if (u.pathname === "/api/ext/parts/601")
    return send(200, { part: { partId: 601, link: "http://kalk/#/kalkulation/601", material: "X5CrNi18-10 1.4301", rawPart: "30x30x37", machine: "DMU 50", timeBasis: "Merkmal-Modell", confidence: "gut", times: { programmingMin: 150, setupMin: 114, machiningMinPerPiece: 29.4 } } });
  send(404, { error: "unbekannt" });
});
await new Promise((r) => kalk.listen(8093, r));
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = {};
const api = async (who, m, u, b, headers = {}) => {
  const r = await fetch(`http://localhost:3088${u}`, { method: m, headers: { "Content-Type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}), ...headers }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) jar[who] = set.split(";")[0];
  const j = await r.json().catch(() => ({}));
  return { ...j, zustand: j.status, status: r.status };
};
const odooState = () => fetch("http://localhost:8109/__state").then((r) => r.json());
const odooLog = () => fetch("http://localhost:8109/__log").then((r) => r.json());
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3088/api/orders"), fetch("http://localhost:8109/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Ablauf: ehrlicher Plan, AV-Stand automatisch, AV-Aktionen in Odoo (Test-Odoo)");

  // 1. Regeln AV001: Werkstoff, Formen, Vorschlag
  assert.deepEqual(werkstoffAV001("X5CrNi18-10 1.4301"), { name: "1.4301", gruppe: "edelstahl" });
  assert.deepEqual(werkstoffAV001("AlMgSi1 3.2315"), { name: "3.2315/6082", gruppe: "alu" });
  assert.deepEqual(werkstoffAV001("42CrMo4 1.7225"), { name: "1.7225", gruppe: "stahl" });
  assert.equal(werkstoffAV001("POM-C schwarz").gruppe, "kunststoff");
  let mo = materialOptionen("X5CrNi18-10 1.4301", "30x30x37");
  assert.equal(mo.vorschlag, "VK");
  assert.deepEqual(mo.optionen.map((x) => x.name), ["1.4301 VK 30", "1.4301 PL 30x30x37", "1.4301 BLK 30x30x37"]);
  assert.equal(mo.optionen[0].menge, 37);
  mo = materialOptionen("X5CrNi18-10 1.4301", "3x35x144");
  assert.equal(mo.vorschlag, "PL", "Blech bis 6 mm als Zuschnitt");
  assert.equal(mo.optionen.find((x) => x.form === "PL").name, "1.4301 PL 3x35x144");
  assert.equal(materialOptionen("AlMgSi1 3.2315", "Ø20x40,5").optionen[0].name, "3.2315/6082 RD 20");
  assert.equal(materialOptionen("AlMgSi1 3.2315", "60x30x140").optionen[0].name, "3.2315/6082 FL 60x30", "Flach: Breite x Dicke");
  ok("AV001: Werkstoff (1.4301, 3.2315/6082), Form (VK/FL/RD, PL bei Blech) und Name nach Schema");

  // 2. Material nur angefragt: Planung wartet (geschätzter Termin), AV-Punkt bleibt offen
  await api("x", "POST", "/api/odoo/sync", { dryRun: false });
  let orders = (await api("x", "GET", "/api/orders")).orders;
  const row = (ref) => orders.find((o) => o.odoo_ref === ref);
  const f1122 = row("FA01122");
  assert.match(f1122.material_info, /noch nicht bestellt/);
  assert.ok(f1122.material_date && f1122.material_date > new Date().toISOString().slice(0, 10), "geschätzter Liefertermin in der Zukunft: " + f1122.material_date);
  let checks = (await api("x", "GET", "/api/av")).checks;
  const mat = (id) => checks.find((c) => c.order_id === id && c.item === "material");
  assert.equal(mat(f1122.id).status, "offen", "nur angefragt bleibt offen, nicht in Arbeit");
  assert.equal(mat(row("FA01309").id).status, "bereit");
  ok("Material nur angefragt: Planung rechnet mit Lieferung frühestens in 7 Tagen, AV-Punkt bleibt offen");

  // 3. startklar
  const ck = new Map(checks.map((c) => [`${c.order_id}|${c.item}`, c]));
  const fa1340 = row("FA01340");
  assert.ok(fa1340, "FA01340 (Entwurf, bestätigter Kundenauftrag) ist in der App");
  assert.deepEqual(startklar({ ...fa1340, machine: "dmu50" }, ck), ["Musterwerte", "FA im Entwurf", "Material", "Programm"]);
  assert.deepEqual(startklar({ ...fa1340, machine: "dmu50", hours: 0 }, ck)[0], "Stunden");
  assert.equal(startklar({ ...fa1340, machine: "qs" }, ck), null);
  assert.equal(startklar({ ...fa1340, machine: "dmu50", done_hours: 1 }, ck), null, "läuft schon: keine Aussage");
  ok("Startklar: Musterwerte, FA im Entwurf, Material, Programm fehlen; Extern/QS und laufende ohne Aussage");

  // 4. AV-Paket gleich für neue Aufträge (nicht erst am Morgen)
  let fg = [];
  for (let i = 0; i < 20 && !fg.some((f) => f.bezug === "FA01340"); i++) {
    await wait(500);
    fg = (await api("x", "GET", "/api/freigaben")).items.filter((f) => f.art === "av");
  }
  assert.ok(fg.some((f) => f.bezug === "FA01340"), "AV-Paket für den neuen FA01340: " + fg.map((f) => f.bezug).join(","));
  ok("Neuer Auftrag aus Odoo bekommt sein AV-Paket sofort");

  // 5. Programm im Auftragsordner -> AV-Punkt Programm bereit (automatisch)
  const pm = await api("x", "POST", "/api/programme/meldung", { meldungen: [{ fa: "FA01340", code: "042-69-099", auftrag: "A01440", eigene: [{ datei: "042-69-099_S1.mcam", pfad: "K:/x", stand: "2026-11-18" }], alt: [] }] }, { authorization: "Bearer " + PROG_KEY });
  assert.equal(pm.status, 200, JSON.stringify(pm));
  assert.equal(pm.programmBereit, 1);
  checks = (await api("x", "GET", "/api/av")).checks;
  const pr = checks.find((c) => c.order_id === fa1340.id && c.item === "programm");
  assert.equal(pr.status, "bereit");
  assert.equal(pr.auto, 1);
  ok("Programm im Auftragsordner gemeldet: AV-Punkt Programm automatisch bereit");

  // 6. AV-Aktionen ansehen: ohne Anmeldung lesen ja, schreiben nein
  let a = await api("gast", "GET", `/api/av/aktionen/${fa1340.id}`);
  assert.equal(a.status, 200, JSON.stringify(a));
  assert.equal(a.fa.entwurf, true);
  assert.equal(a.zeiten.moeglich, true, JSON.stringify(a.zeiten));
  assert.deepEqual(a.zeiten.neu, { programmieren: 150, ruesten: 114, fraesen: 235.2 });
  assert.equal(a.zeiten.stunden, 5.8);
  assert.equal(a.zeiten.muster, true);
  assert.equal(a.zeiten.stueckliste, true);
  assert.equal(a.material.fehlt, true);
  assert.equal(a.material.vorschlag, "VK");
  assert.equal(a.material.lieferant, "SRS-Stahl");
  assert.equal(a.material.optionen[0].mengeFa, 296, "8 × 37 mm");
  assert.equal((await api("gast", "POST", `/api/av/aktionen/${fa1340.id}/zeiten`)).status, 401);
  ok("AV-Aktionen: Zeiten (Kalkulation vs. Odoo), Material-Vorschlag VK 30 bei SRS, FA im Entwurf; ohne PIN kein Schreiben");

  // 7. Zeiten übernehmen
  assert.equal((await api("frank", "POST", "/api/bde/login", { id: 3, pin: "3333" })).status, 200);
  let r = await api("frank", "POST", `/api/av/aktionen/${fa1340.id}/zeiten`);
  assert.equal(r.status, 200, JSON.stringify(r));
  let st = await odooState();
  const wo = (id) => st["mrp.workorder"].find((w) => w.id === id);
  assert.equal(wo(7400).duration_expected, 150);
  assert.equal(wo(7401).duration_expected, 114);
  assert.equal(wo(7402).duration_expected, 235.2);
  assert.equal(wo(7403).duration_expected, 60, "QS bleibt");
  const op = (id) => st["mrp.routing.workcenter"].find((w) => w.id === id);
  assert.equal(op(3302).time_cycle_manual, 29.4);
  assert.equal(op(3301).time_cycle_manual, 114);
  assert.equal(st["mrp.bom"].find((b) => b.id === 903).code, false, "MUSTER entfernt");
  orders = (await api("x", "GET", "/api/orders")).orders;
  assert.equal(row("FA01340").hours, 5.8);
  assert.notEqual(row("FA01340").odoo_bom, "muster");
  ok("Zeiten übernehmen: Arbeitsgänge, Stückliste (je Stück), MUSTER weg, 5,8 h in der Planung");

  // 8. Material anlegen und eintragen (AV001), dann ist es da; zweiter Klick legt nichts doppelt an
  r = await api("frank", "POST", `/api/av/aktionen/${fa1340.id}/material`, { form: "VK" });
  assert.equal(r.status, 200, JSON.stringify(r));
  st = await odooState();
  const art = st["product.template"].find((t) => t.name === "1.4301 VK 30");
  assert.ok(art, "Artikel angelegt");
  assert.equal(art.categ_id, 16);
  assert.equal(art.uom_id, 6);
  assert.equal(art.sale_ok, false);
  assert.equal(art.purchase_ok, true);
  assert.equal(art.tracking, "lot");
  assert.deepEqual(art.route_ids, [[6, 0, [5, 1]]]);
  assert.deepEqual(art.seller_ids, [[0, 0, { partner_id: 233 }]]);
  const line = st["mrp.bom.line"].find((l) => l.bom_id === 903);
  assert.equal(line.product_qty, 37);
  const mv = st["stock.move"].find((m) => m.raw_material_production_id === 1340);
  assert.equal(mv.product_uom_qty, 296);
  assert.equal(mv.location_id, 8);
  assert.equal(mv.location_dest_id, 15);
  a = await api("frank", "GET", `/api/av/aktionen/${fa1340.id}`);
  assert.equal(a.material.fehlt, false);
  assert.equal((await api("frank", "POST", `/api/av/aktionen/${fa1340.id}/material`, { form: "VK" })).status, 400);
  assert.equal(st["product.template"].filter((t) => t.name === "1.4301 VK 30").length, 1);
  ok("Material nach AV001: 1.4301 VK 30 (Stangenware, mm, Los, Einkaufen + Auffüllung nach Auftrag, SRS), 37 mm in der Stückliste, 296 mm im FA");

  // 9. Fertigungsauftrag bestätigen
  r = await api("frank", "POST", `/api/av/aktionen/${fa1340.id}/bestaetigen`);
  assert.equal(r.status, 200, JSON.stringify(r));
  st = await odooState();
  assert.equal(st["mrp.production"].find((p) => p.id === 1340).state, "confirmed");
  assert.ok((await odooLog()).some((l) => l.call === "mrp.production.action_confirm(1340)"));
  assert.equal((await api("frank", "POST", `/api/av/aktionen/${fa1340.id}/bestaetigen`)).status, 400, "schon bestätigt");
  ok("Fertigungsauftrag bestätigen (action_confirm), zweites Mal abgewiesen");

  // 10. Maschinenabgleich: zwei Fräsen auf „Fräsen (Maschine offen)“ werden zusammen umgestellt
  const f1341 = row("FA01341");
  assert.ok(f1341, "FA01341 in der App");
  await api("x", "PUT", `/api/orders/${f1341.id}`, { hours: 4 });
  r = await api("x", "PUT", `/api/orders/${f1341.id}`, { machine: "dmu50" });
  st = await odooState();
  assert.deepEqual([7411, 7413].map((id) => wo(id) && st["mrp.workorder"].find((w) => w.id === id).workcenter_id), [21, 21], JSON.stringify(r.odoo));
  assert.deepEqual([7410, 7412].map((id) => st["mrp.workorder"].find((w) => w.id === id).workcenter_id), [22, 22]);
  ok("Maschinenabgleich: zwei offene Fräsen auf demselben Sammelplatz gehen zusammen auf die DMU 50 (samt Rüsten)");

  // 11. Odoo-Zugang bleibt eng: nicht freigegebene Felder werden abgewiesen
  const { createOdooClient } = await import("../server/odooClient.js");
  process.env.BDE_ODOO_URL = "http://localhost:8109";
  process.env.BDE_ODOO_API_KEY = "test";
  process.env.BDE_WRITE = "1";
  const c = createOdooClient();
  await assert.rejects(() => c.write("mrp.bom", "write", { ids: [903], vals: { code: "X" } }), /MUSTER/);
  await assert.rejects(() => c.write("product.template", "create", { vals_list: [{ name: "x", sale_ok: true }] }), /Rohmaterial/);
  await assert.rejects(() => c.write("mrp.production", "write", { ids: [1340], vals: { move_raw_ids: [[2, 5]] } }), /Materialzeile/);
  await assert.rejects(() => c.write("mrp.workorder", "write", { ids: [7400], vals: { state: "done" } }), /Plandauer/);
  await assert.rejects(() => c.write("mrp.routing.workcenter", "write", { ids: [3300], vals: { workcenter_id: 1 } }), /Zeit/);
  ok("Odoo-Freigaben eng: nur Plandauer, Zeit je Stück, MUSTER entfernen, Rohmaterial ohne Verkauf, neue Materialzeile");

  console.log(`\nAlle ${n} Prüfungen bestanden.`);
} catch (err) {
  console.error("\nFEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  kalk.close();
  await wait(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows hält die Datei evtl. noch */
  }
}
