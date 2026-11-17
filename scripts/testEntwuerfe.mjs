// Prüft den Grundsatz "Jeder bestätigte Kundenauftrag ist in Arbeitsvorbereitung oder Planung sichtbar":
// Entwürfe bestätigter Kundenaufträge kommen in die AV (gekennzeichnet als nicht freigegeben), Altlasten, gelieferte, stornierte
// und Testaufträge bleiben draußen, die Vollständigkeitsprüfung meldet Differenz, Warnliste und "Lieferung offen".
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testEntwuerfe.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "entwuerfe-"));
const env = { ...process.env, MOCK_ENTWURF: "1", MOCK_PORT: "8078", PORT: "3060", DB_PATH: path.join(dir, "t.db"), ODOO_URL: "http://localhost:8078", ODOO_API_KEY: "t", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "", ORDERS_SINCE: "" };
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3060${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const odooWrite = (model, ids, vals) =>
  fetch(`http://localhost:8078/json/2/${model}/write`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "bearer t" }, body: JSON.stringify({ ids, vals }) });
const today = new Date().toISOString().slice(0, 10);
const sources = (list) => list.map((e) => e.source).sort();
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  await wait(4500);
  console.log("Vollständigkeit der Kundenaufträge und Entwürfe in der Arbeitsvorbereitung (Test-Odoo)");

  // A01162 ist beim ersten Abgleich noch ein Angebot: sein alter Fertigungsauftrag FA01122 wird dabei nur als bekannt gemerkt
  await odooWrite("sale.order", [1162], { state: "draft" });

  // 1. Die drei Fälle vom 12.11.2026: Entwurf in Odoo, Kundenauftrag bestätigt, Liefertermin überschritten
  let r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  let orders = (await api("GET", "/api/orders")).orders;
  const row = (ref) => orders.find((o) => o.odoo_ref === ref);
  for (const [ref, source, customer, due] of [
    ["FA01322", "A01422", "Ernst Meck GmbH", "2026-11-05"],
    ["FA01309", "A01385", "ACS Armoured Car Systems GmbH", "2026-11-05"],
    ["FA01334", "A01444", "Schneider Gmbh & Co. KG", "2026-11-06"],
  ]) {
    const o = row(ref);
    assert.ok(o, `${ref} fehlt: ${JSON.stringify(orders.map((x) => x.odoo_ref))}`);
    assert.equal(o.odoo_draft, true, ref + " muss als nicht freigegeben gekennzeichnet sein");
    assert.equal(o.done, false);
    assert.equal(o.machine, "", ref + " steht in der Arbeitsvorbereitung (noch nicht eingeplant)");
    assert.equal(o.source, source);
    assert.equal(o.customer, customer);
    assert.equal(o.due, due);
    assert.ok(o.due < today, ref + " ist überfällig");
    assert.ok(/^2026-10-/.test(o.sale_date), ref + " hat das Auftragsdatum für das Alter in Tagen");
  }
  ok("FA01322, FA01309 und FA01334 stehen in der AV: nicht freigegeben, überfällig, mit Kunde, Liefertermin und Auftragsdatum");

  // 2. Draußen bleiben: Angebot, Altlast von 2025, gelieferter und stornierter Auftrag, Testauftrag
  for (const [ref, why] of [
    ["FA01323", "Kundenauftrag ist nur ein Angebot"],
    ["FA00364", "Altlast von 2025"],
    ["FA01300", "Kundenauftrag vollständig geliefert"],
    ["FA00978", "Kundenauftrag storniert"],
    ["FA01391", "Testauftrag"],
    ["FA01122", "Kundenauftrag noch nicht bestätigt"],
  ])
    assert.ok(!row(ref), `${ref} darf nicht hinein (${why})`);
  let st = await api("GET", "/api/odoo/status");
  assert.equal(st.bomCheck.drafts, 4, JSON.stringify(st.bomCheck));
  ok("Angebot, Altlast, gelieferter, stornierter und Testauftrag bleiben draußen; der Hinweis zählt die vier übrigen Entwürfe");

  // 3. Vollständigkeit nach dem Abgleich: keine Differenz, Warnliste und Lieferung offen stimmen
  let v = (await api("GET", "/api/odoo/vollstaendigkeit")).result;
  assert.ok(v, "Ergebnis der Prüfung fehlt");
  assert.equal(v.total, 6, JSON.stringify(v));
  assert.equal(v.sichtbar, 3);
  assert.deepEqual(v.fehlt, []);
  assert.deepEqual(sources(v.ohneBeleg), ["A01109"]);
  assert.equal(v.ohneBeleg[0].customer, "Konecranes GmbH");
  assert.deepEqual(sources(v.lieferungOffen), ["A01043", "A01446"]);
  assert.match(v.lieferungOffen.find((e) => e.source === "A01043").detail, /Fertigung erledigt/);
  assert.match(v.lieferungOffen.find((e) => e.source === "A01446").detail, /Einkauf P00602 \(Wareneingang offen\)/);
  assert.equal(st.vollst.fehlt, 0);
  assert.equal(st.vollst.ohneBeleg, 1);
  ok("Prüfung: 6 laufende Kundenaufträge, Differenz 0, A01109 ohne Beleg in der Warnliste, A01043 und A01446 unter Lieferung offen");

  // 4. Nachholen: A01162 wird bestätigt, sein schon bekannter Fertigungsauftrag kommt einmalig herein
  await odooWrite("sale.order", [1162], { state: "sale" });
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.created.filter((c) => c.ref === "FA01122").length, 1, JSON.stringify(r.created));
  orders = (await api("GET", "/api/orders")).orders;
  assert.equal(row("FA01122").odoo_draft, false);
  assert.equal(row("FA01122").customer, "Ernst Meck GmbH");
  v = (await api("GET", "/api/odoo/vollstaendigkeit")).result;
  assert.equal(v.total, 7);
  assert.equal(v.sichtbar, 4);
  assert.deepEqual(v.fehlt, []);
  ok("Ein bestätigter Fertigungsauftrag, den die App nur als bekannt führte (FA01122), wird nachgeholt; Differenz bleibt 0");

  // 5. Differenz: Die Position wird in der App gelöscht. Die Prüfung meldet den Auftrag, "Übernehmen" holt ihn zurück
  r = await api("DELETE", `/api/orders/${row("FA01122").id}`);
  assert.equal(r.status, 200);
  v = (await api("POST", "/api/odoo/vollstaendigkeit")).result;
  assert.deepEqual(sources(v.fehlt), ["A01162"], JSON.stringify(v.fehlt));
  assert.deepEqual(v.fehlt[0].refs, ["FA01122"]);
  st = await api("GET", "/api/odoo/status");
  assert.equal(st.vollst.fehlt, 1);
  r = await api("POST", "/api/odoo/nachholen", { source: "A01162", force: true });
  assert.equal(r.created.length, 1, JSON.stringify(r));
  v = (await api("GET", "/api/odoo/vollstaendigkeit")).result;
  assert.deepEqual(v.fehlt, []);
  ok("Fehlt eine Position, meldet die Prüfung die Differenz (A01162, FA01122); Übernehmen bringt sie zurück auf 0");

  // 6. Warnliste abhaken und wieder lösen
  v = (await api("POST", "/api/odoo/vollstaendigkeit/geprueft", { source: "A01109", note: "Lagerware" })).result;
  assert.deepEqual(v.ohneBeleg, []);
  const acked = v.lieferungOffen.find((e) => e.source === "A01109");
  assert.ok(acked && acked.ack && /Lagerware/.test(acked.detail), JSON.stringify(acked));
  v = (await api("POST", "/api/odoo/vollstaendigkeit/geprueft", { source: "A01109", undo: true })).result;
  assert.deepEqual(sources(v.ohneBeleg), ["A01109"]);
  ok("Ein Auftrag ohne Beleg lässt sich mit Grund abhaken (dann unter Lieferung offen) und der Haken wieder lösen");

  // 7. AV-Punkt abhaken, dann in Odoo bestätigen: dieselbe Zeile, Kennzeichnung weg, AV-Stand bleibt
  orders = (await api("GET", "/api/orders")).orders;
  const id = row("FA01322").id;
  r = await api("PUT", "/api/av", { order_id: id, item: "material", status: "bereit" });
  assert.equal(r.item, "material", JSON.stringify(r)); // Antwort enthält selbst ein Feld status (AV-Status)
  await odooWrite("mrp.production", [1322], { state: "confirmed" });
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.created.filter((c) => c.ref === "FA01322").length, 0);
  orders = (await api("GET", "/api/orders")).orders;
  const fa = orders.filter((o) => o.odoo_ref === "FA01322");
  assert.equal(fa.length, 1);
  assert.equal(fa[0].id, id);
  assert.equal(fa[0].odoo_draft, false);
  const checks = (await api("GET", "/api/av")).checks.filter((c) => c.order_id === id && c.item === "material");
  assert.equal(checks[0].status, "bereit");
  assert.equal(r.closing.filter((c) => c.ref === "FA01322").length, 0);
  ok("Nach dem Bestätigen in Odoo bleibt es dieselbe Zeile, AV-Stand erhalten, Kennzeichnung weg, kein Schließvorschlag");

  // 8. Wird der Kundenauftrag geliefert, schlägt die App den Entwurf zum Schließen vor und nimmt den Auftrag aus der Prüfung
  await odooWrite("sale.order", [1385], { delivery_status: "full" });
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.closing.filter((c) => c.ref === "FA01309" && /ausgeliefert/.test(c.reason)).length, 1, JSON.stringify(r.closing));
  v = (await api("GET", "/api/odoo/vollstaendigkeit")).result;
  assert.equal(v.total, 6);
  ok("Ein gelieferter Kundenauftrag fällt aus der Prüfung, sein Entwurf wird zum Schließen vorgeschlagen");

  // 9. Odoo wird nur gelesen: Im Test-Odoo stehen nur die vier Änderungen, die dieser Test selbst gemacht hat
  const log = await fetch("http://localhost:8078/__log").then((x) => x.json());
  assert.equal(log.length, 4, JSON.stringify(log));
  assert.ok(log.every((l) => /^(sale\.order|mrp\.production)\.write\((1162|1322|1385),/.test(l.call)), JSON.stringify(log));
  ok("Die App hat in Odoo nichts geändert");

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
