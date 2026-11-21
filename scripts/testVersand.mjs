// Prüft Versand und Abrechnung: Positionen im Versand werden versendet, sobald die Lieferung in Odoo bestätigt ist (Teillieferung bleibt),
// „Zu berechnen“ nach Mengen (EMPB mit „3 von 1 geliefert“ zählt nicht), Aufgabe „Rechnung stellen“ in Odoo einmal je Lieferstand und nur
// für neue Lieferungen, „Versendet“ von Hand, Liste „Erledigt“ mit Versanddatum, Termin und Rechnung, und der Odoo-Abgleich schlägt
// Positionen im Versand nicht zum Schließen vor. Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testVersand.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "versand-"));
const env = {
  ...process.env,
  MOCK_VERSAND: "1",
  MOCK_CODES: "1",
  MOCK_PORT: "8112",
  PORT: "3093",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8112",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8112",
  BDE_ODOO_API_KEY: "test",
  BDE_WRITE: "1",
  BDE_SECRET: "testgeheimnis",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  FREIGABEN_AUTO: "0",
  EXTERN_AUTO: "0",
  VERSAND_AUTO: "0",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3093${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ...j, status: r.status };
};
const odooLog = () => fetch("http://localhost:8112/__log").then((x) => x.json());
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);

async function position(machine, patch) {
  const o = await api("POST", "/api/orders", { machine: "qs" });
  assert.equal(o.status, 200);
  const r = await api("PUT", `/api/orders/${o.id}`, { ...patch, machine, extern_start: today });
  assert.equal(r.status, 200, JSON.stringify(r));
  return o.id;
}
const order = async (id) => (await api("GET", "/api/orders")).orders.find((x) => x.id === id);

