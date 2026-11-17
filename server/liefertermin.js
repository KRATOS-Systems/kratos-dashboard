// Liefertermin für eine Anfrage oder ein Angebot: Wann könnten wir liefern, wenn der Auftrag heute käme?
// Gerechnet mit der echten Planung (gleiche Logik wie der Zeitstrahl), nichts wird gespeichert.
//
// Eingabe: Stunden (oder Zeichnungsnummer + Menge, dann Stunden aus der Kalkulation), optional Maschine, Tage extern (Oberfläche usw.),
// Prüfung in der QS, Tage Material-Vorlauf. Ergebnis je Maschine zwei Varianten:
//   hinten anstellen   der Auftrag kommt ans Ende der Reihenfolge, niemand anderes verschiebt sich (der ehrliche Termin)
//   vorziehen          frühester Platz, an dem kein anderer Auftrag zu spät wird (wenn es eilt)
// Liefertermin = Maschine fertig + extern + QS + Puffer (Werktage, Sonntage und freie Tage zählen nicht), plus Material-Vorlauf vorne.

import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { MACHINES, addDays } from "../src/lib.js";
import { applyMove, byPosition } from "../src/planLogic.js";
import { makeAllowed } from "./maschinenRegel.js";
import { kalkFromEnv } from "./kalkClient.js";

const NEW_ID = -42;
const BUFFER_DAYS = 2;
const short = (id) => (MACHINES.find((m) => m.id === id) || {}).short || id;

// n Arbeitstage (ohne Sonntag und freie Tage) nach d
function addWorkdays(d, n, free) {
  let x = d;
  let k = 0;
  while (k < n) {
    x = addDays(x, 1);
    if (new Date(x + "T00:00:00Z").getUTCDay() !== 0 && !free.has(x)) k++;
  }
  return x;
}

export function schaetzen(inp, { stunden, maschine = null, extern_tage = 0, qs = true, material_tage = 0, puffer = BUFFER_DAYS, m1_ok = false }) {
  const ctx = makeContext(inp);
  const free = new Set(inp.freeDays.map((d) => d.date));
  const start = material_tage > 0 ? addWorkdays(inp.today, material_tage, free) : null;
  const neu = { id: NEW_ID, machine: "", order_no: "ANFRAGE", source: "ANFRAGE", hours: stunden, done_hours: 0, due: null, position: 9999, done: false, extern_tags: [], extern_days: 7, earliest_start: start, restricted_ok: m1_ok };
  const orders = [...inp.orders, neu];
  const fits = makeAllowed(orders);
  const base = ctx.compute(inp.orders);
  const lateBase = new Set(base.groups.filter((g) => g.status === "late").map((g) => g.key));
  const after = (list) => {
    const r = ctx.compute(list);
    const item = r.plan.flatMap((p) => p.items).find((i) => i.o.id === NEW_ID);
    return { r, item };
  };
  const finish = (end) => {
    const machineEnd = ctx.endDateOf(end);
    let d = machineEnd;
    if (extern_tage > 0) d = addDays(d, extern_tage);
    if (qs) d = addWorkdays(d, 1, free);
    return { maschineFertig: machineEnd, liefertermin: addWorkdays(d, puffer, free) };
  };
  const out = [];
  for (const m of MACHINES) {
    if (maschine && m.id !== maschine) continue;
    if (!fits(neu, m.id) && m.id !== maschine) continue;
    const queue = orders.filter((o) => o.machine === m.id && !o.done && o.id !== NEW_ID).sort(byPosition);
    // hinten anstellen
    const tail = after(applyMove(orders, [NEW_ID], m.id, queue.length).orders);
    if (!tail.item || !tail.item.scheduled) continue;
    const hinten = finish(tail.item.end);
    // vorziehen: frühester Platz ohne neue Verspätung bei anderen (laufende und fixierte bleiben vorne)
    let vorne = null;
    let min = 0;
    while (min < queue.length && ((queue[min].done_hours || 0) > 0 || queue[min].progress_date || queue[min].pinned)) min++;
    for (let idx = min; idx < queue.length; idx++) {
      const t = after(applyMove(orders, [NEW_ID], m.id, idx).orders);
      if (!t.item || !t.item.scheduled) continue;
      const newLate = t.r.groups.filter((g) => g.key !== "ANFRAGE" && g.status === "late" && !lateBase.has(g.key)).map((g) => g.label);
      if (!newLate.length) {
        vorne = { platz: idx + 1, ...finish(t.item.end) };
        break;
      }
    }
    out.push({ maschine: short(m.id), id: m.id, hinten, vorziehen: vorne && vorne.liefertermin < hinten.liefertermin ? vorne : null });
  }
  out.sort((a, b) => a.hinten.liefertermin.localeCompare(b.hinten.liefertermin));
  const best = out[0] || null;
  return {
    heute: inp.today,
    stunden,
    annahmen: { extern_tage, qs, material_tage, puffer_werktage: puffer },
    empfehlung: best ? { maschine: best.maschine, liefertermin: best.hinten.liefertermin, frühestens_bei_vorziehen: best.vorziehen ? best.vorziehen.liefertermin : null } : null,
    maschinen: out,
  };
}

export default function registerLiefertermin(app, db, helpers) {
  const kalk = helpers.kalk || kalkFromEnv();
  async function run(q) {
    let stunden = Number(q.stunden) || 0;
    let quelle = "eingegeben";
    if (!(stunden > 0) && q.code && kalk.enabled) {
      const k = await kalk.lookup(String(q.code).trim(), Number(q.menge) || 1);
      if (k && k.known && k.hours) {
        stunden = k.hours;
        quelle = `Kalkulation (${k.basis || "Schätzung"})`;
      }
    }
    if (!(stunden > 0)) throw Object.assign(new Error(q.code ? "Teil ist in der Kalkulation nicht kalkuliert: bitte Stunden angeben." : "Stunden angeben (oder Zeichnungsnummer und Menge)."), { status: 400 });
    const r = schaetzen(loadPlanInputs(db, helpers), {
      stunden,
      maschine: MACHINES.some((m) => m.id === q.maschine) ? q.maschine : null,
      extern_tage: Math.max(0, Math.min(60, Number(q.extern_tage) || 0)),
      qs: q.qs !== false && q.qs !== "0",
      material_tage: Math.max(0, Math.min(60, Number(q.material_tage) || 0)),
      m1_ok: q.m1_ok === true || q.m1_ok === "1",
    });
    return { ...r, stunden_quelle: quelle };
  }
  app.post("/api/liefertermin", async (req, res) => {
    try {
      res.json(await run(req.body || {}));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
  app.locals.liefertermin = run;
}
