// Prüft den Planvorschlag: Für jede noch nicht eingeplante Position mit Stunden rechnet die App Maschine und Platz aus,
// speichert aber nichts. Übernommen wird über die normale Reihenfolge-Speicherung (wie beim Ziehen einer Karte).
// Läuft ohne Odoo, mit einer Wegwerf-Datenbank.
// Start: node scripts/testPlanvorschlag.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "planvorschlag-"));
const dbPath = path.join(dir, "t.db");
const env = { ...process.env, PORT: "3065", DB_PATH: dbPath, ODOO_URL: "", ODOO_API_KEY: "", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "", APP_PASSWORD: "" };
const procs = [spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3065${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
// Position anlegen: machine "" = nicht eingeplant
const mk = async (source, { machine = "", hours = 0, due = null, product = "Teil " + source, done_hours } = {}) => {
  const o = await api("POST", "/api/orders", { machine: machine || "dmu50" });
  const r = await api("PUT", `/api/orders/${o.id}`, { order_no: "FA-" + source, source, due, hours, product, ...(machine ? {} : { machine: "" }), ...(done_hours ? { done_hours } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r));
  return o.id;
};
try {
  await wait(3500);
  console.log("Planvorschlag für nicht eingeplante Positionen");

  // Ausgangslage: EVO mit laufender Position und einer weiteren, DMU 50 lang belegt, M1 und H800U frei
  const running = await mk("A1", { machine: "dmu40", hours: 30, done_hours: 10, due: day(20) });
  const queued = await mk("A2", { machine: "dmu40", hours: 20, due: day(30) });
  await mk("A3", { machine: "dmu50", hours: 200, due: day(60) });
  const urgent = await mk("U1", { hours: 8, due: day(5) });
  const relaxed = await mk("U2", { hours: 8, due: day(45) });
  const noHours = await mk("U3", { due: day(12) });
  const odooPart = await mk("U4", { hours: 6, due: day(25) });
  const repeat = await mk("U5", { hours: 5, due: day(35), product: "Grundplatte 4711" });
  // Wiederholteil: dasselbe Teil lief zuletzt auf der H800U (erledigt); U4 hat laut Odoo-Arbeitsplan die M1
  const old = await mk("A0", { machine: "h800u", hours: 5, due: day(-40), product: "Grundplatte 4711" });
  await api("PUT", `/api/orders/${old}`, { done: true });
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE orders SET odoo_machine = 'm1' WHERE id = ?").run(odooPart);
  db.close();

  // 1. Vorschläge für alle Positionen mit Stunden, die ohne Stunden stehen getrennt
  let v = await api("GET", "/api/planvorschlag");
  assert.equal(v.status, 200, JSON.stringify(v));
  const of = (id) => v.vorschlaege.find((p) => p.id === id);
  assert.deepEqual(v.vorschlaege.map((p) => p.id).sort(), [urgent, relaxed, odooPart, repeat].sort());
  assert.deepEqual(v.ohneStunden.map((p) => p.id), [noHours]);
  assert.equal(v.vorschlaege[0].id, urgent, "Das Dringendste wird zuerst eingeplant");
  ok("Vorschläge für alle vier Positionen mit Stunden, nach Liefertermin; die Position ohne Stunden steht getrennt");

  // 2. Maschine: laut Odoo-Arbeitsplan, sonst wie beim letzten Mal (Wiederholteil), sonst frei gerechnet
  assert.equal(of(odooPart).machine, "m1");
  assert.equal(of(odooPart).basis, "odoo");
  assert.equal(of(repeat).machine, "h800u");
  assert.equal(of(repeat).basis, "wiederholteil");
  assert.equal(of(urgent).basis, "frei");
  ok("Maschine laut Odoo-Arbeitsplan (M1), Wiederholteil auf der Maschine vom letzten Mal (H800U), sonst frei gerechnet");

  // 3. Der dringende Auftrag kommt pünktlich, niemand wird neu verspätet, die laufende Position bleibt vorne
  const u = of(urgent);
  assert.notEqual(u.status, "late", JSON.stringify(u));
  assert.ok(u.ende <= day(5), JSON.stringify(u));
  assert.ok(v.vorschlaege.every((p) => p.othersNewLate.length === 0), JSON.stringify(v.vorschlaege));
  assert.ok(v.vorschlaege.every((p) => !(p.machine === "dmu40" && p.platz === 1)), "Nie vor die laufende Position");
  assert.equal(v.wirkung.zuSpaetNachher, v.wirkung.zuSpaetVorher);
  ok("Der dringende Auftrag wird pünktlich fertig, kein anderer Auftrag wird neu verspätet, die laufende Position bleibt auf Platz 1");

  // 4. Nichts gespeichert: Die Positionen sind weiter nicht eingeplant
  let orders = (await api("GET", "/api/orders")).orders;
  assert.ok([urgent, relaxed, odooPart, repeat].every((id) => orders.find((o) => o.id === id).machine === ""));
  ok("Der Vorschlag speichert nichts");

  // 5. Übernehmen wie im Planungsfenster: der Reihe nach vor der genannten Position einfügen und die Reihenfolge speichern
  for (const p of v.vorschlaege) {
    orders = (await api("GET", "/api/orders")).orders;
    const ids = orders.filter((o) => o.machine === p.machine && !o.done).sort((a, b) => a.position - b.position || a.id - b.id).map((o) => o.id);
    const at = p.beforeId != null && ids.includes(p.beforeId) ? ids.indexOf(p.beforeId) : ids.length;
    ids.splice(at, 0, p.id);
    const r = await api("POST", "/api/orders/reorder", { machine: p.machine, ids });
    assert.equal(r.status, 200, JSON.stringify(r));
  }
  orders = (await api("GET", "/api/orders")).orders;
  for (const p of v.vorschlaege) assert.equal(orders.find((o) => o.id === p.id).machine, p.machine);
  const evo = orders.filter((o) => o.machine === "dmu40" && !o.done).sort((a, b) => a.position - b.position).map((o) => o.id);
  assert.equal(evo[0], running);
  assert.ok(evo.includes(queued));
  v = await api("GET", "/api/planvorschlag");
  assert.deepEqual(v.vorschlaege, []);
  assert.deepEqual(v.ohneStunden.map((p) => p.id), [noHours]);
  const w = await api("GET", "/api/fruehwarnung");
  assert.ok(!w.items.some((i) => i.source === "U1" && i.kind === "verzug"), JSON.stringify(w.items));
  ok("Nach dem Übernehmen stehen alle vier auf ihrer Maschine, es bleibt kein Vorschlag offen und der dringende Auftrag ist nicht im Verzug");

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
