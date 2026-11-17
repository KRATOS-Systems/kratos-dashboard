// Prüft die Hilfen für den Planungsalltag: Stunden-Vorschlag aus früheren Aufträgen, AV-Punkt Material aus dem Einkauf,
// Aufträge nur aus Dienstleistungen, "Heute zu tun" und dass "Neu ordnen" nur lohnende Maschinenwechsel vorschlägt.
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testAlltag.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "alltag-"));
const env = { ...process.env, MOCK_ENTWURF: "1", MOCK_PORT: "8084", PORT: "3069", DB_PATH: path.join(dir, "t.db"), ODOO_URL: "http://localhost:8084", ODOO_API_KEY: "t", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "", ORDERS_SINCE: "", APP_PASSWORD: "" };
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3069${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
const orders = async () => (await api("GET", "/api/orders")).orders;
const checkOf = async (id, item) => (await api("GET", "/api/av")).checks.find((c) => c.order_id === id && c.item === item);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3069/api/orders"), fetch("http://localhost:8084/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Planungsalltag: Stunden-Vorschlag, Material in der AV, Dienstleistung, Heute zu tun, ruhiges Neu ordnen (Test-Odoo)");

  let r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  let os = await orders();
  const row = (ref) => os.find((o) => o.odoo_ref === ref);

  // 1. Stunden-Vorschlag aus den echten Zeiten des letzten erledigten Auftrags desselben Teils (FA01050: Rüsten 1 h, Fräsen 4 h für 4 Stk)
  const fa1122 = row("FA01122");
  assert.equal(fa1122.hours, 0);
  assert.equal(fa1122.hours_suggest, 13, JSON.stringify(fa1122)); // 1 h Rüsten + 12 Stk x 1 h
  assert.equal(fa1122.hours_suggest_src, "aus FA01050: Fräsen 4 h für 4 Stk, Rüsten 1 h");
  assert.equal(row("FA01322").hours_suggest, null, "ohne früheren Auftrag kein Vorschlag");
  ok("Stunden-Vorschlag: FA01122 (12 Stück) bekommt 13 h aus FA01050, Teile ohne frühere Zeiten bekommen keinen");

  // 2. AV-Punkt Material aus dem Einkauf: bestellt = in Arbeit mit Termin, eingegangen = bereit, angefragt = offen mit Hinweis
  let c = await checkOf(row("FA01334").id, "material");
  assert.equal(c.status, "in_arbeit");
  assert.equal(c.due, day(12));
  assert.match(c.note, /^Einkauf: P00620/);
  c = await checkOf(row("FA01309").id, "material");
  assert.equal(c.status, "bereit");
  c = await checkOf(row("FA01122").id, "material");
  assert.equal(c.status, "offen");
  assert.match(c.note, /noch nicht bestellt/);
  // von Hand geändert: der Abgleich fasst den Punkt nicht mehr an
  await api("PUT", "/api/av", { order_id: row("FA01334").id, item: "material", status: "bereit", note: "liegt schon da" });
  await api("POST", "/api/odoo/sync", { dryRun: false });
  c = await checkOf(row("FA01334").id, "material");
  assert.equal(c.status, "bereit");
  assert.equal(c.note, "liegt schon da");
  ok("AV-Punkt Material setzt sich aus dem Einkauf (bestellt, eingegangen, angefragt), von Hand Geändertes bleibt");

  // 3. Aufträge nur aus Dienstleistungen (Servicetechniker) gehören nicht in die Warnliste
  const v = (await api("GET", "/api/odoo/vollstaendigkeit")).result;
  assert.deepEqual(v.nurDienstleistung, ["A09991"]);
  assert.ok(!v.ohneBeleg.some((e) => e.source === "A09991"));
  assert.ok(v.ohneBeleg.some((e) => e.source === "A01109"), "A01109 hat Ware und bleibt in der Warnliste");
  ok("Ein Auftrag nur aus Servicetechniker-Stunden steht nicht in der Warnliste, einer mit Ware schon");

  // 4. Heute zu tun: Zahlen und Ziele; nach dem Übernehmen eines Stunden-Vorschlags sinkt die Zahl
  let h = await api("GET", "/api/heute");
  assert.equal(h.status, 200);
  const it = (id) => h.items.find((x) => x.id === id);
  assert.ok(it("kunden") && it("kunden").ziel === "fruehwarnung", JSON.stringify(h.items));
  assert.ok(it("ohneStunden") && /Vorschlag/.test(it("ohneStunden").hint));
  assert.equal(it("material").n, 1);
  assert.equal(it("ohneBeleg").n, 1);
  const before = it("ohneStunden").n;
  await api("PUT", `/api/orders/${row("FA01122").id}`, { hours: 13, hours_plan: 13 });
  h = await api("GET", "/api/heute");
  assert.equal(it("ohneStunden").n, before - 1);
  assert.ok(it("einplanen").n >= 1);
  ok("Heute zu tun zählt Kunden zu informieren, fehlende Stunden (mit Vorschlag), Material und Warnliste, und springt an die richtige Stelle");

  // 5. Neu ordnen wechselt die Maschine nur, wenn es sich lohnt (mehr als rund 4 Tage oder pünktlich statt zu spät)
  const mk = async (source, machine, hours, due, extra = {}) => {
    const o = await api("POST", "/api/orders", { machine });
    await api("PUT", `/api/orders/${o.id}`, { order_no: "FA-" + source, source, hours, due, product: "Teil " + source, ...extra });
    return o.id;
  };
  const block = await mk("BLK", "dmu40", 20, day(60), { done_hours: 1 });
  await mk("W", "dmu40", 2, day(-5));
  let p = await api("GET", "/api/neuordnen?wechseln=1");
  assert.ok(!p.wechsel.some((w) => w.source === "W"), "2 Tage Gewinn lohnen keinen Maschinenwechsel: " + JSON.stringify(p.wechsel));
  await api("PUT", `/api/orders/${block}`, { hours: 80 });
  p = await api("GET", "/api/neuordnen?wechseln=1");
  assert.ok(p.wechsel.some((w) => w.source === "W"), "8 Tage Gewinn lohnen den Wechsel: " + JSON.stringify(p.wechsel));
  const off = await api("GET", "/api/neuordnen");
  assert.deepEqual(off.wechsel, [], "Ohne Haken wechselt nichts die Maschine");
  ok("Neu ordnen: kein Maschinenwechsel für 2 Tage Gewinn, wohl für 8 Tage; ohne Haken nie");

  // 6. In Odoo nichts geschrieben
  const log = await fetch("http://localhost:8084/__log").then((x) => x.json());
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
