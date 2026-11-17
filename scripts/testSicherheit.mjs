// Prüft die Sicherheits-Grundlagen: ohne Passwort von außen gesperrt, Lebenszeichen ohne Anmeldung, Sperre nach Fehlversuchen nicht mit
// erfundener Adresse umgehbar (auch Basic und PIN), Datensicherung nur für Leitung (PIN) oder Sicherungs-Skript (Basic).
// Läuft mit Wegwerf-Datenbanken und dem Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Start: node scripts/testSicherheit.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "sicherheit-"));
const base = { ...process.env, BACKUP_AUTO: "0", ODOO_URL: "", ODOO_API_KEY: "", BDE_SECRET: "testgeheimnis", APP_OFFEN: "" };
const procs = [
  // A: ohne Passwort
  spawn("node", ["server/index.js"], { env: { ...base, PORT: "3067", DB_PATH: path.join(dir, "a.db"), APP_PASSWORD: "", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "" }, stdio: "ignore" }),
  // B: mit Passwort und Test-Odoo für die PIN-Anmeldung
  spawn("node", ["scripts/mockOdoo.mjs"], { env: { ...base, MOCK_PORT: "8083" }, stdio: "ignore" }),
  spawn("node", ["server/index.js"], { env: { ...base, PORT: "3068", DB_PATH: path.join(dir, "b.db"), APP_USER: "kratos", APP_PASSWORD: "geheim-test", BDE_ODOO_URL: "http://localhost:8083", BDE_ODOO_API_KEY: "test" }, stdio: "ignore" }),
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (port, method, url, { headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: url, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
const basic = (p) => ({ authorization: "Basic " + Buffer.from(`kratos:${p}`).toString("base64") });
const xff = (chain) => ({ "x-forwarded-for": chain });
const json = { "content-type": "application/json" };
const cookieOf = (res) => (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);
try {
  for (let i = 0; i < 60; i++) {
    const up = await Promise.all([req(3067, "GET", "/health"), req(3068, "GET", "/health"), req(8083, "GET", "/__log")]).then(() => true, () => false);
    if (up) break;
    await wait(500);
  }
  console.log("Sicherheit (Wegwerf-Datenbanken, Test-Odoo)");

  // 1. Ohne Passwort: direkt auf dem Rechner offen, über einen Proxy (von außen) gesperrt
  let r = await req(3067, "GET", "/api/orders");
  assert.equal(r.status, 200);
  r = await req(3067, "GET", "/api/orders", { headers: xff("203.0.113.5") });
  assert.equal(r.status, 503, r.text);
  assert.match(r.text, /APP_PASSWORD/);
  ok("Ohne APP_PASSWORD ist die App von außen gesperrt, direkt auf dem Rechner (Entwicklung, Tests) offen");

  // 2. Lebenszeichen ohne Anmeldung, ohne Daten
  r = await req(3068, "GET", "/health");
  assert.equal(r.status, 200);
  const h = JSON.parse(r.text);
  assert.equal(h.ok, true);
  assert.equal(h.datenDauerhaft, true);
  assert.equal(Object.keys(h).sort().join(","), "datenDauerhaft,ok,zeit");
  r = await req(3068, "GET", "/api/orders");
  assert.equal(r.status, 401);
  ok("/health antwortet ohne Anmeldung (ok, Zeit, ob die Daten dauerhaft liegen), alles andere braucht die Anmeldung");

  // 3. Sperre nach Fehlversuchen: eine erfundene Adresse vorne in X-Forwarded-For hilft nicht (es zählt der letzte Eintrag, den der Proxy setzt)
  for (let i = 0; i < 8; i++) await req(3068, "GET", "/api/orders", { headers: { ...basic("falsch" + i), ...xff(`10.0.0.${i}, 198.51.100.7`) } });
  r = await req(3068, "GET", "/api/orders", { headers: { ...basic("geheim-test"), ...xff("10.9.9.9, 198.51.100.7") } });
  assert.equal(r.status, 429, "Adresse muss gesperrt sein: " + r.status);
  r = await req(3068, "GET", "/api/orders", { headers: { ...basic("geheim-test"), ...xff("198.51.100.8") } });
  assert.equal(r.status, 200, "andere echte Adresse ist nicht gesperrt");
  ok("Falsche Basic-Anmeldungen sperren die echte Adresse, eine vorgetäuschte Adresse umgeht die Sperre nicht");

  // 4. Datensicherung: mit Anmelde-Cookie allein verboten, mit PIN der Leitung oder als Skript (Basic) erlaubt
  r = await req(3068, "POST", "/login", { headers: { "content-type": "application/x-www-form-urlencoded", ...xff("198.51.100.20") }, body: "password=geheim-test&next=%2F" });
  const app = cookieOf(r);
  assert.match(app, /kratos_sess=/);
  r = await req(3068, "GET", "/api/backup", { headers: { cookie: app, ...xff("198.51.100.20") } });
  assert.equal(r.status, 403, r.text);
  r = await req(3068, "POST", "/api/restore", { headers: { cookie: app, ...json, ...xff("198.51.100.20") }, body: JSON.stringify({ backup: {}, dryRun: true }) });
  assert.equal(r.status, 403);
  r = await req(3068, "GET", "/api/backup/auto/latest", { headers: { cookie: app, ...xff("198.51.100.20") } });
  assert.equal(r.status, 403);
  r = await req(3068, "GET", "/api/backup", { headers: { ...basic("geheim-test"), ...xff("198.51.100.21") } });
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.text).app === "kratos-dashboard");
  // Mitarbeiter ohne Leitung (Aurel) darf nicht, Leitung (Frank) darf
  r = await req(3068, "POST", "/api/bde/login", { headers: { cookie: app, ...json, ...xff("198.51.100.20") }, body: JSON.stringify({ id: 2, pin: "2222" }) });
  assert.equal(r.status, 200, r.text);
  r = await req(3068, "GET", "/api/backup", { headers: { cookie: app + "; " + cookieOf(r), ...xff("198.51.100.20") } });
  assert.equal(r.status, 403);
  r = await req(3068, "POST", "/api/bde/login", { headers: { cookie: app, ...json, ...xff("198.51.100.20") }, body: JSON.stringify({ id: 3, pin: "3333" }) });
  assert.equal(r.status, 200, r.text);
  const leitung = app + "; " + cookieOf(r);
  r = await req(3068, "GET", "/api/backup", { headers: { cookie: leitung, ...xff("198.51.100.20") } });
  assert.equal(r.status, 200);
  ok("Datensicherung und Einspielen: nur Leitung mit PIN oder das Sicherungs-Skript (Basic), nicht jeder mit dem App-Passwort");

  // 5. Falsche PINs sperren den Mitarbeiter und die echte Adresse, aber nicht alle anderen Geräte
  for (let i = 0; i < 5; i++) await req(3068, "POST", "/api/bde/login", { headers: { cookie: app, ...json, ...xff(`10.1.1.${i}, 198.51.100.30`) }, body: JSON.stringify({ id: 11, pin: "9999" }) });
  r = await req(3068, "POST", "/api/bde/login", { headers: { cookie: app, ...json, ...xff("198.51.100.30") }, body: JSON.stringify({ id: 1, pin: "1111" }) });
  assert.equal(r.status, 429, "dieses Gerät ist gesperrt: " + r.text);
  r = await req(3068, "POST", "/api/bde/login", { headers: { cookie: app, ...json, ...xff("198.51.100.31") }, body: JSON.stringify({ id: 1, pin: "1111" }) });
  assert.equal(r.status, 200, "anderes Gerät nicht gesperrt: " + r.text);
  ok("Fünf falsche PINs sperren Mitarbeiter und Gerät, andere Geräte in der Halle können sich weiter anmelden");

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
