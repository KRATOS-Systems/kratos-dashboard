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

  // 6. Empfehlung für den Weg und Kontaktdaten: überfällig oder kurzfristig = anrufen, mit Vorlauf reicht eine Mail
  await mk("A09004", day(25), "h800u", 900);
  w = await api("GET", "/api/fruehwarnung");
  assert.equal(item(w, "A01385").advice, "anrufen");
  assert.equal(item(w, "A09003").advice, "anrufen");
  assert.equal(item(w, "A09004").kind, "verzug");
  assert.equal(item(w, "A09004").advice, "mail", JSON.stringify(item(w, "A09004")));
  const k = await api("GET", "/api/fruehwarnung/kontakt?source=A01385");
  assert.equal(k.phone, "+49 9131 555 0142");
  assert.equal(k.name, "Markus Fuss");
  assert.equal(k.company, "ACS Armoured Car Systems GmbH");
  ok("Empfehlung: überfällig oder kurzfristig anrufen, mit Vorlauf reicht eine Mail; Telefonnummer und Ansprechpartner kommen aus Odoo");

  // 6b. Vor dem Anruf: Ansprechpartner aus den Odoo-Kontakten der Firma, Entwurf (Notiz, Termin) bleibt gespeichert, ändert aber nichts
  const kt = await api("GET", "/api/fruehwarnung/kontakt?source=A01385");
  assert.deepEqual(kt.personen.map((p) => p.name), ["ACS Armoured Car Systems GmbH", "Markus Fuss", "Petra Lang"], JSON.stringify(kt.personen));
  assert.equal(kt.personen.find((p) => p.name === "Petra Lang").phone, "+49 9131 555 0150");
  r = await api("POST", "/api/fruehwarnung/entwurf", { source: "A01385", date: day(40), channel: "telefon", contact: "Petra Lang", email: "p.lang@acs.example", note: "Teillieferung anbieten" });
  assert.equal(r.status, 200, JSON.stringify(r));
  w = await api("GET", "/api/fruehwarnung");
  a = item(w, "A01385");
  assert.deepEqual([a.draft.contact, a.draft.note, a.draft.date, a.draft.email], ["Petra Lang", "Teillieferung anbieten", day(40), "p.lang@acs.example"]);
  assert.equal(a.state, "offen", "Ein Entwurf informiert den Kunden noch nicht");
  assert.equal(a.due, "2026-11-05", "Ein Entwurf ändert den Liefertermin nicht");
  m = await api("GET", "/api/fruehwarnung/mail?source=A01385&an=" + encodeURIComponent("p.lang@acs.example") + "&name=" + encodeURIComponent("Petra Lang"));
  assert.equal(m.to, "p.lang@acs.example");
  assert.match(m.body, /^Guten Tag Petra Lang,/);
  r = await api("POST", "/api/fruehwarnung/entwurf", { source: "A09999", note: "x" });
  assert.equal(r.status, 404);
  ok("Vor dem Anruf: Ansprechpartner aus den Odoo-Kontakten wählbar, Notiz und Termin bleiben als Entwurf gespeichert, ohne etwas zu ändern");

  // 7. Telefonisch informiert: abgehakt ohne Mail, der genannte Termin wird Liefertermin, der ursprüngliche bleibt sichtbar
  const before = w.counts.nichtInformiert;
  const proposal = item(w, "A01385").proposal;
  w = await api("POST", "/api/fruehwarnung/informiert", { source: "A01385", date: proposal, channel: "telefon", contact: "Markus Fuss", note: "Teillieferung nicht nötig" });
  a = item(w, "A01385");
  assert.ok(a, "Informierte Aufträge bleiben in der Liste");
  assert.equal(a.state, "informiert");
  assert.equal(a.channel, "telefon");
  assert.equal(a.contact, "Markus Fuss");
  assert.equal(a.informedDate, proposal);
  assert.equal(a.due, proposal);
  assert.equal(a.dueOriginal, "2026-11-05");
  assert.equal(a.dueShifts, 1);
  assert.equal(w.counts.nichtInformiert, before - 1);
  orders = (await api("GET", "/api/orders")).orders;
  assert.equal(row("FA01309").due, proposal);
  assert.equal(row("FA01309").due_original, "2026-11-05");
  assert.equal(row("FA01309").due_shifts, 1);
  let h = (await api("GET", "/api/orders/" + row("FA01309").id + "/due-history")).history;
  assert.equal(h.length, 1, JSON.stringify(h));
  assert.equal(h[0].from, "2026-11-05");
  assert.equal(h[0].to, proposal);
  assert.match(h[0].reason, /Kunde informiert \(Telefon, Markus Fuss\)/);
  assert.equal(a.draft, null, "Mit dem Abhaken ist der Entwurf übernommen und weg");
  assert.match(w.odoo.info, /nicht freigeschaltet/, "Ohne Schreibfreigabe bleibt Odoo unberührt, der Grund steht dabei");
  r = await api("POST", "/api/fruehwarnung/informiert", { source: "A01385", channel: "fax" });
  assert.equal(r.status, 400);
  ok("Telefonisch abgehakt: ohne Mail erledigt, neuer Termin ist Liefertermin, ursprünglicher Termin und Verlauf bleiben erhalten");

  // 8. Mail danach ist freiwillig: Entwurf als Bestätigung des Telefonats, nennt den ursprünglichen Termin
  m = await api("GET", "/api/fruehwarnung/mail?source=A01385&nachTelefon=1");
  assert.equal(m.status, 200, JSON.stringify(m));
  assert.match(m.body, /wie eben telefonisch besprochen/);
  assert.ok(m.body.includes("Bisher zugesagter Liefertermin: 05.11.2026"), m.body);
  assert.ok(m.body.includes("Neuer voraussichtlicher Liefertermin: " + de(proposal)), m.body);
  w = await api("POST", "/api/fruehwarnung/informiert", { source: "A01385", date: proposal, channel: "beides", contact: "Markus Fuss" });
  assert.equal(item(w, "A01385").channel, "beides");
  assert.equal(item(w, "A01385").dueShifts, 1, "Derselbe Termin noch einmal ist keine weitere Verschiebung");
  ok("Die Bestätigung per Mail nach dem Telefonat ist möglich, aber nicht nötig; sie zählt nicht als weitere Verschiebung");

  // 9. Verschiebt sich der Plan danach weiter, meldet die App den Auftrag erneut (zweite Verschiebung: immer anrufen)
  await api("PUT", "/api/orders/" + row("FA01309").id, { hours: 600 });
  w = await api("GET", "/api/fruehwarnung");
  a = item(w, "A01385");
  assert.equal(a.state, "erneut", JSON.stringify(a));
  assert.ok(a.proposal > a.informedDate);
  assert.equal(a.advice, "anrufen");
  w = await api("POST", "/api/fruehwarnung/informiert", { source: "A01385", undo: true });
  assert.equal(item(w, "A01385").state, "offen");
  r = await api("POST", "/api/fruehwarnung/informiert", { source: "A09001" });
  assert.equal(r.status, 404);
  ok("Verschiebt sich der Termin nach der Information weiter, meldet die App den Auftrag erneut und empfiehlt den Anruf");

  // 10. Terminverlauf in der Planung: Tippfehler kurz nacheinander zählen als eine Änderung, zurück auf den alten Termin löscht sie
  const pid = await mk("A09005", day(30), "dmu50", 4);
  await api("PUT", "/api/orders/" + pid, { due: day(31) });
  await api("PUT", "/api/orders/" + pid, { due: day(37), due_reason: "Kunde wünscht später" });
  orders = (await api("GET", "/api/orders")).orders;
  let p = orders.find((o) => o.id === pid);
  assert.equal(p.due, day(37));
  assert.equal(p.due_original, day(30));
  assert.equal(p.due_shifts, 1);
  h = (await api("GET", "/api/orders/" + pid + "/due-history")).history;
  assert.equal(h.length, 1, JSON.stringify(h));
  assert.equal(h[0].reason, "Kunde wünscht später");
  await api("PUT", "/api/orders/" + pid, { due: day(30) });
  orders = (await api("GET", "/api/orders")).orders;
  p = orders.find((o) => o.id === pid);
  assert.equal(p.due_shifts, 0);
  assert.equal(p.due_original, null);
  assert.equal((await api("GET", "/api/orders/" + pid + "/due-history")).history.length, 0);
  r = await api("POST", "/api/orders/due", { ids: [pid], due: day(44), reason: "Material verspätet" });
  assert.equal(r.status, 200, JSON.stringify(r));
  h = (await api("GET", "/api/orders/" + pid + "/due-history")).history;
  assert.equal(h.length, 1);
  assert.equal(h[0].from, day(30));
  assert.equal(h[0].to, day(44));
  ok("Terminverlauf: Korrekturen kurz nacheinander sind eine Änderung, zurück auf den alten Termin löscht sie, der Grund steht dabei");

  // 11. Erledigter Auftrag verschwindet aus der Liste
  await api("PUT", "/api/orders/" + row("FA01309").id, { done: true });
  w = await api("GET", "/api/fruehwarnung");
  assert.ok(!item(w, "A01385"));
  ok("Ist der Auftrag erledigt, verschwindet er aus der Frühwarnung");

  // 12. Odoo wurde nur gelesen
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
