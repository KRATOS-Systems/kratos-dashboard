// Planungslogik (ohne Darstellung): Maschinenbelegung, Arbeitsgänge, Orte, Blöcke und Aufträge.
import { MACHINES, daysBetween, fmtH } from "./lib.js";

export const DEFAULT_TIGHT_DAYS = 3;
export const DRAG_THRESHOLD = 4;
export const MIN_BAR_PX = 32;
export const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
// Maße der Zeitstrahl-Zeilen: Balkenbereich oben, darunter die Liefertermine (je Zeile eine Lane)
export const BAR_TOP = 12;
export const BAR_H = 56;
export const MARKER_TOP = 76;
export const MARKER_LANE = 22;
export const TRACK_PX = 720; // geschätzte Breite der Zeitleiste, um Texte zu stapeln
// Vorschläge für die externe Weiterverarbeitung; eigene Stichpunkte sind möglich
export const EXTERN_SUGGESTIONS = ["Eloxieren", "Pulverbeschichten", "Härten"];
export const MAX_WEEKS_WITH_DAYS = 8; // ab mehr Wochen sind die Tage zu schmal für eine Beschriftung

export const byPosition = (a, b) => a.position - b.position || a.id - b.id;
export const days = (n) => `${n} ${n === 1 ? "Tag" : "Tage"}`;
export const remainingOf = (o) => Math.max(0, o.hours - (o.done_hours || 0));
export const doneHoursOf = (o) => (o.done ? o.hours : Math.min(o.done_hours || 0, o.hours));
export const metaLine = (o, withSource = true) =>
  [withSource && o.source ? `Quelle ${o.source}` : null, o.quantity != null ? `${fmtH(o.quantity)} Stück` : null, o.product]
    .filter(Boolean)
    .join(" · ");
export const ODOO_URL = "https://kratosdata.odoo.com/odoo/manufacturing";
export const round1 = (x) => Math.round(x * 10) / 10;
// Nummer einer Position, bei Teillieferungen mit "Teil 1" bzw. "Rest"
export const posNo = (o) => (o.order_no || "ohne Nummer") + (o.part_label ? ` · ${o.part_label}` : "");
// Ein Auftrag ist die Quelle aus Odoo (z. B. A01335), seine Positionen sind die Fertigungsaufträge
export const groupKeyOf = (o) => o.source || o.order_no || `#${o.id}`;
export const groupLabelOf = (o) => o.source || o.order_no || "ohne Nummer";
export const percentOf = (done, total) => (done > 0 && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null);

export function send(url, method, body) {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch((err) => console.error("Speichern fehlgeschlagen", err));
}

// Setzt Aufträge (ein Block oder eine einzelne Position) an Position `index`
// der Zielmaschine, auch von einer anderen Maschine. Liefert die neue
// Auftragsliste und die Reihenfolge der Zielmaschine.
export function applyMove(orders, ids, machine, index) {
  const moving = ids.map((id) => orders.find((o) => o.id === id)).filter(Boolean);
  if (moving.length === 0) return { orders, ids: [] };
  const target = orders
    .filter((o) => o.machine === machine && !o.done && !ids.includes(o.id))
    .sort(byPosition);
  target.splice(Math.min(Math.max(index, 0), target.length), 0, ...moving.map((o) => ({ ...o, machine })));
  const position = new Map(target.map((o, i) => [o.id, i]));
  return {
    ids: target.map((o) => o.id),
    orders: orders.map((o) => {
      if (ids.includes(o.id)) return { ...o, machine, position: position.get(o.id) };
      return position.has(o.id) ? { ...o, position: position.get(o.id) } : o;
    }),
  };
}

// Der Sonntag und die eingetragenen freien Tage (Feiertage, Betriebsurlaub) sind
// arbeitsfrei. Tag 0 der Zeitachse ist ein Montag, jeder siebte Tag ab Tag 6 ist ein
// Sonntag. `free` ist die Menge der freien Tage als Tagesnummer auf dieser Achse. Die
// Wochenleistung verteilt sich auf die sechs Arbeitstage Montag bis Samstag, ein freier
// Tag mindert also die Leistung der Woche.
export const isSunday = (t) => ((Math.floor(t) % 7) + 7) % 7 === 6;
export const isFreeDay = (t, free) => isSunday(t) || free.has(Math.floor(t));
export const skipFree = (t, free) => {
  let day = Math.floor(t);
  if (!isFreeDay(day, free)) return t;
  while (isFreeDay(day, free)) day += 1;
  return day;
};

