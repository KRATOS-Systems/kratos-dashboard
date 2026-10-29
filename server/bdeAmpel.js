// Maschinenampel: wie eine Signalleuchte an der Maschine, aber aus den Stempelungen in Odoo.
//   grün  = auf der Maschine läuft gerade ein Fräsen
//   gelb  = es wird gerüstet (und es läuft kein Fräsen)
//   rot   = nichts läuft, obwohl Arbeitszeit ist und in der Planung noch Arbeit für die Maschine wartet
//   keine Lampe = nichts läuft und das ist in Ordnung (Nacht, Wochenende oder keine Arbeit offen)
// Die Ampel zeigt, was gestempelt ist, nicht, was die Maschine wirklich tut. Nur lesen (Odoo und Planungsdatenbank), ohne Anmeldung wie die Planung selbst.

import { m2o, parseOdoo, stepOf } from "./bde.js";

const MACHINES = ["dmu40", "dmu50", "m1", "h800u"];
const BY_WORKCENTER = { "DMU 40 EVO": "dmu40", "DMU 50": "dmu50", "DMG M1": "m1", "POS H 800 U": "h800u" };
const TTL_MS = 20 * 1000;
const WORK_FROM = 6; // Arbeitszeit: Montag bis Freitag 6 bis 22 Uhr
const WORK_TO = 22;

function workingNow(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(now).map((x) => [x.type, x.value])
  );
  const hour = Number(p.hour) % 24;
  return !["Sat", "Sun"].includes(p.weekday) && hour >= WORK_FROM && hour < WORK_TO;
}

export default function registerBdeAmpel(app, db, ctx) {
  const { odoo } = ctx;
  let cache = { at: 0, data: null };

  // Maschine des Arbeitsplatzes ("DMU 40 EVO", "DMU 40 EVO Rüsten"); beim Sammelplatz FRÄSEN/RÜSTEN gilt die Maschine aus der Planung
  const machineOfCenter = (name) => BY_WORKCENTER[String(name || "").replace(/\s+Rüsten$/i, "").trim().toUpperCase()] || null;
  const planned = db.prepare("SELECT machine FROM orders WHERE odoo_id = ? AND done = 0 AND is_split = 0 LIMIT 1");
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE machine = ? AND done = 0");

  async function compute() {
    await ctx.ensureEmployees();
    const lines = await odoo.read("mrp.workcenter.productivity", "search_read", {
      domain: [["date_end", "=", false]],
      fields: ["workorder_id", "workcenter_id", "production_id", "employee_id", "date_start"],
      limit: 200,
    });
    const woIds = [...new Set(lines.map((l) => m2o(l.workorder_id)?.id).filter(Boolean))];
    const wos = woIds.length ? await odoo.read("mrp.workorder", "read", { ids: woIds, fields: ["name", "workcenter_id"] }) : [];
    const woName = new Map(wos.map((w) => [w.id, w.name]));
    const names = new Map([...ctx.employees()].map(([id, e]) => [id, e.name]));
    const runs = [];
    for (const l of lines) {
      const wo = m2o(l.workorder_id);
      const wc = m2o(l.workcenter_id);
      const step = stepOf(wo ? woName.get(wo.id) : null) || stepOf(wc?.name);
      if (step !== "Fräsen" && step !== "Rüsten") continue;
      const prod = m2o(l.production_id);
      let machine = machineOfCenter(wc?.name);
      if (!machine && prod) {
        const row = planned.get(prod.id);
        if (row && MACHINES.includes(row.machine)) machine = row.machine;
      }
      const emp = m2o(l.employee_id);
      runs.push({
        machine,
        step,
        workorderId: wo ? wo.id : null,
        productionId: prod ? prod.id : null,
        fa: prod ? prod.name : null,
        employeeId: emp ? emp.id : null,
        who: emp ? names.get(emp.id) || emp.name : null,
        start: parseOdoo(l.date_start),
      });
    }
    const working = workingNow();
    const machines = {};
    for (const m of MACHINES) {
      const mine = runs.filter((r) => r.machine === m);
      let state = "frei";
      if (mine.some((r) => r.step === "Fräsen")) state = "lauf";
      else if (mine.some((r) => r.step === "Rüsten")) state = "ruesten";
      else if (working && waiting.get(m).n > 0) state = "steht";
      machines[m] = { state, runs: mine };
    }
    return { at: Date.now(), working, machines, unknown: runs.filter((r) => !r.machine) };
  }

  // fresh=1: nach dem Beenden eines Laufs sofort neu rechnen, sonst höchstens alle 20 Sekunden
  app.get("/api/maschinen/ampel", async (req, res) => {
    try {
      if (!cache.data || req.query.fresh === "1" || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), data: await compute() };
      res.json(cache.data);
    } catch (err) {
      ctx.fail(res, err);
    }
  });
}
