import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  DEFAULT_WEEK_CAPACITY,
  MACHINES,
  SHIFT_MODELS,
  addDays,
  daysBetween,
  fmtH,
  fmtShort,
  isoWeekOf,
  makeStyles,
  mondayOf,
  todayStr,
} from "./lib.js";
import { parseOdooExport } from "./odooImport.js";
import { holidaysBavaria } from "./holidays.js";

const DEFAULT_TIGHT_DAYS = 3;
const DRAG_THRESHOLD = 4;
const MIN_BAR_PX = 32;
const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
// Maße der Zeitstrahl-Zeilen: Balkenbereich oben, darunter die Liefertermine (je Zeile eine Lane)
const BAR_TOP = 12;
const BAR_H = 56;
const MARKER_TOP = 76;
const MARKER_LANE = 22;
const TRACK_PX = 720; // geschätzte Breite der Zeitleiste, um Texte zu stapeln
// Vorschläge für die externe Weiterverarbeitung; eigene Stichpunkte sind möglich
const EXTERN_SUGGESTIONS = ["Eloxieren", "Pulverbeschichten", "Härten"];
const MAX_WEEKS_WITH_DAYS = 8; // ab mehr Wochen sind die Tage zu schmal für eine Beschriftung

const byPosition = (a, b) => a.position - b.position || a.id - b.id;
const days = (n) => `${n} ${n === 1 ? "Tag" : "Tage"}`;
const remainingOf = (o) => Math.max(0, o.hours - (o.done_hours || 0));
const doneHoursOf = (o) => (o.done ? o.hours : Math.min(o.done_hours || 0, o.hours));
const metaLine = (o, withSource = true) =>
  [withSource && o.source ? `Quelle ${o.source}` : null, o.quantity != null ? `${fmtH(o.quantity)} Stück` : null, o.product]
    .filter(Boolean)
    .join(" · ");
const ODOO_URL = "https://kratosdata.odoo.com/odoo/manufacturing";
// Öffnet den Fertigungsauftrag in Odoo (nur wenn der Export die ID enthielt)
function OdooLink({ o }) {
  if (!o.odoo_id) return null;
  return (
    <a
      href={`${ODOO_URL}/${o.odoo_id}`}
      target="_blank"
      rel="noopener noreferrer"
      title={`${o.order_no} in Odoo öffnen`}
      onClick={(ev) => ev.stopPropagation()}
      style={{ fontSize: 11, fontWeight: 600, color: "inherit", opacity: 0.7, textDecoration: "none", whiteSpace: "nowrap" }}
    >
      Odoo ↗
    </a>
  );
}
// Material laut Odoo (Spalte "Komponentenstatus" im Export): nicht verfügbar = rot, erwartet = gelb, verfügbar = grün
function MaterialBadge({ o, theme }) {
  const text = o.component_status;
  if (!text) return null;
  const low = text.toLowerCase();
  const color = /nicht verf/.test(low) ? theme.red : /verf|reserv/.test(low) ? theme.green : theme.amber;
  return (
    <span
      title={`Materialstatus laut Odoo: ${text}`}
      style={{ fontSize: 10, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 10, padding: "1px 7px", whiteSpace: "nowrap" }}
    >
      {/nicht verf/.test(low) ? "Material fehlt" : text}
    </span>
  );
}
// Eingabe "Noch nötig": wird erst beim Verlassen des Feldes oder mit Enter übernommen
function RestInput({ value, onCommit, style, title }) {
  const [text, setText] = useState(null);
  const shown = text ?? (value === "" ? "" : String(value));
  const commit = () => {
    if (text === null) return;
    const n = text === "" ? null : Number(String(text).replace(",", "."));
    setText(null);
    if (n != null && Number.isFinite(n) && n >= 0) onCommit(n);
  };
  return (
    <input
      type="number"
      min={0}
      step="any"
      placeholder="noch nötig"
      title={title}
      value={shown}
      onChange={(ev) => setText(ev.target.value)}
      onBlur={commit}
      onKeyDown={(ev) => ev.key === "Enter" && ev.target.blur()}
      style={style}
    />
  );
}
const round1 = (x) => Math.round(x * 10) / 10;
// Nummer einer Position, bei Teillieferungen mit "Teil 1" bzw. "Rest"
const posNo = (o) => (o.order_no || "ohne Nummer") + (o.part_label ? ` · ${o.part_label}` : "");
// Ein Auftrag ist die Quelle aus Odoo (z. B. A01335), seine Positionen sind die Fertigungsaufträge
const groupKeyOf = (o) => o.source || o.order_no || `#${o.id}`;
const groupLabelOf = (o) => o.source || o.order_no || "ohne Nummer";
const percentOf = (done, total) => (done > 0 && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null);

function send(url, method, body) {
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
function applyMove(orders, ids, machine, index) {
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
const isSunday = (t) => ((Math.floor(t) % 7) + 7) % 7 === 6;
const isFreeDay = (t, free) => isSunday(t) || free.has(Math.floor(t));
const skipFree = (t, free) => {
  let day = Math.floor(t);
  if (!isFreeDay(day, free)) return t;
  while (isFreeDay(day, free)) day += 1;
  return day;
};

// Zeitpunkt, an dem `hours` Stunden Arbeit ab `start` fertig sind (`perDay` = Stunden je Arbeitstag)
function workEnd(start, hours, perDay, free) {
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
function buildPlan(orders, rates, defaults, monday0, todayOff, free) {
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
        // "Start frühestens" (Rohmaterial, Werkzeuge …): bis dahin wartet die Maschine, leer = sobald sie frei ist
        const waits = earliest != null && earliest > t;
        const start = skipFree(waits ? earliest : t, free);
        const waitFrom = waits ? skipFree(t, free) : null;
        // Schon begonnen: liegt der Start in der Vergangenheit, beginnt der Balken dort (nur die erste Position der Maschine)
        const pastStart = earliest != null && earliest < todayOff && t === todayOff ? earliest : null;
        const end = workEnd(start, remaining, perDay, free);
        t = end;
        const dueEnd = o.due ? daysBetween(monday0, o.due) + 1 : null;
        const diff = dueEnd == null ? null : end - dueEnd;
        const status = diff != null && diff > 0 ? "late" : "ok";
        return { o, scheduled: true, remaining, percent, effDone, estimated, stale, start, end, waitFrom, pastStart, dueEnd, diff, status, lateDays: diff > 0 ? Math.ceil(diff) : 0 };
      });
    const scheduled = items.filter((i) => i.scheduled);
    return { m, rate, items, scheduled, freeAt: scheduled.length ? skipFree(t, free) : null };
  });
}

