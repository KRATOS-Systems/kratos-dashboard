// Prüft die Automatik: Wareneingang der Fremdfertigung → QS (Teil-Wareneingang bleibt mit Stand), Oberfläche zurück → Versand,
// Ziel umstellbar, vollständig ausgelieferte Aufträge schließt die App selbst; „Zu berechnen“ prüft Beträge (unverknüpfte Rechnungszeile),
// erkennt Duplikate (gleiche Bestellnummer) und blendet 0-€-Aufträge aus; „Heute zu tun“ nennt Versand, Rechnungen und Automatik.
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz. Start: node scripts/testAutomatik.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(path.join(tmpdir(), "automatik-"));
const env = {
  ...process.env,
  MOCK_AUTOMATIK: "1",
  MOCK_CODES: "1",
  MOCK_PORT: "8114",
  PORT: "3095",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8114",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8114",
  BDE_ODOO_API_KEY: "test",
  BDE_WRITE: "1",
  BDE_SECRET: "testgeheimnis",
  ORDERS_SINCE: "2020-01-01",
  APP_PASSWORD: "",
  FREIGABEN_AUTO: "0",
  EXTERN_AUTO: "0",
  VERSAND_AUTO: "0",
  AUTOMATIK_AUTO: "0",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3095${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ...j, status: r.status };
};
const odooLog = () => fetch("http://localhost:8114/__log").then((x) => x.json());
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
const sql = (q, ...a) => {
  const d = new DatabaseSync(env.DB_PATH);
  try {
    return d.prepare(q).run(...a);
  } finally {
    d.close();
  }
};
async function position(machine, patch, raw = {}) {
  const o = await api("POST", "/api/orders", { machine: "qs" });
  const r = await api("PUT", `/api/orders/${o.id}`, { ...patch, machine, extern_start: today });
  assert.equal(r.status, 200, JSON.stringify(r));
  for (const [k, v] of Object.entries(raw)) sql(`UPDATE orders SET ${k} = ? WHERE id = ?`, v, o.id);
  return o.id;
}
const order = async (id) => (await api("GET", "/api/orders")).orders.find((x) => x.id === id);

try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3095/api/orders"), fetch("http://localhost:8114/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Automatik und genauere Abrechnung (Test-Odoo)");
  const voll = await position("extern_fert", { source: "A01601", product: "[W-1] Welle", quantity: 12 }, { po_id: 701, odoo_ref: "P00701-7011" });
  const teil = await position("extern_fert", { source: "A01602", product: "[F-2] Flansch", quantity: 20 }, { po_id: 702, odoo_ref: "P00702-7021" });
  const ober = await position("extern", { source: "A01603", product: "[X-3] Gehäuse", quantity: 6, extern_tags: ["Eloxal schwarz"] }, { odoo_ref: "FA01603" });
  const fertig = await position("dmu40", { source: "A01604", product: "[X-4] Deckel", quantity: 2, hours: 3 }, { odoo_ref: "FA09001" });
  sql("INSERT INTO odoo_sync (key, value) VALUES ('pending_closing', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify([{ ref: "FA09001", source: "A01604", product: "Deckel", reason: "Ware laut Odoo vollständig ausgeliefert" }, { ref: "FA09002", source: "A01999", reason: "Verkaufsauftrag in Odoo storniert" }]));

  assert.deepEqual((await api("GET", "/api/automatik")).einstellungen, { nachFremd: "qs", nachOberflaeche: "versand" });
  const r = await api("POST", "/api/automatik/lauf", {});
  assert.equal(r.status, 200, JSON.stringify(r));
  let o = await order(voll);
  assert.equal(o.machine, "qs", "Fremdfertigung eingegangen → QS");
  assert.match(o.ext_info, /Ware eingegangen \(P00701, WH\/IN\/00701\)/);
  o = await order(teil);
  assert.equal(o.machine, "extern_fert", "Teil-Wareneingang bleibt");
  assert.match(o.ext_info, /12 von 20 eingegangen \(Teil-Wareneingang\)/);
  ok("Fertigung extern: Ware eingegangen → QS; Teil-Wareneingang bleibt mit Stand");

  o = await order(ober);
  assert.equal(o.machine, "versand", "Oberfläche zurück → Versand");
  assert.match(o.ext_info, /Ware zurück \(P00703, WH\/IN\/00703\)/);
  ok("Oberfläche extern: Lohnarbeit zum FA eingegangen → Versand");

  o = await order(fertig);
  assert.equal(o.done, true, "vollständig ausgeliefert → selbst abgeschlossen");
  const pend = JSON.parse(new DatabaseSync(env.DB_PATH).prepare("SELECT value FROM odoo_sync WHERE key = 'pending_closing'").get().value);
  assert.deepEqual(pend.map((p) => p.ref), ["FA09002"], "andere Schließvorschläge bleiben Vorschläge");
  const prot = (await api("GET", "/api/automatik")).protokoll;
  assert.equal(prot.length, 3, JSON.stringify(prot));
  ok("Vollständig ausgeliefert: App schließt selbst, Storno bleibt Vorschlag; Protokoll mit 3 Einträgen");

  // Ziel umstellen
  assert.equal((await api("PUT", "/api/automatik/einstellungen", { nachFremd: "versand" })).einstellungen.nachFremd, "versand");
  assert.equal((await api("PUT", "/api/automatik/einstellungen", { nachFremd: "quatsch" })).status, 400);
  const voll2 = await position("extern_fert", { source: "A01601", product: "[W-1] Welle", quantity: 12 }, { po_id: 701, odoo_ref: "P00701-7012" });
  await api("POST", "/api/automatik/lauf", {});
  assert.equal((await order(voll2)).machine, "versand");
  ok("Ziel nach dem Wareneingang umstellbar (Fremdfertigung → Versand)");

  // Zu berechnen
  const d = await api("GET", "/api/versand?neu=1");
  assert.equal(d.status, 200, JSON.stringify(d));
  assert.deepEqual(d.zuBerechnen.map((z) => z.sale), ["A01609"], JSON.stringify(d.zuBerechnen.map((z) => [z.sale, z.wert])));
  assert.equal(d.zuBerechnen[0].wert, 80);
  ok("Zu berechnen: Rechnungsbetrag deckt unverknüpfte Zeile (A01605), Duplikat über Bestellnummer (A01607/A01606), 0 € fällt raus");

  // Heute zu tun
  const h = await api("GET", "/api/heute");
  const item = (id) => h.items.find((i) => i.id === id);
  assert.equal(item("rechnung")?.n, 1, JSON.stringify(h.items.map((i) => i.id)));
  assert.match(item("rechnung").hint, /80/);
  assert.equal(item("rechnung").ziel, "versand");
  assert.equal(item("versand")?.n, 2, "A01603 und A01601 versandbereit");
  assert.equal(item("automatik")?.n, 4);
  ok("Heute zu tun: Rechnungen, versandbereit und was automatisch weiterging, mit Sprung in den Reiter Versand");

  const writes = (await odooLog()).filter((l) => /\.(write|create|unlink|button_|action_|message_post|activity_schedule)\(/.test(l.call));
  assert.deepEqual(writes, [], "Automatik und Abrechnung schreiben nichts in Odoo (A01609 ohne Lieferdatum: keine Aufgabe)");
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