try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3093/api/orders"), fetch("http://localhost:8112/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Versand und Abrechnung (Test-Odoo)");

  // Positionen im Versand: A01501 (4 von 10 geliefert), A01502 (vollständig geliefert, Lieferung nur über die Herkunft verknüpft), ohne Auftrag
  const teil = await position("versand", { source: "A01501", product: "[V-100] Halter", quantity: 10, due: "2026-12-31" });
  const voll = await position("versand", { source: "A01502", product: "[V-200] Deckel", quantity: 5, due: "2026-01-02" });
  const ohne = await position("versand", { order_no: "Muster ohne Auftrag" });
  const qs = await position("qs", { source: "A01501", product: "[V-100] Halter", quantity: 10 });

  let d = await api("GET", "/api/versand?neu=1");
  assert.equal(d.status, 200, JSON.stringify(d));
  assert.equal(d.enabled, true);
  assert.equal(d.versendet, 1, JSON.stringify(d.versand));
  let o = await order(voll);
  assert.equal(o.done, true, "A01502 ist vollständig geliefert");
  assert.equal(o.shipped_date, today);
  assert.equal(o.done_date, today);
  assert.match(o.ship_info, /5 von 5 geliefert, zuletzt .*L00902/);
  o = await order(teil);
  assert.equal(o.done, false, "Teillieferung bleibt im Versand");
  assert.equal(o.machine, "versand");
  assert.match(o.ship_info, /4 von 10 geliefert \(Teillieferung\)/);
  assert.equal((await order(ohne)).done, false, "ohne Auftrag: nur von Hand");
  assert.equal((await order(qs)).done, false, "Positionen in QS bleiben unberührt");
  ok("Versendet, sobald die Lieferung in Odoo bestätigt ist (auch nur über die Herkunft verknüpft); Teillieferung bleibt mit Stand");

  // Zu berechnen
  const zb = new Map(d.zuBerechnen.map((z) => [z.sale, z]));
  assert.deepEqual([...zb.keys()].sort(), ["A01501", "A01502", "A01503"], JSON.stringify(d.zuBerechnen.map((z) => z.sale)));
  assert.deepEqual(zb.get("A01502").positionen.map((p) => [p.code, p.offen]), [["V-200", 3]], "EMPB mit 3 von 1 geliefert zählt nicht");
  assert.equal(zb.get("A01502").wert, 120);
  assert.equal(zb.get("A01501").teil, true);
  assert.equal(zb.get("A01501").wert, 50);
  assert.equal(zb.get("A01503").versendetAm < today, true);
  ok("Zu berechnen je Auftragsposition nach Mengen (höchstens bestellt), berechnete Aufträge fehlen, Wert netto");

  // Aufgaben in Odoo: nur für Lieferungen ab dem Start (A01501, A01502), nicht für A01503 (vor 40 Tagen); einmal je Lieferstand
  let calls = (await odooLog()).filter((l) => /activity_schedule/.test(l.call));
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.ok(calls.some((c) => /A01502, user 2, "Rechnung stellen: A01502"/.test(c.call)));
  assert.ok(calls.some((c) => /A01501, user 2, "Rechnung stellen: A01501"/.test(c.call)));
  assert.ok(zb.get("A01502").aufgabe && zb.get("A01502").aufgabe.am === today);
  assert.equal(zb.get("A01503").aufgabe, null);
  d = await api("GET", "/api/versand?neu=1");
  calls = (await odooLog()).filter((l) => /activity_schedule/.test(l.call));
  assert.equal(calls.length, 2, "kein zweites Mal für denselben Lieferstand");
  const writes = (await odooLog()).filter((l) => /\.(write|create|unlink|button_|action_|message_post)\(/.test(l.call));
  assert.deepEqual(writes, [], "sonst wird in Odoo nichts geändert");
  ok("Aufgabe „Rechnung stellen“ in Odoo für Alexander, einmal je Lieferstand, nicht für alte Lieferungen; sonst nichts geschrieben");

  // Von Hand versendet
  const h = await api("POST", `/api/versand/${ohne}/versendet`, {});
  assert.equal(h.status, 200);
  o = await order(ohne);
  assert.equal(o.done, true);
  assert.equal(o.shipped_date, today);
  assert.equal((await api("POST", `/api/versand/${ohne}/versendet`, {})).status, 404, "nur einmal");
  ok("Versendet von Hand (z. B. Abholung, ohne Odoo-Bezug)");

  // Erledigt
  const e = await api("GET", "/api/erledigt?tage=30");
  assert.equal(e.status, 200, JSON.stringify(e));
  const g = e.list.find((x) => x.auftrag === "A01502");
  assert.ok(g, JSON.stringify(e.list));
  assert.equal(g.versendetAm, today);
  assert.equal(g.liefertermin, "2026-01-02");
  assert.equal(g.puenktlich, false);
  assert.ok(g.tageZuSpaet > 0);
  assert.equal(g.lieferungen, 1);
  assert.equal(g.rechnung, "offen");
  assert.equal(g.offenWert, 120);
  assert.equal((await api("GET", "/api/erledigt?q=deckel")).list.length, 1, "Suche nach Artikel");
  assert.equal((await api("GET", "/api/erledigt?q=gibtsnicht")).list.length, 0);
  ok("Erledigt: Versanddatum, Termin (verspätet), Lieferungen, Rechnung offen mit Wert, Suche");

  // Der Odoo-Abgleich schlägt Positionen im Versand nicht zum Schließen vor (der Fertigungsauftrag ist dort meist schon erledigt)
  const db = await import("node:sqlite");
  const sq = new db.DatabaseSync(env.DB_PATH);
  sq.prepare("UPDATE orders SET odoo_ref = 'FA09999' WHERE id = ?").run(teil);
  sq.close();
  const s = await api("POST", "/api/odoo/sync", { dryRun: true });
  assert.equal(s.status, 200, JSON.stringify(s));
  assert.ok(!(s.closing || []).some((c) => c.ref === "FA09999"), JSON.stringify(s.closing));
  ok("Odoo-Abgleich: Positionen im Versand werden nicht zum Schließen vorgeschlagen");

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
