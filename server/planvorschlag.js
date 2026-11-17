// Planvorschlag: rechnet für jede noch nicht eingeplante Position mit Stunden den besten Platz aus (nur lesen, nichts wird gespeichert).
//
// - Reihenfolge: nach Liefertermin, das Dringendste zuerst. Jeder Vorschlag rechnet die vorherigen Vorschläge schon mit ein.
// - Maschine: laut Arbeitsplan in Odoo, sonst die Maschine, auf der dasselbe Teil zuletzt lief (Wiederholteil), sonst werden alle
//   Maschinen durchgerechnet (fast alle Teile können auf allen vier Maschinen laufen, die mit dem besten Termin gewinnt).
// - Platz: jede Stelle der Maschine wird durchgerechnet, aber nie vor eine Position, die schon läuft oder vorne fixiert ist. Bewertung wie beim Platz-Finden für Talos:
//   zuerst keinen anderen Auftrag neu verspäten, dann wenig zusätzliche Verspätungstage, dann der eigene Termin, dann das frühere Ende.
// - Übernommen wird ein Vorschlag erst per Knopf im Planungsfenster (über die normale Reihenfolge-Speicherung, wie beim Ziehen einer Karte).
// Gerechnet wird mit derselben Planungslogik wie im Zeitstrahl (server/talosPlan.js, src/planLogic.js).

import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { MACHINES } from "../src/lib.js";
import { applyMove, byPosition, groupKeyOf, groupLabelOf } from "../src/planLogic.js";

const MACHINE_IDS = MACHINES.map((m) => m.id);
const short = (id) => (MACHINES.find((m) => m.id === id) || {}).short || id;
const started = (o) => (o.done_hours || 0) > 0 || !!o.progress_date;
const lateSum = (groups, skip) => groups.reduce((s, g) => s + (g.key === skip ? 0 : g.lateDays || 0), 0);

export function planProposals(inp) {
  const ctx = makeContext(inp);
  const byDue = (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.id - b.id;
  const pool = inp.orders.filter((o) => !o.done && o.machine === "").sort(byDue);
  const todo = pool.filter((o) => o.hours > 0);
  // Wiederholteile: Maschine, auf der dasselbe Teil zuletzt gefertigt wurde (erledigte Positionen, die neueste zählt)
  const lastMachine = new Map();
  inp.orders
    .filter((o) => o.done && o.product)
    .sort((a, b) => (a.done_date || "").localeCompare(b.done_date || "") || a.id - b.id)
    .forEach((o) => {
      const m = MACHINE_IDS.includes(o.machine) ? o.machine : MACHINE_IDS.includes(o.from_machine) ? o.from_machine : null;
      if (m) lastMachine.set(o.product, m);
    });

  let work = inp.orders;
  let base = ctx.compute(work);
  const first = base;
  const proposals = [];
  for (const o of todo) {
    const key = groupKeyOf(o);
    let allowed = MACHINE_IDS;
    let basis = "frei";
    if (MACHINE_IDS.includes(o.odoo_machine)) {
      allowed = [o.odoo_machine];
      basis = "odoo";
    } else if (o.product && lastMachine.has(o.product)) {
      allowed = [lastMachine.get(o.product)];
      basis = "wiederholteil";
    }
    const lateBefore = lateSum(base.groups, key);
    const wasLate = new Set(base.groups.filter((g) => g.status === "late").map((g) => g.key));
    let best = null;
    for (const mid of allowed) {
      const queue = work.filter((x) => x.machine === mid && !x.done).sort(byPosition);
      // nie vor eine Position, die schon läuft
      let min = 0;
      while (min < queue.length && (started(queue[min]) || queue[min].pinned)) min++;
      for (let idx = min; idx <= queue.length; idx++) {
        const moved = applyMove(work, [o.id], mid, idx).orders;
        const after = ctx.compute(moved);
        const item = after.plan.find((p) => p.m.id === mid).items.find((i) => i.o.id === o.id);
        if (!item || !item.scheduled) continue; // Maschine ohne Leistung
        const own = after.groups.find((g) => g.key === key);
        const newLate = after.groups.filter((g) => g.key !== key && g.status === "late" && !wasLate.has(g.key)).map((g) => g.label);
        const score = newLate.length * 1000 + Math.max(0, lateSum(after.groups, key) - lateBefore) * 10 + (own ? own.lateDays || 0 : 0) * 20 + item.end * 0.001 + idx * 0.00001;
        if (!best || score < best.score) best = { score, mid, idx, moved, after, item, own, newLate, before: queue[idx] || null };
      }
    }
    if (!best) continue;
    work = best.moved;
    base = best.after;
    proposals.push({
      id: o.id,
      ref: o.order_no || o.odoo_ref || "ohne Nummer",
      source: groupLabelOf(o),
      customer: o.customer || null,
      product: o.product || null,
      quantity: o.quantity ?? null,
      hours: o.hours,
      due: o.due || null,
      draft: !!o.odoo_draft,
      machine: best.mid,
      machineName: short(best.mid),
      platz: best.idx + 1,
      beforeId: best.before ? best.before.id : null,
      vor: best.before ? groupLabelOf(best.before) + (best.before.order_no && best.before.order_no !== best.before.source ? ` (${best.before.order_no})` : "") : "am Ende",
      start: ctx.dateOf(best.item.pastStart ?? best.item.start),
      ende: ctx.endDateOf(best.item.end),
      // Termin des ganzen Auftrags nach diesem Vorschlag
      status: best.own ? best.own.status : "ok",
      lateDays: best.own ? best.own.lateDays || 0 : 0,
      basis,
      othersNewLate: best.newLate,
    });
  }
  const late = (x) => x.groups.filter((g) => g.status === "late").length;
  return {
    stand: new Date().toISOString(),
    today: inp.today,
    vorschlaege: proposals,
    ohneStunden: pool.filter((o) => !(o.hours > 0)).map((o) => ({ id: o.id, ref: o.order_no || o.odoo_ref || "ohne Nummer", source: groupLabelOf(o), customer: o.customer || null, product: o.product || null, due: o.due || null, draft: !!o.odoo_draft })),
    wirkung: { zuSpaetVorher: late(first), zuSpaetNachher: late(base), tageVorher: lateSum(first.groups), tageNachher: lateSum(base.groups) },
  };
}

export default function registerPlanvorschlag(app, db, helpers) {
  app.get("/api/planvorschlag", (req, res) => res.json(planProposals(loadPlanInputs(db, helpers))));
}
