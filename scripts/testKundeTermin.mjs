// Prüft: Kunde über neuen Liefertermin informiert -> mit Schreibfreigabe (BDE_WRITE=1) wird in Odoo genau das zugesagte Lieferdatum
// am Kundenauftrag geändert und die Verschiebung als interne Notiz in den Chatter geschrieben. Sonst nichts.
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testKundeTermin.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "kundetermin-"));
const env = { ...process.env, MOCK_ENTWURF: "1", MOCK_FREMD: "1", MOCK_PORT: "8091", PORT: "3074", DB_PATH: path.join(dir, "t.db"), ODOO_URL: "http://localhost:8091", ODOO_API_KEY: "t", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "", BDE_WRITE: "1", ORDERS_SINCE: "", COMPANY_NAME: "" };
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3074${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const de = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  await wait(4500);
  console.log("Kunde informiert: Termin und Chatter-Notiz in Odoo (Test-Odoo)");
  let r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  const orders = (await api("GET", "/api/orders")).orders;
  const fa = orders.find((o) => o.odoo_ref === "FA01309");
  await api("PUT", `/api/orders/${fa.id}`, { machine: "dmu40", hours: 6 });
  await fetch("http://localhost:8091/__log?clear=1").catch(() => {});
  const before = await fetch("http://localhost:8091/__log").then((x) => x.json());

  let w = await api("GET", "/api/fruehwarnung");
  const proposal = w.items.find((i) => i.source === "A01385").proposal;
  assert.ok(proposal, "Vorschlag nötig");
  w = await api("POST", "/api/fruehwarnung/informiert", { source: "A01385", date: proposal, channel: "telefon", contact: "Petra Lang", note: "Teillieferung angeboten" });
  assert.equal(w.status, 200, JSON.stringify(w));
  assert.equal(w.odoo.ok, true, JSON.stringify(w.odoo));
  const log = (await fetch("http://localhost:8091/__log").then((x) => x.json())).slice(before.length).map((l) => l.call);
  assert.equal(log.length, 2, JSON.stringify(log));
  assert.equal(log[0], `sale.order.write(1385, {"commitment_date":"${proposal} 07:00:00"})`, "Uhrzeit des alten Termins bleibt");
  assert.match(log[1], /^sale\.order\.message_post\(1385, mail\.mt_note, html\)/, "Notiz als HTML senden, sonst zeigt Odoo <p> und <b> als Text");
  assert.match(log[1], new RegExp(`Liefertermin verschoben: 05\\.11\\.2026 → ${de(proposal).replace(/\./g, "\\.")}`));
  const msgs = await fetch("http://localhost:8091/json/2/mail.message/search_read", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "bearer t" }, body: JSON.stringify({ domain: [["model", "=", "sale.order"], ["res_id", "=", 1385]], fields: ["body"] }) }).then((x) => x.json());
  const note = msgs.map((x) => x.body).join(" ");
  assert.match(note, /Telefon \(Petra Lang\)/, note);
  assert.match(note, /Teillieferung angeboten/, note);
  const it = w.items.find((i) => i.source === "A01385");
  assert.match(it.odooInfo, /^In Odoo eingetragen \(Termin und Notiz\)/);
  ok("Mit Schreibfreigabe: zugesagtes Lieferdatum am Kundenauftrag geändert und Verschiebung als interne Notiz im Chatter, sonst nichts");

  // Derselbe Termin noch einmal (z. B. Bestätigung per Mail): nur die Notiz, kein zweites Schreiben des Termins
  w = await api("POST", "/api/fruehwarnung/informiert", { source: "A01385", date: proposal, channel: "beides", contact: "Petra Lang" });
  const log2 = (await fetch("http://localhost:8091/__log").then((x) => x.json())).slice(before.length + 2).map((l) => l.call);
  assert.equal(log2.length, 1, JSON.stringify(log2));
  assert.match(log2[0], /message_post/);
  assert.match(w.items.find((i) => i.source === "A01385").odooInfo, /Termin stand schon/);
  ok("Steht der Termin in Odoo schon, kommt nur die Notiz dazu");

  // Externe Fertigung bekommt den Kunden aus dem Kundenauftrag (für die Gruppierung „ein Anruf für alle“)
  const ext = (await api("GET", "/api/orders")).orders.find((o) => o.machine === "extern_fert" && o.source === "A01446");
  assert.ok(ext, "Fremdfertigung A01446 übernommen");
  assert.equal(ext.customer, "Hof Sonderanlagenbau GmbH");
  ok("Externe Fertigung: Kunde kommt aus dem Kundenauftrag (A01446 → Hof Sonderanlagenbau)");

  // Statuszeile Dienste: Odoo nach dem Abgleich ok, Talos ohne Schlüssel „nicht eingerichtet“ (gelb), kein Maschinen-Dienst ohne MASCHINEN_KEY
  const ds = await api("GET", "/api/dienste");
  assert.equal(ds.status, 200);
  const dz = Object.fromEntries(ds.dienste.map((x) => [x.id, x]));
  assert.equal(dz.odoo.stufe, "ok", JSON.stringify(dz.odoo));
  assert.equal(dz.talos.stufe, "warn");
  assert.match(dz.talos.grund, /nicht eingerichtet/);
  assert.ok(!dz.maschinen);
  assert.equal(ds.alleOk, false);
  ok("Statuszeile: Odoo läuft, Talos ohne Schlüssel als „nicht eingerichtet“ gemeldet, ohne Maschinen-Dienst keine Zeile");

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
