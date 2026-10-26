// Planungswerkzeuge für Talos mit festen Testdaten: node --test server/talosPlan.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTools } from "./talosPlan.js";

// Montag 2026-10-26, Normalschicht 60 h x 100 % = 10 h je Arbeitstag (Mo–Sa)
const order = (id, machine, position, hours, due, source) => ({
  id, machine, position, hours, done_hours: 0, due, done: false, order_no: `FA0${id}`, source, extern_tags: [], extern_days: 7,
});
const inputs = (orders) => () => ({
  orders,
  rates: {},
  weekCap: { "2026-10-26": 60 },
  freeDays: [],
  checks: new Map(),
  settings: { utilization: 100, tight_days: 2, av_lead_days: 2 },
  today: "2026-10-26",
});
const base = [
  order(1, "dmu40", 0, 20, "2026-10-28", "A01"), // Mo+Di → fertig Di, Termin Mi
  order(2, "dmu40", 1, 20, "2026-11-06", "A02"), // Mi+Do
  order(3, "dmu40", 2, 10, "2026-10-30", "A03"), // Fr, Termin Fr → knapp
];
const tool = (name, orders = base) => planTools(inputs(orders)).find((t) => t.name === name);

test("Übersicht rechnet wie das Planungsfenster", () => {
  const r = tool("plan_uebersicht").run({ maschine: "DMU 40" });
  const q = r.maschinen[0].reihenfolge;
  assert.deepEqual(q.map((p) => [p.fa, p.start, p.ende]), [
    ["FA01", "2026-10-26", "2026-10-27"],
    ["FA02", "2026-10-28", "2026-10-29"],
    ["FA03", "2026-10-30", "2026-10-30"],
  ]);
  assert.equal(q[0].puffer_tage, 1);
  assert.equal(r.auftraege.find((a) => a.auftrag === "A03").status, "knapp");
});

test("Simulation: Eilauftrag vorne verschiebt alle, A03 wird zu spät, A01 knapp (Liefertag zählt mit)", () => {
  const r = tool("plan_simulieren").run({ maschine: "dmu40", platz: 1, neu: { stunden: 10, liefertermin: "2026-10-26", bezeichnung: "EIL" } });
  assert.equal(r.eingeschoben[0].ende, "2026-10-26");
  assert.deepEqual(r.neu_zu_spaet, ["A03"]);
  assert.equal(r.aenderungen.find((c) => c.auftrag === "A01").nachher, "knapp");
  assert.equal(r.aenderungen.find((c) => c.auftrag === "A02").verschiebung_tage, 1);
});

test("Simulation einer vorhandenen Position per FA-Nummer", () => {
  const r = tool("plan_simulieren").run({ maschine: "DMU 40", platz: 1, position: "FA03" });
  assert.equal(r.eingeschoben[0].start, "2026-10-26");
  assert.deepEqual(r.neu_zu_spaet, []);
  assert.equal(r.aenderungen.find((c) => c.auftrag === "A01").nachher_fertig, "2026-10-28");
});

test("Platz finden: bester Platz verspätet keinen anderen Auftrag", () => {
  const r = tool("plan_platz_finden").run({ neu: { stunden: 10, liefertermin: "2026-11-06", bezeichnung: "NEU" }, maschine: "DMU 40" });
  assert.equal(r.gepruefte_varianten, 4);
  const best = r.beste[0];
  assert.deepEqual(best.andere_neu_zu_spaet, []);
  assert.equal(best.eigener_auftrag.status !== "zu spät", true);
  // vor A03 einschieben würde A03 verspäten → darf nicht die beste Variante sein
  assert.notEqual(best.platz, 3);
});

test("Unbekannte Maschine und fehlende Angaben werden abgelehnt", () => {
  assert.throws(() => tool("plan_simulieren").run({ maschine: "Hermle", platz: 1, neu: { stunden: 1 } }), /unbekannt/);
  assert.throws(() => tool("plan_simulieren").run({ maschine: "M1", platz: 1 }), /Entweder/);
  assert.throws(() => tool("plan_simulieren").run({ maschine: "M1", platz: 1, position: "FA99" }), /Keine offene Position/);
});

test("AV und Material: offene Punkte je Position, dringendste zuerst", () => {
  const ready = (id) => ["material", "programm", "werkzeuge", "spannmittel"].map((item) => [`${id}|${item}`, { status: "bereit" }]);
  const checks = new Map([
    ...ready(1),
    ...ready(2).filter(([k]) => !k.endsWith("material")),
    ["2|material", { status: "in_arbeit", due: "2026-10-27", assignee: "Nino", note: "bei EHG bestellt" }],
    ...ready(3),
  ]);
  const tools = planTools(() => ({ ...inputs(base)(), checks }));
  const r = tools.find((t) => t.name === "plan_av_material").run({ nur_material: true });
  assert.equal(r.anzahl, 1);
  assert.equal(r.positionen[0].fa, "FA02");
  assert.equal(r.positionen[0].start, "2026-10-28");
  assert.match(r.positionen[0].offen[0], /^Material, in Arbeit, bis 2026-10-27, Nino, „bei EHG bestellt“$/);
  const u = tools.find((t) => t.name === "plan_uebersicht").run({ maschine: "DMU 40" });
  assert.equal(u.maschinen[0].reihenfolge[0].av.bereit, true);
  assert.equal(u.maschinen[0].reihenfolge[1].av.bereit, false);
});
