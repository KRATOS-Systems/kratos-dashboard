// Prüft: Programme aus dem Auftragsordner im AV-Paket (eigenes Programm -> bereit, Altprogramm -> Hinweis), Soll/Ist lernen
// (Korrekturfaktor für Stunden aus der Kalkulation) und den Autopilot (nur Leitung, nur wenn sicher genug, nie mit Warnung).
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs) und eine nachgebaute Kalkulation, nie gegen die echten Systeme.
// Start: node scripts/testLernen.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const KEY = "k".repeat(40);
const PKEY = "p".repeat(30);
const dir = mkdtempSync(path.join(tmpdir(), "lernen-"));
const env = {
  ...process.env,
  MOCK_ENTWURF: "1",
  MOCK_CODES: "1",
  MOCK_PORT: "8101",
  PORT: "3084",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8101",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8101",
  BDE_ODOO_API_KEY: "test",
  BDE_SECRET: "testgeheimnis",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  KALKULATION_URL: "http://localhost:8102",
  KALKULATION_API_KEY: KEY,
  PROGRAMME_KEY: PKEY,
  FREIGABEN_AUTO: "0",
  EXTERN_AUTO: "0",
  SOLLIST_AUTO: "0",
  ABWESENHEIT_AUTO: "0",
};
// Kalkulation: 89058665 kalkuliert (4 h für 60 Stk auf der M1)
const kalk = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, d) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(d));
  if (u.pathname === "/api/ext/products") return send(200, { products: u.searchParams.get("q") === "89058665" ? [{ id: 2903, code: "89058665", partId: 501 }] : [] });
  if (u.pathname === "/api/ext/parts/501") return send(200, { part: { partId: 501, material: "EN AW-6082", machine: "DMG M1", timeBasis: "Merkmal-Modell", times: { programmingMin: 30, setupMin: 60, machiningMinPerPiece: 3 } } });
  send(404, {});
});
await new Promise((r) => kalk.listen(8102, r));
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = {};
const api = async (who, m, u, b, headers = {}) => {
  const r = await fetch(`http://localhost:3084${u}`, { method: m, headers: { "Content-Type": "application/json", ...headers, ...(jar[who] ? { cookie: jar[who] } : {}) }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) jar[who] = set.split(";")[0];
  const j = await r.json().catch(() => ({}));
  return { ...j, status: r.status };
};
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3084/api/orders"), fetch("http://localhost:8101/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Lernen: Programme, Soll/Ist, Autopilot (Test-Odoo)");
  await api("x", "POST", "/api/odoo/sync", { dryRun: false });
  let orders = (await api("x", "GET", "/api/orders")).orders;
  const row = (ref) => orders.find((o) => o.odoo_ref === ref);
  assert.equal((await api("frank", "POST", "/api/bde/login", { id: 3, pin: "3333" })).status, 200);
  assert.equal((await api("aurel", "POST", "/api/bde/login", { id: 2, pin: "2222" })).status, 200);

  // 1. Programme melden: ohne Schlüssel nicht; FA01334 hat ein eigenes Programm, FA01309 ein Altprogramm
  const meldung = {
    meldungen: [
      { fa: "FA01334", code: "042-69-017", auftrag: "A01444", eigene: [{ datei: "042-69-017_S1.mcam", pfad: "K:\\5_Projekte\\5.1_AUFTRÄGE\\2026\\Schneider\\A01444\\Programmierung\\042-69-017\\042-69-017_S1.mcam", stand: "2026-11-16" }], alt: [] },
      { fa: "FA01309", code: "SK966-114100.005.0", auftrag: "A01385", eigene: [], alt: [{ auftrag: "A01100", ordner: "K:\\…\\A01100", dateien: ["SK966-114100.005.0.mcam"], stand: "2026-03-02" }] },
    ],
  };
  assert.equal((await api("x", "POST", "/api/programme/meldung", meldung)).status, 401);
  let r = await api("x", "POST", "/api/programme/meldung", meldung, { Authorization: `Bearer ${PKEY}` });
  assert.equal(r.gespeichert, 2, JSON.stringify(r));
  await api("x", "POST", "/api/freigaben/vorbereiten", {});
  let list = (await api("x", "GET", "/api/freigaben")).items;
  const pk = (ref) => list.find((f) => f.art === "av" && f.bezug === ref);
  assert.match(pk("FA01334").daten.notes.programm, /Programm im Auftragsordner: 042-69-017_S1\.mcam \(Stand 16\.11\.2026\)/);
  assert.equal(pk("FA01334").daten.status.programm, "bereit");
  assert.match(pk("FA01309").daten.notes.programm, /Altprogramm aus A01100 .*Zeichnungsindex prüfen/);
  assert.ok(!pk("FA01309").daten.status.programm, "Altprogramm setzt nichts auf bereit");
  r = await api("frank", "POST", `/api/freigaben/${pk("FA01334").id}`, { aktion: "freigeben" });
  assert.match(r.ergebnis, /Programm auf bereit/, JSON.stringify(r));
  const checks = (await api("x", "GET", "/api/av")).checks;
  const prog = checks.find((c) => c.order_id === row("FA01334").id && c.item === "programm");
  assert.equal(prog.status, "bereit");
  assert.match(prog.note, /Programm im Auftragsordner/);
  ok("Programme aus dem Auftragsordner: eigenes Programm -> „Programm: bereit“ mit Datei, Altprogramm nur als Hinweis; Meldung nur mit Schlüssel");

  // 2. Soll/Ist: fünf erledigte Positionen, die mit Kalkulationsstunden geplant waren (4 h) und 5 h gestempelt haben (FA01050)
  const d = new DatabaseSync(env.DB_PATH);
  const ins = d.prepare("INSERT INTO orders (machine, order_no, position, odoo_ref, odoo_id, hours, hours_plan, hours_basis, done, done_date, extern_days) VALUES ('dmu40', ?, 0, ?, 1050, 4, 4, 'kalkulation', 1, date('now'), 7)");
  for (let i = 0; i < 5; i++) ins.run(`FA01050-${i}`, `FA01050-${i}`);
  d.close();
  const si = await api("x", "GET", "/api/soll-ist?neu=1");
  const k = si.stats.find((x) => x.basis === "kalkulation" && x.machine === null);
  assert.equal(k.n, 5, JSON.stringify(si));
  assert.equal(k.faktor, 1.25, "300 min gestempelt gegen 4 h geplant");
  assert.equal(k.genau, 0);
  // AV-Paket mit Kalkulationsstunden wird korrigiert: 4 h -> 5 h
  await api("x", "POST", "/api/freigaben/vorbereiten", {});
  list = (await api("x", "GET", "/api/freigaben")).items;
  const p1 = pk("FA01322");
  assert.equal(p1.daten.hours, 5, JSON.stringify(p1.daten));
  assert.match(p1.daten.hoursSrc, /korrigiert 4 → 5 h, weil die Kalkulation .*bei 5 erledigten Aufträgen im Mittel 25 % zu niedrig lag/);
  r = await api("frank", "POST", `/api/freigaben/${p1.id}`, { aktion: "freigeben" });
  orders = (await api("x", "GET", "/api/orders")).orders;
  assert.equal(row("FA01322").hours, 5);
  ok("Soll/Ist: gestempelt gegen geplant je Quelle; Kalkulationsstunden werden nach 5 Vergleichen um den gelernten Faktor korrigiert");

  // 3. Autopilot: erst nach genug menschlichen Entscheidungen, nur Leitung; danach gibt die App die Art selbst frei
  let ap = await api("x", "GET", "/api/autopilot");
  assert.equal(ap.kategorien.find((x) => x.id === "av_historie").moeglich, false);
  assert.equal((await api("frank", "POST", "/api/autopilot", { kategorie: "av_historie", an: true })).status, 409);
  const d2 = new DatabaseSync(env.DB_PATH);
  const f = d2.prepare("INSERT INTO freigaben (art, schluessel, bezug, titel, text, daten, quelle, status, erstellt, entschieden, von) VALUES ('av', ?, 'FA0', 'AV-Paket alt', '', ?, 'App', ?, datetime('now'), datetime('now'), 'Frank Häckl')");
  for (let i = 0; i < 10; i++) f.run(`alt:${i}`, JSON.stringify({ kategorie: "av_historie" }), "freigegeben");
  d2.close();
  ap = await api("x", "GET", "/api/autopilot");
  assert.equal(ap.kategorien.find((x) => x.id === "av_historie").moeglich, true, JSON.stringify(ap));
  assert.equal((await api("aurel", "POST", "/api/autopilot", { kategorie: "av_historie", an: true })).status, 403);
  assert.equal((await api("frank", "POST", "/api/autopilot", { kategorie: "av_historie", an: true })).status, 200);
  await api("x", "POST", "/api/freigaben/vorbereiten", {});
  const all = (await api("x", "GET", "/api/freigaben?status=alle")).items;
  const auto = all.find((x) => x.bezug === "FA01122" && x.art === "av");
  assert.ok(auto, JSON.stringify(all.map((x) => x.bezug)));
  assert.equal(auto.daten.kategorie, "av_historie");
  assert.equal(auto.status, "freigegeben");
  assert.equal(auto.von, "Autopilot");
  orders = (await api("x", "GET", "/api/orders")).orders;
  assert.ok(row("FA01122").hours > 0, "Stunden aus früheren Aufträgen automatisch eingetragen");
  // Pakete mit Warnung oder anderer Art bleiben offen
  assert.ok(all.filter((x) => x.status === "offen" && x.art === "av").every((x) => x.daten.kategorie !== "av_historie" || (x.daten.warnungen || []).length));
  ok("Autopilot: einschalten erst nach 10 Entscheidungen mit ≥ 90 %, nur die Leitung; dann gibt die App diese Art selbst frei (Verlauf „Autopilot“)");

  console.log(`Alle ${n} Prüfungen bestanden.`);
} catch (err) {
  console.error("FEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  kalk.close();
  await wait(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
