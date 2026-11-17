// Plan neu ordnen: rechnet für die schon eingeplanten Positionen eine bessere Reihenfolge aus und zeigt vorher und nachher.
// Gespeichert wird erst, wenn ein Mensch übernimmt.
//
// Was fest bleibt:
//   - Positionen, die schon laufen (Fortschritt eingetragen oder Start in der Vergangenheit), bleiben an ihrem Platz
//   - fixierte Positionen (Knopf "Fixieren" an der Position) bleiben auf ihrer Maschine an ihrem Platz
// Was sich ändern darf:
//   1. Reihenfolge je Maschine: die übrigen Positionen nach Liefertermin, danach wird jede einzeln an jede freie Stelle probiert
//      und dort gelassen, wo es besser ist (lokale Suche)
//   2. Maschine wechseln (abschaltbar): Positionen von Aufträgen, die zu spät fertig werden, werden auf die anderen Maschinen probiert.
//      Auf eine eingeschränkte Maschine (M1) nur, wenn klar ist, dass das Teil dort geht (server/maschinenRegel.js).
//      Arbeitsgänge einer Kette (AG …) bleiben auf ihrer Maschine.
// Bewertung (kleiner ist besser): verspätete Aufträge x 1000 + Verspätungstage x 10 + Summe der Fertigstellungen x 0,01
// + Unruhe: jede Position auf einem anderen Platz 3, jeder Maschinenwechsel 40 (so viel wie 4 Tage Verspätung).
// Damit schlägt die App nur Änderungen vor, die sich lohnen, und lässt den Rest stehen.
// Übernommen wird wie beim Ziehen der Karten: Reihenfolge und Maschine speichern, in Odoo stellt sich der noch nicht begonnene Arbeitsplan mit um.

import { createHash } from "node:crypto";
import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { MACHINES, daysBetween } from "../src/lib.js";
import { applyMove, byPosition, groupLabelOf } from "../src/planLogic.js";
import { makeAllowed } from "./maschinenRegel.js";

const IDS = MACHINES.map((m) => m.id);
const short = (id) => (MACHINES.find((m) => m.id === id) || {}).short || id;
const MAX_MOVES = 6;
const COST_SHIFT = 3;
const COST_SWITCH = 40;
const due = (o) => o.due || "9999-12-31";

export const startedOf = (o, today) => (o.done_hours || 0) > 0 || !!o.progress_date || (!!o.earliest_start && o.earliest_start < today);
const chained = (o) => !!o.after_id || /^AG /.test(o.part_label || "");

function score(res, churn = 0) {
  let late = 0;
  let days = 0;
  let ends = 0;
  res.groups.forEach((g) => {
    if (g.status === "late") {
      late++;
      days += g.lateDays || 0;
    }
    if (g.end != null) ends += g.end;
  });
  return { value: late * 1000 + days * 10 + ends * 0.01 + churn, late, days };
}

// Fingerabdruck der Planung: Übernehmen gilt nur, wenn sich seit dem Berechnen nichts geändert hat
export function stampOf(orders) {
  const rows = orders
    .filter((o) => !o.done)
    .map((o) => [o.id, o.machine, o.position, o.hours, o.done_hours, o.due, o.pinned ? 1 : 0, o.restricted_ok ? 1 : 0, o.earliest_start, o.progress_date].join(":"))
    .sort();
  return createHash("sha1").update(rows.join("|")).digest("hex").slice(0, 16);
}

