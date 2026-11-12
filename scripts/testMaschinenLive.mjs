// Prüft die Live-Ampel (server/maschinenLive.js + server/bdeAmpel.js): Zustandslogik, Eingang mit Schlüssel, Ampel mit Live-Daten.
// Nur gegen das Test-Odoo (scripts/mockOdoo.mjs) mit Wegwerf-Datenbank.
// Start:  node scripts/testMaschinenLive.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { ampelZustand, sauber } from "../server/maschinenLive.js";

let n = 0;
const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- reine Logik
console.log("Live-Ampel: Zustandslogik");
const NOW = Date.parse("2026-11-12T10:00:00+01:00");
const vor = (min) => new Date(NOW - min * 60000).toISOString();
const L = (zustand, seitMin, extra = {}) => ({ zustand, seit: vor(seitMin), programm: "A2.H", ...extra });
const F = [{ step: "Fräsen" }];
const R = [{ step: "Rüsten" }];
const o = { working: true, waiting: 1, now: NOW };

assert.deepEqual(ampelZustand("lauf", F, null, o), { state: "lauf", quelle: "stempel", hinweis: null });
assert.equal(ampelZustand("steht", [], L("offline", 3), o).quelle, "stempel");
assert.equal(ampelZustand("steht", [], L("keine_daten", 3), o).quelle, "stempel");
ok("Ohne Live-Daten, offline oder ohne Statusdaten zählt wie bisher der Stempel");

assert.deepEqual(ampelZustand("lauf", F, L("laeuft", 30), o), { state: "lauf", quelle: "maschine", hinweis: null });
assert.equal(ampelZustand("lauf", F, L("unterbrochen", 2), o).state, "pause");
assert.equal(ampelZustand("lauf", F, L("stoerung", 1), o).state, "stoerung");
assert.equal(ampelZustand("ruesten", R, L("bereit", 40), o).state, "ruesten");
ok("Läuft → grün, unterbrochen → gelb, Störung → rot, Rüsten gestempelt → gelb");

let z = ampelZustand("lauf", F, L("bereit", 20), o);
assert.equal(z.state, "steht");
assert.match(z.hinweis, /Fräsen ist gestempelt.*seit 20 min/);
z = ampelZustand("lauf", F, L("bereit", 5), o);
assert.equal(z.state, "ruesten");
assert.equal(z.hinweis, null);
ok("Fräsen gestempelt, Maschine steht: erst gelb, ab 15 min rot mit Hinweis");

z = ampelZustand("frei", [], L("laeuft", 12), o);
assert.equal(z.state, "lauf");
assert.match(z.hinweis, /arbeitet seit 12 min \(A2\.H\), aber es ist kein Fräsen gestempelt/);
assert.equal(ampelZustand("frei", [], L("laeuft", 2), o).hinweis, null);
ok("Maschine läuft ohne Fräsen-Stempel: ab 5 min Hinweis");

assert.equal(ampelZustand("steht", [], L("bereit", 60), o).state, "steht");
assert.equal(ampelZustand("frei", [], L("bereit", 60), { ...o, waiting: 0 }).state, "frei");
assert.equal(ampelZustand("frei", [], L("bereit", 60), { ...o, working: false }).state, "frei");
ok("Maschine bereit: rot nur in der Arbeitszeit mit wartender Arbeit, sonst keine Lampe");

const s = sauber({ id: "dmu40", zustand: "laeuft", programm: "A2.H", werkzeug: 310, spindel: "rechts", vorschub_override: 99.25, achsen: { X: 1.5, "<b>": 2, Y: "x" }, fehler: ["a", "b", "c", "d", "e", "f"], boese: "<script>" });
assert.equal(s.werkzeug, 310);
assert.deepEqual(s.achsen, { X: 1.5 });
assert.equal(s.fehler.length, 5);
assert.equal(s.boese, undefined);
assert.equal(sauber({ id: "unbekannt", zustand: "laeuft" }), null);
assert.equal(sauber({ id: "dmu50", zustand: "explodiert" }).zustand, "keine_daten");
ok("Eingangsdaten werden bereinigt: unbekannte Maschinen, Felder und Werte fallen weg");

// ---------------------------------------------------------------- Server
const ODOO_PORT = 8074;
const APP_PORT = 3058;
const KEY = "k".repeat(32);
const dir = mkdtempSync(path.join(tmpdir(), "maschinenlive-"));
const env = {
  ...process.env,
  MOCK_PORT: String(ODOO_PORT),
  PORT: String(APP_PORT),
  DB_PATH: path.join(dir, "test.db"),
  BACKUP_AUTO: "0",
  BDE_ODOO_URL: `http://localhost:${ODOO_PORT}`,
  BDE_ODOO_API_KEY: "test",
  BDE_SECRET: "testgeheimnis",
  ODOO_URL: "",
  ODOO_API_KEY: "",
  MASCHINEN_KEY: KEY,
  APP_PASSWORD: "geheim",
};
const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, stdio: "ignore" })];
const base = `http://localhost:${APP_PORT}`;
const auth = { Authorization: "Basic " + Buffer.from("kratos:geheim").toString("base64") };
const post = (body, key) => fetch(`${base}/api/maschinen/eingang`, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-Maschinen-Key": key } : {}) }, body: JSON.stringify(body) });

try {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${base}/login`);
      break;
    } catch {
      await wait(250);
    }
  }
  console.log("Live-Ampel: Server");
  const paket = { maschinen: [{ id: "dmu40", zustand: "laeuft", seit: new Date(Date.now() - 60000).toISOString(), programm: "A2.H", zeile: 91053, werkzeug: 310, spindel: "rechts", vorschub_override: 99.25 }] };
  assert.equal((await post(paket)).status, 401);
  assert.equal((await post(paket, "falsch".repeat(6))).status, 401);
  ok("Eingang ohne oder mit falschem Schlüssel wird abgelehnt");

  const r = await post(paket, KEY);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).maschinen, ["dmu40"]);
  ok("Eingang mit Schlüssel geht, auch ohne App-Passwort (Dienst hat keins)");

  assert.equal((await fetch(`${base}/api/maschinen/live`)).status === 200, false);
  const live = await (await fetch(`${base}/api/maschinen/live`, { headers: auth })).json();
  assert.equal(live.aktuell, true);
  assert.equal(live.maschinen.dmu40.programm, "A2.H");
  ok("Lesen der Live-Daten nur mit App-Anmeldung");

  const amp = await (await fetch(`${base}/api/maschinen/ampel?fresh=1`, { headers: auth })).json();
  assert.equal(amp.live, true);
  assert.equal(amp.machines.dmu40.quelle, "maschine");
  assert.equal(amp.machines.dmu40.state, "lauf");
  assert.equal(amp.machines.dmu40.live.werkzeug, 310);
  assert.equal(amp.machines.m1.quelle, "stempel");
  ok("Ampel: DMU 40 kommt von der Maschine, DMG M1 (ohne Live-Daten) weiter vom Stempel");

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
    /* Wegwerfordner */
  }
}
