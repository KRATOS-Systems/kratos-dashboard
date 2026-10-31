// Prüft den gemeinsamen Abfrage-Takt (src/poll.js) mit einem nachgebauten Browser: Hintergrund, Rückkehr, Abmeldung (401).
// Start: node scripts/testPoll.mjs

import assert from "node:assert/strict";

// Browser nachbauen: Sichtbarkeit und fetch
const doc = Object.assign(new EventTarget(), { hidden: false });
let nextStatus = 200;
globalThis.document = doc;
globalThis.window = { fetch: async () => ({ status: nextStatus }) };
globalThis.fetch = globalThis.window.fetch;
const { pollEvery } = await import("../src/poll.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (hidden) => {
  doc.hidden = hidden;
  doc.dispatchEvent(new Event("visibilitychange"));
};
let n = 0;
const ok = (t) => console.log(`  ✓ ${++n}. ${t}`);

console.log("Abfrage-Takt");

// 1. läuft im Takt, solange das Fenster sichtbar ist
let calls = 0;
let stop = pollEvery(() => calls++, 30);
await wait(140);
assert.ok(calls >= 3, `calls=${calls}`);
ok("Im Vordergrund wird im Takt abgefragt");

// 2. im Hintergrund wird nicht abgefragt
show(true);
const before = calls;
await wait(140);
assert.equal(calls, before);
ok("Im Hintergrund wird nicht abgefragt");

// 3. Zurückkehren lädt sofort, wenn die letzte Abfrage länger her ist als 5 Sekunden; sonst nicht doppelt
const realNow = Date.now;
Date.now = () => realNow() + 6000;
const c0 = calls;
show(false);
assert.equal(calls, c0 + 1);
ok("Beim Zurückkehren wird sofort neu geladen");
const c1 = calls;
show(true);
show(false);
assert.equal(calls, c1);
ok("Wechselt man schnell hin und her, wird nicht doppelt geladen");
Date.now = realNow;

// 4. nach dem Aufräumen ist Ruhe
stop();
const c2 = calls;
await wait(120);
show(true);
show(false);
assert.equal(calls, c2);
ok("Nach dem Aufräumen wird nichts mehr abgefragt");

// 5. dreimal 401 hintereinander: Abfragen hören auf, bis man zurückkehrt
calls = 0;
nextStatus = 401;
stop = pollEvery(async () => {
  calls++;
  await globalThis.window.fetch("/api/test");
}, 30);
await wait(300);
assert.equal(calls, 3, `calls=${calls}`);
ok("Nach dreimal 401 hintereinander wird nicht weiter abgefragt");

// 6. Rückkehr gibt einen neuen Versuch, und ist die Anmeldung wieder da, läuft es weiter
nextStatus = 200;
show(true);
show(false);
await wait(150);
assert.ok(calls > 3, `calls=${calls}`);
ok("Nach der Rückkehr wird erneut versucht und läuft bei 200 wieder normal weiter");
stop();

console.log(`\nAlle ${n} Prüfungen bestanden`);
