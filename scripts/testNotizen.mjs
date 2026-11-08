// Prüft die eigenen To-dos und Notizen ("Mein Arbeitsplatz", server/meineNotizen.js) gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testNotizen.mjs   (startet Test-Odoo und Server selbst auf Port 8080 und 3063, mit leerer Wegwerf-Datenbank)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const ODOO_PORT = 8080;
const APP_PORT = 3063;
const dir = mkdtempSync(path.join(tmpdir(), "notizen-"));
const env = {
  ...process.env,
  MOCK_PORT: String(ODOO_PORT),
  PORT: String(APP_PORT),
  DB_PATH: path.join(dir, "test.db"),
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
  const r = await fetch(`http://localhost:${APP_PORT}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body && method !== "GET" ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await r.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, text, ...json };
}
const login = async (id, pin) => {
  cookie = "";
  assert.equal((await api("POST", "/api/bde/login", { id, pin })).status, 200);
};
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://localhost:${APP_PORT}/api/bde/session`);
      break;
    } catch {
      await wait(250);
    }
  }
  console.log("Eigene To-dos und Notizen (Test-Odoo)");

  // Ohne Anmeldung nichts
  for (const [m, u] of [["GET", "/api/ich/todos"], ["POST", "/api/ich/todos"], ["GET", "/api/ich/notizen"], ["POST", "/api/ich/notizen"], ["DELETE", "/api/ich/todos/1"], ["PATCH", "/api/ich/notizen/1"]]) {
    assert.equal((await api(m, u, { text: "x" })).status, 401, `${m} ${u}`);
  }
  ok("Ohne Anmeldung sind To-dos und Notizen gesperrt");

  // Aurel (2) legt To-dos an
  await login(2, "2222");
  let r = await api("POST", "/api/ich/todos", { text: "  Spannmittel prüfen  ", due: "2099-05-01" });
  assert.equal(r.status, 200, r.text);
  const t1 = r.id;
  assert.equal((await api("POST", "/api/ich/todos", { text: "Ohne Frist" })).status, 200);
  assert.equal((await api("POST", "/api/ich/todos", { text: "Früher dran", due: "2099-01-02" })).status, 200);
  r = await api("GET", "/api/ich/todos");
  assert.deepEqual(r.open.map((x) => x.text), ["Früher dran", "Spannmittel prüfen", "Ohne Frist"]);
  assert.equal(r.open[1].due, "2099-05-01");
  assert.match(r.today, /^\d{4}-\d{2}-\d{2}$/);
  ok("Aurel legt drei To-dos an: Text wird gekürzt, Reihenfolge nach Frist, ohne Frist zuletzt");

  // Eingaben prüfen
  assert.equal((await api("POST", "/api/ich/todos", { text: "   " })).status, 400);
  assert.equal((await api("POST", "/api/ich/todos", { text: "Falsches Datum", due: "31.12.2099" })).status, 400);
  assert.equal((await api("POST", "/api/ich/todos", { text: "Gibt es nicht", due: "2099-02-30" })).status, 400);
  assert.equal((await api("PATCH", `/api/ich/todos/${t1}`, { text: "" })).status, 400);
  assert.equal((await api("POST", "/api/ich/notizen", { text: "  " })).status, 400);
  ok("Leerer Text, falsches oder unmögliches Datum werden abgelehnt");

  // Erledigen, wieder öffnen, ändern
  assert.equal((await api("PATCH", `/api/ich/todos/${t1}`, { done: true })).status, 200);
  r = await api("GET", "/api/ich/todos");
  assert.equal(r.open.length, 2);
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].text, "Spannmittel prüfen");
  assert.ok(r.done[0].doneAt);
  assert.equal((await api("PATCH", `/api/ich/todos/${t1}`, { done: false, due: "2099-06-01", text: "Spannmittel bestellen" })).status, 200);
  r = await api("GET", "/api/ich/todos");
  assert.equal(r.done.length, 0);
  assert.equal(r.open.find((x) => x.id === t1).text, "Spannmittel bestellen");
  assert.equal(r.open.find((x) => x.id === t1).due, "2099-06-01");
  assert.equal((await api("PATCH", `/api/ich/todos/${t1}`, { due: null })).status, 200);
  assert.equal((await api("GET", "/api/ich/todos")).open.find((x) => x.id === t1).due, null);
  ok("Erledigen, wieder öffnen, Text und Frist ändern, Frist entfernen");

  // Notizen
  r = await api("POST", "/api/ich/notizen", { title: "Bohrbild", text: "Zeile 1\r\nZeile 2" });
  assert.equal(r.status, 200, r.text);
  const n1 = r.id;
  r = await api("POST", "/api/ich/notizen", { text: "Zweite Notiz ohne Titel" });
  const n2 = r.id;
  let list = (await api("GET", "/api/ich/notizen")).items;
  assert.deepEqual(list.map((x) => x.id), [n2, n1]);
  assert.equal(list[1].text, "Zeile 1\nZeile 2");
  assert.equal((await api("PATCH", `/api/ich/notizen/${n1}`, { pinned: true })).status, 200);
  list = (await api("GET", "/api/ich/notizen")).items;
  assert.deepEqual(list.map((x) => x.id), [n1, n2]);
  assert.equal(list[0].pinned, true);
  assert.equal((await api("PATCH", `/api/ich/notizen/${n2}`, { title: "Titel nachgetragen", text: "Geändert" })).status, 200);
  list = (await api("GET", "/api/ich/notizen")).items;
  assert.equal(list.find((x) => x.id === n2).title, "Titel nachgetragen");
  assert.equal(list.find((x) => x.id === n2).text, "Geändert");
  ok("Notizen anlegen, anheften (steht oben), Titel und Text ändern");

  // Frank (3) sieht nichts von Aurel und kann nichts anfassen
  await login(3, "3333");
  assert.equal((await api("GET", "/api/ich/todos")).open.length, 0);
  assert.equal((await api("GET", "/api/ich/notizen")).items.length, 0);
  assert.equal((await api("PATCH", `/api/ich/todos/${t1}`, { done: true })).status, 404);
  assert.equal((await api("DELETE", `/api/ich/todos/${t1}`)).status, 404);
  assert.equal((await api("PATCH", `/api/ich/notizen/${n1}`, { text: "gekapert" })).status, 404);
  assert.equal((await api("DELETE", `/api/ich/notizen/${n1}`)).status, 404);
  assert.equal((await api("GET", "/api/ich/todos?id=2")).open.length, 0);
  ok("Frank (auch als Leitung) sieht Aurels To-dos und Notizen nicht und kann sie weder ändern noch löschen");

  // Das JSON-Backup enthält keine privaten Notizen
  const backup = await api("GET", "/api/backup");
  assert.equal(backup.status, 200);
  assert.ok(!backup.text.includes("Bohrbild") && !backup.text.includes("Spannmittel"), "Backup darf keine privaten Einträge enthalten");
  ok("Das JSON-Backup (/api/backup) enthält keine privaten Einträge");

  // Löschen
  await login(2, "2222");
  assert.equal((await api("DELETE", `/api/ich/todos/${t1}`)).status, 200);
  assert.equal((await api("DELETE", `/api/ich/notizen/${n1}`)).status, 200);
  assert.equal((await api("DELETE", `/api/ich/notizen/${n1}`)).status, 404);
  assert.equal((await api("GET", "/api/ich/todos")).open.some((x) => x.id === t1), false);
  ok("Löschen klappt, ein zweites Mal gibt 404");

  console.log(`\nAlle ${n} Prüfungen bestanden.`);
} catch (err) {
  console.error("\nFEHLER:", err.message);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  await wait(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
