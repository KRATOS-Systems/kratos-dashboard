// Prüft "Zeichnung lesen" im AV-Paket: Talos liest die Zeichnung, das Paket gleicht Werkstoff und Oberfläche mit Arbeitsplan und
// Kalkulation ab (Warnungen), merkt sich das Ergebnis und liest nur auf Knopfdruck neu. Gegen Test-Odoo, nachgebaute Kalkulation und
// nachgebauten Talos, nie gegen die echten Systeme.
// Start: node scripts/testZeichnung.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const KEY = "k".repeat(40);
const TKEY = "t".repeat(30);
const dir = mkdtempSync(path.join(tmpdir(), "zeichnung-"));
const talosCalls = [];
const servers = [
  // Talos: FA01334 hat eine Zeichnung (Edelstahl, eloxiert), FA01309 keine
  createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const send = (code, d) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(d));
      if (req.url !== "/talos/zeichnung" || req.headers.authorization !== `Bearer ${TKEY}`) return send(401, { error: "unauthorized" });
      const { fa } = JSON.parse(b || "{}");
      talosCalls.push(fa);
      if (fa === "FA01334")
        return send(200, { fa, gefunden: true, anhang: { id: 5, name: "042-69-017_B.pdf" }, daten: { zeichnungsnummer: "042-69-017", index: "B", benennung: "Führungsschlitten", werkstoff: "1.4404", werkstoff_art: "edelstahl", oberflaeche: ["Eloxieren natur"], waermebehandlung: "", allgemeintoleranz: "ISO 2768-mK", engste_toleranz: "Ø12 ±0,01", passungen: ["Ø8 H7"], gewinde: ["M6"], rauheit: "Ra 0,8", abmessungen: "120 x 40 x 20", besonderheiten: ["Werkstoffzeugnis 3.1"], sicherheit: "hoch" } });
      return send(200, { fa, gefunden: false, grund: "Keine Zeichnung (PDF) am Artikel in Odoo" });
    });
  }),
  // Kalkulation: 042-69-017 aus Aluminium gerechnet
  createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, d) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(d));
    if (u.pathname === "/api/ext/products") return send(200, { products: u.searchParams.get("q") === "042-69-017" ? [{ id: 2905, code: "042-69-017", partId: 503 }] : [] });
    if (u.pathname === "/api/ext/parts/503") return send(200, { part: { partId: 503, material: "EN AW-7075", rawPart: "Flach 60x20x125", machine: "DMU 40 EVO", timeBasis: "Merkmal-Modell", times: { programmingMin: 60, setupMin: 45, machiningMinPerPiece: 20 } } });
    send(404, {});
  }),
];
await Promise.all([new Promise((r) => servers[0].listen(8104, r)), new Promise((r) => servers[1].listen(8105, r))]);
const env = {
  ...process.env,
  MOCK_ENTWURF: "1",
  MOCK_CODES: "1",
  MOCK_PORT: "8103",
  PORT: "3085",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8103",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8103",
  BDE_ODOO_API_KEY: "test",
  BDE_SECRET: "testgeheimnis",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  KALKULATION_URL: "http://localhost:8105",
  KALKULATION_API_KEY: KEY,
  TALOS_URL: "http://localhost:8104/talos/ask",
  TALOS_KEY_DASHBOARD: TKEY,
  FREIGABEN_AUTO: "0",
  EXTERN_AUTO: "0",
  SOLLIST_AUTO: "0",
  ABWESENHEIT_AUTO: "0",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = {};
const api = async (who, m, u, b) => {
  const r = await fetch(`http://localhost:3085${u}`, { method: m, headers: { "Content-Type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}) }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) jar[who] = set.split(";")[0];
  const j = await r.json().catch(() => ({}));
  return { ...j, status: r.status };
};
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3085/api/orders"), fetch("http://localhost:8103/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Zeichnung lesen im AV-Paket (Test-Odoo, Test-Talos, Test-Kalkulation)");
  await api("x", "POST", "/api/odoo/sync", { dryRun: false });
  await api("x", "POST", "/api/freigaben/vorbereiten", {});
  assert.ok(talosCalls.length <= 3, `höchstens 3 je Lauf, waren ${talosCalls.length}`);
  await api("x", "POST", "/api/freigaben/vorbereiten", {});
  let list = (await api("x", "GET", "/api/freigaben")).items;
  const pk = (ref) => list.find((f) => f.art === "av" && f.bezug === ref);

  // 1. Zeichnung gelesen: Werkstoff aus der Zeichnung, Warnungen aus dem Abgleich, Hinweise zu Toleranzen
  const p = pk("FA01334").daten;
  assert.equal(p.werkstoff, "1.4404");
  // Material hat schon eine Notiz aus dem Einkauf (P00620): die bleibt, der Werkstoff laut Zeichnung steht als Hinweis
  assert.ok(!p.notes.material);
  assert.ok(p.hinweise.includes("Werkstoff laut Zeichnung: 1.4404 (Index B)"), JSON.stringify(p.hinweise));
  const w = p.warnungen.join(" | ");
  assert.match(w, /Eloxieren geht nur bei Aluminium, der Werkstoff ist aber Edelstahl/);
  assert.match(w, /Zeichnung verlangt Eloxieren .*im Arbeitsplan fehlt der Schritt/);
  assert.match(w, /Werkstoff: Zeichnung 1\.4404, Kalkulation EN AW-7075/);
  assert.ok(p.hinweise.some((h) => /Ø12 ±0,01, Ø8 H7, Ra 0,8/.test(h)), JSON.stringify(p.hinweise));
  assert.ok(p.hinweise.some((h) => /Werkstoffzeugnis 3\.1/.test(h)));
  assert.equal(p.zeichnung.anhang, "042-69-017_B.pdf");
  assert.equal(p.kategorie, null, "mit Warnung nie Autopilot");
  ok("Zeichnung gelesen: Werkstoff aus der Zeichnung, Warnungen (Eloxieren/Edelstahl, Schritt fehlt, Werkstoff weicht ab), Toleranzen als Hinweis");

  // 2. Ohne Zeichnung ein Grund; gemerkt, nicht erneut gelesen; nur wenige je Lauf
  assert.match(pk("FA01309").daten.zeichnung.grund, /Keine Zeichnung/);
  const before = talosCalls.length;
  await api("x", "POST", "/api/freigaben/vorbereiten", {});
  const second = talosCalls.length - before;
  assert.ok(talosCalls.slice(before).every((fa) => !["FA01334", "FA01309"].includes(fa)), "Gelesenes wird nicht erneut gelesen: " + talosCalls.join(","));
  assert.ok(second <= 3);
  ok("Ohne Zeichnung steht der Grund im Paket; gelesene Zeichnungen werden gemerkt, je Lauf höchstens 3 neue");

  // 3. Neu lesen nur mit PIN
  list = (await api("x", "GET", "/api/freigaben")).items;
  assert.equal((await api("x", "POST", `/api/freigaben/${pk("FA01334").id}/zeichnung`)).status, 401);
  assert.equal((await api("frank", "POST", "/api/bde/login", { id: 3, pin: "3333" })).status, 200);
  const n0 = talosCalls.length;
  const r = await api("frank", "POST", `/api/freigaben/${pk("FA01334").id}/zeichnung`);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(talosCalls.length, n0 + 1);
  assert.equal(talosCalls.at(-1), "FA01334");
  ok("„Zeichnung neu lesen“ nur mit PIN-Anmeldung, liest genau diese Zeichnung erneut");

  console.log(`Alle ${n} Prüfungen bestanden.`);
} catch (err) {
  console.error("FEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  servers.forEach((s) => s.close());
  await wait(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
