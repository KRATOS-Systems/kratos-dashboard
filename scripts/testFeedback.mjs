// Prüft die Rückmeldungen (server/feedback.js) gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start:  node scripts/testFeedback.mjs   (startet Test-Odoo und Server selbst auf Port 8072 und 3056, mit leerer Wegwerf-Datenbank)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const ODOO_PORT = 8072;
const APP_PORT = 3056;
const dir = mkdtempSync(path.join(tmpdir(), "feedback-"));
const dbPath = path.join(dir, "test.db");
const env = {
  ...process.env,
  MOCK_PORT: String(ODOO_PORT),
  PORT: String(APP_PORT),
  DB_PATH: dbPath,
  BACKUP_AUTO: "0",
  BDE_ODOO_URL: `http://localhost:${ODOO_PORT}`,
  BDE_ODOO_API_KEY: "test",
  BDE_WRITE: "1",
  BDE_SECRET: "testgeheimnis",
  ODOO_URL: "",
  ODOO_API_KEY: "",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = "";
async function api(method, url, body) {
  const r = await fetch(`http://localhost:${APP_PORT}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const type = r.headers.get("content-type") || "";
  return { status: r.status, type, ...(type.includes("json") ? await r.json().catch(() => ({})) : { size: (await r.arrayBuffer()).byteLength }) };
}
let n = 0;
const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);
// kleines gültiges PNG (1x1)
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

try {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://localhost:${APP_PORT}/api/bde/session`);
      break;
    } catch {
      await wait(250);
    }
  }
  console.log("Rückmeldungen (Test-Odoo)");

  // Ohne Anmeldung schreiben geht, lesen nicht
  let r = await api("POST", "/api/feedback", { art: "idee", text: "  Mehr Platz in der Liste  ", page: "#planung", context: { titel: "Planung" } });
  assert.equal(r.status, 200, JSON.stringify(r));
  const anonId = r.id;
  ok("Ohne Anmeldung schreiben geht");
  assert.equal((await api("GET", "/api/feedback/liste")).status, 403);
  assert.equal((await api("GET", "/api/feedback/meine")).status, 401);
  assert.equal((await api("POST", `/api/feedback/${anonId}/status`, { status: "erledigt" })).status, 403);
  assert.equal((await api("GET", "/api/feedback/anzahl")).neu, 0);
  ok("Liste, Eigene, Statuswechsel und Zähler sind ohne Anmeldung gesperrt");

  // Eingaben prüfen
  assert.equal((await api("POST", "/api/feedback", { art: "wut", text: "x" })).status, 400);
  assert.equal((await api("POST", "/api/feedback", { art: "fehler", text: "   " })).status, 400);
  assert.equal((await api("POST", "/api/feedback", { art: "fehler", text: "x".repeat(3001) })).status, 400);
  assert.equal((await api("POST", "/api/feedback", { art: "fehler", text: "Bild kaputt", image: "data:image/png;base64,AAAA" })).status, 400);
  assert.equal((await api("POST", "/api/feedback", { art: "fehler", text: "Falscher Typ", image: "data:text/html;base64,PGI+aGk8L2I+" })).status, 400);
  assert.equal((await api("POST", "/api/feedback", { art: "fehler", text: "Zu groß", image: "data:image/png;base64," + Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG"), Buffer.alloc(1_600_000)]).toString("base64") })).status, 400);
  ok("Falsche Art, leerer oder zu langer Text, kaputtes, falsches und zu großes Bild werden abgelehnt");

  // Aurel (Mitarbeiter, keine Leitung) schreibt mit Bild
  assert.equal((await api("POST", "/api/bde/login", { id: 2, pin: "2222" })).status, 200);
  r = await api("POST", "/api/feedback", { art: "fehler", text: "Aufspannung lässt sich nicht speichern", page: "#platz", image: PNG });
  assert.equal(r.status, 200, JSON.stringify(r));
  const aurelId = r.id;
  let mine = await api("GET", "/api/feedback/meine");
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].hasImage, true);
  assert.ok(mine.items[0].name.length > 0);
  assert.equal(mine.items[0].status, "neu");
  ok("Angemeldeter Mitarbeiter schreibt mit Bild, Name wird eingetragen, er sieht nur seine eigene");

  assert.equal((await api("GET", `/api/feedback/${aurelId}/bild`)).type, "image/png");
  assert.equal((await api("GET", `/api/feedback/${anonId}/bild`)).status, 404);
  assert.equal((await api("GET", "/api/feedback/liste")).status, 403);
  assert.equal((await api("POST", `/api/feedback/${aurelId}/status`, { status: "erledigt" })).status, 403);
  ok("Absender sieht sein Bild, kann aber weder die Liste lesen noch den Status ändern");

  // Frank (Leitung) bearbeitet
  await api("POST", "/api/bde/logout");
  assert.equal((await api("POST", "/api/bde/login", { id: 3, pin: "3333" })).status, 200);
  assert.equal((await api("GET", "/api/feedback/anzahl")).neu, 2);
  const list = await api("GET", "/api/feedback/liste");
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].id, aurelId);
  assert.equal(list.items.find((x) => x.id === anonId).text, "Mehr Platz in der Liste");
  assert.equal((await api("GET", `/api/feedback/${aurelId}/bild`)).status, 200);
  ok("Leitung sieht alle (neueste zuerst, Text gekürzt um Leerzeichen), den Zähler und jedes Bild");

  assert.equal((await api("POST", `/api/feedback/${aurelId}/status`, { status: "arbeit", answer: "Ich schaue es mir an" })).status, 200);
  assert.equal((await api("POST", `/api/feedback/${aurelId}/status`, { status: "kaputt" })).status, 400);
  assert.equal((await api("POST", "/api/feedback/9999/status", { status: "erledigt" })).status, 404);
  assert.equal((await api("GET", "/api/feedback/anzahl")).neu, 1);
  ok("Status und Antwort speichern, unbekannter Status und unbekannte Nummer werden abgelehnt, Zähler sinkt");

  assert.equal((await api("POST", `/api/feedback/${anonId}/status`, { status: "erledigt" })).status, 200);
  const sorted = (await api("GET", "/api/feedback/liste")).items;
  assert.deepEqual(sorted.map((x) => x.status), ["arbeit", "erledigt"]);
  ok("Erledigte stehen in der Liste unten");

  // Aurel sieht die Antwort
  await api("POST", "/api/bde/logout");
  await api("POST", "/api/bde/login", { id: 2, pin: "2222" });
  mine = await api("GET", "/api/feedback/meine");
  assert.equal(mine.items[0].answer, "Ich schaue es mir an");
  assert.equal(mine.items[0].status, "arbeit");
  assert.ok(mine.items[0].answeredBy);
  ok("Der Absender sieht Status und Antwort");

  // Bilder verschwinden nach 90 Tagen, der Text bleibt
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE feedback SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 100 * 86400000).toISOString(), aurelId);
  db.close();
  procs[1].kill();
  await wait(800);
  procs[1] = spawn("node", ["server/index.js"], { env, stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://localhost:${APP_PORT}/api/bde/session`);
      break;
    } catch {
      await wait(250);
    }
  }
  mine = await api("GET", "/api/feedback/meine");
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].hasImage, false);
  assert.equal(mine.items[0].text, "Aufspannung lässt sich nicht speichern");
  ok("Bilder älter als 90 Tage werden beim Start entfernt, der Text bleibt");

  // Zu viele Rückmeldungen von einer Adresse
  let blocked = 0;
  for (let i = 0; i < 12; i++) if ((await api("POST", "/api/feedback", { art: "lob", text: `Lob ${i}` })).status === 429) blocked++;
  assert.ok(blocked >= 1);
  ok("Zu viele Rückmeldungen in kurzer Zeit werden gebremst");

  console.log(`\nAlle ${n} Prüfungen bestanden`);
} catch (err) {
  console.error("FEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  await wait(800);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Wegwerfordner im Temp-Verzeichnis, darf liegen bleiben */
  }
}
