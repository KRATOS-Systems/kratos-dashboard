// Prüft die Frühwarnung bei Lieferverzug: erkennen (überfällig, laut Plan zu spät, Risiko), Grund, Vorschlag für den neuen Termin,
// Entwurf der Nachricht an den Kunden und den Vermerk "Kunde informiert".
// Läuft gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz. Gesendet wird nirgends etwas.
// Start: node scripts/testFruehwarnung.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "fruehwarn-"));
const env = { ...process.env, MOCK_ENTWURF: "1", MOCK_PORT: "8081", PORT: "3064", DB_PATH: path.join(dir, "t.db"), ODOO_URL: "http://localhost:8081", ODOO_API_KEY: "t", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "", ORDERS_SINCE: "", COMPANY_NAME: "" };
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => {
  const r = await fetch(`http://localhost:3064${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b && m !== "GET" ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const de = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const today = day(0);
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  await wait(4500);
  console.log("Frühwarnung bei Lieferverzug (Test-Odoo)");

  let r = await api("POST", "/api/odoo/sync", { dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  let orders = (await api("GET", "/api/orders")).orders;
  const row = (ref) => orders.find((o) => o.odoo_ref === ref);
  const item = (w, source) => w.items.find((i) => i.source === source);

  // 1. Überfällig und nicht eingeplant: Verzug ohne Terminvorschlag, Grund genannt, Kunde nicht informiert
  let w = await api("GET", "/api/fruehwarnung");
  assert.equal(w.status, 200);
  let a = item(w, "A01385");
  assert.ok(a, JSON.stringify(w.items.map((i) => i.source)));
  assert.equal(a.kind, "verzug");
  assert.equal(a.state, "offen");
  assert.equal(a.due, "2026-11-05");
  assert.equal(a.proposal, null);
  assert.equal(a.customer, "ACS Armoured Car Systems GmbH");
  assert.equal(a.since, today);
  assert.ok(a.lateDays > 0);
  assert.ok(a.reasons.some((x) => /nicht freigegeben: FA01309/.test(x)), JSON.stringify(a.reasons));
  assert.ok(a.reasons.some((x) => /nicht eingeplant/.test(x)), JSON.stringify(a.reasons));
  assert.ok(w.counts.nichtInformiert >= 3, JSON.stringify(w.counts));
  ok("Überfällige, nicht eingeplante Aufträge stehen als Verzug in der Liste: mit Grund, ohne Terminvorschlag, Kunde nicht informiert");

  // 2. Einplanen: jetzt gibt es ein Ende laut Plan und einen Vorschlag (Werktag, nach heute, mit Puffer)
  r = await api("PUT", `/api/orders/${row("FA01309").id}`, { machine: "dmu40", hours: 6 });
  assert.equal(r.status, 200, JSON.stringify(r));
  w = await api("GET", "/api/fruehwarnung");
  a = item(w, "A01385");
  assert.ok(a.forecast && a.forecast >= today, JSON.stringify(a));
  assert.ok(a.proposal && a.proposal > today && a.proposal >= a.forecast, JSON.stringify(a));
  assert.ok(![0, 6].includes(new Date(a.proposal + "T00:00:00Z").getUTCDay()), "Vorschlag muss ein Werktag sein: " + a.proposal);
  assert.equal(a.unscheduled, 0);
  assert.ok(a.reasons.some((x) => /Laut Plan fertig am/.test(x)), JSON.stringify(a.reasons));
  ok("Nach dem Einplanen nennt die Frühwarnung das Ende laut Plan und schlägt einen neuen Termin vor (Werktag, mit Puffer)");

  // 3. Pünktlicher Auftrag erscheint nicht, knapper und nicht eingeplanter Auftrag als Risiko
  const mk = async (source, due, machine, hours) => {
    const o = await api("POST", "/api/orders", { machine: machine || "dmu50" });
    await api("PUT", `/api/orders/${o.id}`, { order_no: source, source, due, hours, product: "Prüfteil", ...(machine ? {} : { machine: "" }) });
    return o.id;
  };
  await mk("A09001", day(40), "dmu50", 5);
  await mk("A09002", day(5), null, 5);
  w = await api("GET", "/api/fruehwarnung");
  assert.ok(!item(w, "A09001"), "Pünktlicher Auftrag darf nicht in der Liste stehen");
  const risk = item(w, "A09002");
  assert.ok(risk, JSON.stringify(w.items.map((i) => i.source)));
  assert.equal(risk.kind, "risiko");
  assert.equal(risk.state, "risiko");
  assert.equal(w.counts.risiko, 1);
  ok("Ein pünktlicher Auftrag bleibt draußen; Liefertermin in 5 Tagen und nicht eingeplant zählt als Risiko");

  // 4. Laut Plan zu spät (Liefertermin noch nicht erreicht): Verzug mit Vorschlag
  await mk("A09003", day(3), "m1", 400);
  w = await api("GET", "/api/fruehwarnung");
  const late = item(w, "A09003");
  assert.ok(late && late.kind === "verzug" && late.proposal > late.due, JSON.stringify(late));
  assert.ok(late.lateDays > 10, JSON.stringify(late));
  ok("Wird ein Auftrag laut Plan erst nach dem Liefertermin fertig, meldet die App den Verzug schon vorher");

  // 5. Entwurf der Nachricht: Empfänger, Bestellnummer und Ansprechpartner aus Odoo, alter und neuer Termin im Text
  let m = await api("GET", `/api/fruehwarnung/mail?source=A01385`);
  assert.equal(m.status, 200, JSON.stringify(m));
  assert.equal(m.to, "einkauf@acs.example");
  assert.match(m.subject, /Bestellung 723835 \(unser Auftrag A01385\)/);
  assert.match(m.body, /^Guten Tag Markus Fuss,/);
  assert.ok(m.body.includes("Bisher zugesagter Liefertermin: 05.11.2026"), m.body);
  assert.ok(m.body.includes("Neuer voraussichtlicher Liefertermin: " + de(a.proposal)), m.body);
  assert.ok(m.body.includes("2 Stück"), m.body);
  assert.ok(m.body.trim().endsWith("KRATOS Precision GmbH"), m.body);
  const custom = day(21);
  m = await api("GET", `/api/fruehwarnung/mail?source=A01385&date=${custom}`);
  assert.ok(m.body.includes("Neuer voraussichtlicher Liefertermin: " + de(custom)), m.body);
  r = await api("GET", `/api/fruehwarnung/mail?source=A09001`);
  assert.equal(r.status, 404);
  ok("Mail-Entwurf: Empfänger, Bestellnummer und Ansprechpartner aus Odoo, alter und neuer Termin im Text, eigener Termin möglich");

  // 6. Kunde informiert: raus aus der roten Liste; verschiebt sich der Plan danach weiter, meldet die App es erneut
  const before = w.counts.nichtInformiert;
  w = await api("POST", "/api/fruehwarnung/informiert", { source: "A01385", date: a.proposal });
  a = item(w, "A01385");
  assert.equal(a.state, "informiert");
  assert.equal(a.informedDate, a.proposal);
  assert.equal(w.counts.nichtInformiert, before - 1);
  await api("PUT", `/api/orders/${row("FA01309").id}`, { hours: 600 });
  w = await api("GET", "/api/fruehwarnung");
  a = item(w, "A01385");
  assert.equal(a.state, "erneut", JSON.stringify(a));
  assert.ok(a.proposal > a.informedDate);
  w = await api("POST", "/api/fruehwarnung/informiert", { source: "A01385", undo: true });
  assert.equal(item(w, "A01385").state, "offen");
  r = await api("POST", "/api/fruehwarnung/informiert", { source: "A09001" });
  assert.equal(r.status, 404);
  ok("Nach „Kunde ist informiert“ gilt der Auftrag als erledigt; verschiebt sich der Termin weiter, meldet die App ihn erneut");

  // 7. Erledigter Auftrag verschwindet aus der Liste
  await api("PUT", `/api/orders/${row("FA01309").id}`, { done: true });
  w = await api("GET", "/api/fruehwarnung");
  assert.ok(!item(w, "A01385"));
  ok("Ist der Auftrag erledigt, verschwindet er aus der Frühwarnung");

  // 8. Odoo wurde nur gelesen
  const log = await fetch("http://localhost:8081/__log").then((x) => x.json());
  assert.deepEqual(log, [], JSON.stringify(log));
  ok("Die App hat in Odoo nichts geändert und nichts gesendet");

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
