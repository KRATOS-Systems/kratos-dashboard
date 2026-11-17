// Prüft die Verbindung zu QS (server/qsBridge.js) ohne echtes QS und ohne echtes Odoo: Schlüssel, Liste offen, Rückmeldung „bereit“,
// automatischer Status für neue Positionen (Prüfplan aus QS, EMPB aus der Position „[EMPB]“ im Verkaufsauftrag) und dass Handeinträge nie überschrieben werden.
// Start: node scripts/testQsBridge.mjs
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import registerQsBridge, { artikelAus, gleicherArtikel, hatEmpb, empbTeile } from "../server/qsBridge.js";

const dir = mkdtempSync(path.join(tmpdir(), "qsbridge-"));
const db = new DatabaseSync(path.join(dir, "t.db"));
db.exec(`
  CREATE TABLE orders (id INTEGER PRIMARY KEY, machine TEXT NOT NULL DEFAULT '', order_no TEXT NOT NULL DEFAULT '', hours REAL NOT NULL DEFAULT 0, done_hours REAL NOT NULL DEFAULT 0,
    due_date TEXT, position INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, odoo_ref TEXT, odoo_id INTEGER, source TEXT, product TEXT, quantity REAL);
  CREATE TABLE av_checks (order_id INTEGER NOT NULL, item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'offen', due TEXT, note TEXT NOT NULL DEFAULT '', updated_at TEXT, assignee TEXT, PRIMARY KEY (order_id, item));
  CREATE TABLE odoo_seen (odoo_id INTEGER PRIMARY KEY, first_seen TEXT NOT NULL);
  CREATE TABLE plan_rates (machine TEXT PRIMARY KEY, weekly_hours REAL NOT NULL);
  CREATE TABLE week_capacity (reading_date TEXT PRIMARY KEY, capacity_hours REAL NOT NULL);
  CREATE TABLE free_days (date TEXT PRIMARY KEY, name TEXT NOT NULL);
`);
const orderOut = (r) => ({ ...r, due: r.due_date, done: r.done === 1, extern_tags: [], qs_required: true, is_split: false });
const planSettingsOut = () => ({ utilization: 80, tight_days: 3 });

// Attrappen: QS kennt einen freigegebenen Plan für SK966-114000.001.0; im Verkaufsauftrag A100 steht unter dem Teil die Position „[EMPB]“
const fetchImpl = async (url) => {
  const u = new URL(url);
  if (u.pathname.endsWith("/api/extern/plaene")) {
    const artikel = Object.fromEntries(u.searchParams.getAll("artikel").map((a) => [a, { freigegeben: gleicherArtikel(a, "sk966_114000_001_0__") ? [""] : [], entwurf: [] }]));
    return new Response(JSON.stringify({ artikel }), { status: 200 });
  }
  return new Response("?", { status: 404 });
};
const L = (id, order, seq, product, name = "", display_type = false) => ({ id, order_id: [id, order], sequence: seq, product_id: product, name, display_type });
const ZEILEN = [
  L(1, "A100", 1, [5, "[SK966-114000.001.0] Schliessbolzen"]),
  L(2, "A100", 2, [1150, "[EMPB] Erstmusterprüfbericht"], "[EMPB] Erstmusterprüfbericht"),
  L(3, "A100", 3, [222, "AV"]),
  L(4, "A200", 1, [6, "[NEU-1] Neuteil"]),
  L(5, "A200", 2, [222, "AV"]),
];
const odooImpl = async (model, method, p) => {
  if (model === "sale.order.line") return ZEILEN.filter((l) => p.domain[0][2].includes(l.order_id[1]));
  throw new Error("unerwartet " + model);
};