// Zeitpunkt, an dem `hours` Stunden Arbeit ab `start` fertig sind (`perDay` = Stunden je Arbeitstag)
export function workEnd(start, hours, perDay, free) {
  let t = start;
  let left = hours;
  for (let guard = 0; guard < 4000; guard++) {
    t = skipFree(t, free);
    const day = Math.floor(t);
    const pd = perDay(day);
    if (!(pd > 0)) {
      t = day + 1;
      continue;
    }
    const capacity = (day + 1 - t) * pd;
    if (left <= capacity + 1e-9) return t + left / pd;
    left -= capacity;
    t = day + 1;
  }
  return t;
}

// Positionen je Maschine hintereinander abarbeiten, ab heute
// `depEnd`: Ende des vorherigen Arbeitsgangs (after_id) je Position-Id, der nächste Arbeitsgang startet nicht davor
export function buildPlan(orders, rates, defaults, monday0, todayOff, free, depEnd = new Map()) {
  return MACHINES.map((m) => {
    const own = rates[m.id] > 0;
    const rate = own ? rates[m.id] : defaults.now;
    const perDay = own ? () => rates[m.id] / 6 : defaults.perDayAt;
    let t = todayOff;
    const items = orders
      .filter((o) => o.machine === m.id && !o.done)
      .sort(byPosition)
      .map((o) => {
        const earliest = o.earliest_start ? daysBetween(monday0, o.earliest_start) : null;
        // Laufende Position (erste der Maschine, Start in der Vergangenheit): Die Arbeitstage seit dem Start bzw. seit der
        // letzten Eingabe zählen nach Plan als gelaufen (höchstens 90 %), bis der echte Stand eingetragen wird
        const baseDone = Math.min(o.done_hours || 0, o.hours);
        let estDone = 0;
        let sinceOff = null;
        if (earliest != null && earliest < todayOff && t === todayOff && o.hours > 0) {
          const progressOff = o.progress_date ? daysBetween(monday0, o.progress_date) : null;
          sinceOff = progressOff != null ? Math.max(progressOff, earliest) : earliest;
          let est = 0;
          for (let d = sinceOff; d < todayOff; d++) if (!isFreeDay(d, free)) est += perDay(d);
          estDone = Math.max(0, Math.min(est, 0.9 * o.hours - baseDone));
        }
        const effDone = baseDone + estDone;
        const remaining = Math.max(0, o.hours - effDone);
        const percent = percentOf(effDone, o.hours);
        const estimated = estDone > 0.05;
        const stale = estimated && todayOff - sinceOff >= 7; // seit einer Woche nicht bestätigt
        if (!rate || !(remaining > 0)) return { o, scheduled: false, remaining, percent, effDone, estimated, stale };
        // "Start frühestens" (Rohmaterial, Werkzeuge …) und das Ende des vorherigen Arbeitsgangs: bis dahin wartet die
        // Maschine, leer = sobald sie frei ist
        const dep = o.after_id && depEnd.has(o.after_id) ? depEnd.get(o.after_id) : null;
        // Arbeitsvorbereitung: Der späteste Termin der offenen Punkte (av_ready) hält die Position zurück, bis alles da ist
        const avOff = o.av_ready ? daysBetween(monday0, o.av_ready) : null;
        const floors = [earliest, dep, avOff].filter((v) => v != null);
        const notBefore = floors.length ? Math.max(...floors) : null;
        const waits = notBefore != null && notBefore > t;
        const waitReason = waits ? (avOff != null && avOff === notBefore ? "av" : dep != null && dep === notBefore ? "dep" : "earliest") : null;
        const start = skipFree(waits ? notBefore : t, free);
        const waitFrom = waits ? skipFree(t, free) : null;
        // Schon begonnen: liegt der Start in der Vergangenheit, beginnt der Balken dort (nur die erste Position der Maschine)
        const pastStart = earliest != null && earliest < todayOff && t === todayOff ? earliest : null;
        const end = workEnd(start, remaining, perDay, free);
        t = end;
        const dueEnd = o.due ? daysBetween(monday0, o.due) + 1 : null;
        const diff = dueEnd == null ? null : end - dueEnd;
        const status = diff != null && diff > 0 ? "late" : "ok";
        return { o, scheduled: true, remaining, percent, effDone, estimated, stale, start, end, waitFrom, waitReason, pastStart, dueEnd, diff, status, dep, avWait: avOff != null && avOff > todayOff, lateDays: diff > 0 ? Math.ceil(diff) : 0 };
      });
    const scheduled = items.filter((i) => i.scheduled);
    return { m, rate, items, scheduled, freeAt: scheduled.length ? skipFree(t, free) : null };
  });
}

