// Prüft Prio-Aufträge (nur Leitung setzt, alle sehen, endet von selbst, „Noch Prio?“ nach 7 Tagen), den Platz-Vorschlag im Pool
// (gleiche Rechnung wie „Platz finden“ im Chat, M1-Regel) und die Erkennung von Musterwerten ohne Referenz MUSTER.
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testPrio.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { looksMuster } from "../server/odooSync.js";

const dir = mkdtempSync(path.join(tmpdir(), "prio-"));
const DB = path.join(dir, "t.db");
const env = {
  ...process.env,
  MOCK_ENTWURF: "1",
  MOCK_PORT: "8108",
  PORT: "3087",
  DB_PATH: DB,
  ODOO_URL: "http://localhost:8108",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8108",
  BDE_ODOO_API_KEY: "test",
  BDE_SECRET: "testgeheimnis",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  FREIGABEN_AUTO: "0",
  EXTERN_AUTO: "0",
  SOLLIST_AUTO: "0",
  ABWESENHEIT_AUTO: "0",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = {};
const api = async (who, m, u, b) => {
  const r = await fetch(`http://localhost:3087${u}`, { method: m, headers: { "Content-Type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}) }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) jar[who] = set.split(";")[0];
  const j = await r.json().catch(() => ({}));
  return { ...j, status: r.status };
};
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3087/api/orders"), fetch("http://localhost:8108/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Prio-Aufträge, Platz-Vorschlag, Musterwerte (Test-Odoo)");
  await api("x", "POST", "/api/odoo/sync", { dryRun: false });
  let orders = (await api("x", "GET", "/api/orders")).orders;
  const fa = orders.find((o) => o.odoo_ref === "FA01334");
  assert.ok(fa, "FA01334 im Test-Odoo");
  const key = fa.source || fa.order_no;
  const group = orders.filter((o) => !o.done && (o.source || o.order_no) === key);

  // 1. Ohne Anmeldung: sehen ja, setzen nein
  let p = await api("gast", "GET", "/api/prio");
  assert.equal(p.status, 200);
  assert.deepEqual(p.items, []);
  assert.equal(p.darf, false);
  assert.equal((await api("gast", "POST", "/api/prio", { auftrag: key })).status, 403);
  assert.equal((await api("aurel", "POST", "/api/bde/login", { id: 2, pin: "2222" })).status, 200);
  assert.equal((await api("aurel", "POST", "/api/prio", { auftrag: key })).status, 403, "Mitarbeiter ohne Leitung darf nicht");
  ok("Prio sehen alle, setzen nur die Leitung (ohne Anmeldung und als Mitarbeiter 403)");

  // 2. Leitung setzt Prio am Auftrag: Positionen, AV offen, Kunde/Termin; unbekannter Auftrag 404
  assert.equal((await api("frank", "POST", "/api/bde/login", { id: 3, pin: "3333" })).status, 200);
  p = await api("frank", "POST", "/api/prio", { auftrag: key, grund: "Kunde wartet" });
  assert.equal(p.status, 200, JSON.stringify(p));
  assert.equal(p.items.length, 1);
  const it = p.items[0];
  assert.equal(it.auftrag, key);
  assert.equal(it.grund, "Kunde wartet");
  assert.equal(it.positionen.length, group.length);
  assert.ok(it.positionen.some((x) => x.ref === "FA01334"));
  assert.ok(it.positionen.every((x) => x.avOffen.includes("Material") && x.avOffen.includes("Programm")), JSON.stringify(it.positionen));
  assert.equal(it.avOffen, true);
  assert.equal(it.nachfragen, false);
  assert.equal((await api("frank", "POST", "/api/prio", { auftrag: "A99999" })).status, 404);
  assert.equal((await api("frank", "GET", "/api/prio")).darf, true);
  const plan = await api("x", "GET", "/api/orders");
  assert.ok(plan.orders.filter((o) => (o.source || o.order_no) === key).every((o) => o.machine === (orders.find((x) => x.id === o.id) || {}).machine), "Prio schiebt den Plan nicht um");
  ok("Leitung setzt Prio am Auftrag: alle Positionen, offene AV-Punkte, Grund; Plan bleibt unverändert");

  // 3. Nach 7 Tagen fragt die Leiste „Noch Prio?“; bestätigen setzt die Frist neu
  const db = new DatabaseSync(DB);
  db.prepare("UPDATE prio SET seit = ? WHERE auftrag = ?").run(new Date(Date.now() - 8 * 86400000).toISOString(), key);
  assert.equal((await api("frank", "GET", "/api/prio")).items[0].nachfragen, true);
  p = await api("frank", "POST", "/api/prio/bestaetigen", { auftrag: key });
  assert.equal(p.status, 200);
  assert.equal(p.items[0].nachfragen, false);
  ok("Nach 7 Tagen „Noch Prio?“, Ja setzt die Frist neu");

  // 4. Prio endet von selbst, wenn alle Positionen erledigt sind; Prio aus geht auch von Hand
  for (const o of group) await api("x", "PUT", `/api/orders/${o.id}`, { done: true });
  assert.deepEqual((await api("frank", "GET", "/api/prio")).items, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prio").get().n, 0);
  for (const o of group) await api("x", "PUT", `/api/orders/${o.id}`, { done: false });
  await api("frank", "POST", "/api/prio", { auftrag: key });
  p = await api("frank", "POST", "/api/prio/aus", { auftrag: key });
  assert.deepEqual(p.items, []);
  db.close();
  ok("Prio endet von selbst, wenn alles erledigt ist; „Prio aus“ nimmt sie weg");

  // 5. Platz-Vorschlag für eine Position im Pool: Varianten mit Maschine, Platz, Fertig; M1 nur mit Freigabe
  orders = (await api("x", "GET", "/api/orders")).orders;
  const pool = orders.find((o) => !o.done && o.machine === "" && o.odoo_ref === "FA01334");
  assert.ok(pool, "FA01334 liegt im Pool");
  let v = await api("x", "GET", `/api/plan/platz/${pool.id}`);
  assert.equal(v.status, 200);
  assert.deepEqual(v.varianten, [], "ohne Stunden kein Vorschlag");
  await api("x", "PUT", `/api/orders/${pool.id}`, { hours: 4 });
  v = await api("x", "GET", `/api/plan/platz/${pool.id}`);
  assert.ok(v.varianten.length >= 1, JSON.stringify(v));
  assert.ok(v.varianten.every((x) => ["dmu40", "dmu50", "h800u"].includes(x.machine)), "ohne Freigabe nie auf die M1: " + JSON.stringify(v.varianten));
  assert.ok(v.varianten[0].platz >= 1 && "maschine" in v.varianten[0] && "fertig" in v.varianten[0]);
  await api("x", "PUT", `/api/orders/${pool.id}`, { restricted_ok: true });
  v = await api("x", "GET", `/api/plan/platz/${pool.id}`);
  assert.ok(v.varianten.length >= 1);
  assert.equal((await api("x", "GET", "/api/plan/platz/999999")).status, 404);
  ok("Platz-Vorschlag im Pool: beste Stellen je Maschine, M1 nur mit „passt auf M1“, ohne Stunden keiner");

  // 6. Musterwerte ohne Referenz MUSTER: jeder Arbeitsgang 60 min bzw. 60 min je Stück
  assert.equal(looksMuster({ ops: [60, 60, 960, 60] }, 16), true);
  assert.equal(looksMuster({ ops: [60, 960, 960, 60] }, 16), true, "Rüsten auf der M1 je Stück gerechnet");
  assert.equal(looksMuster({ ops: [90, 60, 365, 60] }, 16), false);
  assert.equal(looksMuster({ ops: [60, 60] }, 1), false, "zu wenige Arbeitsgänge");
  assert.equal(looksMuster(null, 4), false);
  ok("Musterwerte erkannt, auch wenn die Stückliste keine Referenz MUSTER hat");

  console.log(`\nAlle ${n} Prüfungen bestanden.`);
} catch (err) {
  console.error("\nFEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  await wait(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows hält die Datei evtl. noch */
  }
}