export function reorderPlan(inp, { wechseln = false } = {}) {
  const ctx = makeContext(inp);
  const today = inp.today;
  const fixed = (o) => startedOf(o, today) || !!o.pinned;
  const queueOf = (orders, mid) => orders.filter((o) => o.machine === mid && !o.done).sort(byPosition);
  // Neue Reihenfolge einer Maschine aus Liste der Ids setzen (Positionen 0..n)
  const setQueue = (orders, mid, list) => {
    const pos = new Map(list.map((o, i) => [o.id, i]));
    return orders.map((o) => (pos.has(o.id) ? { ...o, machine: mid, position: pos.get(o.id) } : o));
  };

  const fits = makeAllowed(inp.orders);
  // Unruhe gegenüber der jetzigen Planung
  const origMach = new Map();
  const origAt = new Map();
  IDS.forEach((mid) => queueOf(inp.orders, mid).forEach((o, i) => (origMach.set(o.id, mid), origAt.set(o.id, i))));
  const churnOf = (orders) => {
    let c = 0;
    IDS.forEach((mid) =>
      queueOf(orders, mid).forEach((o, i) => {
        if (!origMach.has(o.id)) return;
        if (origMach.get(o.id) !== mid) c += COST_SWITCH;
        else if (origAt.get(o.id) !== i) c += COST_SHIFT;
      })
    );
    return c;
  };
  const rate = (r, orders) => score(r, churnOf(orders));
  const before = ctx.compute(inp.orders);
  const s0 = score(before);
  let work = inp.orders;

  // 1. Je Maschine: freie Positionen nach Liefertermin auf die freien Plätze, feste bleiben auf ihrem Platz
  for (const mid of IDS) {
    const q = queueOf(work, mid);
    const free = q.filter((o) => !fixed(o)).sort((a, b) => due(a).localeCompare(due(b)) || a.position - b.position || a.id - b.id);
    let k = 0;
    work = setQueue(work, mid, q.map((o) => (fixed(o) ? o : free[k++])));
  }
  let best = ctx.compute(work);
  let bestScore = rate(best, work);
  if (bestScore.value > s0.value) {
    // Liefertermin-Reihenfolge ist schlechter als die jetzige: von der jetzigen aus weiter verbessern
    work = inp.orders;
    best = before;
    bestScore = s0;
  }

  // Lokale Suche: jede freie Position an jede andere freie Stelle ihrer Maschine probieren, Verbesserungen behalten
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (const mid of IDS) {
      const q = queueOf(work, mid);
      const slots = q.map((o, i) => (fixed(o) ? null : i)).filter((i) => i !== null);
      for (const from of slots) {
        for (const to of slots) {
          if (to === from) continue;
          const cur = queueOf(work, mid);
          const list = [...cur];
          const [moved] = list.splice(from, 1);
          list.splice(to, 0, moved);
          // feste Positionen müssen an ihrem Platz bleiben
          if (list.some((o, i) => fixed(o) && cur[i].id !== o.id)) continue;
          const trial = setQueue(work, mid, list);
          const r = ctx.compute(trial);
          const sc = rate(r, trial);
          if (sc.value < bestScore.value - 1e-9) {
            work = trial;
            best = r;
            bestScore = sc;
            improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }

  // 2. Maschine wechseln: Positionen verspäteter Aufträge auf die anderen Maschinen probieren
  const moves = [];
  if (wechseln) {
    for (let n = 0; n < MAX_MOVES; n++) {
      const lateKeys = new Set(best.groups.filter((g) => g.status === "late").map((g) => g.key));
      if (!lateKeys.size) break;
      let cand = null;
      for (const p of best.plan) {
        for (const it of p.scheduled) {
          const o = it.o;
          if (!lateKeys.has(o.source || o.order_no || `#${o.id}`) || fixed(o) || chained(o)) continue;
          for (const mid of IDS) {
            if (mid === o.machine || !fits(o, mid)) continue;
            const q = queueOf(work, mid).filter((x) => x.id !== o.id);
            // Einfügen nach den festen Positionen vorne, vor der ersten freien mit späterem Liefertermin
            let idx = 0;
            while (idx < q.length && fixed(q[idx])) idx++;
            while (idx < q.length && (fixed(q[idx]) || due(q[idx]) <= due(o))) idx++;
            const trial = applyMove(work, [o.id], mid, idx).orders;
            const r = ctx.compute(trial);
            const sc = rate(r, trial);
            if (sc.value < bestScore.value - 1e-9 && (!cand || sc.value < cand.sc.value)) cand = { o, from: o.machine, mid, trial, r, sc };
          }
        }
      }
      if (!cand) break;
      work = cand.trial;
      best = cand.r;
      bestScore = cand.sc;
      moves.push({ id: cand.o.id, from: cand.from, to: cand.mid });
    }
  }

  // Ergebnis: neue Reihenfolge je Maschine, was sich ändert, welche Aufträge wie betroffen sind
  const orig = new Map(inp.orders.map((o) => [o.id, o]));
  const origIdx = new Map();
  IDS.forEach((mid) => queueOf(inp.orders, mid).forEach((o, i) => origIdx.set(o.id, i)));
  const machines = IDS.map((mid) => {
    const list = queueOf(work, mid);
    const items = list.map((o, i) => {
      const was = orig.get(o.id);
      return {
        id: o.id,
        ref: o.order_no || o.odoo_ref || "ohne Nummer",
        source: groupLabelOf(o),
        customer: o.customer || null,
        due: o.due || null,
        hours: o.hours,
        fixed: fixed(o),
        pinned: !!o.pinned,
        platz: i + 1,
        vonPlatz: was.machine === mid ? origIdx.get(o.id) + 1 : null,
        vonMaschine: was.machine !== mid ? short(was.machine) : null,
      };
    });
    return { id: mid, name: short(mid), ids: list.map((o) => o.id), geaendert: items.some((x) => x.vonMaschine || x.vonPlatz !== x.platz), items };
  });
  const b = new Map(before.groups.map((g) => [g.key, g]));
  const auftraege = best.groups
    .map((g) => {
      const old = b.get(g.key);
      if (!old || old.end == null || g.end == null) return null;
      const vorher = ctx.endDateOf(old.end);
      const nachher = ctx.endDateOf(g.end);
      // in Kalendertagen, wie die Daten angezeigt werden
      const shift = daysBetween(vorher, nachher);
      if (shift === 0 && old.status === g.status) return null;
      return {
        auftrag: g.label,
        liefertermin: g.due || null,
        vorher,
        nachher,
        tage: shift,
        statusVorher: old.status,
        statusNachher: g.status,
      };
    })
    .filter(Boolean)
    .sort((x, y) => (x.statusNachher === "late") - (y.statusNachher === "late") || x.tage - y.tage);
  const better = bestScore.value < s0.value - 1e-9 && machines.some((m) => m.geaendert);
  return {
    stamp: stampOf(inp.orders),
    today,
    wechseln,
    verbessert: better,
    vorher: { zuSpaet: s0.late, tage: s0.days },
    nachher: better ? { zuSpaet: bestScore.late, tage: bestScore.days } : { zuSpaet: s0.late, tage: s0.days },
    wechsel: better ? moves.map((m) => ({ ...m, ref: orig.get(m.id).order_no || orig.get(m.id).odoo_ref, source: groupLabelOf(orig.get(m.id)), von: short(m.from), nach: short(m.to) })) : [],
    maschinen: better ? machines : [],
    auftraege: better ? auftraege : [],
  };
}

export default function registerNeuordnen(app, db, helpers) {
  const inputs = () => loadPlanInputs(db, helpers);
  const flag = (v) => v === "1" || v === true;

  app.get("/api/neuordnen", (req, res) => res.json(reorderPlan(inputs(), { wechseln: flag(req.query.wechseln) })));

  // Express 4 fängt Fehler in async-Routen nicht selbst ab
  app.post("/api/neuordnen", (req, res) => apply(req, res).catch((err) => res.status(500).json({ error: err.message })));
  async function apply(req, res) {
    const { stamp, wechseln } = req.body || {};
    const inp = inputs();
    if (stampOf(inp.orders) !== stamp) return res.status(409).json({ error: "Die Planung hat sich inzwischen geändert. Bitte den Vorschlag neu berechnen." });
    const r = reorderPlan(inp, { wechseln: wechseln === true });
    if (!r.verbessert) return res.json({ ok: true, geaendert: 0, odoo: [] });
    const beforeRows = new Map(db.prepare("SELECT id, machine, odoo_id, odoo_ref, done FROM orders WHERE done = 0").all().map((x) => [x.id, x]));
    const update = db.prepare("UPDATE orders SET machine = ?, position = ? WHERE id = ? AND done = 0");
    db.exec("BEGIN");
    try {
      r.maschinen.forEach((m) => m.ids.forEach((id, i) => update.run(m.id, i, id)));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    // Maschinenwechsel: in Odoo den noch nicht begonnenen Arbeitsplan mit umstellen (wie beim Ziehen einer Karte)
    const odoo = [];
    if (helpers.odooMachineMoves) {
      for (const m of r.maschinen) {
        const rows = m.items.filter((x) => x.vonMaschine).map((x) => beforeRows.get(x.id)).filter(Boolean);
        if (rows.length) odoo.push(...(await helpers.odooMachineMoves(rows, m.id)));
      }
    }
    res.json({ ok: true, geaendert: r.maschinen.reduce((s, m) => s + m.items.filter((x) => x.vonMaschine || x.vonPlatz !== x.platz).length, 0), wechsel: r.wechsel.length, odoo });
  }
}
