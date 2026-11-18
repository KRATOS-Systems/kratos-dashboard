// Prüft "Planen im Chat": eigener Schlüssel mit Schreib-Werkzeugen, Talos-Schlüssel ohne; ohne bestaetigt nur Vorschau, mit bestaetigt
// wird geändert (Position verschieben, Stunden, Liefertermin mit Verlauf, Freigabe entscheiden, Lieferant angefragt / neuer Termin).
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testChatPlan.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const TALOS = "t".repeat(30);
const CHAT = "c".repeat(30);
const dir = mkdtempSync(path.join(tmpdir(), "chatplan-"));
const env = {
  ...process.env,
  MOCK_ENTWURF: "1",
  MOCK_EXTERN: "1",
  MOCK_CODES: "1",
  MOCK_PORT: "8097",
  PORT: "3082",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8097",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8097",
  BDE_ODOO_API_KEY: "test",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  FREIGABEN_AUTO: "0",
  EXTERN_AUTO: "0",
  TALOS_PLAN_SECRET: TALOS,
  PLAN_CHAT_SECRET: CHAT,
  PLAN_CHAT_NAME: "Chat (Alexander)",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3082${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ...j, status: r.status };
};
let rpc = 0;
const mcp = async (secret, method, params) => {
  const r = await fetch(`http://localhost:3082/mcp/${secret}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }) });
  return r.status === 404 ? { status: 404 } : r.json();
};
const call = async (name, args, secret = CHAT) => {
  const r = await mcp(secret, "tools/call", { name, arguments: args });
  if (r.error) return { fehler: r.error.message };
  const text = r.result.content[0].text;
  return r.result.isError ? { fehler: text } : JSON.parse(text);
};
const orders = async () => (await api("GET", "/api/orders")).orders;
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3082/api/orders"), fetch("http://localhost:8097/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Planen im Chat (Test-Odoo)");
  await api("POST", "/api/odoo/sync", { dryRun: false });
  await api("GET", "/api/extern?neu=1");

  // 1. Schlüssel: Talos ohne Schreib-Werkzeuge, Chat mit; unbekannter Schlüssel = 404
  const t = (await mcp(TALOS, "tools/list", {})).result.tools.map((x) => x.name);
  const c = (await mcp(CHAT, "tools/list", {})).result.tools;
  assert.ok(!t.includes("position_verschieben") && !t.includes("freigabe_entscheiden"), t.join(","));
  for (const w of ["position_verschieben", "stunden_setzen", "liefertermin_setzen", "position_fixieren", "freigabe_entscheiden", "lieferant_status_setzen"]) {
    const tool = c.find((x) => x.name === w);
    assert.ok(tool, w);
    assert.equal(tool.annotations.readOnlyHint, false, w);
  }
  assert.ok((await call("position_verschieben", { position: "FA01322", maschine: "DMU 50", platz: 1 }, TALOS)).fehler);
  assert.equal((await mcp("z".repeat(30), "tools/list", {})).status, 404);
  const init = await mcp(CHAT, "initialize", {});
  assert.match(init.result.instructions, /erst nach seinem ausdrücklichen Ja/);
  ok("Nur der Chat-Schlüssel darf ändern; Talos liest und schlägt vor; fremder Schlüssel wird abgewiesen");

  // 2. Stunden setzen: Vorschau ändert nichts, bestaetigt ändert
  let r = await call("stunden_setzen", { position: "FA01322", stunden: 4 });
  assert.equal(r.vorschau, true);
  assert.equal(r.stunden_neu, 4);
  let o = (await orders()).find((x) => x.odoo_ref === "FA01322");
  assert.ok(!(o.hours > 0), "Vorschau ändert nichts");
  r = await call("stunden_setzen", { position: "FA01322", stunden: 4, bestaetigt: true });
  assert.equal(r.geaendert, true);
  o = (await orders()).find((x) => x.odoo_ref === "FA01322");
  assert.equal(o.hours, 4);
  ok("Stunden: erst Vorschau ohne Änderung, mit Bestätigung gespeichert");

  // 3. Position verschieben: Vorschau mit Folgen, dann auf DMU 50 Platz 1
  r = await call("position_verschieben", { position: "FA01322", maschine: "DMU 50", platz: 1 });
  assert.equal(r.vorschau, true);
  assert.ok("zu_spaet_nachher" in r, JSON.stringify(r));
  assert.equal((await orders()).find((x) => x.odoo_ref === "FA01322").machine, "");
  r = await call("position_verschieben", { position: "FA01322", maschine: "DMU 50", platz: 1, bestaetigt: true });
  assert.equal(r.geaendert, true, JSON.stringify(r));
  o = (await orders()).find((x) => x.odoo_ref === "FA01322");
  assert.equal(o.machine, "dmu50");
  assert.equal(o.position, 0);
  r = await call("position_verschieben", { position: "FA01322", maschine: "M1", platz: 1 });
  assert.ok(r.warnungen && r.warnungen.some((w) => /eingeschränkte Maschine/.test(w)), JSON.stringify(r));
  ok("Verschieben: Vorschau nennt Folgen und warnt bei der M1, mit Bestätigung wie beim Ziehen gespeichert");

  // 4. Liefertermin mit Verlauf und Grund
  r = await call("liefertermin_setzen", { auftrag: "A01422", termin: "2026-12-04", grund: "Material kommt später", bestaetigt: true });
  assert.equal(r.geaendert, true, JSON.stringify(r));
  o = (await orders()).find((x) => x.odoo_ref === "FA01322");
  assert.equal(o.due, "2026-12-04");
  assert.equal(o.due_original, "2026-11-05");
  const hist = await api("GET", `/api/orders/${o.id}/due-history`);
  const h = JSON.stringify(hist);
  assert.ok(/Chat \(Alexander\)/.test(h) && /Material kommt später/.test(h), h);
  ok("Liefertermin aus dem Chat: ursprünglicher Termin bleibt, Verlauf mit Name und Grund");

  // 5. Freigabe entscheiden aus dem Chat
  await call("freigaben_vorbereiten", {});
  const offen = await call("freigaben_offen", { art: "av" });
  const paket = offen.freigaben.find((f) => f.bezug === "FA01309");
  assert.ok(paket, JSON.stringify(offen));
  r = await call("freigabe_entscheiden", { id: paket.id, aktion: "ablehnen", notiz: "Zeit selbst schätzen" });
  assert.equal(r.vorschau, true);
  r = await call("freigabe_entscheiden", { id: paket.id, aktion: "ablehnen", notiz: "Zeit selbst schätzen", bestaetigt: true });
  assert.equal(r.status, "abgelehnt");
  const all = (await api("GET", "/api/freigaben?status=alle")).items.find((f) => f.id === paket.id);
  assert.equal(all.von, "Chat (Alexander)");
  ok("Freigabe aus dem Chat entschieden, im Verlauf als „Chat (Alexander)“");

  // 6. Lieferant: Mail-Entwurf, angefragt und neuer Termin
  r = await call("lieferant_mail_entwurf", { bestellung: "p00581" });
  assert.match(r.subject, /Delivery date/);
  r = await call("lieferant_status_setzen", { bestellung: "P00581", angefragt: "telefon", neuer_termin: "2026-11-27", notiz: "Teillieferung möglich" });
  assert.equal(r.vorschau, true);
  r = await call("lieferant_status_setzen", { bestellung: "P00581", angefragt: "telefon", neuer_termin: "2026-11-27", notiz: "Teillieferung möglich", bestaetigt: true });
  assert.equal(r.geaendert, true, JSON.stringify(r));
  const ex = (await api("GET", "/api/extern")).offen.find((x) => x.po === "P00581");
  assert.equal(ex.neuerTermin, "2026-11-27");
  assert.equal(ex.angefragtVon, "Chat (Alexander)");
  ok("Lieferant aus dem Chat: Mail-Entwurf (nicht gesendet), angefragt und neuer Termin mit Verlauf");

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
