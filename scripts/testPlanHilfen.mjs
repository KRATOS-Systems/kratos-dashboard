// Prüft die Planungshilfen: Liefertermin für eine Anfrage (hinten anstellen / vorziehen), Feiertage und Abwesenheiten aus Odoo
// (ohne Grund), Morgenbericht als Nachricht (Webhook, nur Leitung von Hand). Läuft gegen das Test-Odoo, nie gegen die echte Instanz.
// Start: node scripts/testPlanHilfen.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const SECRET = "h".repeat(30);
const dir = mkdtempSync(path.join(tmpdir(), "planhilfen-"));
const hook = [];
const hookServer = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    hook.push({ auth: req.headers.authorization, body: JSON.parse(b || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
});
await new Promise((r) => hookServer.listen(8099, r));
const env = {
  ...process.env,
  MOCK_ENTWURF: "1",
  MOCK_EXTERN: "1",
  MOCK_ABWESEND: "1",
  MOCK_PORT: "8098",
  PORT: "3083",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8098",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8098",
  BDE_ODOO_API_KEY: "test",
  BDE_SECRET: "testgeheimnis",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  FREIGABEN_AUTO: "0",
  EXTERN_AUTO: "0",
  ABWESENHEIT_AUTO: "0",
  MORGENBERICHT_AUTO: "0",
  MORGENBERICHT_WEBHOOK: "http://localhost:8099/morgen",
  MORGENBERICHT_AN: "frank@kratos.example",
  MORGENBERICHT_KEY: "geheim-fuer-n8n",
  TALOS_PLAN_SECRET: SECRET,
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = {};
const api = async (who, m, u, b) => {
  const r = await fetch(`http://localhost:3083${u}`, { method: m, headers: { "Content-Type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}) }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) jar[who] = set.split(";")[0];
  const j = await r.json().catch(() => ({}));
  return { ...j, status: r.status };
};
const berlin = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3083/api/orders"), fetch("http://localhost:8098/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Planungshilfen: Liefertermin für Anfragen, Abwesenheit, Morgenbericht (Test-Odoo)");
  await api("x", "POST", "/api/odoo/sync", { dryRun: false });
  const orders = (await api("x", "GET", "/api/orders")).orders;
  // Belegung: zwei Positionen mit Stunden auf der EVO
  await api("x", "PUT", `/api/orders/${orders.find((o) => o.odoo_ref === "FA01322").id}`, { machine: "dmu40", hours: 30 });
  await api("x", "PUT", `/api/orders/${orders.find((o) => o.odoo_ref === "FA01309").id}`, { machine: "dmu40", hours: 20 });

  // 1. Liefertermin: EVO hinten anstellen später als eine freie Maschine; Extern und QS verlängern
  let r = await api("x", "POST", "/api/liefertermin", { stunden: 8 });
  assert.equal(r.status, 200, JSON.stringify(r));
  const evo = r.maschinen.find((m) => m.id === "dmu40");
  const free = r.maschinen.find((m) => m.id === "dmu50");
  assert.ok(evo && free, JSON.stringify(r.maschinen));
  assert.ok(evo.hinten.maschineFertig > free.hinten.maschineFertig, "die belegte Maschine ist später fertig");
  assert.ok(!r.maschinen.some((m) => m.id === "m1"), "M1 nur, wenn das Teil dort geht");
  assert.ok(r.empfehlung.liefertermin > r.heute);
  const r2 = await api("x", "POST", "/api/liefertermin", { stunden: 8, extern_tage: 7, maschine: "dmu50" });
  assert.ok(r2.maschinen[0].hinten.liefertermin > free.hinten.liefertermin, "Extern verlängert");
  assert.equal((await api("x", "POST", "/api/liefertermin", {})).status, 400);
  const tc = await fetch(`http://localhost:3083/mcp/${SECRET}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "liefertermin_schaetzen", arguments: { stunden: 8 } } }) }).then((x) => x.json());
  assert.ok(JSON.parse(tc.result.content[0].text).empfehlung, JSON.stringify(tc));
  ok("Liefertermin für eine Anfrage aus der echten Belegung; extern verlängert, M1 nur wenn erlaubt; Talos kann es auch");

  // 2. Betriebsruhe aus Odoo kommt in die freien Tage (nicht Sonntag), gelöscht bleibt gelöscht; Abwesenheit ohne Grund
  let a = await api("x", "GET", "/api/abwesenheit?neu=1");
  assert.equal(a.status, 200, JSON.stringify(a));
  // wie das Test-Odoo: Betriebsruhe von utc(7) 23:00 bis utc(9) 22:59 UTC, also deutsche Tage utc(8) und utc(9)
  const utc = (k) => new Date(Date.now() + k * 86400000).toISOString().slice(0, 10);
  const toBerlin = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const first = toBerlin(utc(7) + "T23:00:00Z");
  const last = toBerlin(utc(9) + "T22:59:00Z");
  const want = [first, last].filter((d, i, l) => l.indexOf(d) === i).filter((d) => new Date(d + "T00:00:00Z").getUTCDay() !== 0 && d > berlin(0));
  let days = (await api("x", "GET", "/api/free-days")).days;
  const freeDates = (days || []).map((d) => d.date);
  for (const d of want) assert.ok(freeDates.includes(d), `${d} fehlt: ${JSON.stringify(freeDates)}`);
  assert.equal((await api("x", "DELETE", `/api/free-days/${want[0]}`)).status, 200);
  await api("x", "GET", "/api/abwesenheit?neu=1");
  days = (await api("x", "GET", "/api/free-days")).days;
  assert.ok(!(days || []).some((d) => d.date === want[0]), "Gelöschter Tag kommt nicht zurück");
  assert.deepEqual(a.abwesend.map((x) => x.name), ["Aurel Rama", "Nino Posset"]);
  assert.ok(!JSON.stringify(a).includes("Krankheit"), "Grund der Abwesenheit wird nicht gezeigt");
  assert.equal(a.abwesend[1].beantragt, true);
  ok("Betriebsruhe aus Odoo in die freien Tage (einmal, gelöscht bleibt gelöscht); Abwesenheiten ohne Grund");

  // 3. Morgenbericht: lesbar; von Hand senden nur Leitung; Webhook bekommt Betreff, Empfänger, Text
  const mb = await api("x", "GET", "/api/morgenbericht");
  assert.equal(mb.eingerichtet, true);
  assert.match(mb.text, /^Morgenbericht Produktion/);
  assert.match(mb.text, /Heute zu tun/);
  assert.match(mb.text, /Extern & Wareneingang: .*überfällig/);
  assert.equal((await api("aurel", "POST", "/api/bde/login", { id: 2, pin: "2222" })).status, 200);
  assert.equal((await api("aurel", "POST", "/api/morgenbericht/senden")).status, 403);
  assert.equal((await api("frank", "POST", "/api/bde/login", { id: 3, pin: "3333" })).status, 200);
  r = await api("frank", "POST", "/api/morgenbericht/senden");
  assert.equal(r.gesendet, true, JSON.stringify(r));
  assert.equal(hook.length, 1);
  assert.equal(hook[0].auth, "Bearer geheim-fuer-n8n");
  assert.deepEqual(hook[0].body.an, ["frank@kratos.example"]);
  assert.match(hook[0].body.betreff, /^Morgenbericht Produktion \d\d\.\d\d\.$/);
  assert.match(hook[0].body.text, /Zur Planung: https:\/\/dashboard\.kratos-precision\.de/);
  ok("Morgenbericht: Text mit Heute zu tun und Extern, Versand über Webhook, von Hand nur durch die Leitung");

  console.log(`Alle ${n} Prüfungen bestanden.`);
} catch (err) {
  console.error("FEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  hookServer.close();
  await wait(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
