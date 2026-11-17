// Prüft den KI-Planer: AV-Pakete (Stunden und Werkstoff aus der Kalkulation, Plausibilität), Freigeben/Ablehnen mit PIN,
// Kalkulation auf Knopfdruck, Morgenvorschlag (Plan freigeben, Schutz bei geänderter Planung), Fortschritt aus dem Stempeln,
// "Heute zu tun", Kennzahlen und die Talos-Werkzeuge. Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs) und eine
// nachgebaute Kalkulation, nie gegen die echten Systeme.
// Start: node scripts/testKiPlaner.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const KEY = "k".repeat(40);
const SECRET = "s".repeat(30);
const dir = mkdtempSync(path.join(tmpdir(), "kiplaner-"));
const env = {
  ...process.env,
  MOCK_ENTWURF: "1",
  MOCK_ARBEITSPLAN: "1",
  MOCK_CODES: "1",
  MOCK_PORT: "8091",
  PORT: "3076",
  DB_PATH: path.join(dir, "t.db"),
  ODOO_URL: "http://localhost:8091",
  ODOO_API_KEY: "t",
  BDE_ODOO_URL: "http://localhost:8091",
  BDE_ODOO_API_KEY: "test",
  BDE_SECRET: "testgeheimnis",
  ORDERS_SINCE: "",
  APP_PASSWORD: "",
  KALKULATION_URL: "http://localhost:8092",
  KALKULATION_API_KEY: KEY,
  TALOS_PLAN_SECRET: SECRET,
  TALOS_KEY_DASHBOARD: "",
  FREIGABEN_AUTO: "0",
};

// Nachgebaute Kalkulation: 89058665 ist kalkuliert (Edelstahl, M1), SK966-114100.005.0 kennt sie nur als Odoo-Produkt
const kalkLog = [];
const parts = {
  501: { partId: 501, link: "http://kalk/#/kalkulation/501", material: "1.4301 X5CrNi18-10", rawPart: "Flach 45x25x75", machine: "DMG M1", timeBasis: "Wiederholteil (Ist-Zeiten)", confidence: "gut (Ist-Zeiten)", reference: { type: "repeat", part: "Flach 40x20", order: "A01100" }, times: { programmingMin: 0, setupMin: 60, machiningMinPerPiece: 3 } },
  502: { partId: 502, link: "http://kalk/#/kalkulation/502", material: "EN AW-6082", rawPart: "Rund 30x40", machine: "DMU 50", timeBasis: "Merkmal-Modell", confidence: "mittel", reference: null, times: { programmingMin: 45, setupMin: 30, machiningMinPerPiece: 10 } },
};
const kalk = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    kalkLog.push(`${req.method} ${req.url} ${body}`);
    const send = (code, data) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "Ungültiger Schlüssel" });
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/ext/products") {
      const q = u.searchParams.get("q");
      if (q === "89058665") return send(200, { products: [{ id: 2903, code: "89058665", name: "Flach 40x20, 70lg.", partId: 501 }] });
      if (q === "SK966-114100.005.0") return send(200, { products: [{ id: 2904, code: "SK966-114100.005.0", name: "Bundbuchse", partId: null }] });
      return send(200, { products: [] });
    }
    const m = /^\/api\/ext\/parts\/(\d+)$/.exec(u.pathname);
    if (m && parts[m[1]]) return send(200, { part: parts[m[1]] });
    if (u.pathname === "/api/ext/calculate" && req.method === "POST") {
      const b = JSON.parse(body || "{}");
      if (b.product === 2904) return send(200, { part: { ...parts[502], newlyImported: true } });
      return send(404, { error: "Kein Bauteil" });
    }
    send(404, { error: "Unbekannt" });
  });
});
await new Promise((r) => kalk.listen(8092, r));