// Aufeinanderfolgende Positionen desselben Auftrags auf einer Maschine ergeben einen Block
function buildBlocks(items) {
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

const tagsOf = (o) => o.extern_tags || [];
// Neben den Maschinen gibt es feste Orte im Zeitstrahl: QS (Prüfung), FERTIGUNG EXTERN und
// OBERFLÄCHE EXTERN (Weiterverarbeitung nach der Maschine). Eine Position liegt immer an genau einem Ort
// (Beginn = extern_start, Dauer = extern_days in Kalendertagen). "extern" ist die Oberfläche (Stichpunkte).
const EXTERN = "extern";
const LANES = [
  { id: "qs", name: "QS", colorKey: "green", defaultDays: 2, tags: false },
  { id: "extern_fert", name: "FERTIGUNG EXTERN", defaultDays: 7, tags: false },
  { id: EXTERN, name: "OBERFLÄCHE EXTERN", defaultDays: 7, tags: true },
];
const LANE_IDS = LANES.map((l) => l.id);
const laneOf = (id) => LANES.find((l) => l.id === id);
const EXTERN_DURATIONS = [1, 2, 3, 4, 5, 6, 7, 14, 21, 28, 35, 42, 49, 56]; // Tage
const fmtDuration = (days) =>
  days % 7 === 0 ? `${days / 7} ${days === 7 ? "Woche" : "Wochen"}` : `${days} ${days === 1 ? "Tag" : "Tage"}`;

// Neue Dauer beim Wechsel an einen Ort: aus einem anderen Ort kommend (und beim Weg in die QS) gilt die
// Standarddauer des Ziels, damit eine Dauer nicht von einem Ort in den nächsten mitwandert
function laneDaysOnMove(o, lane) {
  if (o.machine === lane.id || lane.id === "qs") return {};
  if (LANE_IDS.includes(o.machine) && o.machine !== "qs") return { extern_days: lane.defaultDays };
  return {};
}
// Dauer der Position an ihrem Ort (QS: eigene Dauer, sonst die Dauer der externen Bearbeitung)
const daysIn = (o) => (o.machine === "qs" ? o.qs_days || 2 : o.extern_days || 7);

// Legt Positionen an einen Ort (QS, Extern …), Beginn am angegebenen Tag
function applyLaneMove(orders, ids, date, lane) {
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
function buildGroups(orders, plan, monday0, tightDays) {
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

export default function Planning({ theme, mode, shift, weekCap, onSaveShift, onDeleteShift }) {
  const { eyebrow, mono } = makeStyles(theme);
  const today = useMemo(() => todayStr(), []);
  const [orders, setOrders] = useState([]);
  const [rates, setRates] = useState({});
  const [tightDays, setTightDays] = useState(DEFAULT_TIGHT_DAYS);
  const [preview, setPreview] = useState(null); // ungespeichertes Schichtmodell "Was wäre wenn": { date, hours }
  const [newShift, setNewShift] = useState({ date: "", hours: 100 });
  const [pendingDue, setPendingDue] = useState(null); // { key, value }: neuer Auftragstermin wartet auf Rückfrage
  const [utilization, setUtilization] = useState(80); // % der Betriebszeit, mit denen die Planung rechnet
  const [showDone, setShowDone] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [freeDays, setFreeDays] = useState([]); // [{ date, name }], arbeitsfreie Tage wie der Sonntag
  const [showFree, setShowFree] = useState(false);
  const [newFree, setNewFree] = useState({ from: "", to: "", name: "" });
  const [expanded, setExpanded] = useState({});
  const [viewMode, setViewMode] = useState("weeks"); // weeks | month
  const [viewWeeks, setViewWeeks] = useState(() => {
    try {
      const v = Number(window.localStorage.getItem("kratos-view-weeks"));
      return [1, 2, 3].includes(v) ? v : 2;
    } catch {
      return 2;
    }
  });
  const [viewOffset, setViewOffset] = useState(0); // Wochen bzw. Monate ab heute
  const [splitFor, setSplitFor] = useState(null); // Teillieferung einer Position: { id, qty, due, error }
  const [splitGroup, setSplitGroup] = useState(null); // Teillieferung eines Auftrags: { key, qty, due, error }
  const [laneDetail, setLaneDetail] = useState(null); // Positionen des angeklickten Balkens in QS / Extern (ids)
  const [reworkId, setReworkId] = useState(null); // QS: Position, für die gerade die Nacharbeit abgefragt wird
  const [reworkText, setReworkText] = useState("");
  const [detailId, setDetailId] = useState(null); // Position, deren Details unter dem Zeitstrahl stehen
  const [selected, setSelected] = useState({});
  const [importPreview, setImportPreview] = useState(null); // { items, result, fileName }
  const [importMsg, setImportMsg] = useState("");
  const [drag, setDrag] = useState(null); // { ids, label, sub, active, x, y, offX, offY, w, h, target }
  const fileInput = useRef(null);
  const dragInfo = useRef(null);
  const trackRefs = useRef({});
  const laneTracks = useRef({});
  const lastDragEnd = useRef(0);
  const latest = useRef({});

  useEffect(() => {
    Promise.all([
      fetch("/api/orders").then((r) => r.json()),
      fetch("/api/plan-rates").then((r) => r.json()),
      fetch("/api/plan-settings").then((r) => r.json()),
    ]).then(([o, r, s]) => {
      setOrders(o.orders);
      setRates(r.rates);
      setTightDays(s.tight_days);
      if (s.utilization) setUtilization(s.utilization);
    });

    // Freie Tage laden; die Feiertage für Bayern werden für dieses und das nächste Jahr einmalig eingetragen
    (async () => {
      let data = await fetch("/api/free-days").then((r) => r.json());
      const year = new Date().getFullYear();
      for (const y of [year, year + 1]) {
        if (!data.seeded_years.includes(y)) {
          data = await send("/api/free-days", "POST", { days: holidaysBavaria(y), seed_year: y });
        }
      }
      setFreeDays(data.days);
    })().catch((err) => console.error("Freie Tage laden fehlgeschlagen", err));
  }, []);

  // Der Zeitstrahl beginnt am Montag der aktuellen Woche, gerechnet in Tagen
  const monday0 = mondayOf(today);
  const todayOff = daysBetween(monday0, today);
  const dateOf = (off) => addDays(monday0, Math.floor(off));
  // Freie Tage als Tagesnummer auf der Zeitachse (und ihr Name für den Hinweistext)
  const free = useMemo(() => new Set(freeDays.map((d) => daysBetween(monday0, d.date))), [freeDays, monday0]);
  const freeNames = useMemo(() => new Map(freeDays.map((d) => [daysBetween(monday0, d.date), d.name])), [freeDays, monday0]);
  // Schichtmodell je Woche: die eingetragenen Modelle (Schlüssel = Montag, ab dem sie gelten) und eine ungespeicherte Vorschau.
  // Standard-Wochenleistung einer Maschine = Betriebszeit des Modells x Nutzung in %; ein eigener Wert hat Vorrang.
  const makeDefaults = (cap) => {
    const schedule = Object.keys(cap)
      .sort()
      .map((d) => ({ off: daysBetween(monday0, d), hours: cap[d] }));
    const hoursAt = (day) => {
      let h = DEFAULT_WEEK_CAPACITY;
      for (const e of schedule) {
        if (e.off <= day) h = e.hours;
        else break;
      }
      return h;
    };
    return {
      now: (hoursAt(todayOff) * utilization) / 100,
      perDayAt: (day) => (hoursAt(day) * utilization) / 100 / 6,
    };
  };
  const capWithPreview = useMemo(
    () => (preview ? { ...weekCap, [preview.date]: preview.hours } : weekCap),
    [weekCap, preview]
  );
  const defaults = useMemo(() => makeDefaults(capWithPreview), [capWithPreview, utilization, monday0, todayOff]); // eslint-disable-line react-hooks/exhaustive-deps
  const baseDefaults = useMemo(() => makeDefaults(weekCap), [weekCap, utilization, monday0, todayOff]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ein Ende genau am Tageswechsel gehört noch zum Vortag
  const endDateOf = (off) => dateOf(off - 1e-6);

  // Beim Ziehen wird die Planung live mit dem verschobenen Block berechnet
  const dragActive = drag?.active === true;
  const dragKey = drag ? drag.ids.join(",") : "";
  const viewOrders = useMemo(() => {
    if (!dragActive || !drag.target) return orders;
    return LANE_IDS.includes(drag.target.machine)
      ? applyLaneMove(orders, drag.ids, drag.target.date, laneOf(drag.target.machine))
      : applyMove(orders, drag.ids, drag.target.machine, drag.target.index).orders;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, dragActive, dragKey, drag?.target?.machine, drag?.target?.index, drag?.target?.date]);
  const plan = useMemo(
    () => buildPlan(viewOrders, rates, defaults, monday0, todayOff, free),
    [viewOrders, rates, defaults, monday0, todayOff, free]
  );
  // Ohne den gezogenen Block: stabile Grundlage, um die Einfügeposition zu bestimmen
  const basePlan = useMemo(
    () =>
      drag
        ? buildPlan(orders.filter((o) => !drag.ids.includes(o.id)), rates, defaults, monday0, todayOff, free)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dragKey, orders, rates, defaults, monday0, todayOff, free]
  );
  const groups = useMemo(
    () => buildGroups(viewOrders, plan, monday0, tightDays),
    [viewOrders, plan, monday0, tightDays]
  );
  // Die erste Position einer Maschine gilt als laufend: ihr Start wird automatisch eingetragen (änderbar)
  useEffect(() => {
    if (dragActive) return;
    plan.forEach((p) => {
      const first = p.items.find((i) => i.scheduled);
      if (first && !first.o.earliest_start) patchOrder(first.o.id, { earliest_start: dateOf(first.start) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, dragActive]);

  const groupByKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);
  const warnings = groups.filter((g) => g.status === "late");
  const previewStats = useMemo(() => {
    if (!preview) return null;
    const count = (grps) => ({
      late: grps.filter((g) => g.status === "late").length,
      days: grps.reduce((sum, g) => sum + g.lateDays, 0),
    });
    const savedPlan = buildPlan(orders, rates, baseDefaults, monday0, todayOff, free);
    return { before: count(buildGroups(orders, savedPlan, monday0, tightDays)), after: count(groups) };
  }, [preview, orders, rates, baseDefaults, monday0, todayOff, free, tightDays, groups]);

  // Sichtfenster des Zeitstrahls: Wochenansicht (1-3 Wochen ab der gewählten Woche) oder Kalendermonat.
  // Alle Zeiten sind Tage ab dem Montag der aktuellen Woche (negativ = früher).
  let viewStart;
  let weeksShown;
  let monthKey = null;
  let viewLabel;
  if (viewMode === "weeks") {
    viewStart = 7 * viewOffset;
    weeksShown = viewWeeks;
    const first = addDays(monday0, viewStart);
    const last = addDays(first, 7 * weeksShown - 1);
    const weekText = weeksShown > 1 ? `KW ${isoWeekOf(first).week} – ${isoWeekOf(last).week}` : `KW ${isoWeekOf(first).week}`;
    viewLabel = `${weekText} · ${fmtShort(first)} – ${fmtShort(last)}`;
  } else {
    const [ty, tm] = today.split("-").map(Number);
    const firstOfMonth = new Date(Date.UTC(ty, tm - 1 + viewOffset, 1));
    const lastOfMonth = new Date(Date.UTC(ty, tm + viewOffset, 0));
    const iso = (d) => d.toISOString().slice(0, 10);
    monthKey = iso(firstOfMonth).slice(0, 7);
    const startMonday = mondayOf(iso(firstOfMonth));
    const endMonday = mondayOf(iso(lastOfMonth));
    viewStart = daysBetween(monday0, startMonday);
    weeksShown = daysBetween(startMonday, endMonday) / 7 + 1;
    viewLabel = `${MONTHS[firstOfMonth.getUTCMonth()]} ${firstOfMonth.getUTCFullYear()}`;
  }
  const total = weeksShown * 7;
  const viewEnd = viewStart + total;
  const posPct = (x) => ((x - viewStart) / total) * 100;
  // Auf das Sichtfenster zugeschnitten; cutL/cutR = der Balken läuft links/rechts über den Rand
  const span = (a, b) => ({ cs: Math.max(a, viewStart), ce: Math.min(b, viewEnd), cutL: a < viewStart, cutR: b > viewEnd });

  latest.current = { orders, basePlan, total, viewStart, monday0, detailId };

  // Klick neben die Balken: aufgeklappte Blöcke wieder zusammenfassen und die Detailkarte schließen
  const clearSelection = (e) => {
    if (e.target.closest('[data-bar]') || Date.now() - lastDragEnd.current < 400) return;
    setExpanded({});
    setDetailId(null);
    setLaneDetail(null);
  };

  // Ziehen mit der Maus: Fenster-Ereignisse nur, solange etwas gegriffen ist
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;

    const findTarget = (x, y) => {
      const { basePlan: base, total: t, viewStart: v0, monday0: m0 } = latest.current;
      if (!base) return null;
      // Orte (QS, Extern …): der Tag, an dem losgelassen wird, ist der Beginn dort
      for (const lane of LANES) {
        const ex = laneTracks.current[lane.id];
        if (!ex) continue;
        const r = ex.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom) {
          const day = Math.min(t - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * t))) + v0;
          return { machine: lane.id, date: addDays(m0, day) };
        }
      }
      for (const p of base) {
        const el = trackRefs.current[p.m.id];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (y < r.top || y > r.bottom) continue;
        const day = ((x - r.left) / r.width) * t + v0;
        let index = p.items.length;
        for (const b of buildBlocks(p.items)) {
          if (day < (b.start + b.end) / 2) {
            index = b.firstIndex;
            break;
          }
        }
        return { machine: p.m.id, index };
      }
      return null;
    };

    const onMove = (e) => {
      const i = dragInfo.current;
      if (!i) return;
      if (!i.active && Math.hypot(e.clientX - i.startX, e.clientY - i.startY) < DRAG_THRESHOLD) return;
      i.active = true;
      const target = findTarget(e.clientX, e.clientY);
      setDrag((d) => d && { ...d, active: true, x: e.clientX, y: e.clientY, target });
    };

    const onUp = (e) => {
      const i = dragInfo.current;
      dragInfo.current = null;
      setDrag(null);
      if (!i) return;
      if (!i.active) {
        if (i.toggle) setExpanded((prev) => ({ ...prev, [i.toggle]: !prev[i.toggle] }));
        if (i.laneSelect) {
          setLaneDetail((cur) => (cur && cur.join() === i.laneSelect.join() ? null : i.laneSelect));
          setDetailId(null);
        }
        if (i.select != null) {
          setLaneDetail(null);
          if (latest.current.detailId === i.select) {
            setDetailId(null);
            if (i.collapse) setExpanded((prev) => ({ ...prev, [i.collapse]: false }));
          } else {
            setDetailId(i.select);
          }
        }
        return;
      }
      lastDragEnd.current = Date.now();
      const target = findTarget(e.clientX, e.clientY);
      if (!target) return;
      const current = latest.current.orders;
      if (LANE_IDS.includes(target.machine)) {
        const lane = laneOf(target.machine);
        setOrders(applyLaneMove(current, i.ids, target.date, lane));
        i.ids.forEach((id) => {
          const o = current.find((x) => x.id === id);
          send(`/api/orders/${id}`, "PUT", {
            machine: lane.id,
            extern_start: target.date,
            ...(o ? laneDaysOnMove(o, lane) : {}),
          });
        });
        return;
      }
      const before = current
        .filter((o) => o.machine === target.machine && !o.done)
        .sort(byPosition)
        .map((o) => o.id);
      const next = applyMove(current, i.ids, target.machine, target.index);
      if (next.ids.length === before.length && next.ids.every((id, k) => id === before[k])) return;
      setOrders(next.orders);
      send("/api/orders/reorder", "POST", { machine: target.machine, ids: next.ids });
    };

    const cancel = () => {
      dragInfo.current = null;
      setDrag(null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") cancel();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragging]);

  function startDrag(e, bar) {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    dragInfo.current = { ids: bar.ids, startX: e.clientX, startY: e.clientY, active: false, toggle: bar.toggle, select: bar.select ?? null, collapse: bar.collapse ?? null, laneSelect: bar.laneSelect ?? null };
    setDrag({
      ids: bar.ids,
      label: bar.label,
      sub: bar.sub,
      active: false,
      x: e.clientX,
      y: e.clientY,
      offX: e.clientX - r.left,
      offY: e.clientY - r.top,
      w: r.width,
      h: r.height,
      target: null,
    });
    e.preventDefault();
  }

  // Auftrag an einem Ort anlegen (z. B. FERTIGUNG EXTERN), Beginn heute
  async function addLaneOrder(lane) {
    const row = await send("/api/orders", "POST", { machine: lane.id });
    if (row && row.id) {
      const patch = { extern_start: today };
      setOrders((prev) => [...prev, { ...row, ...patch }]);
      send(`/api/orders/${row.id}`, "PUT", patch);
    }
  }

  async function addOrder(machine) {
    const row = await send("/api/orders", "POST", { machine });
    if (row && row.id) setOrders((prev) => [...prev, row]);
  }

  // "Noch nötig" eintragen. Ist der Rest größer als geplant, wachsen die Gesamtstunden (das bisher Gelaufene bleibt),
  // sonst gilt entsprechend mehr als gelaufen. Gleicher Wert = Schätzung bestätigen.
  function setRest(o, effDone, rest) {
    if (rest === 0) {
      finishProduced(o);
      return;
    }
    const cur = Math.max(0, o.hours - effDone);
    const patch =
      rest >= cur
        ? { hours: round1(effDone + rest), done_hours: round1(effDone), hours_plan: o.hours_plan ?? o.hours }
        : { done_hours: round1(o.hours - rest) };
    patchOrder(o.id, { ...patch, progress_date: today });
  }

  function patchOrder(id, patch) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
    send(`/api/orders/${id}`, "PUT", patch);
  }

  // Löschen mit Rückfrage direkt in der App (Browser-Dialoge erscheinen nicht überall)
  function askDelete(id) {
    setConfirmDeleteId(id);
    setTimeout(() => setConfirmDeleteId((cur) => (cur === id ? null : cur)), 5000);
  }

  function removeOrder(o) {
    setConfirmDeleteId(null);
    setOrders((prev) => prev.filter((x) => x.id !== o.id));
    send(`/api/orders/${o.id}`, "DELETE");
  }

  // Einzelnen Tag oder Zeitraum (Betriebsurlaub) als arbeitsfrei eintragen
  const dateRe = /^d{4}-d{2}-d{2}$/;
  const freeFromOk = dateRe.test(newFree.from);
  const freeToOk = newFree.to === "" || dateRe.test(newFree.to);
  const freeSpan = freeFromOk && freeToOk ? daysBetween(newFree.from, newFree.to || newFree.from) + 1 : 0;
  const canAddFree = freeFromOk && freeToOk && freeSpan >= 1 && freeSpan <= 120 && newFree.name.trim() !== "";
  async function addFreeDays() {
    if (!canAddFree) return;
    const days = Array.from({ length: freeSpan }, (_, i) => ({ date: addDays(newFree.from, i), name: newFree.name.trim() }));
    const data = await send("/api/free-days", "POST", { days });
    if (data?.days) setFreeDays(data.days);
    setNewFree({ from: "", to: "", name: "" });
  }

  async function removeFreeDay(date) {
    setFreeDays((prev) => prev.filter((d) => d.date !== date));
    const data = await send(`/api/free-days/${date}`, "DELETE");
    if (data?.days) setFreeDays(data.days);
  }

  function move(machine, id, dir) {
    const list = orders.filter((o) => o.machine === machine && !o.done).sort(byPosition);
    const i = list.findIndex((o) => o.id === id);
    if (i + dir < 0 || i + dir >= list.length) return;
    const next = applyMove(orders, [id], machine, i + dir);
    setOrders(next.orders);
    send("/api/orders/reorder", "POST", { machine, ids: next.ids });
  }

  // Zuweisen hängt die Positionen hinten in der Reihenfolge der Maschine an
  async function assignMany(list, machine) {
    if (list.length === 0) return;
    const base = Math.max(-1, ...orders.filter((x) => x.machine === machine).map((x) => x.position)) + 1;
    const position = new Map(list.map((o, k) => [o.id, base + k]));
    setOrders((prev) => prev.map((x) => (position.has(x.id) ? { ...x, machine, position: position.get(x.id) } : x)));
    setSelected({});
    for (const o of list) await send(`/api/orders/${o.id}`, "PUT", { machine });
  }

  // Liefertermin eines ganzen Auftrags: gilt für alle seine offenen Positionen
  function setGroupDue(g, value) {
    const ids = g.positions.filter((o) => !o.done).map((o) => o.id);
    const due = value || null;
    setOrders((prev) => prev.map((o) => (ids.includes(o.id) ? { ...o, due } : o)));
    send("/api/orders/due", "POST", { ids, due });
  }

  // Start frühestens für einen ganzen Auftrag: gilt für alle seine offenen Positionen
  const earliestOf = (g) =>
    g.positions
      .filter((o) => !o.done && o.earliest_start)
      .map((o) => o.earliest_start)
      .sort()[0] || "";
  function setGroupEarliest(g, value) {
    const ids = g.positions.filter((o) => !o.done).map((o) => o.id);
    const earliest_start = value || null;
    setOrders((prev) => prev.map((o) => (ids.includes(o.id) ? { ...o, earliest_start } : o)));
    send("/api/orders/earliest", "POST", { ids, earliest_start });
  }

  async function onImportFile(ev) {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    setImportMsg("");
    try {
      const items = parseOdooExport(await file.arrayBuffer());
      const result = await send("/api/orders/import", "POST", { items, dryRun: true });
      if (!result || result.error) throw new Error("Der Server hat den Import abgelehnt");
      setImportPreview({ items, result, fileName: file.name });
    } catch (err) {
      setImportPreview(null);
      setImportMsg(`Import nicht möglich: ${err.message}`);
    }
  }

  async function applyImport() {
    const { items } = importPreview;
    const result = await send("/api/orders/import", "POST", { items, dryRun: false });
    if (!result || result.error) {
      setImportMsg("Der Import konnte nicht gespeichert werden.");
      return;
    }
    const fresh = await fetch("/api/orders").then((r) => r.json());
    setOrders(fresh.orders);
    setImportPreview(null);
    setImportMsg(
      `Import fertig: ${result.created.length} neu, ${result.updated.length} aktualisiert, ` +
        `${result.closed.length} auf erledigt gesetzt.`
    );
  }

  function changeTightDays(raw) {
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 60) return;
    setTightDays(value);
    send("/api/plan-settings", "PUT", { tight_days: value });
  }

  function changeUtilization(raw) {
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) return;
    setUtilization(value);
    if (value >= 1) send("/api/plan-settings", "PUT", { utilization: value });
  }

  function setRate(machine, raw) {
    const value = raw === "" ? null : Number(raw);
    if (value !== null && !(value > 0)) return;
    setRates((prev) => {
      const next = { ...prev };
      if (value === null) delete next[machine];
      else next[machine] = value;
      return next;
    });
    send("/api/plan-rates", "PUT", { machine, weekly_hours: value });
  }

  const field = {
    ...mono,
    boxSizing: "border-box",
    border: `1px solid ${theme.line}`,
    borderRadius: 6,
    padding: "5px 8px",
    fontSize: 13,
    fontWeight: 600,
    color: theme.ink,
    background: theme.panel,
    outline: "none",
  };
  const smallBtn = (disabled) => ({
    ...eyebrow,
    fontSize: 10,
    padding: "5px 8px",
    borderRadius: 6,
    border: `1px solid ${theme.line}`,
    background: theme.panel,
    color: theme.steel,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
  });
  // QS-Ablauf: "Fertig produziert" schiebt die Position in die QS (Beginn heute), ohne QS-Pflicht ist sie damit erledigt.
  // In der QS bestätigt "Geprüft" den Abschluss (mit Stichpunkten geht es weiter zur Oberfläche) oder "Nacharbeit"
  // schickt die Position mit dem noch nötigen Rest zurück an ihre Maschine.
  function finishProduced(o) {
    const patch = { done_hours: o.hours, produced_date: today, progress_date: today };
    if (o.qs_required !== false) {
      const qs = laneOf("qs");
      const extra = { ...patch, from_machine: o.machine };
      setOrders((prev) => applyLaneMove(prev, [o.id], today, qs).map((x) => (x.id === o.id ? { ...x, ...extra } : x)));
      send(`/api/orders/${o.id}`, "PUT", { machine: qs.id, extern_start: today, ...extra });
    } else {
      patchOrder(o.id, { ...patch, done: true, done_date: today });
    }
  }

  function markChecked(o) {
    const patch = { checked_date: today };
    if (tagsOf(o).length > 0) {
      const lane = laneOf(EXTERN);
      setOrders((prev) => applyLaneMove(prev, [o.id], today, lane).map((x) => (x.id === o.id ? { ...x, ...patch } : x)));
      send(`/api/orders/${o.id}`, "PUT", { machine: lane.id, extern_start: today, ...laneDaysOnMove(o, lane), ...patch });
    } else {
      patchOrder(o.id, { ...patch, done: true, done_date: today });
    }
  }

  function sendRework(o, rest) {
    const machine = o.from_machine || MACHINES[0].id;
    const patch = {
      machine,
      hours: round1(o.hours + rest),
      done_hours: round1(o.hours),
      hours_plan: o.hours_plan ?? o.hours,
      extern_start: null,
      earliest_start: null,
      progress_date: today,
      checked_date: null,
    };
    setOrders((prev) => {
      const next = Math.max(-1, ...prev.filter((x) => x.machine === machine).map((x) => x.position)) + 1;
      return prev.map((x) => (x.id === o.id ? { ...x, ...patch, position: next } : x));
    });
    send(`/api/orders/${o.id}`, "PUT", patch);
    setReworkId(null);
  }

  // Schaltflächen einer Position, die an einem Ort liegt (QS: Geprüft / Nacharbeit, sonst Erledigt)
  const laneButtons = (o) => {
    if (o.machine !== "qs") {
      return (
        <button onClick={() => patchOrder(o.id, { done: true, done_date: today })} style={smallBtn(false)}>
          Erledigt
        </button>
      );
    }
    if (reworkId === o.id) {
      const n = Number(String(reworkText).replace(",", "."));
      return (
        <>
          <span style={{ fontSize: 12 }}>Noch nötig:</span>
          <input
            type="number"
            min={0}
            step="any"
            autoFocus
            value={reworkText}
            onChange={(ev) => setReworkText(ev.target.value)}
            onKeyDown={(ev) => ev.key === "Enter" && Number.isFinite(n) && n > 0 && sendRework(o, n)}
            style={{ ...field, width: 80 }}
          />
          <span style={{ fontSize: 12 }}>h</span>
          <button
            disabled={!(Number.isFinite(n) && n > 0)}
            onClick={() => sendRework(o, n)}
            style={smallBtn(!(Number.isFinite(n) && n > 0))}
          >
            Zurück an {MACHINES.find((m) => m.id === (o.from_machine || MACHINES[0].id))?.short}
          </button>
          <button onClick={() => setReworkId(null)} style={smallBtn(false)}>
            Abbrechen
          </button>
        </>
      );
    }
    return (
      <>
        <button
          onClick={() => markChecked(o)}
          title={tagsOf(o).length ? "Geprüft: weiter zu OBERFLÄCHE EXTERN" : "Geprüft: Position ist erledigt"}
          style={{ ...smallBtn(false), background: theme.green, borderColor: theme.green, color: "#fff" }}
        >
          Geprüft
        </button>
        <button
          onClick={() => {
            setReworkId(o.id);
            setReworkText("");
          }}
          title="Nicht in Ordnung: zurück an die Maschine"
          style={smallBtn(false)}
        >
          Nacharbeit
        </button>
        <span style={{ fontSize: 11, color: theme.steel }}>
          {tagsOf(o).length > 0 ? `danach: ${tagsOf(o).join(", ")} (OBERFLÄCHE EXTERN)` : "danach: erledigt"}
        </span>
      </>
    );
  };

  // Teillieferung: eine Position in zwei teilen (Stück und Stunden anteilig), einzeln oder für alle Positionen eines Auftrags
  const reloadOrders = () =>
    fetch("/api/orders")
      .then((r) => r.json())
      .then((d) => setOrders(d.orders));

  async function postSplit(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  async function doSplit(o) {
    const n = Number(String(splitFor.qty).replace(",", "."));
    const { ok, data } = await postSplit("/api/orders/split", { id: o.id, quantity: n, due: splitFor.due || null });
    if (!ok) {
      setSplitFor((cur) => cur && { ...cur, error: data.error || "Das Teilen hat nicht geklappt" });
      return;
    }
    setSplitFor(null);
    reloadOrders();
  }

  async function doSplitMany(source) {
    const n = Number(String(splitGroup.qty).replace(",", "."));
    const { ok, data } = await postSplit("/api/orders/split-many", { source, quantity: n, due: splitGroup.due || null });
    if (!ok) {
      setSplitGroup((cur) => cur && { ...cur, error: data.error || "Das Teilen hat nicht geklappt" });
      return;
    }
    setSplitGroup(null);
    setImportMsg(`Teillieferung: ${data.split} Positionen geteilt, ${data.whole} liefern vollständig mit der ersten Lieferung.`);
    reloadOrders();
  }

  const splitForm = (o) => {
    const n = Number(String(splitFor.qty).replace(",", "."));
    const ok = Number.isFinite(n) && n > 0 && n < o.quantity && splitFor.due;
    const part1 = Number.isFinite(n) && n > 0 && n < o.quantity ? round1((o.hours * n) / o.quantity) : null;
    return (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          marginTop: 8,
          padding: 10,
          border: `1px dashed ${theme.line}`,
          borderRadius: 8,
          fontSize: 12,
        }}
      >
        <span>Teillieferung: erste Lieferung</span>
        <input
          type="number"
          min={0}
          step="any"
          autoFocus
          value={splitFor.qty}
          onChange={(ev) => setSplitFor({ ...splitFor, qty: ev.target.value, error: null })}
          style={{ ...field, width: 70 }}
        />
        <span>von {fmtH(o.quantity)} Stück, Liefertermin</span>
        <input
          type="date"
          value={splitFor.due}
          onChange={(ev) => setSplitFor({ ...splitFor, due: ev.target.value, error: null })}
          style={{ ...field, colorScheme: mode }}
        />
        <button disabled={!ok} onClick={() => doSplit(o)} style={smallBtn(!ok)}>
          Anlegen
        </button>
        <button onClick={() => setSplitFor(null)} style={smallBtn(false)}>
          Abbrechen
        </button>
        {part1 != null && (
          <span style={{ color: theme.steel }}>
            Teil 1: {fmtH(n)} Stück, {fmtH(part1)} h · Rest: {fmtH(o.quantity - n)} Stück, {fmtH(round1(o.hours - part1))} h
          </span>
        )}
        {splitFor.error && <span style={{ color: theme.red }}>{splitFor.error}</span>}
      </div>
    );
  };

  const deleteButton = (o) =>
    confirmDeleteId === o.id ? (
      <>
        <button
          onClick={() => removeOrder(o)}
          style={{ ...smallBtn(false), background: theme.red, borderColor: theme.red, color: "#fff" }}
        >
          Wirklich löschen?
        </button>
        <button onClick={() => setConfirmDeleteId(null)} style={smallBtn(false)}>
          Abbrechen
        </button>
      </>
    ) : (
      <button onClick={() => askDelete(o.id)} style={smallBtn(false)}>
        Löschen
      </button>
    );
  const statusColor = (s) => (s === "late" ? theme.red : s === "tight" ? theme.amber : theme.graphite);

  // Stichpunkte für die externe Oberflächenbearbeitung einer Position (mehrere möglich) und die Dauer;
  // in QS und FERTIGUNG EXTERN gibt es nur die Dauer
  const externEditor = (o) => {
    const lane = laneOf(o.machine);
    const tags = tagsOf(o);
    const setTags = (next) => patchOrder(o.id, { extern_tags: next });
    const toggle = (tag) => setTags(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]);
    const chip = (on) => ({
      ...eyebrow,
      fontSize: 10,
      padding: "3px 8px",
      borderRadius: 12,
      border: `1px solid ${on ? theme.ink : theme.line}`,
      background: on ? theme.ink : theme.panel,
      color: on ? theme.bg : theme.steel,
      cursor: "pointer",
      textTransform: "none",
      letterSpacing: "0.04em",
    });
    const durationSelect = (
      <select
        value={daysIn(o)}
        title={lane ? `Dauer in ${lane.name}` : "Dauer der externen Bearbeitung"}
        onChange={(ev) => patchOrder(o.id, { [o.machine === "qs" ? "qs_days" : "extern_days"]: Number(ev.target.value) })}
        style={{ ...field, padding: "3px 6px", fontSize: 11 }}
      >
        {[...new Set([...EXTERN_DURATIONS, daysIn(o)])]
          .sort((a, b) => a - b)
          .map((d) => (
            <option key={d} value={d}>
              {fmtDuration(d)}
            </option>
          ))}
      </select>
    );
    if (lane && !lane.tags) {
      return (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 }}>
          <span style={eyebrow}>Dauer</span>
          {durationSelect}
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 }}>
        <span style={eyebrow}>Oberfläche</span>
        {[...EXTERN_SUGGESTIONS, ...tags.filter((t) => !EXTERN_SUGGESTIONS.includes(t))].map((tag) => (
          <button key={tag} onClick={() => toggle(tag)} style={chip(tags.includes(tag))}>
            {tag}
          </button>
        ))}
        <input
          type="text"
          maxLength={40}
          placeholder="+ Stichpunkt"
          onKeyDown={(ev) => {
            const value = ev.target.value.trim();
            if (ev.key === "Enter" && value) {
              if (!tags.includes(value) && tags.length < 10) setTags([...tags, value]);
              ev.target.value = "";
            }
          }}
          style={{ ...field, width: 110, padding: "3px 8px", fontSize: 11, fontWeight: 400 }}
        />
        {(tags.length > 0 || o.machine === EXTERN) && durationSelect}
      </div>
    );
  };

  // Orte (QS, FERTIGUNG EXTERN, OBERFLÄCHE EXTERN): Positionen desselben Auftrags mit gleichem Beginn und
  // gleicher Dauer ergeben einen Balken, gleichzeitige Balken stehen untereinander
  const laneBlocks = LANES.map((lane) => {
    const blocks = [];
    const byKey = new Map();
    viewOrders
      .filter((o) => o.machine === lane.id && !o.done && o.extern_start)
      .forEach((o) => {
        const duration = daysIn(o);
        const k = `${groupKeyOf(o)}|${o.extern_start}|${duration}`;
        if (!byKey.has(k)) {
          const start = daysBetween(monday0, o.extern_start);
          const b = {
            key: k,
            groupKey: groupKeyOf(o),
            label: groupLabelOf(o),
            ids: [],
            tags: new Set(),
            start,
            end: start + duration,
            duration,
          };
          byKey.set(k, b);
          blocks.push(b);
        }
        const b = byKey.get(k);
        b.ids.push(o.id);
        tagsOf(o).forEach((t) => b.tags.add(t));
      });
    blocks.sort((a, b) => a.start - b.start);
    const rowEnds = [];
    blocks.forEach((b) => {
      let row = rowEnds.findIndex((end) => end <= b.start);
      if (row === -1) row = rowEnds.length;
      rowEnds[row] = b.end;
      b.row = row;
    });
    return { lane, blocks, rows: Math.max(1, ...blocks.map((b) => b.row + 1)) };
  });

  const doneOrders = orders.filter((o) => o.done);
  const poolOrders = orders
    .filter((o) => o.machine === "" && !o.done)
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.id - b.id);
  const poolGroups = [];
  poolOrders.forEach((o) => {
    const key = groupKeyOf(o);
    let g = poolGroups.find((x) => x.key === key);
    if (!g) poolGroups.push((g = { key, label: groupLabelOf(o), due: null, items: [] }));
    g.items.push(o);
    if (o.due && (!g.due || o.due < g.due)) g.due = o.due;
  });
  const selectedOrders = poolOrders.filter((o) => selected[o.id]);
  const assignable = selectedOrders.filter((o) => o.hours > 0);
  const draggedBar = dragActive ? drag : null;

  return (
    <div>
      <div
        style={{
          marginBottom: 14,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div style={eyebrow}>Produktionsplanung</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginTop: 2 }}>Maschinenbelegung und Liefertermine</div>
        </div>
        <div>
          <input ref={fileInput} type="file" accept=".xlsx" onChange={onImportFile} style={{ display: "none" }} />
          <button onClick={() => fileInput.current.click()} style={smallBtn(false)}>
            Aus Odoo importieren
          </button>
        </div>
      </div>

      {importMsg && <div style={{ fontSize: 13, marginBottom: 14, color: theme.steel }}>{importMsg}</div>}

      {importPreview && (
        <div
          style={{
            background: theme.panel,
            border: `1px solid ${theme.line}`,
            borderLeft: `4px solid ${theme.ink}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
          }}
        >
          <div style={{ ...eyebrow, marginBottom: 6 }}>Import-Vorschau · {importPreview.fileName}</div>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <b>{importPreview.result.created.length}</b> neu (landen in „Noch nicht eingeplant“) ·{" "}
            <b>{importPreview.result.updated.length}</b> schon vorhanden (Menge und Produkt werden aus Odoo
            aktualisiert, ihre Liefertermine bleiben unverändert) · <b>{importPreview.result.closed.length}</b> werden
            auf erledigt gesetzt
          </div>
          {importPreview.result.closed.length > 0 && (
            <div style={{ fontSize: 12, color: theme.steel, marginTop: 4 }}>
              Auf erledigt, weil sie im Export fehlen: {importPreview.result.closed.join(", ")}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={applyImport} style={{ ...smallBtn(false), color: theme.ink, borderColor: theme.ink }}>
              Importieren
            </button>
            <button onClick={() => setImportPreview(null)} style={smallBtn(false)}>
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div
          style={{
            background: theme.panel,
            border: `1px solid ${theme.line}`,
            borderLeft: `4px solid ${theme.red}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
          }}
        >
          <div style={{ ...eyebrow, color: theme.red, marginBottom: 6 }}>Liefertermin gefährdet</div>
          {warnings.map((g) => (
            <div key={g.key} style={{ fontSize: 13, lineHeight: 1.6 }}>
              <b>{g.label}</b>: voraussichtlich {days(g.lateDays)} nach dem Liefertermin ({fmtShort(g.due)}),{" "}
              {LANES.some((l) => l.name === g.endMachine)
                ? `verzögert durch ${g.endMachine}`
                : `letzte Position endet auf ${g.endMachine}`}
              {g.unscheduled > 0 ? ` · ${g.unscheduled} Pos. noch nicht eingeplant` : ""}
            </div>
          ))}
        </div>
      )}

      {poolOrders.length > 0 && (
        <div
          style={{
            background: theme.panel,
            border: `1px solid ${theme.line}`,
            borderRadius: 10,
            padding: 18,
            marginBottom: 16,
          }}
        >
          <div style={eyebrow}>Noch nicht eingeplant ({poolOrders.length} Positionen)</div>
          <div style={{ fontSize: 12, color: theme.steel, margin: "4px 0 10px" }}>
            Ungefähre Gesamtstunden je Position eintragen. Mehrere Positionen ankreuzen und gemeinsam einer Maschine
            zuweisen, dann erscheinen sie im Zeitstrahl.
          </div>

          {selectedOrders.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                marginBottom: 8,
                borderRadius: 8,
                border: `1px solid ${theme.ink}`,
              }}
            >
              <b style={{ fontSize: 13 }}>{selectedOrders.length} ausgewählt</b>
              <select
                value=""
                disabled={assignable.length === 0}
                onChange={(ev) => ev.target.value && assignMany(assignable, ev.target.value)}
                style={{ ...field, opacity: assignable.length ? 1 : 0.5 }}
              >
                <option value="">{assignable.length ? "Maschine für Auswahl wählen" : "Stunden fehlen"}</option>
                {MACHINES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.short}
                  </option>
                ))}
              </select>
              {assignable.length < selectedOrders.length && (
                <span style={{ fontSize: 12, color: theme.steel }}>
                  {selectedOrders.length - assignable.length} ohne Stunden werden übersprungen
                </span>
              )}
              <button onClick={() => setSelected({})} style={smallBtn(false)}>
                Auswahl aufheben
              </button>
            </div>
          )}

          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {poolGroups.map((g) => {
              const allSelected = g.items.every((o) => selected[o.id]);
              return (
                <div key={g.key} style={{ borderTop: `1px solid ${theme.line}`, padding: "8px 0" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = { ...prev };
                          g.items.forEach((o) => {
                            if (allSelected) delete next[o.id];
                            else next[o.id] = true;
                          });
                          return next;
                        })
                      }
                      style={{ accentColor: theme.ink }}
                    />
                    <b style={{ ...mono, fontSize: 13 }}>{g.label}</b>
                    <span style={{ fontSize: 12, color: theme.steel }}>
                      {g.items.length} {g.items.length === 1 ? "Position" : "Positionen"}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: g.due && g.due < today ? theme.red : theme.steel,
                        fontWeight: g.due && g.due < today ? 600 : 400,
                      }}
                    >
                      {g.due ? `Liefertermin ${fmtShort(g.due)}` : "ohne Liefertermin"}
                    </span>
                  </label>
                  {g.items.map((o) => (
                    <div
                      key={o.id}
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 0 6px 26px",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!selected[o.id]}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = { ...prev };
                            if (next[o.id]) delete next[o.id];
                            else next[o.id] = true;
                            return next;
                          })
                        }
                        style={{ accentColor: theme.ink }}
                      />
                      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                        <div style={{ ...mono, fontWeight: 600, fontSize: 12 }}>
                          {o.order_no || "ohne Nummer"} <OdooLink o={o} />
                        </div>
                        <div
                          title={metaLine(o, false)}
                          style={{
                            fontSize: 11,
                            color: theme.steel,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {metaLine(o, false)}
                        </div>
                      </div>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        placeholder="Std gesamt"
                        title="Ungefähre Gesamtstunden dieser Position"
                        value={o.hours || ""}
                        onChange={(ev) =>
                          patchOrder(o.id, (() => {
                          const h = ev.target.value === "" ? 0 : Math.max(0, Number(ev.target.value));
                          return { hours: h, hours_plan: h };
                        })())
                        }
                        style={{ ...field, width: 96 }}
                      />
                      <select
                        value=""
                        disabled={!(o.hours > 0)}
                        onChange={(ev) => ev.target.value && assignMany([o], ev.target.value)}
                        style={{ ...field, opacity: o.hours > 0 ? 1 : 0.5 }}
                      >
                        <option value="">{o.hours > 0 ? "Maschine wählen" : "erst Stunden"}</option>
                        {MACHINES.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.short}
                          </option>
                        ))}
                      </select>
                      {deleteButton(o)}
                      <div style={{ flexBasis: "100%", paddingLeft: 26 }}>{externEditor(o)}</div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Zeitstrahl */}
      <div
        style={{
          background: theme.panel,
          border: `1px solid ${theme.line}`,
          borderRadius: 10,
          padding: 18,
          marginBottom: 16,
          overflowX: "auto",
        }}
      >
        <div style={{ minWidth: 620 }}>
          {/* Vorschau "Was wäre wenn": gilt nur hier, bis sie übernommen oder verworfen wird */}
          {preview && (
            <div
              style={{
                marginBottom: 14,
                padding: "10px 14px",
                borderRadius: 8,
                border: `1px dashed ${theme.amber}`,
                background: `${theme.amber}18`,
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 700 }}>
                Vorschau, nicht gespeichert: ab KW {isoWeekOf(preview.date).week} ({fmtShort(preview.date)}){" "}
                {SHIFT_MODELS.find((s) => s.hours === preview.hours)?.label ?? "Eigener Wert"} · {fmtH(preview.hours)} h
              </div>
              {previewStats && (
                <div style={{ marginTop: 4 }}>
                  Aufträge, die den Liefertermin verfehlen: <b>{previewStats.before.late}</b> → <b>{previewStats.after.late}</b> · Verspätung
                  zusammen: <b>{previewStats.before.days}</b> → <b>{previewStats.after.days}</b> Tage
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => {
                    onSaveShift(preview.date, preview.hours);
                    setPreview(null);
                  }}
                  style={{ ...smallBtn(false), background: theme.ink, color: theme.bg, borderColor: theme.ink }}
                >
                  Übernehmen
                </button>
                <button onClick={() => setPreview(null)} style={smallBtn(false)}>
                  Verwerfen
                </button>
              </div>
            </div>
          )}

          {/* Ansicht: Wochen oder Kalendermonat, vor und zurück blättern */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {[
                ["weeks", "Wochen"],
                ["month", "Monat"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => {
                    setViewMode(id);
                    setViewOffset(0);
                  }}
                  style={{
                    ...smallBtn(false),
                    ...(viewMode === id ? { background: theme.ink, color: theme.bg, borderColor: theme.ink } : {}),
                  }}
                >
                  {label}
                </button>
              ))}
              {viewMode === "weeks" && (
                <select
                  value={viewWeeks}
                  onChange={(ev) => {
                    const v = Number(ev.target.value);
                    setViewWeeks(v);
                    try {
                      window.localStorage.setItem("kratos-view-weeks", String(v));
                    } catch {
                      /* ohne Speicher bleibt es bei der Auswahl dieser Sitzung */
                    }
                  }}
                  style={{ ...field, padding: "4px 8px" }}
                >
                  <option value={1}>1 Woche</option>
                  <option value={2}>2 Wochen</option>
                  <option value={3}>3 Wochen</option>
                </select>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => setViewOffset((o) => o - 1)}
                title={viewMode === "weeks" ? "Eine Woche zurück" : "Voriger Monat"}
                style={smallBtn(false)}
              >
                ◀
              </button>
              <span style={{ ...mono, fontSize: 13, fontWeight: 600, minWidth: 200, textAlign: "center" }}>{viewLabel}</span>
              <button
                onClick={() => setViewOffset((o) => o + 1)}
                title={viewMode === "weeks" ? "Eine Woche vor" : "Nächster Monat"}
                style={smallBtn(false)}
              >
                ▶
              </button>
              {viewOffset !== 0 && (
                <button onClick={() => setViewOffset(0)} style={smallBtn(false)}>
                  Heute
                </button>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr" }}>
            <div />
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeksShown}, 1fr)` }}>
              {Array.from({ length: weeksShown }, (_, w) => {
                const monday = addDays(monday0, viewStart + 7 * w);
                return (
                  <div
                    key={w}
                    style={{
                      fontSize: 12,
                      color: theme.steel,
                      padding: "0 0 6px 6px",
                      borderLeft: `1px solid ${theme.line}`,
                    }}
                  >
                    <b style={{ color: theme.ink, fontWeight: 600 }}>KW {isoWeekOf(monday).week}</b> · {fmtShort(monday)}
                    {weeksShown <= MAX_WEEKS_WITH_DAYS && (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginTop: 3, marginLeft: -6 }}>
                        {DAY_NAMES.map((name, d) => {
                          const date = addDays(monday, d);
                          const outside = monthKey != null && date.slice(0, 7) !== monthKey;
                          return (
                            <div
                              key={name}
                              style={{
                                fontSize: weeksShown <= 3 ? 12 : 10,
                                lineHeight: 1.25,
                                textAlign: "center",
                                opacity: outside ? 0.4 : 1,
                                fontWeight: date === today ? 700 : 400,
                                color: isFreeDay(viewStart + w * 7 + d, free)
                                  ? theme.line
                                  : date === today
                                  ? theme.red
                                  : theme.steel,
                              }}
                            >
                              {name}
                              <br />
                              {date.slice(8, 10)}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {plan.map((p) => {
            const blocks = buildBlocks(p.items);
            // Liefertermine dieser Zeile: außerhalb des Fensters am Rand, überlappende untereinander
            const markers = [];
            const seenGroups = new Set();
            blocks.forEach((block) => {
              const g = groupByKey.get(block.key);
              if (!g || g.dueEnd == null || seenGroups.has(g.key)) return;
              seenGroups.add(g.key);
              const side = g.dueEnd < viewStart ? "left" : g.dueEnd > viewEnd ? "right" : "in";
              const text =
                `${side === "left" ? "◀ " : ""}${g.label} · ${fmtShort(g.due)}` +
                `${g.status === "late" ? ` · +${days(g.lateDays)}` : ""}${side === "right" ? " ▶" : ""}`;
              const widthPct = ((text.length * 6.6 + 26) / TRACK_PX) * 100;
              const x = side === "left" ? 0 : side === "right" ? 100 - widthPct : Math.min(posPct(g.dueEnd), 100 - widthPct);
              markers.push({ g, side, text, x, widthPct });
            });
            markers.sort((a, b) => a.x - b.x);
            const laneEnds = [];
            markers.forEach((m) => {
              let lane = laneEnds.findIndex((end) => end <= m.x);
              if (lane === -1) lane = laneEnds.length;
              laneEnds[lane] = m.x + m.widthPct;
              m.lane = lane;
            });
            const rowHeight = MARKER_TOP + Math.max(1, laneEnds.length) * MARKER_LANE + 8;
            return (
              <div
                key={p.m.id}
                style={{ display: "grid", gridTemplateColumns: "140px 1fr", borderTop: `1px solid ${theme.line}` }}
              >
                <div style={{ padding: "12px 8px 0 0" }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: theme[p.m.colorKey] }}>{p.m.name}</div>
                  <div style={{ fontSize: 12, color: theme.steel }}>
                    {p.rate ? `${fmtH(p.rate)} h/Woche` : "keine Wochenleistung"}
                  </div>
                </div>
                <div
                  ref={(el) => {
                    trackRefs.current[p.m.id] = el;
                  }}
                  onClick={clearSelection}
                  style={{
                    position: "relative",
                    height: rowHeight,
                    overflow: "hidden",
                    backgroundColor: dragActive && drag.target?.machine === p.m.id ? `${theme.line}66` : "transparent",
                    backgroundImage: `linear-gradient(to right, ${theme.line} 1px, transparent 1px)`,
                    backgroundSize: `${100 / weeksShown}% 100%`,
                  }}
                >
                  {Array.from({ length: total }, (_, k) => viewStart + k)
                    .filter((d) => isFreeDay(d, free))
                    .map((d) => (
                      <div
                        key={`free-${d}`}
                        title={freeNames.get(d) || undefined}
                        style={{
                          position: "absolute",
                          top: 0,
                          bottom: 0,
                          left: `${posPct(d)}%`,
                          width: `${(1 / total) * 100}%`,
                          backgroundImage: `repeating-linear-gradient(135deg, ${theme.line} 0 2px, transparent 2px 6px)`,
                          opacity: 0.7,
                        }}
                      />
                    ))}
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: `${posPct(todayOff)}%`,
                      borderLeft: `2px dashed ${theme.red}`,
                      opacity: 0.75,
                    }}
                  />
                  {p.items
                    .filter((it) => it.scheduled && it.waitFrom != null && it.start > it.waitFrom)
                    .map((it) => {
                      const { cs, ce } = span(it.waitFrom, it.start);
                      if (ce <= cs) return null;
                      return (
                        <div
                          key={`wait-${it.o.id}`}
                          title={`${it.o.order_no || "Position"} wartet bis ${fmtShort(dateOf(it.start))} (Start frühestens)`}
                          style={{
                            position: "absolute",
                            top: BAR_TOP,
                            height: BAR_H,
                            left: `${posPct(cs)}%`,
                            width: `calc(${((ce - cs) / total) * 100}% - 2px)`,
                            boxSizing: "border-box",
                            border: `1px dashed ${theme.steel}`,
                            borderRadius: 6,
                            backgroundImage: `repeating-linear-gradient(135deg, ${theme.line} 0 2px, transparent 2px 6px)`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                            color: theme.steel,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                          }}
                        >
                          wartet
                        </div>
                      );
                    })}
                  {blocks.flatMap((block, bIdx) => {
                    const g = groupByKey.get(block.key);
                    const status = g ? g.status : "ok";
                    const multi = block.items.length > 1;
                    const externCount = block.items.filter((i) => tagsOf(i.o).length > 0).length;
                    const toggleKey = `${p.m.id}|${block.key}`;
                    const open = multi && expanded[toggleKey];
                    const bg = statusColor(status);
                    const fg = status === "late" ? "#fff" : status === "tight" ? "#16181D" : theme.bg;
                    const groupTip =
                      (g && g.due ? `\nLiefertermin ${fmtShort(g.due)}` : "") +
                      (status === "late"
                        ? `\nAchtung: Auftrag ${days(g.lateDays)} zu spät (Ende: ${g.endMachine})`
                        : status === "tight"
                        ? `\nPuffer des Auftrags nur ${fmtH(-g.diff)} Tage`
                        : "");

                    const parts = open
                      ? block.items.map((it) => ({
                          ids: [it.o.id],
                          start: it.pastStart ?? it.start,
                          pastEnd: it.pastStart != null ? it.start : null,
                          end: it.end,
                          label: posNo(it.o),
                          sub:
                            `${it.percent != null ? `${it.estimated ? "~" : ""}${it.percent} % · ` : ""}${fmtH(it.remaining)} h` +
                            (tagsOf(it.o).length ? " · extern" : ""),
                          percent: it.percent,
                          toggle: null,
                          select: it.o.id,
                          collapse: toggleKey,
                          tip:
                            `${it.o.order_no || "ohne Nummer"} · gesamt ${fmtH(it.o.hours)} h` +
                            (metaLine(it.o) ? `\n${metaLine(it.o)}` : "") +
                            (tagsOf(it.o).length
                              ? `\nOBERFLÄCHE EXTERN danach: ${tagsOf(it.o).join(", ")} (${fmtDuration(it.o.extern_days || 7)})`
                              : "") +
                            (it.percent != null ? `\ngelaufen ${fmtH(it.effDone)} h (${it.estimated ? "geschätzt ~" : ""}${it.percent} %), Rest ${fmtH(it.remaining)} h` : "") +
                            `\nStart ca. ${fmtShort(dateOf(it.start))} · Ende ca. ${fmtShort(endDateOf(it.end))}` +
                            groupTip +
                            "\n\nKlicken für Details und Odoo-Link · erneut klicken zum Zuklappen · ziehen zum Verschieben",
                        }))
                      : [
                          {
                            ids: block.items.map((i) => i.o.id),
                            start: block.start,
                            pastEnd: block.doneEnd,
                            end: block.end,
                            label: g ? g.label : groupLabelOf(block.items[0].o),
                            sub:
                              `${block.percent != null ? `${block.estimated ? "~" : ""}${block.percent} % · ` : ""}` +
                              `${multi ? `${block.items.length} Pos. · ` : ""}${fmtH(block.remaining)} h` +
                              (externCount ? ` · ${externCount} extern` : ""),
                            percent: block.percent,
                            toggle: multi ? toggleKey : null,
                            select: multi ? null : block.items[0].o.id,
                            tip:
                              `${g ? g.label : groupLabelOf(block.items[0].o)}` +
                              (multi ? ` · ${block.items.length} Positionen auf dieser Maschine` : "") +
                              (multi
                                ? `\nFA: ${block.items
                                    .slice(0, 6)
                                    .map((i) => i.o.order_no)
                                    .join(", ")}${block.items.length > 6 ? " …" : ""}`
                                : (metaLine(block.items[0].o) ? `\n${metaLine(block.items[0].o)}` : "") +
                                  `\n${block.items[0].o.order_no || "ohne Nummer"}`) +
                              `\ngesamt ${fmtH(block.hours)} h` +
                              (block.percent != null ? ` · ${block.estimated ? "~" : ""}${block.percent} % ${block.estimated ? "geschätzt" : "erledigt"}` : "") +
                              `, Rest ${fmtH(block.remaining)} h` +
                              (externCount
                                ? `\nOBERFLÄCHE EXTERN danach (${externCount} Pos.): ${[
                                    ...new Set(block.items.flatMap((i) => tagsOf(i.o))),
                                  ].join(", ")}`
                                : "") +
                              `\nStart ca. ${fmtShort(dateOf(block.start))} · Ende ca. ${fmtShort(endDateOf(block.end))}` +
                              groupTip +
                              (multi ? "\n\nKlicken zum Aufklappen · ziehen zum Verschieben" : "\n\nKlicken für Details und Odoo-Link · ziehen zum Verschieben"),
                          },
                        ];

                    const bars = parts.map((part, idx) => {
                      const { cs, ce, cutL, cutR } = span(part.start, part.end);
                      if (ce <= cs) return null;
                      const isDragged = dragActive && part.ids.some((id) => drag.ids.includes(id));
                      return (
                        <div
                          key={`${block.key}-${part.ids[0]}`}
                          title={dragActive ? undefined : part.tip}
                          data-bar="1"
                          onPointerDown={(e) => startDrag(e, part)}
                          style={{
                            position: "absolute",
                            top: BAR_TOP,
                            height: BAR_H,
                            left: `${posPct(cs)}%`,
                            width: `calc(${((ce - cs) / total) * 100}% - 2px)`,
                            // Sehr kleine Aufträge bleiben greifbar; sie liegen über dem Nachfolger
                            minWidth: MIN_BAR_PX,
                            zIndex: Math.max(1, 100 - bIdx * 10 - idx),
                            boxShadow: `0 0 0 1px ${theme.panel}`,
                            boxSizing: "border-box",
                            borderRadius: 6,
                            padding: "4px 8px 8px",
                            overflow: "hidden",
                            background: bg,
                            color: fg,
                            opacity: isDragged ? 0.35 : status === "ok" && (bIdx + idx) % 2 ? 0.78 : 1,
                            outline: isDragged
                              ? `2px dashed ${theme.ink}`
                              : part.select != null && part.select === detailId
                              ? `2px solid ${theme.ink}`
                              : "none",
                            cursor: "grab",
                            touchAction: "none",
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "center",
                            lineHeight: 1.25,
                          }}
                        >
                          {part.pastEnd != null &&
                            (() => {
                              const w = ((Math.min(part.pastEnd, ce) - cs) / (ce - cs)) * 100;
                              return w > 0 ? (
                                <div
                                  title="schon gelaufen (ab dem eingetragenen Start)"
                                  style={{
                                    position: "absolute",
                                    left: 0,
                                    top: 0,
                                    bottom: 0,
                                    width: `${Math.min(100, w)}%`,
                                    backgroundImage: "repeating-linear-gradient(135deg, rgba(0,0,0,0.22) 0 4px, transparent 4px 8px)",
                                    pointerEvents: "none",
                                  }}
                                />
                              ) : null;
                            })()}
                          <b style={{ position: "relative", fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {cutL ? "◀ " : ""}
                            {part.label}
                          </b>
                          <span style={{ position: "relative", fontSize: 12, opacity: 0.85, whiteSpace: "nowrap" }}>
                            {part.sub}
                            {cutR ? " ▶" : ""}
                          </span>
                          {part.percent != null && (
                            <div
                              style={{
                                position: "absolute",
                                left: 6,
                                right: 6,
                                bottom: 4,
                                height: 3,
                                borderRadius: 2,
                                background: "rgba(127,127,127,0.35)",
                              }}
                            >
                              <div style={{ width: `${part.percent}%`, height: "100%", borderRadius: 2, background: fg }} />
                            </div>
                          )}
                        </div>
                      );
                    });

                    return bars;
                  })}
                  {markers.map((m) => (
                    <div
                      key={`due-${m.g.key}`}
                      title={`Liefertermin ${fmtShort(m.g.due)}`}
                      style={{
                        position: "absolute",
                        top: MARKER_TOP + m.lane * MARKER_LANE,
                        left: m.side === "right" ? undefined : `${m.x}%`,
                        right: m.side === "right" ? 0 : undefined,
                        transform: m.side === "in" ? "translateX(-5px)" : "none",
                        zIndex: 200,
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        fontSize: 12,
                        whiteSpace: "nowrap",
                        padding: "1px 5px 1px 2px",
                        borderRadius: 4,
                        background: theme.panel,
                        color: m.g.status === "late" ? theme.red : theme.steel,
                        fontWeight: m.g.status === "late" ? 600 : 400,
                      }}
                    >
                      <i
                        style={{
                          width: 9,
                          height: 9,
                          display: "block",
                          transform: "rotate(45deg)",
                          background: m.g.status === "late" ? theme.red : theme.ink,
                        }}
                      />
                      {m.text}
                    </div>
                  ))}
                  {p.freeAt != null &&
                    (() => {
                      const label = `frei ab ca. ${fmtShort(dateOf(p.freeAt))}`;
                      const base = {
                        position: "absolute",
                        top: BAR_TOP + BAR_H / 2 - 9,
                        fontSize: 12,
                        color: theme.steel,
                        whiteSpace: "nowrap",
                        zIndex: 150,
                      };
                      if (p.freeAt >= viewEnd) {
                        return (
                          <div style={{ ...base, right: 6, background: theme.panel, padding: "1px 6px", borderRadius: 4 }}>
                            {label} ▶
                          </div>
                        );
                      }
                      if (p.freeAt < viewStart) return <div style={{ ...base, left: 6 }}>{label}</div>;
                      const lastStart = Math.max(p.scheduled[p.scheduled.length - 1].start, viewStart);
                      return (
                        <div
                          style={{
                            ...base,
                            left: `max(calc(${posPct(p.freeAt)}% + 6px), calc(${posPct(lastStart)}% + ${MIN_BAR_PX + 6}px))`,
                          }}
                        >
                          {label}
                        </div>
                      );
                    })()}
                </div>
              </div>
            );
          })}

          {/* Orte: QS, FERTIGUNG EXTERN, OBERFLÄCHE EXTERN */}
          {laneBlocks.map(({ lane, blocks, rows }) => (
            <div
              key={lane.id}
              style={{ display: "grid", gridTemplateColumns: "140px 1fr", borderTop: `1px solid ${theme.line}` }}
            >
              <div style={{ padding: "12px 8px 0 0" }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: lane.colorKey ? theme[lane.colorKey] : undefined }}>{lane.name}</div>
              </div>
              <div
                ref={(el) => {
                  laneTracks.current[lane.id] = el;
                }}
                onClick={clearSelection}
                style={{
                  position: "relative",
                  height: rows * 32 + 14,
                  overflow: "hidden",
                  backgroundColor: dragActive && drag.target?.machine === lane.id ? `${theme.line}66` : "transparent",
                  backgroundImage: `linear-gradient(to right, ${theme.line} 1px, transparent 1px)`,
                  backgroundSize: `${100 / weeksShown}% 100%`,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: `${posPct(todayOff)}%`,
                    borderLeft: `2px dashed ${theme.red}`,
                    opacity: 0.75,
                  }}
                />
                {blocks.map((b) => {
                  const g = groupByKey.get(b.groupKey);
                  const overdue = lane.id === "qs" && b.end <= todayOff; // Prüfung länger als geplant
                  const color = overdue ? theme.red : statusColor(g ? g.status : "ok");
                  const isDragged = dragActive && b.ids.some((id) => drag.ids.includes(id));
                  const tags = [...b.tags];
                  const { cs, ce } = span(b.start, b.end);
                  if (ce <= cs) return null;
                  return (
                    <div
                      key={b.key}
                      title={
                        dragActive
                          ? undefined
                          : `${b.label} · ${b.ids.length} ${b.ids.length === 1 ? "Position" : "Positionen"} in ${lane.name}` +
                            (tags.length ? `: ${tags.join(", ")}` : "") +
                            `\n${fmtDuration(b.duration)}, ab ${fmtShort(dateOf(b.start))} ` +
                            `bis ca. ${fmtShort(endDateOf(b.end))}` +
                            (overdue ? " – Prüfung überfällig" : "") +
                            (g && g.due ? `\nLiefertermin ${fmtShort(g.due)}` : "") +
                            (g && g.status === "late"
                              ? `\nAchtung: Auftrag ${days(g.lateDays)} zu spät (Ende: ${g.endMachine})`
                              : "") +
                            "\n\nZum Verschieben ziehen (auch zurück auf eine Maschine)"
                      }
                      data-bar="1"
                      onPointerDown={(e) =>
                        startDrag(e, {
                          ids: b.ids,
                          label: b.label,
                          sub: `${b.ids.length} Pos.`,
                          toggle: null,
                          laneSelect: b.ids,
                        })
                      }
                      style={{
                        position: "absolute",
                        top: 7 + b.row * 32,
                        height: 26,
                        left: `${posPct(cs)}%`,
                        width: `calc(${((ce - cs) / total) * 100}% - 2px)`,
                        minWidth: MIN_BAR_PX,
                        boxSizing: "border-box",
                        borderRadius: 6,
                        border: `2px solid ${color}`,
                        backgroundImage: `repeating-linear-gradient(135deg, ${color}44 0 5px, transparent 5px 10px)`,
                        opacity: isDragged ? 0.45 : 1,
                        outline: isDragged ? `2px dashed ${theme.ink}` : "none",
                        cursor: "grab",
                        touchAction: "none",
                        padding: "0 8px",
                        display: "flex",
                        alignItems: "center",
                        fontSize: 12,
                        color: theme.ink,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      <b style={{ marginRight: 6 }}>{b.label}</b>
                      {b.ids.length > 1 ? `${b.ids.length} Pos. ` : ""}
                      {tags.join(", ")}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Details der gewählten Position, mit Link zum Fertigungsauftrag in Odoo */}
          {(() => {
            const found =
              detailId != null
                ? plan.flatMap((pl) => pl.items.map((it) => ({ pl, it }))).find((x) => x.it.o.id === detailId)
                : null;
            if (!found) return null;
            const { pl, it } = found;
            const o = it.o;
            const g = groupByKey.get(groupKeyOf(o));
            const toggleKey = `${pl.m.id}|${groupKeyOf(o)}`;
            const meta = [o.quantity != null ? `${fmtH(o.quantity)} Stück` : null, o.product].filter(Boolean).join(" · ");
            const fact = (label, value) => (
              <div style={{ minWidth: 130 }}>
                <div style={{ ...eyebrow, fontSize: 9 }}>{label}</div>
                <div style={{ fontSize: 12, marginTop: 2 }}>{value}</div>
              </div>
            );
            return (
              <div style={{ marginTop: 14, padding: 14, border: `1px solid ${theme.line}`, borderRadius: 8, background: theme.bg }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <b style={{ ...mono, fontSize: 14 }}>{posNo(o)}</b>
                      <span style={{ fontSize: 12, color: theme.steel }}>
                        {o.source ? `Auftrag ${o.source} · ` : ""}
                        <span style={{ color: theme[pl.m.colorKey], fontWeight: 600 }}>{pl.m.name}</span>
                      </span>
                    </div>
                    {meta && <div style={{ fontSize: 12, marginTop: 4 }}>{meta}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {o.odoo_id ? (
                      <a
                        href={`${ODOO_URL}/${o.odoo_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ ...smallBtn(false), textDecoration: "none", color: theme.ink, fontWeight: 700 }}
                      >
                        In Odoo öffnen ↗
                      </a>
                    ) : (
                      <span style={{ fontSize: 11, color: theme.steel }}>Kein Odoo-Link (Export ohne ID)</span>
                    )}
                    <button onClick={() => finishProduced(o)} title="Fertig produziert: die Position geht in die QS" style={smallBtn(false)}>
                      Fertig produziert
                    </button>
                    {expanded[toggleKey] && (
                      <button
                        onClick={() => {
                          setExpanded((prev) => ({ ...prev, [toggleKey]: false }));
                          setDetailId(null);
                        }}
                        style={smallBtn(false)}
                      >
                        Block zuklappen
                      </button>
                    )}
                    <button onClick={() => setDetailId(null)} title="Schließen" style={smallBtn(false)}>
                      ✕
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 24px", marginTop: 12 }}>
                  {fact(
                    "Gesamtstunden",
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        title="Gesamtstunden der Position (Schätzung)"
                        value={o.hours || ""}
                        onChange={(ev) =>
                          patchOrder(o.id, (() => {
                          const h = ev.target.value === "" ? 0 : Math.max(0, Number(ev.target.value));
                          return { hours: h, hours_plan: h };
                        })())
                        }
                        style={{ ...field, width: 84 }}
                      />
                      h
                    </span>
                  )}
                  {fact(
                    "Noch nötig",
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <RestInput
                        value={o.hours > 0 ? round1(it.remaining) : ""}
                        title="Wie viele Stunden braucht die Position noch? (Stand heute). Mehr als geplant verlängert den Balken."
                        onCommit={(n) => setRest(o, it.effDone, n)}
                        style={{ ...field, width: 84 }}
                      />
                      h
                      <span style={{ color: it.stale ? theme.amber : theme.steel }}>
                        {it.percent != null ? `${it.estimated ? "~" : ""}${it.percent} % ${it.estimated ? "geschätzt" : "erledigt"} · ` : ""}
                        gelaufen {fmtH(it.effDone)} h{it.stale ? " · Fortschritt prüfen" : ""}
                      </span>
                    </span>
                  )}
                  {o.hours_plan != null &&
                    o.hours > o.hours_plan + 0.05 &&
                    fact("Mehraufwand", `+${fmtH(o.hours - o.hours_plan)} h (Plan ${fmtH(o.hours_plan)} h, jetzt ${fmtH(o.hours)} h)`)}
                  {fact(
                    "Auf der Maschine",
                    it.scheduled
                      ? `${it.pastStart != null ? "seit " : ""}${fmtShort(dateOf(it.pastStart ?? it.start))} bis ca. ${fmtShort(endDateOf(it.end))}`
                      : "nicht eingeplant"
                  )}
                  {fact(
                    "Liefertermin der Position",
                    <input
                      type="date"
                      title="Liefertermin dieser Position (der Auftragstermin steht in der Auftragsübersicht)"
                      value={o.due || ""}
                      onChange={(ev) => patchOrder(o.id, { due: ev.target.value || null })}
                      style={{ ...field, colorScheme: mode }}
                    />
                  )}
                  {o.component_status && fact("Material (Odoo)", <MaterialBadge o={o} theme={theme} />)}
                  {fact(
                    "Start frühestens",
                    <input
                      type="date"
                      title="Z. B. wenn Rohmaterial und Werkzeuge da sind. Ein Datum in der Vergangenheit gilt als tatsächlicher Start (der Balken beginnt dort). Leer = sobald die Maschine frei ist."
                      value={o.earliest_start || ""}
                      onChange={(ev) => patchOrder(o.id, { earliest_start: ev.target.value || null })}
                      style={{ ...field, colorScheme: mode }}
                    />
                  )}
                  {g && g.end != null && fact("Auftrag fertig ca.", `${fmtShort(endDateOf(g.end))} (${g.endMachine})`)}
                  {tagsOf(o).length > 0 && fact("OBERFLÄCHE EXTERN danach", `${tagsOf(o).join(", ")} · ${fmtDuration(o.extern_days || 7)}`)}
                </div>
              </div>
            );
          })()}

          {/* QS und andere Orte: Positionen des angeklickten Balkens mit ihren Aktionen */}
          {laneDetail &&
            (() => {
              const list = laneDetail.map((id) => orders.find((x) => x.id === id)).filter((x) => x && !x.done);
              if (list.length === 0) return null;
              const lane = laneOf(list[0].machine);
              if (!lane) return null;
              return (
                <div style={{ marginTop: 14, padding: 14, border: `1px solid ${theme.line}`, borderRadius: 8, background: theme.bg }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <b style={{ fontSize: 14, color: lane.colorKey ? theme[lane.colorKey] : undefined }}>{lane.name}</b>
                    <button onClick={() => setLaneDetail(null)} title="Schließen" style={smallBtn(false)}>
                      ✕
                    </button>
                  </div>
                  {list.map((o) => {
                    const start = o.extern_start ? daysBetween(monday0, o.extern_start) : null;
                    return (
                      <div key={o.id} style={{ borderTop: `1px solid ${theme.line}`, marginTop: 10, paddingTop: 10 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                          <b style={{ ...mono, fontSize: 13 }}>{posNo(o)}</b>
                          <OdooLink o={o} />
                          <span style={{ fontSize: 12, color: theme.steel }}>
                            {o.source ? `Auftrag ${o.source} · ` : ""}
                            {start != null
                              ? `seit ${fmtShort(o.extern_start)}, ${fmtDuration(daysIn(o))} (bis ca. ${fmtShort(endDateOf(start + daysIn(o)))})`
                              : "ohne Beginn"}
                          </span>
                        </div>
                        {metaLine(o, false) && <div style={{ fontSize: 12, marginTop: 4 }}>{metaLine(o, false)}</div>}
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                          {laneButtons(o)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 14, fontSize: 11, color: theme.steel }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ width: 14, height: 10, borderRadius: 3, background: theme.graphite, display: "inline-block" }} />
              Auftrag im Plan
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ width: 14, height: 10, borderRadius: 3, background: theme.amber, display: "inline-block" }} />
              Puffer unter
              <input
                type="number"
                min={0}
                max={60}
                step={1}
                title="Mindestpuffer in Tagen: darunter wird ein Auftrag gelb markiert"
                value={tightDays}
                onChange={(ev) => changeTightDays(ev.target.value)}
                style={{ ...field, width: 52, padding: "2px 6px", fontSize: 12 }}
              />
              Tagen
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title="Die Planung rechnet je Maschine mit Betriebszeit des Schichtmodells x Nutzung. Ein eigener Wert pro Maschine hat Vorrang.">
              Planung: {shift.label} {fmtH(shift.hours)} h ×
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={utilization || ""}
                onChange={(ev) => changeUtilization(ev.target.value)}
                style={{ ...field, width: 56, padding: "2px 6px", fontSize: 12 }}
              />
              % Nutzung
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ width: 14, height: 10, borderRadius: 3, background: theme.red, display: "inline-block" }} />
              Liefertermin wird verfehlt
            </span>
            <span>◆ Liefertermin des Auftrags</span>
            <span>gestrichelt: heute</span>
          </div>
          <div style={{ fontSize: 11, color: theme.steel, marginTop: 10 }}>
            Positionen eines Auftrags (gleiche Quelle) stehen als ein Block, ein Klick klappt ihn in die einzelnen
            Positionen auf. Ein Klick auf eine einzelne Position zeigt ihre Details mit Link zu Odoo, ein zweiter Klick darauf oder ein Klick daneben klappt alles wieder zu. Blöcke und Positionen lassen sich mit der Maus ziehen, auch in die Zeile einer anderen
            Maschine (Esc bricht ab). Dauer = Reststunden, gerechnet mit der Wochenleistung verteilt auf Montag bis
            Samstag (Sonntage und freie Tage sind schraffiert). Die Stunden gelten als Maschinenzeit. „Fertig produziert“ schiebt eine Position in die QS, dort schließt „Geprüft“ sie ab. Ein gestricheltes Feld „wartet“ steht vor einer Position, die erst ab ihrem „Start frühestens“ beginnt.
          </div>
        </div>
      </div>

      {/* Schichtmodell für künftige Wochen, mit Vorschau "Was wäre wenn" */}
      {(() => {
        const future = Object.keys(weekCap)
          .filter((d) => d > today)
          .sort();
        const modelName = (h) => SHIFT_MODELS.find((s) => s.hours === h)?.label ?? "Eigener Wert";
        const formDate = newShift.date ? mondayOf(newShift.date) : "";
        const formOk = /^\d{4}-\d{2}-\d{2}$/.test(newShift.date) && formDate > today;
        return (
          <div style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 18, marginBottom: 20 }}>
            <div style={eyebrow}>Schichtmodell der Planung</div>
            <div style={{ fontSize: 12, color: theme.steel, marginTop: 4 }}>
              Jetzt: {shift.label} {fmtH(shift.hours)} h pro Woche (das Modell vom letzten Montag). Hier kannst du ein anderes Modell
              ab einer künftigen Woche ausprobieren oder festlegen.
            </div>
            {future.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {future.map((d) => (
                  <div key={d} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <span style={{ ...mono, width: 150 }}>
                      ab KW {isoWeekOf(d).week} ({fmtShort(d)})
                    </span>
                    <span>
                      {modelName(weekCap[d])} · {fmtH(weekCap[d])} h
                    </span>
                    <button onClick={() => onDeleteShift(d)} title="Entfernen" style={{ ...smallBtn(false), padding: "2px 7px" }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginTop: 12 }}>
              <label>
                <div style={eyebrow}>Ab Woche mit Montag</div>
                <input
                  type="date"
                  value={newShift.date}
                  onChange={(ev) => setNewShift({ ...newShift, date: ev.target.value })}
                  style={{ ...field, colorScheme: mode, marginTop: 4 }}
                />
              </label>
              <label>
                <div style={eyebrow}>Schichtmodell</div>
                <select
                  value={newShift.hours}
                  onChange={(ev) => setNewShift({ ...newShift, hours: Number(ev.target.value) })}
                  style={{ ...field, marginTop: 4 }}
                >
                  {SHIFT_MODELS.map((s) => (
                    <option key={s.label} value={s.hours}>
                      {s.label} · {s.hours} h
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!formOk}
                onClick={() => setPreview({ date: formDate, hours: newShift.hours })}
                style={smallBtn(!formOk)}
              >
                Vorschau ansehen
              </button>
              {newShift.date && !formOk && (
                <span style={{ fontSize: 11, color: theme.red }}>Das Datum muss in der Zukunft liegen</span>
              )}
            </div>
          </div>
        );
      })()}

      {/* Freie Tage: Feiertage und Betriebsurlaub zählen in der Planung wie der Sonntag */}
      {(() => {
        const upcoming = freeDays.filter((d) => d.date >= today);
        const next = upcoming[0];
        const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
        const wd = (date) => WD[new Date(date + "T00:00:00Z").getUTCDay()];
        return (
          <div style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 18, marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={eyebrow}>Freie Tage</div>
                <div style={{ fontSize: 12, color: theme.steel, marginTop: 4 }}>
                  {next ? `Nächster: ${next.name}, ${wd(next.date)} ${fmtShort(next.date)}` : "Keine freien Tage in der Zukunft"}
                </div>
              </div>
              <button onClick={() => setShowFree((v) => !v)} style={smallBtn(false)}>
                {showFree ? "Schließen" : "Anzeigen und bearbeiten"}
              </button>
            </div>

            {showFree && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginBottom: 14 }}>
                  <label>
                    <div style={eyebrow}>Von</div>
                    <input
                      type="date"
                      value={newFree.from}
                      onChange={(ev) => setNewFree({ ...newFree, from: ev.target.value })}
                      style={{ ...field, colorScheme: mode, marginTop: 4 }}
                    />
                  </label>
                  <label>
                    <div style={eyebrow}>Bis (optional)</div>
                    <input
                      type="date"
                      value={newFree.to}
                      onChange={(ev) => setNewFree({ ...newFree, to: ev.target.value })}
                      style={{ ...field, colorScheme: mode, marginTop: 4 }}
                    />
                  </label>
                  <label>
                    <div style={eyebrow}>Bezeichnung</div>
                    <input
                      type="text"
                      maxLength={60}
                      placeholder="z. B. Betriebsurlaub"
                      value={newFree.name}
                      onChange={(ev) => setNewFree({ ...newFree, name: ev.target.value })}
                      onKeyDown={(ev) => ev.key === "Enter" && addFreeDays()}
                      style={{ ...field, width: 200, marginTop: 4 }}
                    />
                  </label>
                  <button onClick={addFreeDays} disabled={!canAddFree} style={smallBtn(!canAddFree)}>
                    Hinzufügen
                  </button>
                  {freeFromOk && freeToOk && freeSpan > 120 && (
                    <span style={{ fontSize: 11, color: theme.red }}>Höchstens 120 Tage auf einmal</span>
                  )}
                  {freeFromOk && freeToOk && freeSpan < 1 && (
                    <span style={{ fontSize: 11, color: theme.red }}>„Bis“ liegt vor „Von“</span>
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 6 }}>
                  {upcoming.map((d) => (
                    <div
                      key={d.date}
                      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${theme.line}` }}
                    >
                      <span style={{ ...mono, width: 86, color: theme.steel }}>
                        {wd(d.date)} {fmtShort(d.date)}{d.date.slice(2, 4)}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.name}>
                        {d.name}
                      </span>
                      <button
                        onClick={() => removeFreeDay(d.date)}
                        title={`${d.name} entfernen`}
                        style={{ ...smallBtn(false), padding: "2px 7px" }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {upcoming.length === 0 && <div style={{ fontSize: 12, color: theme.steel }}>Keine freien Tage in der Zukunft.</div>}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Auftragsübersicht */}
      {groups.length > 0 && (
        <div
          style={{
            background: theme.panel,
            border: `1px solid ${theme.line}`,
            borderRadius: 10,
            padding: 18,
            marginBottom: 16,
            overflowX: "auto",
          }}
        >
          <div style={{ ...eyebrow, marginBottom: 10 }}>Aufträge im Überblick ({groups.length})</div>
          <div style={{ minWidth: 820 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1.3fr 1.3fr 1.1fr 1.3fr 1.1fr 1fr",
                gap: 10,
                fontSize: 10,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: theme.steel,
                fontWeight: 600,
                paddingBottom: 6,
              }}
            >
              <span>Auftrag</span>
              <span>Liefertermin</span>
              <span>Start frühestens</span>
              <span>Fertig ca.</span>
              <span>Status</span>
              <span>Positionen</span>
              <span>Fortschritt</span>
            </div>
            {groups.map((g) => (
              <div
                key={g.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1.3fr 1.3fr 1.1fr 1.3fr 1.1fr 1fr",
                  gap: 10,
                  alignItems: "center",
                  padding: "9px 0 9px 10px",
                  borderTop: `1px solid ${theme.line}`,
                  borderLeft: `4px solid ${g.end == null ? theme.line : statusColor(g.status)}`,
                  fontSize: 13,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <b style={mono}>{g.label}</b>
                  {g.positions.some((o) => o.source) && g.positions.some((o) => !o.done && o.quantity > 1) && (
                    <div>
                      <button
                        onClick={() => setSplitGroup({ key: g.key, qty: "", due: "", error: null })}
                        title="Teillieferung für alle Positionen dieses Auftrags"
                        style={{ ...smallBtn(false), marginTop: 4, padding: "2px 8px" }}
                      >
                        Teillieferung
                      </button>
                    </div>
                  )}
                  {g.externTags.length > 0 && (
                    <div
                      title={g.externTags.join(", ")}
                      style={{ fontSize: 11, color: theme.steel, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                      extern: {g.externTags.join(", ")}
                      {g.externDays ? ` · ${fmtDuration(g.externDays)}` : ""}
                    </div>
                  )}
                </div>
                {(() => {
                  // Einzeltermine, die vom Auftragstermin abweichen, dürfen nicht ohne Rückfrage überschrieben werden
                  const open = g.positions.filter((o) => !o.done);
                  const dues = [...new Set(open.map((o) => o.due).filter(Boolean))].sort();
                  const deviating = dues.length > 1;
                  const pending = pendingDue && pendingDue.key === g.key ? pendingDue : null;
                  const apply = (value) => {
                    setGroupDue(g, value);
                    setPendingDue(null);
                  };
                  return (
                    <div style={{ minWidth: 0 }}>
                      <input
                        type="date"
                        title="Liefertermin des Auftrags (gilt für alle seine Positionen)"
                        value={pending ? pending.value : g.due || ""}
                        onChange={(ev) => (deviating ? setPendingDue({ key: g.key, value: ev.target.value }) : apply(ev.target.value))}
                        style={{
                          ...field,
                          width: "100%",
                          minWidth: 0,
                          color: g.due && g.due < today ? theme.red : theme.ink,
                          colorScheme: mode,
                        }}
                      />
                      {deviating && !pending && (
                        <div
                          title={`Abweichende Liefertermine in diesem Auftrag: ${dues.map((d) => fmtShort(d)).join(", ")}`}
                          style={{ fontSize: 11, color: theme.amber, marginTop: 3 }}
                        >
                          {dues.length} verschiedene Termine
                        </div>
                      )}
                      {pending && (
                        <div style={{ fontSize: 11, marginTop: 4 }}>
                          <div style={{ color: theme.amber }}>
                            {open.filter((o) => o.due && o.due !== pending.value).length} Positionen mit eigenem Termin überschreiben?
                          </div>
                          <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                            <button onClick={() => apply(pending.value)} style={{ ...smallBtn(false), padding: "2px 8px" }}>
                              Ja
                            </button>
                            <button onClick={() => setPendingDue(null)} style={{ ...smallBtn(false), padding: "2px 8px" }}>
                              Nein
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                <input
                  type="date"
                  title="Start frühestens für den ganzen Auftrag (z. B. wenn Rohmaterial und Werkzeuge da sind). Leer = sobald die Maschine frei ist. Gilt für alle offenen Positionen."
                  value={earliestOf(g)}
                  onChange={(ev) => setGroupEarliest(g, ev.target.value)}
                  style={{ ...field, width: "100%", minWidth: 0, colorScheme: mode }}
                />
                <span>{g.end != null ? `${fmtShort(endDateOf(g.end))} (${g.endMachine})` : "–"}</span>
                <span
                  style={{
                    color: g.status === "late" ? theme.red : theme.steel,
                    fontWeight: g.status === "late" ? 600 : 400,
                  }}
                >
                  {g.end == null
                    ? "noch nicht eingeplant"
                    : g.status === "late"
                    ? `+${days(g.lateDays)}`
                    : g.diff != null
                    ? `Puffer ${fmtH(-g.diff)} Tage`
                    : "im Plan"}
                  {g.end != null && g.unscheduled > 0 ? ` · ${g.unscheduled} Pos. offen` : ""}
                </span>
                <span style={{ color: theme.steel }}>
                  {g.finished}/{g.total} erledigt
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ ...mono, fontSize: 12, minWidth: 34 }}>{g.percent != null ? `${g.percent} %` : "–"}</span>
                  <span style={{ flex: 1, height: 6, borderRadius: 3, background: theme.line, overflow: "hidden" }}>
                    <span
                      style={{ display: "block", width: `${g.percent || 0}%`, height: "100%", background: theme.graphite }}
                    />
                  </span>
                </span>
              </div>
            ))}
            {splitGroup &&
              (() => {
                const g = groups.find((x) => x.key === splitGroup.key);
                if (!g) return null;
                const source = g.positions.find((o) => o.source)?.source;
                const n = Number(String(splitGroup.qty).replace(",", "."));
                const valid = Number.isFinite(n) && n > 0;
                const open = g.positions.filter((o) => !o.done && o.quantity > 0);
                const toSplit = valid ? open.filter((o) => o.quantity > n).length : 0;
                const whole = valid ? open.length - toSplit : 0;
                const ok = source && valid && toSplit > 0 && splitGroup.due;
                return (
                  <div style={{ marginTop: 12, padding: 12, border: `1px dashed ${theme.line}`, borderRadius: 8, fontSize: 12 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <span>
                        Teillieferung für Auftrag <b>{g.label}</b>: erste Lieferung je Position
                      </span>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        autoFocus
                        value={splitGroup.qty}
                        onChange={(ev) => setSplitGroup({ ...splitGroup, qty: ev.target.value, error: null })}
                        style={{ ...field, width: 70 }}
                      />
                      <span>Stück, Liefertermin</span>
                      <input
                        type="date"
                        value={splitGroup.due}
                        onChange={(ev) => setSplitGroup({ ...splitGroup, due: ev.target.value, error: null })}
                        style={{ ...field, colorScheme: mode }}
                      />
                      <button disabled={!ok} onClick={() => doSplitMany(source)} style={smallBtn(!ok)}>
                        Anlegen
                      </button>
                      <button onClick={() => setSplitGroup(null)} style={smallBtn(false)}>
                        Abbrechen
                      </button>
                    </div>
                    {valid && (
                      <div style={{ color: theme.steel, marginTop: 6 }}>
                        {toSplit} Positionen werden geteilt, {whole} liefern vollständig mit der ersten Lieferung (höchstens {fmtH(n)} Stück).
                      </div>
                    )}
                    {splitGroup.error && <div style={{ color: theme.red, marginTop: 6 }}>{splitGroup.error}</div>}
                  </div>
                );
              })()}
          </div>
        </div>
      )}

      {/* Positionen je Maschine bearbeiten */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16 }}>
        {plan.map((p) => {
          const base = defaults.now;
          const own = rates[p.m.id] > 0;
          return (
            <div
              key={p.m.id}
              style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 18 }}
            >
              <div style={{ fontWeight: 700, fontSize: 15, color: theme[p.m.colorKey] }}>{p.m.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "8px 0 12px" }}>
                <span style={eyebrow}>Wochenleistung</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  placeholder={fmtH(base)}
                  value={rates[p.m.id] ?? ""}
                  onChange={(ev) => setRate(p.m.id, ev.target.value)}
                  style={{ ...field, width: 80 }}
                />
                <span style={{ fontSize: 11, color: theme.steel }}>
                  {own
                    ? `eigener Wert (leer = ${shift.label} ${fmtH(shift.hours)} h × ${utilization} %)`
                    : `${shift.label} ${fmtH(shift.hours)} h × ${utilization} %`}
                </span>
              </div>

              {p.items.map(({ o, scheduled, end, status, lateDays, diff, remaining, percent, estimated, effDone, stale }, idx) => (
                <div key={o.id} style={{ borderTop: `1px solid ${theme.line}`, padding: "10px 0" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      disabled={idx === 0}
                      onClick={() => move(p.m.id, o.id, -1)}
                      aria-label="Nach oben"
                      style={smallBtn(idx === 0)}
                    >
                      ↑
                    </button>
                    <button
                      disabled={idx === p.items.length - 1}
                      onClick={() => move(p.m.id, o.id, 1)}
                      aria-label="Nach unten"
                      style={smallBtn(idx === p.items.length - 1)}
                    >
                      ↓
                    </button>
                    <input
                      type="text"
                      placeholder="Auftrag"
                      maxLength={40}
                      value={o.order_no}
                      onChange={(ev) => patchOrder(o.id, { order_no: ev.target.value })}
                      style={{ ...field, width: 90 }}
                    />
                    <OdooLink o={o} />
                    <MaterialBadge o={o} theme={theme} />
                    {o.part_label && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: theme.steel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: "1px 7px", whiteSpace: "nowrap" }}>
                        {o.part_label}
                      </span>
                    )}
                    <input
                      type="number"
                      min={0}
                      step="any"
                      placeholder="Gesamt"
                      title="Gesamtstunden der Position"
                      value={o.hours || ""}
                      onChange={(ev) =>
                        patchOrder(o.id, (() => {
                          const h = ev.target.value === "" ? 0 : Math.max(0, Number(ev.target.value));
                          return { hours: h, hours_plan: h };
                        })())
                      }
                      style={{ ...field, width: 72 }}
                    />
                    <span style={{ ...eyebrow, fontSize: 11 }}>h</span>
                    <RestInput
                      value={o.hours > 0 ? round1(remaining) : ""}
                      title="Wie viele Stunden braucht die Position noch? (Stand heute). Mehr als geplant verlängert den Balken."
                      onCommit={(n) => setRest(o, effDone, n)}
                      style={{ ...field, width: 98 }}
                    />
                    <span style={{ ...eyebrow, fontSize: 11 }}>h</span>
                    <input
                      type="date"
                      title="Liefertermin"
                      value={o.due || ""}
                      onChange={(ev) => patchOrder(o.id, { due: ev.target.value || null })}
                      style={{ ...field, colorScheme: mode }}
                    />
                    <span style={{ ...eyebrow, fontSize: 10 }}>Start frühestens</span>
                    <input
                      type="date"
                      title="Start frühestens, z. B. wenn Rohmaterial und Werkzeuge da sind. Ein Datum in der Vergangenheit gilt als tatsächlicher Start: Der Balken beginnt dann dort. Leer = sobald die Maschine frei ist."
                      value={o.earliest_start || ""}
                      onChange={(ev) => patchOrder(o.id, { earliest_start: ev.target.value || null })}
                      style={{ ...field, colorScheme: mode }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                    <button
                      onClick={() => finishProduced(o)}
                      title="Fertig produziert: die Position geht in die QS (ohne QS-Prüfung ist sie damit erledigt)"
                      style={smallBtn(false)}
                    >
                      Fertig produziert
                    </button>
                    <label
                      title="Muss die Position durch die QS-Prüfung?"
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: theme.steel }}
                    >
                      <input
                        type="checkbox"
                        checked={o.qs_required !== false}
                        onChange={(ev) => patchOrder(o.id, { qs_required: ev.target.checked })}
                        style={{ accentColor: theme.ink }}
                      />
                      QS-Prüfung
                    </label>
                    {o.quantity > 1 && (
                      <button
                        onClick={() => setSplitFor({ id: o.id, qty: "", due: "", error: null })}
                        title="Teillieferung: einen Teil der Stückzahl vorab liefern"
                        style={smallBtn(false)}
                      >
                        Teillieferung
                      </button>
                    )}
                    {deleteButton(o)}
                    <span
                      style={{
                        fontSize: 12,
                        marginLeft: 4,
                        color: status === "late" ? theme.red : theme.steel,
                        fontWeight: status === "late" ? 600 : 400,
                      }}
                    >
                      {(percent != null ? `${estimated ? "~" : ""}${percent} % ${estimated ? "geschätzt" : "erledigt"} · Rest ${fmtH(remaining)} h · ` : "") +
                        (stale ? "Fortschritt prüfen · " : "") +
                        (o.hours_plan != null && o.hours > o.hours_plan + 0.05
                          ? `Mehraufwand +${fmtH(o.hours - o.hours_plan)} h (Plan ${fmtH(o.hours_plan)} h) · `
                          : "") +
                        (scheduled
                          ? `Ende ca. ${fmtShort(endDateOf(end))}` +
                            (status === "late"
                              ? ` · ${days(lateDays)} nach Liefertermin`
                              : diff != null
                              ? ` · Puffer ${fmtH(-diff)} Tage`
                              : "")
                          : !(o.hours > 0)
                          ? "Stunden eintragen"
                          : remaining === 0
                          ? "Stunden erreicht, bitte als erledigt markieren"
                          : "Wochenleistung fehlt")}
                    </span>
                  </div>
                  {splitFor && splitFor.id === o.id && splitForm(o)}
                  {externEditor(o)}
                  {metaLine(o) && (
                    <div style={{ fontSize: 11, color: theme.steel, marginTop: 6 }}>{metaLine(o)}</div>
                  )}
                </div>
              ))}

              <button onClick={() => addOrder(p.m.id)} style={{ ...smallBtn(false), marginTop: 6 }}>
                + Auftrag hinzufügen
              </button>
            </div>
          );
        })}

        {/* Orte: Positionen in QS, FERTIGUNG EXTERN und OBERFLÄCHE EXTERN */}
        {LANES.map((lane) => {
          const inLane = orders.filter((o) => o.machine === lane.id && !o.done).sort(byPosition);
          return (
            <div
              key={lane.id}
              style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 18 }}
            >
              <div style={{ fontWeight: 700, fontSize: 15, color: lane.colorKey ? theme[lane.colorKey] : undefined }}>{lane.name}</div>
              <div style={{ height: 8 }} />
              {inLane.map((o) => {
                const start = o.extern_start ? daysBetween(monday0, o.extern_start) : null;
                const end = start != null ? start + daysIn(o) : null;
                return (
                  <div key={o.id} style={{ borderTop: `1px solid ${theme.line}`, padding: "10px 0" }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {o.odoo_ref ? (
                        <b style={{ ...mono, fontSize: 13 }}>{posNo(o)}</b>
                      ) : (
                        <input
                          type="text"
                          placeholder="Nummer / Bezeichnung"
                          maxLength={40}
                          value={o.order_no}
                          onChange={(ev) => patchOrder(o.id, { order_no: ev.target.value })}
                          style={{ ...field, width: 150 }}
                        />
                      )}
                      <OdooLink o={o} />
                      <span style={{ ...eyebrow, fontSize: 10 }}>Beginn</span>
                      <input
                        type="date"
                        title={`Beginn in ${lane.name}`}
                        value={o.extern_start || ""}
                        onChange={(ev) => patchOrder(o.id, { extern_start: ev.target.value || null })}
                        style={{ ...field, colorScheme: mode }}
                      />
                      {lane.id !== "qs" && end != null && (
                        <>
                          <span style={{ ...eyebrow, fontSize: 10 }}>Rückkehr</span>
                          <input
                            type="date"
                            title="Wann kommt das Teil zurück? Ersetzt die Dauer."
                            value={endDateOf(end)}
                            onChange={(ev) => {
                              const d = ev.target.value;
                              if (!d || !o.extern_start) return;
                              patchOrder(o.id, { extern_days: Math.min(120, Math.max(1, daysBetween(o.extern_start, d) + 1)) });
                            }}
                            style={{ ...field, colorScheme: mode }}
                          />
                        </>
                      )}
                    </div>
                    {!o.odoo_ref && (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                        <input
                          type="text"
                          placeholder="Auftrag (z. B. A01234)"
                          title="Zu welchem Auftrag gehört das? Dann zählt es im Auftragsende mit."
                          maxLength={40}
                          value={o.source || ""}
                          onChange={(ev) => patchOrder(o.id, { source: ev.target.value || null })}
                          style={{ ...field, width: 140 }}
                        />
                        <input
                          type="text"
                          placeholder="Teil / Lieferant"
                          maxLength={200}
                          value={o.product || ""}
                          onChange={(ev) => patchOrder(o.id, { product: ev.target.value || null })}
                          style={{ ...field, width: 200 }}
                        />
                        <input
                          type="number"
                          min={0}
                          step="any"
                          placeholder="Stück"
                          value={o.quantity ?? ""}
                          onChange={(ev) =>
                            patchOrder(o.id, { quantity: ev.target.value === "" ? null : Math.max(0, Number(ev.target.value)) })
                          }
                          style={{ ...field, width: 70 }}
                        />
                        <span style={{ ...eyebrow, fontSize: 10 }}>Liefertermin</span>
                        <input
                          type="date"
                          title="Liefertermin des Auftrags an den Kunden"
                          value={o.due || ""}
                          onChange={(ev) => patchOrder(o.id, { due: ev.target.value || null })}
                          style={{ ...field, colorScheme: mode }}
                        />
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                      {laneButtons(o)}
                      {deleteButton(o)}
                      <span style={{ fontSize: 12, marginLeft: 4, color: theme.steel }}>
                        {end != null
                          ? `${lane.id === "qs" ? "fertig" : "zurück"} ca. ${fmtShort(endDateOf(end))}`
                          : "Beginn eintragen"}
                      </span>
                    </div>
                    {externEditor(o)}
                    {metaLine(o) && (
                      <div style={{ fontSize: 11, color: theme.steel, marginTop: 6 }}>{metaLine(o)}</div>
                    )}
                  </div>
                );
              })}
              {inLane.length === 0 && (
                <div style={{ borderTop: `1px solid ${theme.line}`, paddingTop: 10, fontSize: 12, color: theme.steel }}>
                  Noch nichts in {lane.name}.
                </div>
              )}
              {lane.id !== "qs" && (
                <button onClick={() => addLaneOrder(lane)} style={{ ...smallBtn(false), marginTop: 6 }}>
                  + AUFTRAG HINZUFÜGEN
                </button>
              )}
            </div>
          );
        })}
      </div>

      {doneOrders.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button onClick={() => setShowDone((v) => !v)} style={smallBtn(false)}>
            {showDone ? "Erledigte ausblenden" : `Erledigte anzeigen (${doneOrders.length})`}
          </button>
          {showDone && (
            <div
              style={{
                background: theme.panel,
                border: `1px solid ${theme.line}`,
                borderRadius: 10,
                padding: "6px 18px",
                marginTop: 10,
              }}
            >
              {doneOrders.map((o) => (
                <div
                  key={o.id}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    flexWrap: "wrap",
                    padding: "8px 0",
                    borderTop: `1px solid ${theme.line}`,
                    fontSize: 13,
                  }}
                >
                  <span style={{ ...mono, fontWeight: 600 }}>{posNo(o)}</span>
                  <span style={{ color: theme.steel }}>
                    {laneOf(o.machine)?.name ?? MACHINES.find((m) => m.id === o.machine)?.short ?? "nicht eingeplant"} ·{" "}
                    {fmtH(o.hours)} h
                    {o.source ? ` · ${o.source}` : ""}
                    {o.checked_date ? ` · geprüft am ${fmtShort(o.checked_date)}` : ""}
                    {o.done_date ? ` · erledigt am ${fmtShort(o.done_date)}` : ""}
                  </span>
                  <button onClick={() => patchOrder(o.id, { done: false, done_date: null })} style={smallBtn(false)}>
                    Wieder öffnen
                  </button>
                  {deleteButton(o)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {draggedBar && (
        <div
          style={{
            position: "fixed",
            left: draggedBar.x - draggedBar.offX,
            top: draggedBar.y - draggedBar.offY,
            width: draggedBar.w,
            height: draggedBar.h,
            boxSizing: "border-box",
            borderRadius: 6,
            padding: "4px 8px",
            background: theme.graphite,
            color: theme.bg,
            boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
            pointerEvents: "none",
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            lineHeight: 1.25,
            overflow: "hidden",
          }}
        >
          <b style={{ fontSize: 12 }}>{draggedBar.label}</b>
          <span style={{ fontSize: 11, opacity: 0.85 }}>{draggedBar.sub}</span>
        </div>
      )}
    </div>
  );
}
