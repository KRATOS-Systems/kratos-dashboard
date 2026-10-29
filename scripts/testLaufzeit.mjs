// Prüft die Programmlaufzeit je Aufspannung gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start:  node scripts/testLaufzeit.mjs   (startet Test-Odoo und Server selbst auf Port 8071 und 3055, mit leerer Wegwerf-Datenbank)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const ODOO_PORT = 8071;
const APP_PORT = 3055;
const dir = mkdtempSync(path.join(tmpdir(), "laufzeit-"));
const env = {
  ...process.env,
  MOCK_PORT: String(ODOO_PORT),
  PORT: String(APP_PORT),
  DB_PATH: path.join(dir, "test.db"),
  BDE_ODOO_URL: `http://localhost:${ODOO_PORT}`,
  BDE_ODOO_API_KEY: "test",
  BDE_WRITE: "1",
  BDE_SECRET: "testgeheimnis",
  ODOO_URL: "",
  ODOO_API_KEY: "",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const stopAll = async () => {
  procs.forEach((p) => p.kill());
  await new Promise((r) => setTimeout(r, 800)); // Windows hält die Datenbankdatei kurz gesperrt
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Wegwerfordner im Temp-Verzeichnis, darf liegen bleiben */
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const odoo = (p) => fetch(`http://localhost:${ODOO_PORT}${p}`).then((r) => r.json());
let cookie = "";
async function api(method, url, body) {
  const r = await fetch(`http://localhost:${APP_PORT}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
let n = 0;
const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);

try {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://localhost:${APP_PORT}/api/bde/session`);
      await odoo("/__log");
      break;
    } catch {
      await wait(250);
    }
  }
  console.log("Programmlaufzeit je Aufspannung (Test-Odoo)");

  assert.equal((await api("GET", "/api/bde/laufzeit?productionId=1307")).status, 401);
  ok("ohne Anmeldung gesperrt");

  const login = await api("POST", "/api/bde/login", { id: 2, pin: "2222" });
  assert.equal(login.status, 200, JSON.stringify(login));

  // Status, Wiederholteil-Vorschlag
  let st = await api("GET", "/api/bde/laufzeit?productionId=1307");
  assert.equal(st.available, true);
  assert.equal(st.workorderId, 6533);
  assert.equal(st.anzahl, 0);
  assert.equal(st.suggestion.from, "FA01100");
  assert.equal(st.suggestion.anzahl, 2);
  assert.deepEqual(st.suggestion.rows, [{ nr: 1, minutes: 7.5, teile: 1 }, { nr: 2, minutes: 12, teile: 2 }]);
  ok("Status und Vorschlag aus früherem Auftrag desselben Artikels (FA01100)");

  // "Als Nächstes": zuerst die weiteren Arbeitsschritte des Auftrags, an dem man zuletzt gearbeitet hat (auch wartende), dann das Geplante
  const nx = await api("GET", "/api/bde/next");
  assert.equal(nx.status, 200);
  const mineRows = nx.items.filter((i) => i.mine);
  assert.ok(mineRows.length >= 3 && mineRows.every((i) => i.fa === "FA01307"), JSON.stringify(nx.items.map((i) => [i.fa, i.label, i.state, i.mine])));
  assert.deepEqual(nx.items.slice(0, mineRows.length).map((i) => i.workorderId), mineRows.map((i) => i.workorderId), "eigene Aufträge stehen zuerst");
  assert.ok(mineRows.some((i) => i.state === "blocked"), "auch wartende Arbeitsgänge sind dabei");
  ok("Als Nächstes zeigt zuerst alle weiteren Arbeitsgänge des Auftrags, an dem der Mitarbeiter gearbeitet hat (auch wartende), danach das Geplante");

  // Programmierung ist kein Fräsen
  assert.equal((await api("GET", "/api/bde/laufzeit?workorderId=6531")).status, 400);
  ok("Laufzeiten gibt es nur beim Fräsen");

  // Ohne Anzahl keine Laufzeit
  let r = await api("POST", "/api/bde/laufzeit/save", { productionId: 1307, aufspannung: 1, sekunden: 450 });
  assert.equal(r.status, 400);
  assert.match(r.error, /Anzahl der Aufspannungen/);
  ok("Laufzeit ohne Anzahl der Aufspannungen wird abgewiesen");

  r = await api("POST", "/api/bde/laufzeit/anzahl", { productionId: 1307, anzahl: 0 });
  assert.equal(r.status, 400);
  r = await api("POST", "/api/bde/laufzeit/anzahl", { productionId: 1307, anzahl: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.anzahl, 2);
  assert.deepEqual(r.open, [1, 2]);
  ok("Anzahl der Aufspannungen = 2 als Notiz im Fertigungsauftrag festgehalten");

  // Fräsen kann noch nicht fertig gemeldet werden
  r = await api("POST", "/api/bde/laufzeit/finish", { workorderId: 6533 });
  assert.equal(r.status, 400);
  assert.match(r.error, /Aufspannung 1, 2/);
  ok("Fräsen fertig melden gesperrt, solange Laufzeiten fehlen");

  // Aufspannung 1: 7:30 min, 1 Teil (Wiederholteil unverändert)
  r = await api("POST", "/api/bde/laufzeit/save", { workorderId: 6533, aufspannung: 1, sekunden: 450, teile: 1, uebernommen: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.open, [2]);
  assert.equal(r.rows[0].perPiece, 7.5);
  assert.equal(r.rows[0].uebernommen, true);
  assert.equal(r.rows[0].who, "Aurel Rama");
  ok("Aufspannung 1 gespeichert (7:30, 1 Teil, unverändert übernommen, Mitarbeiter automatisch)");

  // Fehleingaben
  for (const bad of [{ aufspannung: 3, sekunden: 60 }, { aufspannung: 2, sekunden: 0 }, { aufspannung: 2, sekunden: 60, teile: 0 }, { aufspannung: 2, sekunden: 60, teile: 2.5 }]) {
    r = await api("POST", "/api/bde/laufzeit/save", { workorderId: 6533, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  ok("Unsinnige Eingaben (falsche Aufspannung, 0 Sekunden, 0 oder 2,5 Teile) werden abgewiesen");

  // Gestempelte Zeit erzeugen (Test-Odoo rechnet Dauer aus den Stempelungen), dann Plausibilität
  await api("POST", "/api/bde/act", { action: "start", workorderId: 6533 });
  await wait(1500);
  await api("POST", "/api/bde/act", { action: "stop", workorderId: 6533 });
  // Test-Odoo: gestempelte Dauer des Arbeitsgangs auf 20 Minuten setzen (bei 10 Stück passen höchstens 2:00 je Stück)
  await fetch(`http://localhost:${ODOO_PORT}/json/2/mrp.workorder/write`, { method: "POST", headers: { Authorization: "bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ ids: [6533], vals: { duration: 20 } }) });

  r = await api("POST", "/api/bde/laufzeit/save", { workorderId: 6533, aufspannung: 2, sekunden: 720, teile: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.needsConfirm, true);
  assert.match(r.warning, /Minuten/);
  st = await api("GET", "/api/bde/laufzeit?workorderId=6533");
  assert.equal(st.rows.length, 1, "bei offener Warnung wird nichts gespeichert");
  ok("Plausibilität: (7:30 + 6:00) × 10 Stück übersteigt die gestempelten 20 Minuten → Warnung, nichts gespeichert");

  // Auffangnetz: das gestoppte Fräsen mit fehlender Aufspannung steht in der Liste "Laufzeiten offen"
  r = await api("GET", "/api/bde/offen");
  assert.deepEqual(r.items.filter((i) => i.step === "Fräsen").map((i) => [i.workorderId, i.anzahl, i.erfasst]), [[6533, 2, 1]]);
  assert.ok(r.items.some((i) => i.workorderId === 6531 && i.step === "Programmierung"), "gestoppte, nicht fertig gemeldete Programmierung steht auch drin");
  ok("Liste „Noch nicht fertig gemeldet“ zeigt das Fräsen mit 1 von 2 Aufspannungen und die gestoppte Programmierung");

  r = await api("POST", "/api/bde/laufzeit/save", { workorderId: 6533, aufspannung: 2, sekunden: 720, teile: 2, confirm: true });
  assert.equal(r.status, 200);
  assert.equal(r.complete, true);
  assert.equal(r.sumPerPiece, 13.5);
  ok("Nach Bestätigung gespeichert: Aufspannung 2 = 12:00 für 2 Teile = 6:00 je Stück, Summe 13,5 min je Stück");

  // Korrektur einer Aufspannung (Programm geändert)
  r = await api("POST", "/api/bde/laufzeit/save", { workorderId: 6533, aufspannung: 1, sekunden: 360, teile: 1, geaendert: true, confirm: true });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].geaendert, true);
  assert.equal(r.rows[0].uebernommen, false);
  assert.equal(r.sumPerPiece, 12);
  ok("Korrektur: die neueste Notiz gilt (Programm geändert), je Aufspannung nur eine Zeile");

  // Die Zeiten stehen als interne Notizen im Fertigungsauftrag, nichts anderes in Odoo wurde beschrieben
  const state = await odoo("/__state");
  const notes = state["mail.message"].filter((m) => m.model === "mrp.production" && m.res_id === 1307).map((m) => m.body.replace(/<[^>]+>/g, ""));
  assert.ok(notes.includes("Aufspannungen (FRÄSEN): 2 (Aurel Rama, " + new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" }) + ")"), notes.join(" | "));
  assert.equal(notes.filter((t) => t.startsWith("Laufzeit Aufspannung 1 (FRÄSEN):")).length, 2);
  assert.ok(notes.some((t) => /^Laufzeit Aufspannung 2 \(FRÄSEN\): 12:00 Min:Sek für 2 Teile = 6:00 je Stück \(Aurel Rama, \d\d\.\d\d\.\d{4}\)$/.test(t)), notes.join(" | "));
  const wlog = (await odoo("/__log")).map((l) => l.call).filter((c) => /\.(write|create)\(/.test(c));
  assert.deepEqual(wlog, ['mrp.workorder.write(6533, {"duration":20})'], "nur der Testaufbau (gestempelte Dauer) schreibt direkt");
  ok("Anzahl und 3 Zeilen für Aufspannung 1 und 2 stehen als Notizen im Fertigungsauftrag; die App schreibt sonst nichts in Odoo");

  // Von Hand verunstaltete oder fremde Notizen stören nicht
  await fetch(`http://localhost:${ODOO_PORT}/json/2/mrp.production/message_post`, {
    method: "POST",
    headers: { Authorization: "bearer test", "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [1307], body: "<p>Laufzeit Aufspannung ? ungefähr sieben Minuten, Aufspannung 2 neu machen</p>", message_type: "comment", subtype_xmlid: "mail.mt_note" }),
  });
  st = await api("GET", "/api/bde/laufzeit?workorderId=6533");
  assert.equal(st.rows.length, 2);
  assert.equal(st.sumPerPiece, 12);
  ok("Eine nicht lesbare Notiz mit dem Wort „Aufspannung“ ändert nichts");

  // Fräsen fertig melden
  r = await api("POST", "/api/bde/laufzeit/finish", { workorderId: 6533 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal((await odoo("/__log")).filter((l) => l.call.includes("button_finish")).length, 1);
  ok("Fräsen fertig melden klappt, wenn alle Laufzeiten da sind");

  r = await api("POST", "/api/bde/laufzeit/save", { workorderId: 6533, aufspannung: 1, sekunden: 100, confirm: true });
  assert.equal(r.status, 400);
  ok("Nach Abschluss keine Änderung mehr");

  r = await api("GET", "/api/bde/offen");
  assert.deepEqual(r.items.filter((i) => i.step === "Fräsen"), []);
  ok("Nach Abschluss steht das Fräsen nicht mehr in der Liste „Noch nicht fertig gemeldet“");

  // Die Zeiterfassung wurde nicht angefasst: nur start/stop, kein Schreiben an productivity
  const calls = (await odoo("/__log")).map((l) => l.call);
  assert.equal(calls.filter((c) => c.startsWith("mrp.workcenter.productivity.")).length, 0);
  ok("Keine Schreibzugriffe auf mrp.workcenter.productivity");

  // --- Arbeitsgänge fertig melden, weiterer Arbeitsschritt, Auftrag abschließen ---
  const mock = (model, method, body) =>
    fetch(`http://localhost:${ODOO_PORT}/json/2/${model}/${method}`, { method: "POST", headers: { Authorization: "bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());

  // Programmierung fertig melden (nichts läuft mehr)
  r = await api("POST", "/api/bde/fertig", { workorderId: 6531 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.step, "Programmierung");
  assert.equal(r.production.allDone, false);
  ok("Programmierung fertig gemeldet (button_finish), der Auftrag ist damit noch nicht komplett");

  // Läuft noch eine Zeit, geht es nicht
  await api("POST", "/api/bde/act", { action: "start", workorderId: 6532 });
  r = await api("POST", "/api/bde/fertig", { workorderId: 6532 });
  assert.equal(r.status, 400);
  assert.match(r.error, /läuft noch eine Zeit/);
  await api("POST", "/api/bde/act", { action: "stop", workorderId: 6532 });
  r = await api("POST", "/api/bde/fertig", { workorderId: 6532 });
  assert.equal(r.status, 200);
  assert.equal(r.step, "Rüsten");
  ok("Rüsten: mit laufender Zeit gesperrt, nach dem Stopp fertig gemeldet");

  // Auftrag abschließen geht erst nach der QS
  r = await api("POST", "/api/bde/auftrag/abschliessen", { productionId: 1307 });
  assert.equal(r.status, 400);
  assert.match(r.error, /Offen: QS/);
  ok("Auftrag abschließen gesperrt, solange die QS offen ist");

  // Weiterer Arbeitsschritt auf einer anderen Maschine (hier: nach der ersten Spannung wird entschieden)
  r = await api("GET", "/api/bde/schritt?productionId=1307");
  assert.equal(r.status, 200);
  assert.deepEqual(r.machines.map((m) => m.name).sort(), ["DMG M1", "DMU 40 EVO", "DMU 50", "FRÄSEN"]);
  ok("Für den weiteren Arbeitsschritt stehen alle Maschinen mit Rüst-Arbeitsplatz zur Wahl");
  r = await api("POST", "/api/bde/schritt", { productionId: 1307, machineId: 999 });
  assert.equal(r.status, 400);
  r = await api("POST", "/api/bde/schritt", { productionId: 1307, machineId: 14, ruestenMin: 45, fraesenMin: 120 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.production.steps.map((x) => [x.step, x.machine, x.state]), [
    ["Programmierung", "CAM-PROGRAMMIERUNG", "done"],
    ["Rüsten", "RÜSTEN", "done"],
    ["Fräsen", "FRÄSEN", "done"],
    ["Rüsten", "DMU 40 EVO Rüsten", "blocked"],
    ["Fräsen", "DMU 40 EVO", "blocked"],
    ["QS", "QUALITÄTSSICHERUNG (QS)", "blocked"],
  ]);
  const st2 = await odoo("/__state");
  const qs = st2["mrp.workorder"].find((x) => x.id === 6534);
  assert.equal(qs.sequence, 5);
  assert.deepEqual(qs.blocked_by_workorder_ids, [[4, r.fraesenId]]);
  const neuF = st2["mrp.workorder"].find((x) => x.id === r.fraesenId);
  assert.equal(neuF.workcenter_id, 14);
  assert.equal(neuF.duration_expected, 120);
  assert.deepEqual(neuF.blocked_by_workorder_ids, [[4, r.ruestenId]]);
  ok("Weiterer Arbeitsschritt: Rüsten und Fräsen auf DMU 40 EVO stehen vor der QS, die QS wartet auf das neue Fräsen, geplante Zeiten übernommen");
  const idsNew = [r.ruestenId, r.fraesenId];

  // Die Laufzeit gehört jetzt zum neuen Fräsen-Arbeitsgang (Maschine DMU 40 EVO), erkannt am Namen, nicht am Arbeitsplatz
  st = await api("GET", "/api/bde/laufzeit?productionId=1307");
  assert.equal(st.workorderId, idsNew[1]);
  assert.equal(st.machine, "DMU 40 EVO");
  assert.equal(st.anzahl, 0);
  r = await api("POST", "/api/bde/laufzeit/anzahl", { workorderId: idsNew[1], anzahl: 1 });
  assert.equal(r.anzahl, 1);
  r = await api("POST", "/api/bde/laufzeit/save", { workorderId: idsNew[1], aufspannung: 1, sekunden: 310, teile: 1 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.complete, true);
  assert.equal(r.rows[0].minutes, 5.1667);
  const alle = (await odoo("/__state"))["mail.message"].filter((m) => m.res_id === 1307).map((m) => m.body.replace(/<[^>]+>/g, ""));
  assert.ok(alle.some((t) => t.startsWith("Weiterer Arbeitsschritt auf DMU 40 EVO angelegt")), alle.join(" | "));
  assert.ok(alle.some((t) => t.startsWith("Laufzeit Aufspannung 1 (DMU 40 EVO): 5:10 Min:Sek")), alle.join(" | "));
  // das erste Fräsen (FRÄSEN) behält seine eigenen Zeiten
  st = await api("GET", "/api/bde/laufzeit?workorderId=6533");
  assert.equal(st.machine, "FRÄSEN");
  assert.equal(st.rows.length, 2);
  ok("Laufzeiten werden je Maschine geführt: Aufspannung 1 auf DMU 40 EVO neben den zwei Aufspannungen auf FRÄSEN");

  // Fertig melden Schritt für Schritt bis zur QS, dann Auftrag abschließen
  for (const id of [idsNew[0], idsNew[1]]) {
    r = await api("POST", "/api/bde/fertig", { workorderId: id });
    assert.equal(r.status, 200, JSON.stringify(r));
  }
  r = await api("POST", "/api/bde/fertig", { workorderId: 6534 });
  assert.equal(r.status, 200);
  assert.equal(r.step, "QS");
  assert.equal(r.production.allDone, true);
  ok("Neues Rüsten, neues Fräsen und QS fertig gemeldet: der Auftrag meldet „alles fertig“");

  r = await api("POST", "/api/bde/auftrag/abschliessen", { productionId: 1307 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.state, "done");
  const prod1307 = (await odoo("/__state"))["mrp.production"].find((x) => x.id === 1307);
  assert.equal(prod1307.qty_producing, 10);
  assert.equal(prod1307.state, "done");
  r = await api("POST", "/api/bde/auftrag/abschliessen", { productionId: 1307 });
  assert.equal(r.status, 400);
  r = await api("POST", "/api/bde/schritt", { productionId: 1307, machineId: 14 });
  assert.equal(r.status, 400);
  ok("Auftrag abgeschlossen (Menge gesetzt, button_mark_done); danach weder erneut abschließen noch ein weiterer Arbeitsschritt");

  // Odoo fragt etwas zurück (Assistent): der Auftrag bleibt offen, die App sagt, dass es in Odoo zu klären ist
  const [pid] = await mock("mrp.production", "create", { vals_list: [{ name: "FA09999", product_id: 2901, state: "progress", origin: "A09999", product_qty: 5, qty_producing: 5, wizard: true }] });
  await mock("mrp.workorder", "create", { vals_list: [{ name: "Qualitätssicherung", production_id: pid, workcenter_id: 5, product_id: 2901, state: "done", sequence: 1 }] });
  r = await api("POST", "/api/bde/auftrag/abschliessen", { productionId: pid });
  assert.equal(r.status, 400);
  assert.match(r.error, /fragt etwas zurück/);
  assert.equal(((await odoo("/__state"))["mrp.production"].find((x) => x.id === pid)).state, "progress");
  ok("Stellt Odoo beim Abschließen eine Rückfrage, bleibt der Auftrag offen und die App verweist auf Odoo");

  // --- Planung: Arbeitsgänge einer Position (Dashboard) legen die Arbeitsschritte auch in Odoo an ---
  const [p2] = await mock("mrp.production", "create", { vals_list: [{ name: "FA02001", product_id: 2901, state: "confirmed", origin: "A02001", product_qty: 4, qty_producing: 0 }] });
  const wo2 = await mock("mrp.workorder", "create", {
    vals_list: [
      { name: "Programmierung", production_id: p2, workcenter_id: 6, product_id: 2901, state: "done", sequence: 0 },
      { name: "Rüsten", production_id: p2, workcenter_id: 10, product_id: 2901, state: "done", sequence: 1 },
      { name: "Fräsen", production_id: p2, workcenter_id: 1, product_id: 2901, state: "progress", sequence: 2 },
      { name: "Qualitätssicherung", production_id: p2, workcenter_id: 5, product_id: 2901, state: "blocked", sequence: 3 },
    ],
  });
  r = await api("POST", "/api/planung/odoo-schritte", { productionId: p2, ags: [{ machine: "dmu40", hours: 2 }, { machine: "h800u", hours: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.error, /POS H 800 U/);
  assert.match(r.error, /nichts angelegt/);
  assert.equal((await odoo("/__state"))["mrp.workorder"].filter((x) => x.production_id === p2).length, 4);
  ok("Fehlt der Arbeitsplatz einer Maschine in Odoo (hier die POS H 800 U), sagt die App welcher und legt nichts an");

  r = await api("POST", "/api/planung/odoo-schritte", { productionId: p2, ags: [{ machine: "dmu40", hours: 2 }, { machine: "m1", hours: 3.5 }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.reused, 1);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].machine, "DMG M1");
  const stp = (await odoo("/__state"))["mrp.workorder"].filter((x) => x.production_id === p2).sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(stp.map((x) => [x.name, x.workcenter_id, x.sequence]), [["Programmierung", 6, 0], ["Rüsten", 10, 1], ["Fräsen", 1, 2], ["Rüsten", 17, 3], ["Fräsen", 15, 4], ["Qualitätssicherung", 5, 5]]);
  assert.equal(stp[4].duration_expected, 210);
  ok("Planung: AG 1 gehört zum vorhandenen Fräsen, für AG 2 auf der M1 entstehen Rüsten und Fräsen (3,5 Std) vor der QS");

  r = await api("POST", "/api/planung/odoo-schritte", { productionId: p2, ags: [{ machine: "dmu40", hours: 2 }] });
  assert.equal(r.status, 400);
  r = await api("POST", "/api/planung/odoo-schritte", {});
  assert.equal(r.status, 400);
  ok("Eingaben ohne Odoo-Auftrag oder mit nur einem Arbeitsgang werden abgewiesen");

  // --- Hinweis "Zur Rechnung bereit" (nur Leitung) ---
  const mk = async (model, v) => (await mock(model, "create", { vals_list: [v] }))[0];
  const so = (name, extra = {}) => mk("sale.order", { name, state: "sale", invoice_status: "to invoice", invoice_count: 1, delivery_status: "full", partner_id: 41, amount_total: 1234.5, ...extra });
  // A07001: ein Fertigungsauftrag abgeschlossen, einer noch offen, aber alle Arbeitsgänge erledigt (so wie bei uns oft) -> bereit
  await so("A07001", { invoice_count: 0, delivery_status: "partial" });
  await mk("mrp.production", { name: "FA07001", state: "done", origin: "A07001", product_id: 2901 });
  const m2 = await mk("mrp.production", { name: "FA07002", state: "confirmed", origin: "A07001", product_id: 2901 });
  await mk("mrp.workorder", { name: "Fräsen", production_id: m2, workcenter_id: 1, state: "done" });
  await mk("mrp.workorder", { name: "Qualitätssicherung", production_id: m2, workcenter_id: 5, state: "done" });
  // A07002: ein Arbeitsgang läuft noch -> nicht bereit
  await so("A07002");
  const m3 = await mk("mrp.production", { name: "FA07003", state: "progress", origin: "A07002", product_id: 2901 });
  await mk("mrp.workorder", { name: "Fräsen", production_id: m3, workcenter_id: 1, state: "done" });
  await mk("mrp.workorder", { name: "Qualitätssicherung", production_id: m3, workcenter_id: 5, state: "progress" });
  // A07003: schon berechnet -> nicht in der Liste; A07004: nichts gefertigt (Handelsware) -> nicht in der Liste
  await so("A07003", { invoice_status: "invoiced" });
  await mk("mrp.production", { name: "FA07004", state: "done", origin: "A07003", product_id: 2901 });
  await so("A07004");

  r = await api("GET", "/api/bde/rechnung");
  assert.equal(r.status, 200);
  assert.deepEqual(r.items, []);
  ok("Mitarbeiter ohne Leitung sehen den Rechnungshinweis nicht");

  await api("POST", "/api/bde/login", { id: 3, pin: "3333" });
  r = await api("GET", "/api/bde/rechnung");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.items.map((i) => i.name), ["A07001"]);
  assert.equal(r.items[0].parts, 2);
  assert.equal(r.items[0].invoices, 0);
  assert.equal(r.items[0].deliveryLabel, "teilweise geliefert");
  assert.equal(r.items[0].partner, "Frank Häckl");
  ok("Leitung sieht A07001 (alle Teile gefertigt, auch das mit nur erledigten Arbeitsgängen); A07002 (QS läuft), A07003 (berechnet) und A07004 (nichts gefertigt) fehlen");

  // --- Maschinenlauf eines Kollegen beenden ---
  const pm = await mk("mrp.production", { name: "FA08001", state: "confirmed", origin: "A08001", product_id: 2901 });
  const woMachine = await mk("mrp.workorder", { name: "Fräsen", production_id: pm, workcenter_id: 14, product_id: 2901, state: "ready", sequence: 1 });
  const woPerson = await mk("mrp.workorder", { name: "Rüsten", production_id: pm, workcenter_id: 16, product_id: 2901, state: "ready", sequence: 0 });
  await api("POST", "/api/bde/login", { id: 3, pin: "3333" }); // Frank
  r = await api("POST", "/api/bde/act", { action: "start", workorderId: woMachine });
  assert.equal(r.status, 200, JSON.stringify(r));
  r = await api("POST", "/api/bde/act", { action: "start", workorderId: woPerson });
  assert.equal(r.status, 200, JSON.stringify(r));
  // Maschinenampel: Fräsen läuft = grün (vor Rüsten = gelb)
  let amp = await api("GET", "/api/maschinen/ampel");
  assert.equal(amp.status, 200, JSON.stringify(amp));
  assert.equal(amp.machines.dmu40.state, "lauf");
  assert.equal(amp.machines.dmu40.runs.find((x) => x.step === "Fräsen").who, "Frank Häckl");
  assert.ok(["frei", "steht"].includes(amp.machines.dmu50.state));
  ok("Ampel: auf der DMU 40 läuft ein Fräsen (Frank) und gleichzeitig wird gerüstet, die Ampel zeigt grün");
  await api("POST", "/api/bde/login", { id: 2, pin: "2222" }); // Aurel, keine Leitung
  r = await api("POST", "/api/bde/act", { action: "stop", workorderId: woPerson, employeeId: 3 });
  assert.equal(r.status, 403);
  r = await api("POST", "/api/bde/act", { action: "start", workorderId: woPerson, employeeId: 3 });
  assert.equal(r.status, 403);
  r = await api("POST", "/api/bde/act", { action: "stop", workorderId: woMachine, employeeId: 3 });
  assert.equal(r.status, 200, JSON.stringify(r));
  const lines = (await odoo("/__state"))["mrp.workcenter.productivity"].filter((x) => x.workorder_id === woMachine);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].date_end, "der Maschinenlauf ist beendet");
  amp = await api("GET", "/api/maschinen/ampel?fresh=1");
  assert.equal(amp.machines.dmu40.state, "ruesten");
  ok("Ampel: nach dem Beenden des Fräsens bleibt nur das Rüsten, die Ampel zeigt gelb");
  ok("Jeder angemeldete Mitarbeiter darf den Maschinenlauf eines Kollegen beenden; seine Personenzeit beenden oder etwas für ihn starten darf er nicht");

  // Sperre im Odoo-Zugang
  process.env.BDE_ODOO_URL = env.BDE_ODOO_URL;
  process.env.BDE_ODOO_API_KEY = "test";
  process.env.BDE_WRITE = "1";
  const { createOdooClient } = await import("../server/odooClient.js");
  const c = createOdooClient();
  await assert.rejects(c.write("mrp.workorder", "write", { ids: [6533], vals: { state: "done" } }), /nur Reihenfolge und Abhängigkeit/);
  await assert.rejects(c.write("mrp.workorder", "write", { ids: [6533], vals: { duration: 5 } }), /nur Reihenfolge und Abhängigkeit/);
  await assert.rejects(c.write("mrp.workorder", "create", { vals_list: [{ name: "Rüsten", workcenter_id: 16, production_id: 1307, state: "done" }] }), /nur Name, Arbeitsplatz/);
  await assert.rejects(c.write("mrp.production", "write", { ids: [1307], vals: { product_qty: 1 } }), /nur die produzierte Menge/);
  await assert.rejects(c.write("mrp.production", "message_post", { ids: [1307], body: "x", message_type: "comment", subtype_xmlid: "mail.mt_comment" }), /Nur interne Notizen/);
  await assert.rejects(c.write("mrp.production", "message_post", { ids: [1307], body: "x", message_type: "comment", subtype_xmlid: "mail.mt_note", partner_ids: [3] }), /Nur interne Notizen/);
  await assert.rejects(c.write("mail.message", "unlink", { ids: [910] }), /gesperrt/);
  ok("Odoo-Zugang: Fertigungsauftrag nur Notiz, Menge und Abschließen; Arbeitsgang nur Starten, Stoppen, Fertig melden, Anlegen mit festen Feldern; kein Löschen");

  // Maschinen, die nur nach ihrem Typ heißen, laufen nebenher wie der Sammelplatz FRÄSEN; "… Rüsten" bleibt Personenarbeit
  const { kindOf, labelOf, stepOf } = await import("../server/bde.js");
  for (const m of ["FRÄSEN", "DMU 40 EVO", "DMG M1", "POS H 800 U", "DMU 50"]) {
    assert.equal(kindOf(m), "maschine", m);
    assert.equal(labelOf(m), "Fräsen", m);
  }
  for (const m of ["DMU 40 EVO Rüsten", "DMG M1 Rüsten", "RÜSTEN", "CAM-PROGRAMMIERUNG", "QUALITÄTSSICHERUNG (QS)"]) assert.equal(kindOf(m), "person", m);
  assert.equal(labelOf("DMU 40 EVO Rüsten"), "Rüsten");
  assert.equal(stepOf("Programmlaufzeit"), null);
  ok("Maschinen-Arbeitsplätze (DMU 40 EVO, DMG M1, POS H 800 U, DMU 50) laufen nebenher wie FRÄSEN, die „… Rüsten“-Arbeitsplätze zählen als Personenzeit");

  console.log(`\nAlle ${n} Prüfungen bestanden`);
} catch (err) {
  console.error("\nFEHLER:", err.message);
  process.exitCode = 1;
} finally {
  await stopAll();
}
