// Prüft die Leitstand-Funktionen der Planung: Auslastung nach vorn, Plan neu ordnen (mit Fixieren und Maschinenwechsel)
// und den Materialtermin aus dem Einkauf. Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testLeitstand.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "leitstand-"));
const env = { ...process.env, MOCK_ENTWURF: "1", MOCK_PORT: "8082", PORT: "3066", DB_PATH: path.join(dir, "t.db"), ODOO_URL: "http://localhost:8082", ODOO_API_KEY: "t", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "", ORDERS_SINCE: "", APP_PASSWORD: "" };
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3066${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
const mk = async (source, machine, hours, due, extra = {}) => {
  const o = await api("POST", "/api/orders", { machine: machine || "dmu50" });
  const r = await api("PUT", `/api/orders/${o.id}`, { order_no: "FA-" + source, source, hours, due, product: "Teil " + source, ...(machine ? {} : { machine: "" }), ...extra });
  assert.equal(r.status, 200, JSON.stringify(r));
  return o.id;
};
const queue = async (mid) =>
  (await api("GET", "/api/orders")).orders
    .filter((o) => o.machine === mid && !o.done)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((o) => o.source);
try {
  // warten, bis Server und Test-Odoo antworten (höchstens 20 Sekunden)
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3066/api/orders"), fetch("http://localhost:8082/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Leitstand: Auslastung, Plan neu ordnen, Material aus dem Einkauf (Test-Odoo)");

  // 1. Auslastung: leere Maschinen sind frei, belegte zeigen Stunden; ein Auftrag, der zu spät fertig wird, färbt die Woche rot
  await mk("B1", "m1", 30, day(40));
  let a = await api("GET", "/api/auslastung");
  assert.equal(a.status, 200);
  assert.equal(a.wochen.length, 8);
  const m1 = a.maschinen.find((m) => m.id === "m1");
  const total = m1.wochen.reduce((s, w) => s + w.belegt, 0);
  assert.ok(Math.abs(total - 30) < 0.6, "30 Stunden müssen verteilt sein: " + total);
  assert.ok(m1.ausgebuchtBis >= day(0));
  assert.ok(m1.wochen.every((w) => w.ampel !== "rot"));
  const evo = a.maschinen.find((m) => m.id === "dmu40");
  assert.equal(evo.ausgebuchtBis, null);
  assert.ok(evo.wochen.every((w) => w.belegt === 0));
  await mk("B2", "m1", 120, day(3));
  a = await api("GET", "/api/auslastung");
  const red = a.maschinen.find((m) => m.id === "m1").wochen.find((w) => w.ampel === "rot");
  assert.ok(red && red.zuSpaet.some((z) => z.auftrag === "B2"), JSON.stringify(a.maschinen.find((m) => m.id === "m1").wochen));
  assert.ok(a.maschinen.find((m) => m.id === "m1").wochen[0].prozent >= 90);
  await mk("B3", null, 12, day(9));
  a = await api("GET", "/api/auslastung");
  const poolHours = a.nichtEingeplant.wochen.reduce((s, w) => s + w.stunden, 0);
  assert.equal(poolHours, 12);
  ok("Auslastung: Stunden je Maschine und Woche, Ampel rot in der Woche mit Verspätung, freie Maschinen und nicht eingeplante Stunden");

  // 2. Plan neu ordnen auf einer Maschine: dringender Auftrag hinten wird nach vorn geholt, die laufende Position bleibt vorne
  const run = await mk("R1", "dmu50", 20, day(60), { done_hours: 5 });
  await mk("R2", "dmu50", 40, day(50));
  await mk("R3", "dmu50", 6, day(4));
  assert.deepEqual(await queue("dmu50"), ["R1", "R2", "R3"]);
  let p = await api("GET", "/api/neuordnen?wechseln=0");
  assert.equal(p.status, 200);
  assert.equal(p.verbessert, true, JSON.stringify(p));
  assert.ok(p.nachher.zuSpaet < p.vorher.zuSpaet || p.nachher.tage < p.vorher.tage, JSON.stringify([p.vorher, p.nachher]));
  const d50 = p.maschinen.find((m) => m.id === "dmu50");
  assert.equal(d50.items[0].source, "R1");
  assert.equal(d50.items[0].fixed, true);
  assert.equal(d50.items[1].source, "R3");
  assert.deepEqual(p.wechsel, []);
  assert.deepEqual(await queue("dmu50"), ["R1", "R2", "R3"], "Berechnen speichert nichts");
  ok("Neu ordnen: der dringende Auftrag kommt nach vorn, die laufende Position bleibt auf Platz 1, gespeichert wird nichts");

  // 3. Übernehmen nur mit aktuellem Stand; danach gibt es nichts mehr zu verbessern
  let r = await api("POST", "/api/neuordnen", { stamp: "veraltet", wechseln: false });
  assert.equal(r.status, 409);
  r = await api("POST", "/api/neuordnen", { stamp: p.stamp, wechseln: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok(r.geaendert >= 2);
  assert.deepEqual((await queue("dmu50")).slice(0, 3), ["R1", "R3", "R2"]);
  p = await api("GET", "/api/neuordnen?wechseln=0");
  assert.equal(p.verbessert, false, JSON.stringify(p));
  ok("Übernehmen gilt nur für den berechneten Stand (sonst Hinweis neu berechnen), danach ist der Plan geordnet");

  // 4. Fixiert bleibt, wo es ist: R2 wird nach vorn geschoben und fixiert, Neu ordnen lässt es dort
  const ids = (await api("GET", "/api/orders")).orders.filter((o) => o.machine === "dmu50" && !o.done).sort((x, y) => x.position - y.position).map((o) => o.id);
  const r2 = (await api("GET", "/api/orders")).orders.find((o) => o.source === "R2").id;
  await api("POST", "/api/orders/reorder", { machine: "dmu50", ids: [run, r2, ...ids.filter((x) => x !== run && x !== r2)] });
  r = await api("PUT", `/api/orders/${r2}`, { pinned: true });
  assert.equal(r.pinned, true);
  p = await api("GET", "/api/neuordnen?wechseln=0");
  if (p.verbessert) {
    const it = p.maschinen.find((m) => m.id === "dmu50").items.find((x) => x.id === r2);
    assert.equal(it.platz, 2);
    assert.equal(it.pinned, true);
  }
  const pv = await api("GET", "/api/planvorschlag");
  const b3 = pv.vorschlaege.find((x) => x.source === "B3");
  assert.ok(b3 && !(b3.machine === "dmu50" && b3.platz <= 2), JSON.stringify(b3));
  ok("Eine fixierte Position bleibt auf ihrem Platz, auch der Planvorschlag schiebt nichts davor");

  // 5. Maschine wechseln: die M1 ist überladen, verspätete Positionen dürfen auf freie Maschinen
  p = await api("GET", "/api/neuordnen?wechseln=1");
  assert.equal(p.verbessert, true, JSON.stringify(p.vorher));
  assert.ok(p.wechsel.length >= 1, JSON.stringify(p.wechsel));
  assert.ok(p.wechsel.every((w) => w.von !== w.nach));
  assert.ok(p.nachher.zuSpaet < p.vorher.zuSpaet || p.nachher.tage < p.vorher.tage);
  const noSwitch = await api("GET", "/api/neuordnen?wechseln=0");
  assert.deepEqual(noSwitch.wechsel, []);
  r = await api("POST", "/api/neuordnen", { stamp: p.stamp, wechseln: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.wechsel, p.wechsel.length);
  const moved = (await api("GET", "/api/orders")).orders.find((o) => o.id === p.wechsel[0].id);
  assert.notEqual(moved.machine, "m1");
  ok("Mit „auch Maschine wechseln“ wandern Positionen verspäteter Aufträge auf freie Maschinen, ohne den Haken nicht");

  // 5b. M1 ist eingeschränkt: von selbst legt die App ein Teil nur dorthin, wenn es dort gehen kann
  for (const mid of ["dmu40", "dmu50", "h800u"]) await mk("V-" + mid, mid, 300, day(80));
  const q1 = await mk("Q1", "dmu50", 10, day(4));
  const q1Late = await api("GET", "/api/neuordnen?wechseln=1");
  assert.ok(!q1Late.wechsel.some((w) => w.nach === "M1"), "ohne Freigabe nicht auf die M1: " + JSON.stringify(q1Late.wechsel));
  let pv1 = await api("GET", "/api/planvorschlag");
  await mk("Q2", null, 8, day(5));
  pv1 = await api("GET", "/api/planvorschlag");
  assert.notEqual(pv1.vorschlaege.find((x) => x.source === "Q2").machine, "m1", JSON.stringify(pv1.vorschlaege));
  // Die anderen drei Maschinen vorne zu (alles fixiert außer Q1, hinten 300 h): dort wäre es zu spät, auf der M1 pünktlich
  const pinnedIds = (await api("GET", "/api/orders")).orders.filter((x) => !x.done && ["dmu40", "dmu50", "h800u"].includes(x.machine) && !x.pinned && x.id !== q1).map((x) => x.id);
  for (const id of pinnedIds) await api("PUT", `/api/orders/${id}`, { pinned: true });
  const q1Blocked = await api("GET", "/api/neuordnen?wechseln=1");
  assert.ok(!q1Blocked.wechsel.some((w) => w.nach === "M1"), "auch dann nicht ohne Freigabe: " + JSON.stringify(q1Blocked.wechsel));
  await api("PUT", `/api/orders/${q1}`, { restricted_ok: true });
  const q1Ok = await api("GET", "/api/neuordnen?wechseln=1");
  assert.ok(q1Ok.wechsel.some((w) => w.source === "Q1" && w.nach === "M1"), JSON.stringify(q1Ok.wechsel));
  pv1 = await api("GET", "/api/planvorschlag");
  assert.notEqual(pv1.vorschlaege.find((x) => x.source === "Q2").machine, "m1", "ohne Haken auch dann nicht auf die M1");
  const q2 = (await api("GET", "/api/orders")).orders.find((o) => o.source === "Q2");
  await api("PUT", `/api/orders/${q2.id}`, { restricted_ok: true });
  pv1 = await api("GET", "/api/planvorschlag");
  assert.equal(pv1.vorschlaege.find((x) => x.source === "Q2").machine, "m1", JSON.stringify(pv1.vorschlaege));
  ok("Die M1 ist eingeschränkt: Neu ordnen und Planvorschlag legen ein Teil nur mit „passt auf M1“ (oder Odoo, Wiederholteil) dorthin");
  for (const id of pinnedIds) await api("PUT", `/api/orders/${id}`, { pinned: false });
  for (const o of (await api("GET", "/api/orders")).orders.filter((x) => /^(V-|Q[12]$)/.test(x.source || ""))) await api("DELETE", `/api/orders/${o.id}`);

  // 6. Material aus dem Einkauf: bestätigte Bestellung mit offenem Wareneingang hält die Position bis zum Liefertermin des Lieferanten zurück
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  const orders = (await api("GET", "/api/orders")).orders;
  const fa1334 = orders.find((o) => o.odoo_ref === "FA01334");
  assert.equal(fa1334.material_date, day(12));
  assert.match(fa1334.material_info, /^P00620 .*Wareneingang offen, geplant/);
  assert.match(orders.find((o) => o.odoo_ref === "FA01122").material_info, /noch nicht bestellt/);
  // nur angefragt: kein Termin, die Planung verschiebt nichts
  assert.equal(orders.find((o) => o.odoo_ref === "FA01122").material_date, null);
  assert.match(orders.find((o) => o.odoo_ref === "FA01309").material_info, /eingegangen/);
  await api("PUT", `/api/orders/${fa1334.id}`, { hours: 4 });
  let v = await api("GET", "/api/planvorschlag");
  let prop = v.vorschlaege.find((x) => x.id === fa1334.id);
  assert.ok(prop.start > day(12), "Start erst nach dem Wareneingang: " + JSON.stringify(prop));
  const w = await api("GET", "/api/fruehwarnung");
  assert.ok(w.items.find((i) => i.source === "A01444").reasons.some((x) => /Material kommt laut Einkauf am/.test(x)));
  ok("Material: bestätigte Bestellung mit offenem Wareneingang hält die Position zurück; Anfrage und eingegangene Ware nur als Hinweis");

  // 7. Material in der AV als bereit gemeldet: der Einkaufstermin hält nicht mehr zurück
  await api("PUT", "/api/av", { order_id: fa1334.id, item: "material", status: "bereit" });
  v = await api("GET", "/api/planvorschlag");
  prop = v.vorschlaege.find((x) => x.id === fa1334.id);
  assert.ok(prop.start <= day(7), JSON.stringify(prop));
  ok("Steht Material in der AV auf bereit, plant die App ohne den Termin aus dem Einkauf");

  // 7b. Von Hand „in Arbeit, kommt am …“ eingetragen: dieses Datum zählt, nicht der Termin aus Odoo
  await api("PUT", "/api/av", { order_id: fa1334.id, item: "material", status: "in_arbeit", due: day(3) });
  v = await api("GET", "/api/planvorschlag");
  prop = v.vorschlaege.find((x) => x.id === fa1334.id);
  assert.ok(prop.start >= day(3) && prop.start < day(12), "Start nach dem eigenen Datum, vor dem Odoo-Termin: " + JSON.stringify(prop));
  ok("Datum von Hand in der AV zählt vor dem Liefertermin aus Odoo");

  // 7c. Wareneingang in Odoo setzt Material bereit, auch über einen Eintrag von Hand
  const fa1309 = orders.find((o) => o.odoo_ref === "FA01309");
  await api("PUT", "/api/av", { order_id: fa1309.id, item: "material", status: "in_arbeit", due: day(5) });
  r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  const m1309 = (await api("GET", "/api/av")).checks.find((c) => c.order_id === fa1309.id && c.item === "material");
  assert.equal(m1309.status, "bereit", JSON.stringify(m1309));
  assert.equal(m1309.due, null);
  ok("Wareneingang in Odoo: Material bereit, auch wenn vorher von Hand ein Datum stand");

  // 8. In Odoo hat die App nichts geschrieben (ohne Bedienen-Freigabe wird beim Maschinenwechsel nichts umgestellt)
  const log = await fetch("http://localhost:8082/__log").then((x) => x.json());
  assert.deepEqual(log, [], JSON.stringify(log));
  ok("In Odoo wurde nichts geändert");

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
