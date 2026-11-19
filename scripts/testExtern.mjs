// Prüft Extern & Wareneingang: überfällige Wareneingänge, Lieferant anfragen (Mail-Entwurf deutsch/englisch), angefragt abhaken,
// neuer Termin gilt in der Planung (auch nach dem nächsten Odoo-Abgleich), externer Arbeitsgang ohne Bestellung, Lieferanten-Bewertung,
// Altlasten, "Heute zu tun" und das Talos-Werkzeug. Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testExtern.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const SECRET = "x".repeat(30);
const dir = mkdtempSync(path.join(tmpdir(), "extern-"));
const env = {
  ...process.env,
  MOCK_ENTWURF: "1",
  MOCK_EXTERN: "1",
  MOCK_CODES: "1",
  MOCK_PORT: "8096",
  PORT: "3081",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8096",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8096",
  BDE_ODOO_API_KEY: "test",
  BDE_SECRET: "testgeheimnis",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  FREIGABEN_AUTO: "0",
  EXTERN_AUTO: "0",
  TALOS_PLAN_SECRET: SECRET,
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3081${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ...j, status: r.status };
};
const odooLog = () => fetch("http://localhost:8096/__log").then((x) => x.json());
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3081/api/orders"), fetch("http://localhost:8096/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Extern & Wareneingang (Test-Odoo)");
  assert.equal((await api("POST", "/api/odoo/sync", { dryRun: false })).status, 200);
  const logBefore = (await odooLog()).length;
  let d = await api("GET", "/api/extern?neu=1");
  assert.equal(d.status, 200, JSON.stringify(d));
  const po = (name) => d.offen.find((x) => x.po === name);

  // 1. Überfällig: AV CNC Milling, Lieferant anfragen, englisch (Rumänien), offene Mengen
  const av = po("P00581");
  assert.ok(av, JSON.stringify(d.offen.map((x) => x.po)));
  assert.equal(av.status, "ueberfaellig");
  assert.equal(av.aktion, "anfragen");
  assert.equal(av.art, "Fremdfertigung");
  assert.equal(av.lang, "en");
  assert.deepEqual(av.wareneingang, ["WH/IN/00437"]);
  let m = await api("GET", "/api/extern/P00581/mail");
  assert.equal(m.to, "office@avcnc.example");
  assert.match(m.subject, /P00581 \/ B-000003/);
  assert.match(m.body, /48 x \[05842\.100-123\] Auflagepad/);
  assert.match(m.body, /8 x \[05842\.100-519\] Greifbacke/, "offen = bestellt minus eingegangen");
  assert.match(m.mailto, /^mailto:office%40avcnc\.example\?subject=/);
  m = await api("GET", "/api/extern/P00581/mail?lang=de");
  assert.match(m.body, /zu unserer Bestellung P00581 \(Ihre Referenz B-000003\)/);
  ok("Überfälliger Wareneingang: Lieferant anfragen, Mail mit offenen Mengen, englisch für Ausland, deutsch wählbar");

  // 2. Material für FA01322 überfällig: Kundentermin in Gefahr, Ansprechpartner der Firma, Heute zu tun
  const telle = po("P00601");
  assert.equal(telle.art, "Material");
  assert.deepEqual(telle.betroffen.map((b) => b.ref), ["FA01322"]);
  assert.equal(telle.kundeGefahr, true);
  assert.equal(telle.email, "info@telle.example", "Mail der Firma, wenn der Ansprechpartner keine hat");
  m = await api("GET", "/api/extern/P00601/mail");
  assert.match(m.body, /^Guten Tag Jörg Mühlbauer,/);
  const heute = await api("GET", "/api/heute");
  const li = heute.items.find((i) => i.id === "lieferant");
  assert.ok(li && li.n >= 2 && li.ziel === "extern" && li.tone === "bad", JSON.stringify(heute.items));
  ok("Material überfällig: hängender FA und Kundentermin in Gefahr, Ansprechpartner, „Heute zu tun“ springt zu Extern");

  // 3. Angefragt abhaken, neuer Termin gilt in der Planung, auch nach dem nächsten Odoo-Abgleich
  assert.equal((await api("POST", "/api/extern/P00601/angefragt", { weg: "telefon", von: "Frank", notiz: "Herr Mühlbauer ruft zurück" })).status, 200);
  d = await api("GET", "/api/extern");
  assert.equal(po("P00601").aktion, "warten");
  assert.equal(po("P00601").angefragtVon, "Frank");
  const neu = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  let r = await api("POST", "/api/extern/P00601/termin", { termin: neu, von: "Frank" });
  assert.equal(r.status, 200, JSON.stringify(r));
  let orders = (await api("GET", "/api/orders")).orders;
  assert.equal(orders.find((o) => o.odoo_ref === "FA01322").material_date, neu);
  await api("POST", "/api/odoo/sync", { dryRun: false });
  orders = (await api("GET", "/api/orders")).orders;
  const fa = orders.find((o) => o.odoo_ref === "FA01322");
  assert.equal(fa.material_date, neu, "Der Abgleich übernimmt den Termin des Lieferanten, nicht den alten aus Odoo");
  assert.match(fa.material_info, /neuer Termin .*vom Lieferanten/);
  d = await api("GET", "/api/extern");
  assert.equal(po("P00601").termin, neu);
  assert.equal(po("P00601").aktion, null);
  assert.ok(po("P00601").verlauf.some((v) => /angefragt telefonisch/.test(v.was)) && po("P00601").verlauf.some((v) => /neuer Termin/.test(v.was)));
  ok("Angefragt per Telefon abgehakt, neuer Termin rechnet Planung neu und bleibt auch nach dem Odoo-Abgleich");

  // 4. Externer Arbeitsgang ohne Bestellung: FA01122 Strahlen (die Material-Anfrage zum FA zählt nicht); dringend, wenn die Maschine bald fertig ist
  let f = d.fehlt.find((x) => x.fa === "FA01122");
  assert.ok(f, JSON.stringify(d.fehlt));
  assert.equal(f.schritt, "Strahlen extern");
  assert.equal(f.anfrage, null);
  assert.equal(f.dringend, false, "nicht eingeplant = noch nicht dringend");
  // Material als da melden (startklar)
  await api("PUT", "/api/av", { order_id: orders.find((o) => o.odoo_ref === "FA01122").id, item: "material", status: "bereit" });
  await api("PUT", `/api/orders/${orders.find((o) => o.odoo_ref === "FA01122").id}`, { machine: "dmu40", hours: 4 });
  d = await api("GET", "/api/extern?neu=1");
  f = d.fehlt.find((x) => x.fa === "FA01122");
  assert.equal(f.dringend, true, JSON.stringify(f));
  const h2 = await api("GET", "/api/heute");
  assert.ok(h2.items.some((i) => i.id === "bestellungFehlt" && i.n === 1), JSON.stringify(h2.items));
  ok("Externer Arbeitsgang ohne passende Bestellung wird gemeldet, dringend sobald die Maschine in 7 Tagen fertig ist");

  // 5. Lieferanten-Bewertung und Altlasten
  const b = d.bewertung.find((x) => x.lieferant === "AV CNC MILLING S.R.L.");
  assert.equal(b.eingaenge, 2);
  assert.equal(b.quote, 50);
  assert.equal(b.spaetSchnitt, 3);
  assert.equal(b.ueberfaellig, 1);
  assert.deepEqual(d.altlasten.map((a) => a.ref).sort(), ["P00557", "WH/IN/00296"]);
  ok("Termintreue je Lieferant aus validierten Wareneingängen, Altlasten zum Aufräumen");

  // 6. Talos: extern_offen; die App hat in Odoo nichts geschrieben
  const tc = await fetch(`http://localhost:3081/mcp/${SECRET}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "extern_offen", arguments: { lieferant: "av cnc" } } }) }).then((x) => x.json());
  const t = JSON.parse(tc.result.content[0].text);
  assert.deepEqual(t.offen.map((x) => x.bestellung), ["P00581"]);
  assert.match(t.offen[0].status, /Tage überfällig/);
  const writes = (await odooLog()).slice(logBefore).filter((l) => /\.(write|create|unlink|button_|action_|message_post)/.test(l.call));
  assert.deepEqual(writes, [], "Extern ändert in Odoo nichts");
  ok("Talos liest offene Bestellungen je Lieferant; in Odoo wurde nichts geändert");

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