const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: process.env.ZEIGEN ? "inherit" : "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = {};
const api = async (who, m, u, b) => {
  const r = await fetch(`http://localhost:3076${u}`, { method: m, headers: { "Content-Type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}) }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) jar[who] = set.split(";")[0];
  const j = await r.json().catch(() => ({}));
  return { ...j, zustand: j.status, status: r.status };
};
const mcp = async (method, params) =>
  fetch(`http://localhost:3076/mcp/${SECRET}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([fetch("http://localhost:3076/api/orders"), fetch("http://localhost:8091/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("KI-Planer: AV-Pakete, Freigaben, Morgenvorschlag, Fortschritt, Kennzahlen, Talos (Test-Odoo, Test-Kalkulation)");
  let r = await api("x", "POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  // Der erste Abgleich merkt laufende Aufträge nur als bekannt: FA01310 und FA01311 als Karten auf der EVO (wie schon in der App)
  const d = new DatabaseSync(env.DB_PATH);
  const card = d.prepare("INSERT INTO orders (machine, order_no, position, odoo_ref, odoo_id, extern_days) VALUES ('dmu40', ?, ?, ?, ?, 7)");
  card.run("FA01310", 50, "FA01310", 1310);
  card.run("FA01311", 51, "FA01311", 1311);
  d.close();
  r = await api("x", "POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  let orders = (await api("x", "GET", "/api/orders")).orders;
  const row = (ref) => orders.find((o) => o.odoo_ref === ref);

  // 1. Fortschritt aus dem Stempeln: FA01311 hat 45 min Rüsten und 30 min Fräsen gestempelt, 5 h laut Arbeitsplan
  assert.equal(row("FA01311").hours, 5, JSON.stringify(row("FA01311")));
  assert.equal(row("FA01311").done_hours, 1.25, JSON.stringify(row("FA01311")));
  assert.ok(row("FA01311").progress_date, "Fortschritt hat ein Datum");
  assert.ok(!(row("FA01310").done_hours > 0), "ohne Stempel kein Fortschritt");
  // von Hand mehr eingetragen: der Abgleich nimmt nichts zurück
  await api("x", "PUT", `/api/orders/${row("FA01311").id}`, { done_hours: 3 });
  await api("x", "POST", "/api/odoo/sync", { dryRun: false });
  orders = (await api("x", "GET", "/api/orders")).orders;
  assert.equal(row("FA01311").done_hours, 3);
  ok("Gestempelte Zeit aus Odoo wird Fortschritt, nie weniger als von Hand eingetragen");

  // 2. AV-Pakete: FA01322 (in der Kalkulation, Edelstahl, laut Arbeitsplan eloxiert), FA01309 (noch nicht kalkuliert)
  await api("x", "PUT", `/api/orders/${row("FA01322").id}`, { extern_tags: ["Eloxieren"] });
  r = await api("x", "POST", "/api/freigaben/vorbereiten", {});
  assert.equal(r.status, 200, JSON.stringify(r));
  let list = (await api("x", "GET", "/api/freigaben")).items;
  const paket = (ref) => list.find((f) => f.art === "av" && f.bezug === ref);
  const p1 = paket("FA01322");
  assert.ok(p1, JSON.stringify(list.map((f) => f.titel)));
  assert.equal(p1.daten.hours, 4, "60 min Rüsten + 60 Stk x 3 min = 4 h");
  assert.match(p1.daten.hoursSrc, /Kalkulation \(Wiederholteil/);
  assert.deepEqual(p1.daten.machine, { id: "m1", why: "laut Kalkulation" });
  assert.match(p1.daten.notes.material, /Werkstoff 1\.4301 .*Rohteil Flach 45x25x75/);
  assert.match(p1.daten.notes.programm, /Wiederholteil laut Kalkulation/);
  assert.equal(p1.daten.warnungen.length, 1, JSON.stringify(p1.daten));
  assert.match(p1.daten.warnungen[0], /Eloxieren geht nur bei Aluminium.*Edelstahl/);
  const p2 = paket("FA01309");
  assert.ok(p2 && p2.daten.kalkMoeglich && !p2.daten.hours, JSON.stringify(p2));
  assert.ok(list.some((f) => f.art === "plan"), "Planvorschlag des Tages ist da");
  assert.ok(!kalkLog.some((l) => l.startsWith("POST")), "Im Hintergrund wird in der Kalkulation nichts angelegt");
  ok("AV-Paket: Stunden, Maschine, Werkstoff und Rohteil aus der Kalkulation, Warnung Eloxieren bei Edelstahl, nichts angelegt");

  // 3. Freigeben nur mit PIN; Frank gibt FA01322 frei: Stunden, Hinweise, passt auf M1
  r = await api("x", "POST", `/api/freigaben/${p1.id}`, { aktion: "freigeben" });
  assert.equal(r.status, 401);
  assert.equal((await api("frank", "POST", "/api/bde/login", { id: 3, pin: "3333" })).status, 200);
  r = await api("frank", "POST", `/api/freigaben/${p1.id}`, { aktion: "freigeben" });
  assert.equal(r.status, 200, JSON.stringify(r));
  for (const t of [/4 h eingetragen/, /Hinweis Material/, /Hinweis Programm/, /passt auf M1/]) assert.match(r.ergebnis, t);
  orders = (await api("x", "GET", "/api/orders")).orders;
  assert.equal(row("FA01322").hours, 4);
  assert.equal(row("FA01322").restricted_ok, true);
  const av = (await api("x", "GET", "/api/av")).checks || (await api("x", "GET", "/api/av")).items || [];
  const note = (Array.isArray(av) ? av : []).find((c) => c.order_id === row("FA01322").id && c.item === "material");
  if (note) assert.match(note.note, /1\.4301/);
  r = await api("frank", "POST", `/api/freigaben/${p1.id}`, { aktion: "freigeben" });
  assert.equal(r.status, 409, "zweimal freigeben geht nicht");
  list = (await api("x", "GET", "/api/freigaben?status=alle")).items;
  const done1 = list.find((f) => f.id === p1.id);
  assert.equal(done1.status, "freigegeben");
  assert.match(done1.von, /Frank/);
  ok("Freigeben nur mit PIN: Stunden und AV-Hinweise übernommen, M1 erlaubt, festgehalten wer, nicht doppelt");

  // 4. Kalkulation auf Knopfdruck für FA01309, danach ablehnen; abgelehnt bleibt abgelehnt
  r = await api("frank", "POST", `/api/freigaben/${p2.id}/kalkulation`, {});
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.paket.hours, 1, "30 min + 2 x 10 min = 50 min, aufgerundet 1 h");
  assert.ok(kalkLog.some((l) => l.startsWith("POST /api/ext/calculate") && /"product":2904/.test(l)), kalkLog.join(" | "));
  r = await api("frank", "POST", `/api/freigaben/${p2.id}`, { aktion: "ablehnen", notiz: "Zeit passt nicht" });
  assert.equal(r.status, 200);
  await api("x", "POST", "/api/freigaben/vorbereiten", {});
  list = (await api("x", "GET", "/api/freigaben?status=alle")).items;
  assert.equal(list.filter((f) => f.schluessel === `av:${row("FA01309").id}`).length, 1);
  assert.equal(list.find((f) => f.id === p2.id).status, "abgelehnt");
  ok("Kalkulation rechnet nur auf Knopfdruck; abgelehnte Pakete kommen nicht wieder");

  // 5. Morgenvorschlag: FA01322 hat jetzt Stunden und wird eingeplant; ändert sich die Planung vorher, wird neu gerechnet
  list = (await api("x", "GET", "/api/freigaben")).items;
  let plan = list.find((f) => f.art === "plan");
  assert.ok(plan.daten.einplanen.some((e) => e.ref === "FA01322"), JSON.stringify(plan.daten.einplanen));
  await api("x", "PUT", `/api/orders/${row("FA01310").id}`, { hours: 7 });
  r = await api("frank", "POST", `/api/freigaben/${plan.id}`, { aktion: "freigeben" });
  assert.equal(r.status, 409, JSON.stringify(r));
  assert.match(r.error, /neu gerechnet/);
  list = (await api("x", "GET", "/api/freigaben")).items;
  const plan2 = list.find((f) => f.art === "plan");
  assert.equal(plan2.id, plan.id, "derselbe Vorschlag, neu gerechnet");
  assert.notEqual(plan2.daten.stamp, plan.daten.stamp);
  r = await api("frank", "POST", `/api/freigaben/${plan.id}`, { aktion: "freigeben" });
  assert.equal(r.status, 200, JSON.stringify(r));
  orders = (await api("x", "GET", "/api/orders")).orders;
  const target = plan2.daten.einplanen.find((e) => e.ref === "FA01322").machine;
  assert.equal(row("FA01322").machine, target);
  ok("Planvorschlag freigeben setzt den Plan wie vorgeschlagen; bei geänderter Planung erst neu rechnen");

  // 6. Heute zu tun und Kennzahlen
  const heute = await api("x", "GET", "/api/heute");
  const fz = heute.items.find((i) => i.id === "freigaben");
  assert.ok(fz && fz.n >= 1 && fz.ziel === "freigaben", JSON.stringify(heute.items));
  const kz = await api("x", "GET", "/api/kennzahlen");
  assert.equal(kz.status, 200, JSON.stringify(kz));
  const avQ = kz.ki.find((a) => a.art === "av");
  assert.equal(avQ.freigegeben, 1);
  assert.equal(avQ.abgelehnt, 1);
  assert.equal(avQ.quote, 50);
  assert.ok(Array.isArray(kz.liefertreue));
  ok("„Heute zu tun“ zeigt die offenen Freigaben; Kennzahlen zählen übernommene und abgelehnte Vorschläge");

  // 7. Talos: neue Werkzeuge, Vorschlag ablegen ändert nichts, Mensch hakt ab
  const tl = await mcp("tools/list", {});
  const names = tl.result.tools.map((t) => t.name);
  for (const t of ["plan_heute", "plan_vorschlag", "freigaben_offen", "freigabe_vorschlagen"]) assert.ok(names.includes(t), names.join(","));
  assert.equal(tl.result.tools.find((t) => t.name === "freigabe_vorschlagen").annotations.readOnlyHint, false);
  assert.equal(tl.result.tools.find((t) => t.name === "plan_vorschlag").annotations.readOnlyHint, true);
  const before = JSON.stringify((await api("x", "GET", "/api/orders")).orders);
  let c = await mcp("tools/call", { name: "freigabe_vorschlagen", arguments: { titel: "FA01334 vorziehen", text: "Liefertermin 06.11., Material kommt in 12 Tagen", bezug: "FA01334" } });
  assert.ok(!c.result.isError, JSON.stringify(c));
  assert.equal(JSON.stringify((await api("x", "GET", "/api/orders")).orders), before, "Talos ändert an der Planung nichts");
  c = await mcp("tools/call", { name: "freigaben_offen", arguments: { art: "hinweis" } });
  const offen = JSON.parse(c.result.content[0].text);
  assert.equal(offen.anzahl, 1);
  assert.equal(offen.freigaben[0].quelle, "Talos");
  c = await mcp("tools/call", { name: "plan_vorschlag", arguments: {} });
  assert.ok(JSON.parse(c.result.content[0].text).simulation);
  c = await mcp("tools/call", { name: "plan_heute", arguments: {} });
  assert.ok(Array.isArray(JSON.parse(c.result.content[0].text).items));
  r = await api("frank", "POST", `/api/freigaben/${offen.freigaben[0].id}`, { aktion: "freigeben" });
  assert.equal(r.status, 200);
  assert.equal(r.ergebnis, "gesehen");
  ok("Talos liest Heute, Planvorschlag und Freigaben; ein Vorschlag von Talos ändert nichts, bis ein Mensch ihn abhakt");

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