// Arbeitsgänge hängen über Maschinen hinweg voneinander ab: Die Planung wird wiederholt, bis sich die Enden nicht mehr ändern
export function buildPlanDeps(orders, rates, defaults, monday0, todayOff, free) {
  let plan = buildPlan(orders, rates, defaults, monday0, todayOff, free);
  if (!orders.some((o) => o.after_id && !o.done)) return plan;
  for (let pass = 0; pass < 10; pass++) {
    const ends = new Map();
    plan.forEach((p) => p.items.forEach((i) => i.scheduled && ends.set(i.o.id, i.end)));
    const next = buildPlan(orders, rates, defaults, monday0, todayOff, free, ends);
    const changed = next.some((p, pi) =>
      p.items.some((i, ii) => Math.abs((i.end ?? 0) - (plan[pi].items[ii].end ?? 0)) > 1e-9 || i.scheduled !== plan[pi].items[ii].scheduled)
    );
    plan = next;
    if (!changed) break;
  }
  return plan;
}

// Aufeinanderfolgende Positionen desselben Auftrags auf einer Maschine ergeben einen Block
export function buildBlocks(items) {
  const blocks = [];
  items.forEach((it, index) => {
    if (!it.scheduled) return;
    const key = groupKeyOf(it.o);
    const last = blocks[blocks.length - 1];
    if (last && last.key === key) {
      last.items.push(it);
      last.end = it.end;
    } else {
      blocks.push({ key, firstIndex: index, items: [it], start: it.pastStart ?? it.start, doneEnd: it.pastStart != null ? it.start : null, end: it.end });
    }
  });
  blocks.forEach((b) => {
    b.hours = b.items.reduce((s, i) => s + i.o.hours, 0);
    b.remaining = b.items.reduce((s, i) => s + i.remaining, 0);
    b.percent = percentOf(
      b.items.reduce((s, i) => s + (i.effDone ?? doneHoursOf(i.o)), 0),
      b.hours
    );
    b.estimated = b.items.some((i) => i.estimated);
  });
  return blocks;
}

export const tagsOf = (o) => o.extern_tags || [];
// Neben den Maschinen gibt es feste Orte im Zeitstrahl: QS (Prüfung), FERTIGUNG EXTERN und
// OBERFLÄCHE EXTERN (Weiterverarbeitung nach der Maschine). Eine Position liegt immer an genau einem Ort
// (Beginn = extern_start, Dauer = extern_days in Kalendertagen). "extern" ist die Oberfläche (Stichpunkte).
export const EXTERN = "extern";
export const LANES = [
  { id: "qs", name: "QS", colorKey: "green", c: "var(--qs)", cap: "Prüfung", defaultDays: 2, tags: false },
  { id: "extern_fert", name: "FERTIGUNG EXTERN", c: "var(--ext)", cap: "Fremdfertigung", defaultDays: 7, tags: false },
  { id: EXTERN, name: "OBERFLÄCHE EXTERN", c: "var(--ext)", cap: "Eloxieren, Pulvern, Härten", defaultDays: 7, tags: true },
];
export const LANE_IDS = LANES.map((l) => l.id);
export const laneOf = (id) => LANES.find((l) => l.id === id);
export const EXTERN_DURATIONS = [1, 2, 3, 4, 5, 6, 7, 14, 21, 28, 35, 42, 49, 56]; // Tage
export const fmtDuration = (days) =>
  days % 7 === 0 ? `${days / 7} ${days === 7 ? "Woche" : "Wochen"}` : `${days} ${days === 1 ? "Tag" : "Tage"}`;

// Neue Dauer beim Wechsel an einen Ort: aus einem anderen Ort kommend (und beim Weg in die QS) gilt die
// Standarddauer des Ziels, damit eine Dauer nicht von einem Ort in den nächsten mitwandert
export function laneDaysOnMove(o, lane) {
  if (o.machine === lane.id || lane.id === "qs") return {};
  if (LANE_IDS.includes(o.machine) && o.machine !== "qs") return { extern_days: lane.defaultDays };
  return {};
}
// Dauer der Position an ihrem Ort (QS: eigene Dauer, sonst die Dauer der externen Bearbeitung)
export const daysIn = (o) => (o.machine === "qs" ? o.qs_days || 2 : o.extern_days || 7);

