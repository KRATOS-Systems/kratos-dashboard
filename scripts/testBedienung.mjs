// Prüft die Bedien-Umbauten auf dem Server: Planvorschlag trennt "einplanen" und "umstellen" (schon zu späte Positionen
// werden genannt, nicht dem Vorschlag angelastet), Datenqualität als Arbeitsliste, Extern "angefragt" lässt sich zurücknehmen.
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testBedienung.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "bedienung-"));
const env = {
  ...process.env,
  MOCK_ENTWURF: "1",
  MOCK_EXTERN: "1",
  MOCK_CODES: "1",
  MOCK_PORT: "8107",
  PORT: "3086",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8107",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8107",
  BDE_ODOO_API_KEY: "test",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  FREIGABEN_AUTO: "0",
  EXTERN_AUTO: "0",
  SOLLIST_AUTO: "0",
  ABWESENHEIT_AUTO: "0",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3086${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ...j, status: r.status };
};
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3086/api/orders"), fetch("http://localhost:8107/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Bedienung: Planvorschlag ehrlich, Datenqualität, Extern rückgängig (Test-Odoo)");
  await api("POST", "/api/odoo/sync", { dryRun: false });
  let orders = (await api("GET", "/api/orders")).orders;
  const row = (ref) => orders.find((o) => o.odoo_ref === ref);
  // FA01122 (Liefertermin Mai, längst vorbei) und FA01334 bekommen Stunden: beide werden neu eingeplant
  await api("PUT", `/api/orders/${row("FA01122").id}`, { hours: 6 });
  await api("PUT", `/api/orders/${row("FA01334").id}`, { hours: 4 });

  // 1. Planvorschlag: neu eingeplante, schon zu späte Positionen stehen getrennt; Text belastet das Umstellen nicht damit
  await api("POST", "/api/freigaben/vorbereiten", {});
  const plan = (await api("GET", "/api/freigaben")).items.find((f) => f.art === "plan");
  const p = plan.daten;
  assert.ok(p.einplanen.some((e) => e.ref === "FA01122"), JSON.stringify(p.einplanen));
  assert.ok(p.schonSpaet.some((x) => x.ref === "FA01122"), JSON.stringify(p.schonSpaet));
  assert.ok(p.nachEinplanen && typeof p.nachEinplanen.tage === "number");
  assert.ok(p.geaendertIds.includes(row("FA01122").id));
  assert.match(plan.text, /neu einplanen/);
  assert.match(plan.text, /Schon zu spät \(waren bisher nur nicht eingeplant\): A01162/);
  assert.doesNotMatch(plan.text, /Verspätete Aufträge: \d+ → \d+/, "keine irreführende Vorher/Nachher-Zeile mehr");
  assert.equal(p.kategorie, null, "mit schon zu späten Positionen kein Autopilot");
  ok("Planvorschlag: „neu eingeplant, davon schon zu spät“ getrennt vom Umstellen; Positionen für die Vorschau im Zeitstrahl");

  // 2. Datenqualität: Gruppen mit Zahlen und Einträgen
  const dq = await api("GET", "/api/datenqualitaet");
  assert.equal(dq.status, 200, JSON.stringify(dq));
  const g = (id) => dq.gruppen.find((x) => x.id === id);
  for (const id of ["stueckliste", "zeichnung", "kalkulation", "stunden", "schliessen", "einkauf", "stempel"]) assert.ok(g(id), id);
  assert.ok(g("stunden").items.some((x) => x.ref === "FA01309"), JSON.stringify(g("stunden")));
  assert.deepEqual(g("einkauf").items.map((x) => x.ref).sort(), ["P00557", "WH/IN/00296"]);
  assert.equal(dq.gesamt, dq.gruppen.reduce((s, x) => s + x.n, 0));
  ok("Datenqualität: Arbeitsliste nach Art (Stückliste, Zeichnung, Kalkulation, Stunden, Schließen, Einkauf, Stempel)");

  // 3. Extern: angefragt (z. B. beim Öffnen der Mail) lässt sich zurücknehmen
  await api("GET", "/api/extern?neu=1");
  assert.equal((await api("POST", "/api/extern/P00581/angefragt", { weg: "mail", von: "Frank" })).status, 200);
  let ex = (await api("GET", "/api/extern")).offen.find((x) => x.po === "P00581");
  assert.equal(ex.aktion, "warten");
  assert.equal((await api("POST", "/api/extern/P00581/rueckgaengig", {})).status, 200);
  ex = (await api("GET", "/api/extern")).offen.find((x) => x.po === "P00581");
  assert.equal(ex.angefragt, null);
  assert.equal(ex.aktion, "anfragen");
  assert.equal((await api("POST", "/api/extern/P00581/rueckgaengig", {})).status, 409, "zweimal geht nicht");
  ok("Extern: „angefragt per Mail“ beim Öffnen lässt sich zurücknehmen, danach wieder „Lieferant anfragen“");

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
