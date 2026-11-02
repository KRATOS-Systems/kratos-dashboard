// Prüft die Anmeldung (server/login.js): Anmeldeseite, Cookie, bisherige Basic-Anmeldung für Skripte, Weiterleitung, Sperre nach Fehlversuchen.
// Start:  node scripts/testLogin.mjs   (startet nur den Server, Port 3057, mit leerer Wegwerf-Datenbank und gesetztem Passwort; vorher "npx vite build")

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

const PORT = 3057;
const dir = mkdtempSync(path.join(tmpdir(), "login-"));
const env = { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, "test.db"), BACKUP_AUTO: "0", APP_USER: "kratos", APP_PASSWORD: "geheim-test", BDE_SECRET: "testgeheimnis", ODOO_URL: "", ODOO_API_KEY: "", BDE_ODOO_URL: "", BDE_ODOO_API_KEY: "" };
const server = spawn("node", ["server/index.js"], { env, stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Ohne fetch, damit der Kopf "sec-fetch-mode" wie im Browser mitgeschickt werden kann
const req = (method, url, { headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: url, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
const form = (o) => new URLSearchParams(o).toString();
const post = (o, headers = {}) => req("POST", "/login", { headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form(o) });
const basic = (u, p) => ({ authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });
const browserNav = { "sec-fetch-mode": "navigate" };
const browserFetch = { "sec-fetch-mode": "cors" };
let n = 0;
const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);
const stop = () => server.kill();
process.on("exit", stop);

try {
  for (let i = 0; i < 40; i++) {
    try {
      await req("GET", "/login");
      break;
    } catch {
      await wait(250);
    }
  }

  let r = await req("GET", "/api/readings");
  assert.equal(r.status, 401);
  assert.match(r.headers["www-authenticate"] || "", /^Basic/);
  ok("Skript ohne Anmeldung: 401 mit Aufforderung zur Basic-Anmeldung");

  r = await req("GET", "/api/readings", { headers: browserFetch });
  assert.equal(r.status, 401);
  assert.equal(r.headers["www-authenticate"], undefined);
  ok("Abfrage aus dem Browser ohne Anmeldung: 401 ohne Anmeldefenster");

  r = await req("GET", "/planung?x=1", { headers: browserNav });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "/login?next=" + encodeURIComponent("/planung?x=1"));
  ok("Seitenaufruf im Browser ohne Anmeldung: Weiterleitung auf /login mit Ziel");

  r = await req("GET", "/login?next=%2Fplanung", { headers: browserNav });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /html/);
  assert.match(r.text, /type="password"/);
  assert.match(r.text, /name="next" value="\/planung"/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.doesNotMatch(r.text, /\{\{/);
  ok("Anmeldeseite ist offen, hat Passwortfeld und merkt sich das Ziel");

  r = await req("GET", "/login?next=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.doesNotMatch(r.text, /<script>alert/);
  r = await req("GET", "/login?next=%2F%2Fboese.de");
  assert.match(r.text, /name="next" value="\/"/);
  ok("Ziel wird nicht ungeprüft in die Seite oder als fremde Adresse übernommen");

  r = await req("GET", "/login-assets/halle.webp");
  assert.equal(r.status, 200);
  ok("Hintergrundbild der Anmeldeseite ist ohne Anmeldung abrufbar");

  r = await post({ password: "falsch", next: "/" });
  assert.equal(r.status, 303);
  assert.match(r.headers.location, /^\/login\?fehler=1/);
  assert.equal(r.headers["set-cookie"], undefined);
  r = await req("GET", r.headers.location);
  assert.match(r.text, /Das Passwort stimmt nicht/);
  ok("Falsches Passwort: zurück zur Seite mit Hinweis, kein Cookie");

  r = await post({ password: "geheim-test", next: "//boese.de" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, "/");
  ok("Richtiges Passwort: Weiterleitung nur auf Ziele dieser Seite");
  const setCookie = r.headers["set-cookie"][0];
  assert.match(setCookie, /^kratos_sess=\d+\.[\w-]+;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=2592000/);
  ok("Cookie ist HttpOnly, SameSite=Lax und 30 Tage gültig");
  const cookie = setCookie.split(";")[0];

  r = await req("GET", "/api/readings", { headers: { cookie, ...browserFetch } });
  assert.equal(r.status, 200);
  r = await req("GET", "/", { headers: { cookie, ...browserNav } });
  assert.equal(r.status, 200);
  ok("Mit Cookie: Daten und Startseite erreichbar");

  r = await req("GET", "/login", { headers: { cookie, ...browserNav } });
  assert.equal(r.status, 303);
  ok("Wer angemeldet ist, kommt von /login direkt weiter");

  const [exp, sig] = cookie.split("=")[1].split(".");
  for (const bad of [`kratos_sess=${exp}.${sig.slice(0, -2)}xx`, `kratos_sess=${Date.now() + 1e10}.${sig}`, `kratos_sess=${Date.now() - 1000}.${sig}`, "kratos_sess=", "kratos_sess=abc"]) {
    r = await req("GET", "/api/readings", { headers: { cookie: bad } });
    assert.equal(r.status, 401, bad);
  }
  ok("Gefälschte, veränderte und abgelaufene Cookies werden abgewiesen");

  r = await req("GET", "/api/readings", { headers: basic("kratos", "geheim-test") });
  assert.equal(r.status, 200);
  r = await req("GET", "/api/readings", { headers: basic("kratos", "falsch") });
  assert.equal(r.status, 401);
  r = await req("GET", "/api/readings", { headers: basic("jemand", "geheim-test") });
  assert.equal(r.status, 401);
  ok("Bisherige Anmeldung mit Benutzername und Passwort funktioniert weiter (Skripte), falsche nicht");

  r = await req("GET", "/logout", { headers: { cookie } });
  assert.equal(r.status, 303);
  assert.match(r.headers["set-cookie"][0], /Max-Age=0/);
  ok("Abmelden löscht das Cookie");

  // Sperre zuletzt: gleiche Adresse für alle Versuche
  let last;
  for (let i = 0; i < 9; i++) last = await post({ password: "falsch" + i, next: "/" });
  assert.match(last.headers.location, /^\/login\?gesperrt=1/);
  r = await post({ password: "geheim-test", next: "/" });
  assert.match(r.headers.location, /^\/login\?gesperrt=1/);
  assert.equal(r.headers["set-cookie"], undefined);
  ok("Nach zu vielen Fehlversuchen ist die Anmeldung kurz gesperrt, auch mit richtigem Passwort");

  console.log(`\nAlle ${n} Prüfungen bestanden.`);
} catch (e) {
  console.error("\nFEHLGESCHLAGEN:", e.message);
  process.exitCode = 1;
} finally {
  stop();
}