// Legt Positionen an einen Ort (QS, Extern …), Beginn am angegebenen Tag
export function applyLaneMove(orders, ids, date, lane) {
  let next = Math.max(-1, ...orders.filter((o) => o.machine === lane.id).map((o) => o.position)) + 1;
  return orders.map((o) =>
    ids.includes(o.id)
      ? {
          ...o,
          ...laneDaysOnMove(o, lane),
          ...(lane.id === "qs" && MACHINES.some((m) => m.id === o.machine) ? { from_machine: o.machine } : {}),
          machine: lane.id,
          extern_start: date,
          position: next++,
        }
      : o
  );
}

// Auftragsübersicht: alle Positionen eines Auftrags über alle Maschinen. Die
// späteste Position bestimmt das Ende, es gilt der früheste Liefertermin der
// Positionen. Positionen in der Zeile "Extern" sind mit Beginn und Dauer (Tage)
// fest. Positionen mit Stichpunkt, die noch an der Maschine
// liegen, gehen danach extern weiter: Ihre Dauer zählt schon jetzt
// mit (ohne eigenen Balken). Das Ende des Auftrags ist das späteste von allem.
export function buildGroups(orders, plan, monday0, tightDays) {
  const map = new Map();
  const eff = new Map(); // Fortschritt je Position inkl. Schätzung
  plan.forEach((p) => p.items.forEach((i) => eff.set(i.o.id, i.effDone)));
  orders.forEach((o) => {
    const key = groupKeyOf(o);
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: groupLabelOf(o),
        positions: [],
        due: null,
        machineEnd: null,
        machineEndName: null,
        externEnd: null,
        externEndName: null,
        forecastEnd: null,
        scheduledIds: new Set(),
      });
    }
    const g = map.get(key);
    g.positions.push(o);
    if (o.due && (!g.due || o.due < g.due)) g.due = o.due;
    if (LANE_IDS.includes(o.machine) && !o.done && o.extern_start) {
      g.scheduledIds.add(o.id);
      const e = daysBetween(monday0, o.extern_start) + daysIn(o);
      if (g.externEnd == null || e > g.externEnd) {
        g.externEnd = e;
        g.externEndName = laneOf(o.machine).name;
      }
    }
  });
  plan.forEach((p) =>
    p.scheduled.forEach((i) => {
      const g = map.get(groupKeyOf(i.o));
      g.scheduledIds.add(i.o.id);
      if (g.machineEnd == null || i.end > g.machineEnd) {
        g.machineEnd = i.end;
        g.machineEndName = p.m.short;
      }
      if (tagsOf(i.o).length > 0) {
        const e = i.end + (i.o.extern_days || 7);
        if (g.forecastEnd == null || e > g.forecastEnd) g.forecastEnd = e;
      }
    })
  );
  return [...map.values()]
    .filter((g) => g.positions.some((o) => !o.done))
    .map((g) => {
      const hours = g.positions.reduce((s, o) => s + o.hours, 0);
      const unscheduled = g.positions.filter(
        (o) => !o.done && !g.scheduledIds.has(o.id) && !(o.hours > 0 && remainingOf(o) === 0)
      ).length;
      const externLatest = Math.max(g.externEnd ?? -Infinity, g.forecastEnd ?? -Infinity);
      const externName = (g.externEnd ?? -Infinity) >= (g.forecastEnd ?? -Infinity) ? g.externEndName : laneOf(EXTERN).name;
      const hasExtern = externLatest > -Infinity;
      const externLast = hasExtern && (g.machineEnd == null || externLatest > g.machineEnd);
      const end = externLast ? externLatest : g.machineEnd;
      const dueEnd = g.due ? daysBetween(monday0, g.due) + 1 : null;
      const diff = end != null && dueEnd != null ? end - dueEnd : null;
      const externPositions = g.positions.filter((o) => !o.done && (tagsOf(o).length > 0 || LANE_IDS.includes(o.machine)));
      return {
        ...g,
        end,
        endMachine: externLast ? externName : g.machineEndName,
        externDays: externPositions.reduce((m, o) => Math.max(m, daysIn(o)), 0),
        externTags: [...new Set(g.positions.filter((o) => !o.done).flatMap(tagsOf))],
        total: g.positions.length,
        finished: g.positions.filter((o) => o.done).length,
        hours,
        percent: percentOf(
          g.positions.reduce((s, o) => s + (!o.done && eff.has(o.id) ? eff.get(o.id) : doneHoursOf(o)), 0),
          hours
        ),
        unscheduled,
        dueEnd,
        diff,
        status: diff == null ? "ok" : diff > 0 ? "late" : -diff < tightDays ? "tight" : "ok",
        lateDays: diff > 0 ? Math.ceil(diff) : 0,
      };
    })
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.label.localeCompare(b.label));
}