const app = express();
const bridge = registerQsBridge(app, db, { orderOut, planSettingsOut }, { fetchImpl, odooImpl });
bridge.afterLogin();
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const KEY = bridge.key();
const api = async (method, url, body, key = KEY) => {
  const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(key ? { "X-QS-Schluessel": key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  console.log("Verbindung zu QS (Test ohne echtes QS/Odoo)");
  assert.equal(artikelAus("[SK966-114000.001.0] Schliessbolzen"), "SK966-114000.001.0");
  assert.ok(gleicherArtikel("SK954-080400.002.0", "sk954_080400_002_0_a") && !gleicherArtikel("327-62-18", "327-62-181"));
  assert.ok(hatEmpb(["Stammkunde", "EMPB"]) && !hatEmpb(["EMPBX"]));
  // Wie im echten Auftrag A01385: Teil, EMPB, Teil, EMPB, AV; dazu ein Teil mit „EMPB“ im Text und eins ohne
  const t = empbTeile([
    L(1, "A1", 1, [1, "[SK967-114000.001.0] Schliessbolzen-Fuss"]),
    L(2, "A1", 2, [1150, "[EMPB] Erstmusterprüfbericht"]),
    L(3, "A1", 3, [2, "[SK966-114100.005.0] Bundbuchse"]),
    L(4, "A1", 4, [1150, "[EMPB] Erstmusterprüfbericht"]),
    L(5, "A1", 5, [222, "AV"]),
    L(6, "A2", 1, [3, "[X-1] Ohne"]),
    L(7, "A3", 1, [1150, "[EMPB] Erstmusterprüfbericht"]),
    L(8, "A4", 1, [49, "[Y-2] Frästeil"], "Muster mit EMPB"),
  ]);
  assert.deepEqual([...t].sort(), ["A1|sk9661141000050", "A1|sk9671140000010", "A4|y2"]);
  ok("Artikel aus Odoo-Produkt, Vergleich mit Zeichnungsnummer, EMPB-Position gilt für das Teil darüber");

  assert.ok(KEY.length >= 40);
  assert.equal((await api("GET", "/api/extern/av-offen", null, "")).status, 401);
  assert.equal((await api("GET", "/api/extern/av-offen", null, "falsch")).status, 401);
  assert.equal((await api("GET", "/api/qs-verbindung")).schluessel, KEY);
  ok("Schlüssel wird selbst erzeugt; ohne oder mit falschem Schlüssel kein Zugriff");

  // Alte Position (vor dem Einschalten) und zwei neue
  const ab = db.prepare("SELECT value FROM kv WHERE key = 'qs_auto_ab'").get().value;
  const ins = db.prepare("INSERT INTO orders (id, odoo_ref, odoo_id, source, product, due_date) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run(1, "FA00001", 101, "A001", "[ALT-1] Altteil", "2026-12-01");
  ins.run(2, "FA00002", 102, "A100", "[SK966-114000.001.0] Schliessbolzen", "2026-12-05");
  ins.run(3, "FA00003", 103, "A200", "[NEU-1] Neuteil", "2026-12-03");
  db.prepare("INSERT INTO odoo_seen VALUES (101, 'baseline'), (102, ?), (103, ?)").run(ab, new Date(Date.parse(ab) + 1000).toISOString());
  // Von Hand: EMPB bei Position 3 bewusst „nicht nötig“ → darf nie überschrieben werden
  db.prepare("INSERT INTO av_checks (order_id, item, status, note, auto) VALUES (3, 'empb', 'entfaellt', '', 0)").run();
  const r1 = await bridge.automatisch();
  const st = (id, item) => db.prepare("SELECT status, auto FROM av_checks WHERE order_id = ? AND item = ?").get(id, item);
  assert.deepEqual({ ...st(2, "pruefplan") }, { status: "bereit", auto: 1 }, "Wiederholteil mit freigegebenem Plan");
  assert.deepEqual({ ...st(3, "pruefplan") }, { status: "offen", auto: 1 }, "Neuteil ohne Plan");
  assert.deepEqual({ ...st(2, "empb") }, { status: "offen", auto: 1 }, "EMPB-Position unter dem Teil im Verkaufsauftrag");
  assert.deepEqual({ ...st(3, "empb") }, { status: "entfaellt", auto: 0 }, "Handeintrag bleibt");
  assert.equal(st(1, "pruefplan"), undefined, "alte Positionen bleiben unberührt");
  assert.equal(r1.geprueft, 2);
  ok("Automatischer Status: Prüfplan bereit/offen nach QS, EMPB nach Verkaufsauftrag, Handeintrag und alte Positionen unberührt");

  const offen = await api("GET", "/api/extern/av-offen");
  assert.deepEqual(offen.zeilen.map((z) => z.id).sort(), [2, 3]);
  const z3 = offen.zeilen.find((z) => z.id === 3);
  assert.equal(z3.artikel, "NEU-1");
  assert.equal(z3.fa, "FA00003");
  assert.equal(z3.pruefplan.status, "offen");
  assert.equal(z3.pruefplan.zustaendig, "Aurel");
  ok("Liste offen: nur Positionen mit offenem Prüfplan oder EMPB, mit Artikel, FA und Zuständigem");

  const b = await api("POST", "/api/extern/av-bereit", { artikel: "neu_1_a", item: "pruefplan" });
  assert.equal(b.gesetzt, 1);
  assert.equal(st(3, "pruefplan").status, "bereit");
  assert.equal((await api("POST", "/api/extern/av-bereit", { artikel: "NEU-1", item: "pruefplan" })).gesetzt, 0, "bereit bleibt bereit");
  assert.equal((await api("POST", "/api/extern/av-bereit", { artikel: "NEU-1", item: "material" })).status, 400);
  ok("Rückmeldung aus QS setzt nur offene Punkte des Artikels auf bereit");

  // Erneuter Lauf: bereit wird nicht zurückgesetzt
  await bridge.automatisch();
  assert.equal(st(3, "pruefplan").status, "bereit");
  assert.equal(st(3, "empb").status, "entfaellt");
  ok("Erneuter automatischer Lauf setzt nichts zurück");
  console.log("Alle Prüfungen bestanden.");
} catch (err) {
  console.error("\nFEHLGESCHLAGEN:", err.message);
  process.exitCode = 1;
} finally {
  server.close();
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* gesperrt */
  }
}
