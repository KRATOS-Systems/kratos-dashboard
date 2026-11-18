// Prüft die Laufkarte (Schritt 4, src/ablauf.js): welcher Schritt erledigt ist, welcher als Nächstes dran ist, und dass
// laufende Positionen bei den Vorbereitungs-Schritten nicht mehr zählen. Reine Logik, ohne Server.
// Start: node scripts/testLaufkarte.mjs

import assert from "node:assert/strict";
import { ablaufOf } from "../src/ablauf.js";

let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
const ck = (list) => new Map(list.map(([id, item, status]) => [`${id}|${item}`, { status }]));
const allReady = (id) => ["material", "programm", "werkzeuge", "spannmittel"].map((it) => [id, it, "bereit"]);
const pos = (o) => ({ id: 1, order_no: "FA1", hours: 6, machine: "dmu40", odoo_bom: "ok", done: false, done_hours: 0, ...o });
const state = (ab) => Object.fromEntries(ab.steps.map((s) => [s.id, s.state]));

try {
  console.log("Laufkarte: Ablauf je Auftrag");

  // 1. Musterwerte, kein Material, Entwurf, nicht eingeplant: als Nächstes Zeiten
  let ab = ablaufOf([pos({ machine: "", odoo_bom: "muster", odoo_draft: true })], ck([]));
  assert.equal(ab.next.id, "zeiten");
  assert.deepEqual(state(ab), { da: "done", zeiten: "now", material: "open", fa: "open", plan: "open", av: "open", fertigung: "open", qs: "open" });
  ok("Neuer Auftrag mit Musterwerten: als Nächstes „Zeiten & Stückliste“, alles andere offen");

  // 2. Zeiten da, Material nur angefragt
  ab = ablaufOf([pos({ machine: "", material_info: "P1 SRS, Material noch nicht bestellt (Anfrage)" })], ck([]));
  assert.equal(ab.next.id, "material");
  assert.match(ab.next.detail, /nur angefragt, bestellen/);
  ok("Zeiten da, Material nur angefragt: als Nächstes Material, mit Hinweis „bestellen“");

  // 3. Material da, FA im Entwurf
  ab = ablaufOf([pos({ machine: "", odoo_draft: true })], ck([[1, "material", "bereit"]]));
  assert.equal(ab.next.id, "fa");
  ok("Material bereit, FA im Entwurf: als Nächstes FA freigeben");

  // 4. Alles vorbereitet, nicht eingeplant
  ab = ablaufOf([pos({ machine: "" })], ck(allReady(1)));
  assert.equal(ab.next.id, "plan");
  assert.equal(state(ab).av, "done");
  ok("Alles vorbereitet, keine Maschine: als Nächstes Einplanen (AV schon grün)");

  // 5. Eingeplant, Programm fehlt
  ab = ablaufOf([pos({})], ck([[1, "material", "bereit"]]));
  assert.equal(ab.next.id, "av");
  assert.match(ab.next.detail, /Programm/);
  ok("Eingeplant, AV offen: als Nächstes AV mit den offenen Punkten");

  // 6. Läuft auf der Maschine: Vorbereitung zählt nicht mehr, Fertigung ist dran und läuft
  ab = ablaufOf([pos({ done_hours: 2, odoo_bom: "muster" })], ck([]));
  assert.equal(ab.next.id, "fertigung");
  assert.equal(ab.steps.find((s) => s.id === "fertigung").running, true);
  assert.equal(state(ab).material, "done");
  ok("Fräsen läuft: Vorbereitung erledigt, als Nächstes Fertigung (läuft)");

  // 7. In QS / extern
  ab = ablaufOf([pos({ machine: "qs" }), pos({ id: 2, machine: "", done: true })], ck([]));
  assert.equal(ab.next.id, "qs");
  assert.equal(state(ab).fertigung, "done");
  ok("Position in QS: Fertigung erledigt, als Nächstes QS · Extern · Lieferung");

  // 8. Mehrere Positionen: eine fertig vorbereitet, eine ohne Stunden -> Zeiten offen für die eine
  ab = ablaufOf([pos({ ...{} }), pos({ id: 2, order_no: "FA2", hours: 0, machine: "" })], ck([...allReady(1), ...allReady(2)]));
  assert.equal(ab.next.id, "zeiten");
  assert.deepEqual(ab.steps.find((s) => s.id === "zeiten").ids, [2]);
  ok("Mehrere Positionen: Schritt erst erledigt, wenn alle es sind; die betroffene Position wird genannt");

  // 9. Alles geliefert
  ab = ablaufOf([pos({ done: true })], ck([]));
  assert.equal(ab.next, null);
  assert.equal(ab.doneCount, 8);
  ok("Alles erledigt: kein nächster Schritt, 8 von 8");

  console.log(`\nAlle ${n} Prüfungen bestanden.`);
} catch (err) {
  console.error("\nFEHLER:", err.message);
  process.exitCode = 1;
}
