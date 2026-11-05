// Prüft "Von mir vergeben" (Aufgaben, die man selbst vergeben hat) gegen das Test-Odoo (scripts/mockOdoo.mjs), nie gegen die echte Instanz.
// Auch Aufgaben, die die Kalkulation vergibt ("… über Kratos Kalkulation"), müssen dort erscheinen.
// Start: node scripts/testAufgaben.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { assignerName } from "../server/bdeQuestions.js";

const ODOO_PORT = 8079;
const APP_PORT = 3062;
const dir = mkdtempSync(path.join(tmpdir(), "aufgaben-"));
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
  const r = await fetch(`http://localhost:${APP_PORT}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const mock = async (model, method, p) => {
  const r = await fetch(`http://localhost:${ODOO_PORT}/json/2/${model}/${method}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "bearer test" }, body: JSON.stringify(p) });
  assert.ok(r.ok, `Test-Odoo ${model}.${method}: ${r.status}`);
  return r.json();
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
  console.log("Aufgaben: Von mir vergeben (Test-Odoo)");

  // Der Vergebende wird aus dem Vermerk gelesen, egal ob die Aufgabe aus der BDE oder der Kalkulation kommt
  assert.equal(assignerName("<p>Vergeben von Frank Häckl über Kratos BDE</p>"), "Frank Häckl");
  assert.equal(assignerName("<p>Vergeben von Alexander Meimeteas über Kratos Kalkulation</p>"), "Alexander Meimeteas");
  assert.equal(assignerName("<p>Bohrbild abgleichen</p>"), null);
  ok("Vergebender wird bei BDE- und Kalkulations-Vermerk erkannt, ohne Vermerk nicht");

  // Alexander (Odoo-Benutzer 2) vergibt zwei Aufgaben: eine über die BDE, eine über die Kalkulation; Frank vergibt eine, eine ist erledigt
  const act = (summary, note, extra = {}) => ({ activity_type_id: 1, user_id: 25, create_uid: 2, summary, note, date_deadline: "2099-01-01", res_model: "sale.order", res_id: 1, res_name: "A01458", date_done: false, ...extra });
  await mock("mail.activity", "create", {
    vals_list: [
      act("Spannmittel bestellen", "<p>Vergeben von Alexander Meimeteas über Kratos BDE</p>", { res_name: "FA01070", res_model: "mrp.production" }),
      act("DRINGEND · Kalkulation prüfen: A01458 (2 Teile)", "<p>Vergeben von Alexander Meimeteas über Kratos Kalkulation</p>"),
      act("Fremde Aufgabe", "<p>Vergeben von Frank Häckl über Kratos Kalkulation</p>"),
      act("Schon erledigt", "<p>Vergeben von Alexander Meimeteas über Kratos Kalkulation</p>", { date_done: "2099-01-02" }),
      act("Von Hand in Odoo", "<p>Bohrbild abgleichen</p>"),
    ],
  });
  ok("Test-Odoo hat fünf Aufgaben: zwei von Alexander (BDE, Kalkulation), eine von Frank, eine erledigte, eine ohne Vermerk");

  assert.equal((await api("POST", "/api/bde/login", { id: 1, pin: "1111" })).status, 200);
  const r = await api("GET", "/api/bde/aufgaben/vergeben");
  assert.equal(r.status, 200, JSON.stringify(r));
  const texts = r.items.map((i) => i.summary).sort();
  assert.deepEqual(texts, ["Kalkulation prüfen: A01458 (2 Teile)", "Spannmittel bestellen"]);
  assert.ok(r.items.find((i) => i.summary.startsWith("Kalkulation")).urgent);
  assert.equal(r.items.find((i) => i.summary.startsWith("Kalkulation")).resName, "A01458");
  ok("Von mir vergeben zeigt die BDE- und die Kalkulations-Aufgabe (mit Dringend und Bezug A01458), nicht fremde, erledigte oder ohne Vermerk");

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
