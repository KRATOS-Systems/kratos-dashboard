import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { isNewPlan, DEFAULT_WEEK_CAPACITY, MACHINES, SHIFT_MODELS, addDays, daysBetween, fmtH, fmtShort, isoWeekOf, mondayOf } from "./lib.js";
import { parseOdooExport } from "./odooImport.js";
import { holidaysBavaria } from "./holidays.js";
import AvView, { avUrgentCount } from "./Av.jsx";
import { AV_ITEMS, AV_STATUS, AV_TEAM, isNewAv, avKey, avState, avSummary } from "./avLib.js";
import { STAFF, ACTIVITIES, STAFF_DEFAULTS, responsible, avResponsible, sharedMachine } from "./staffLib.js";
import Avatar from "./Avatar.jsx";
import { AppTile, Ico, LaneTile, MTile, Thumb, useToast, partImg } from "./ui.jsx";
import {
  DEFAULT_TIGHT_DAYS,
  DRAG_THRESHOLD,
  MIN_BAR_PX,
  DAY_NAMES,
  MONTHS,
  EXTERN_SUGGESTIONS,
  byPosition,
  days,
  doneHoursOf,
  remainingOf,
  metaLine,
  ODOO_URL,
  ODOO_PO_URL,
  round1,
  posNo,
  groupKeyOf,
  groupLabelOf,
  send,
  applyMove,
  isFreeDay,
  buildPlanDeps,
  buildBlocks,
  tagsOf,
  EXTERN,
  LANES,
  LANE_IDS,
  laneOf,
  EXTERN_DURATIONS,
  fmtDuration,
  laneDaysOnMove,
  daysIn,
  applyLaneMove,
  buildGroups,
} from "./planLogic.js";

const REPEAT_ITEMS = ["programm", "werkzeuge", "spannmittel", "pruefplan", "empb"];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const isOp = (o) => /^AG /.test(o.part_label || "");
const stat = (g) => (g ? g.status : "ok");
// Ampel am Balken: grün im Plan, gelb Puffer knapp, rot Liefertermin verfehlt, ohne Liefertermin keine
const ampel = (g) => (!g || g.dueEnd == null || g.end == null ? "none" : g.status);

// Öffnet den Fertigungsauftrag in Odoo (nur wenn der Export die ID enthielt)
function OdooLink({ o, btn }) {
  if (!o.odoo_id && !o.po_id) return null;
  const po = !o.odoo_id;
  return (
    <a
      href={po ? `${ODOO_PO_URL}/${o.po_id}` : `${ODOO_URL}/${o.odoo_id}`}
      target="_blank"
      rel="noopener noreferrer"
      title={po ? `Bestellung ${o.order_no} beim Lieferanten in Odoo öffnen` : `${o.order_no} in Odoo öffnen`}
      className={btn ? "btn odoo" : "olink"}
      onClick={(ev) => ev.stopPropagation()}
    >
      {btn ? (po ? "Bestellung in Odoo öffnen" : "In Odoo öffnen") : "Odoo"} <Ico n="ext" s={btn ? 15 : 12} />
    </a>
  );
}
// Material laut Odoo (Spalte "Komponentenstatus" im Export): nicht verfügbar = rot, erwartet = gelb, verfügbar = grün
function MaterialBadge({ o }) {
  const text = o.component_status;
  if (!text) return null;
  const low = text.toLowerCase();
  const cls = /nicht verf/.test(low) ? "bad" : /verf|reserv/.test(low) ? "ok" : "warn";
  return (
    <span className={`pill ${cls}`} title={`Materialstatus laut Odoo: ${text}`}>
      {/nicht verf/.test(low) ? "Material fehlt" : text}
    </span>
  );
}
// Eingabe "Noch nötig": wird erst beim Verlassen des Feldes oder mit Enter übernommen
function RestInput({ value, onCommit, title }) {
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
    />
  );
}

export default function Planning({ section = "planung", today, shift, weekCap, onSaveShift, onDeleteShift, onAvCount, onNewCount, onShared, openReq, onOpenHandled, goTo, openTalos }) {
  const toast = useToast();
  const [orders, setOrders] = useState([]);
  const [checks, setChecks] = useState(() => new Map()); // Arbeitsvorbereitung: Position|Punkt -> { status, due, note }
  // Zuständigkeiten: Stammbediener je Maschine, Rollen, Abweichungen je Position und Tätigkeit ("id|tätigkeit" -> Name)
  const [staff, setStaff] = useState(() => ({ defaults: { ...STAFF_DEFAULTS }, overrides: new Map(), info: [] }));
  const [newInfo, setNewInfo] = useState({ source: "Nino", scope: "av", target: "Frank" });
  const [rates, setRates] = useState({});
  const [tightDays, setTightDays] = useState(DEFAULT_TIGHT_DAYS);
  const [avLead, setAvLead] = useState(2); // Vorlauf der Arbeitsvorbereitung in Tagen
  const [preview, setPreview] = useState(null); // ungespeichertes Schichtmodell "Was wäre wenn": { date, hours }
  const [newShift, setNewShift] = useState({ date: "", hours: 100 });
  const [pendingDue, setPendingDue] = useState(null); // { key, value }: neuer Auftragstermin wartet auf Rückfrage
  const [utilization, setUtilization] = useState(80); // % der Betriebszeit, mit denen die Planung rechnet
  const [showDone, setShowDone] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [freeDays, setFreeDays] = useState([]); // [{ date, name }], arbeitsfreie Tage wie der Sonntag
  const [newFree, setNewFree] = useState({ from: "", to: "", name: "" });
  const [expanded, setExpanded] = useState({});
  const [expandedOrders, setExpandedOrders] = useState({});
  const [tab, setTab] = useState("zeit"); // zeit | auf | einst
  const [hl, setHl] = useState(null); // late | pool | soon: Hervorhebung über die Kennzahlen
  const [hoverGroup, setHoverGroup] = useState(null);
  const [odooStatus, setOdooStatus] = useState(null); // { enabled, baselineDone, lastSync, lastChange, pendingClosing }
  const [syncDlg, setSyncDlg] = useState(null); // { loading, error, result, closeSel }
  const lastChangeSeen = useRef(null);
  const [avFocus, setAvFocus] = useState(null); // Position, die in der Arbeitsvorbereitung aufgeklappt werden soll
  const pendingOpen = useRef(null); // Position, die nach dem Seitenwechsel in der Planung geöffnet werden soll
  const [hlSel, setHlSel] = useState(null); // aus der Kennzahlen-Liste gewählt: { ids, anchor }
  const [hoverStrip, setHoverStrip] = useState(null); // Positionen der Terminlinie, über der die Maus steht
  const [fresh, setFresh] = useState(null);
  const [leaving, setLeaving] = useState({});
  const [avFilter, setAvFilter] = useState("offen");
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
  const [opsFor, setOpsFor] = useState(null); // Arbeitsgänge einer Position: { id, rows: [{ label, machine, hours }], error }
  const [splitFor, setSplitFor] = useState(null); // Teillieferung einer Position: { id, qty, due, error }
  const [splitGroup, setSplitGroup] = useState(null); // Teillieferung eines Auftrags: { key, qty, due, error }
  const [laneDetail, setLaneDetail] = useState(null); // Positionen des angeklickten Balkens in QS / Extern (ids)
  const [reworkId, setReworkId] = useState(null); // QS: Position, für die gerade die Nacharbeit abgefragt wird
  const [reworkText, setReworkText] = useState("");
  const [detailId, setDetailId] = useState(null); // Position, deren Details in der Schublade stehen
  const [selected, setSelected] = useState({});
  const [importPreview, setImportPreview] = useState(null); // { items, result, fileName }
  const [drag, setDrag] = useState(null); // { ids, label, sub, active, x, y, offX, offY, w, h, target }
  const [links, setLinks] = useState([]);
  const [callouts, setCallouts] = useState([]);
  const [trackW, setTrackW] = useState(720); // gemessene Breite der Zeitleiste, um die Liefertermin-Texte zu stapeln
  const fileInput = useRef(null);
  const dragInfo = useRef(null);
  const trackRefs = useRef({});
  const laneTracks = useRef({});
  const lastDragEnd = useRef(0);
  const latest = useRef({});
  const boardCols = useRef({}); // Spalten des Maschinen-Boards unten (Ziel beim Ziehen, wie die Zeilen im Zeitstrahl)
  const [boardQuery, setBoardQuery] = useState("");
  const [boardFilter, setBoardFilter] = useState("alle"); // alle | spaet | neu
  const tlRef = useRef(null);
  const tipRef = useRef(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/orders").then((r) => r.json()),
      fetch("/api/plan-rates").then((r) => r.json()),
      fetch("/api/plan-settings").then((r) => r.json()),
      fetch("/api/av").then((r) => r.json()),
      fetch("/api/staff")
        .then((r) => r.json())
        .catch(() => null),
    ]).then(([o, r, s, a, st]) => {
      if (st && st.defaults) setStaff({ defaults: st.defaults, overrides: new Map(st.orders.map((x) => [`${x.order_id}|${x.activity}`, x.name])), info: st.info || [] });
      setOrders(o.orders);
      setChecks(new Map(a.checks.map((c) => [avKey(c.order_id, c.item), { status: c.status, due: c.due, note: c.note, assignee: c.assignee || null }])));
      setRates(r.rates);
      setTightDays(s.tight_days);
      if (typeof s.av_lead_days === "number") setAvLead(s.av_lead_days);
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

  // Odoo-Abgleich: Status regelmäßig holen; hat der Server neue Aufträge übernommen, die Liste neu laden
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/odoo/status")
        .then((r) => r.json())
        .then((s) => {
          if (stop) return;
          setOdooStatus(s);
          if (lastChangeSeen.current !== null && s.lastChange && s.lastChange !== lastChangeSeen.current) {
            fetch("/api/orders").then((r) => r.json()).then((d) => setOrders(d.orders));
          }
          lastChangeSeen.current = s.lastChange || "";
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 2 * 60 * 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
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
  const capWithPreview = useMemo(() => (preview ? { ...weekCap, [preview.date]: preview.hours } : weekCap), [weekCap, preview]);
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
  // Späteste Termine der offenen AV-Punkte je Position: Die Planung wartet bis dahin (zusätzlich zu "Start frühestens")
  const avDates = useMemo(() => {
    const m = new Map();
    orders.forEach((o) => {
      if (o.done) return;
      const s = avSummary(checks, o.id);
      if (!s.ready && s.readyDate) m.set(o.id, s.readyDate);
    });
    return m;
  }, [orders, checks]);
  const withAv = (list) => (avDates.size ? list.map((o) => (avDates.has(o.id) ? { ...o, av_ready: avDates.get(o.id) } : o)) : list);
  const plan = useMemo(
    () => buildPlanDeps(withAv(viewOrders), rates, defaults, monday0, todayOff, free),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewOrders, rates, defaults, monday0, todayOff, free, avDates]
  );
  // Ohne den gezogenen Block: stabile Grundlage, um die Einfügeposition zu bestimmen
  const basePlan = useMemo(
    () => (drag ? buildPlanDeps(withAv(orders.filter((o) => !drag.ids.includes(o.id))), rates, defaults, monday0, todayOff, free) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dragKey, orders, rates, defaults, monday0, todayOff, free, avDates]
  );
  const groups = useMemo(() => buildGroups(viewOrders, plan, monday0, tightDays), [viewOrders, plan, monday0, tightDays]);
  // Die erste Position einer Maschine gilt als laufend: ihr Start wird automatisch eingetragen (änderbar)
  useEffect(() => {
    if (dragActive) return;
    plan.forEach((p) => {
      const first = p.items.find((i) => i.scheduled);
      if (first && !first.o.earliest_start && first.dep == null && !first.avWait) patchOrder(first.o.id, { earliest_start: dateOf(first.start) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, dragActive]);

  const planStart = useMemo(() => {
    const m = new Map();
    plan.forEach((p) => p.items.forEach((i) => i.scheduled && m.set(i.o.id, { machine: p.m.short, start: addDays(monday0, Math.floor(i.pastStart ?? i.start)) })));
    return m;
  }, [plan, monday0]);
  useEffect(() => {
    if (onAvCount) onAvCount(avUrgentCount(orders, checks, planStart, today));
    if (onNewCount) {
      onNewCount({ plan: orders.filter(isNewPlan).length, av: orders.filter((o) => isNewAv(o, checks)).length });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, checks, planStart]);

  const groupByKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);
  const warnings = groups.filter((g) => g.status === "late");
  const previewStats = useMemo(() => {
    if (!preview) return null;
    const count = (grps) => ({
      late: grps.filter((g) => g.status === "late").length,
      days: grps.reduce((sum, g) => sum + g.lateDays, 0),
    });
    const savedPlan = buildPlanDeps(withAv(orders), rates, baseDefaults, monday0, todayOff, free);
    return { before: count(buildGroups(orders, savedPlan, monday0, tightDays)), after: count(groups) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  latest.current = { orders, basePlan, total, viewStart, monday0, detailId, today };

  // Klick neben die Balken: aufgeklappte Blöcke wieder zusammenfassen
  const clearSelection = (e) => {
    if (e.target.closest("[data-bar]") || Date.now() - lastDragEnd.current < 400) return;
    setExpanded({});
  };

  // ---------- Ziehen mit der Maus: Fenster-Ereignisse nur, solange etwas gegriffen ist ----------
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return undefined;

    const findTarget = (x, y, ids) => {
      const { basePlan: base, total: t, viewStart: v0, monday0: m0 } = latest.current;
      if (!base) return null;
      // Maschinen-Board unten: dieselbe Logik wie im Zeitstrahl, nur dass die Einfügeposition aus der Reihenfolge der Karten kommt.
      // In QS und Extern beginnt die Position heute (wie beim Verschieben per Knopf); liegt sie schon dort, bleibt alles wie es ist.
      const dragged = ids || [];
      for (const [id, el] of Object.entries(boardCols.current)) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        if (LANE_IDS.includes(id)) {
          const cur = latest.current.orders;
          if (dragged.length > 0 && dragged.every((oid) => cur.find((o) => o.id === oid)?.machine === id)) return null;
          return { machine: id, date: latest.current.today };
        }
        const cards = [...el.querySelectorAll("[data-card]")].filter((c) => !dragged.includes(Number(c.dataset.card)));
        let index = cards.length;
        for (let k = 0; k < cards.length; k++) {
          const cr = cards[k].getBoundingClientRect();
          if (y < cr.top + cr.height / 2) {
            index = k;
            break;
          }
        }
        return { machine: id, index };
      }
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
      const target = findTarget(e.clientX, e.clientY, i.ids);
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
          setLaneDetail(i.laneSelect);
          setDetailId(null);
        }
        if (i.select != null) {
          setLaneDetail(null);
          setDetailId(i.select);
        }
        return;
      }
      lastDragEnd.current = Date.now();
      const target = findTarget(e.clientX, e.clientY, i.ids);
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
    dragInfo.current = { ids: bar.ids, startX: e.clientX, startY: e.clientY, active: false, toggle: bar.toggle, select: bar.select ?? null, laneSelect: bar.laneSelect ?? null };
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

  // ---------- Daten ändern ----------
  function patchOrder(id, patch) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
    send(`/api/orders/${id}`, "PUT", patch);
  }

  // Auftrag an einem Ort anlegen (z. B. FERTIGUNG EXTERN), Beginn heute
  async function addLaneOrder(lane) {
    const row = await send("/api/orders", "POST", { machine: lane.id });
    if (row && row.id) {
      const patch = { extern_start: today };
      setOrders((prev) => [...prev, { ...row, ...patch }]);
      send(`/api/orders/${row.id}`, "PUT", patch);
      setLaneDetail([row.id]);
      setDetailId(null);
    }
  }

  async function addOrder(machine) {
    const row = await send("/api/orders", "POST", { machine });
    if (row && row.id) {
      setOrders((prev) => [...prev, row]);
      setDetailId(row.id);
      setLaneDetail(null);
    }
  }

  // "Noch nötig" eintragen. Ist der Rest größer als geplant, wachsen die Gesamtstunden (das bisher Gelaufene bleibt),
  // sonst gilt entsprechend mehr als gelaufen. Gleicher Wert = Schätzung bestätigen.
  function setRest(o, effDone, rest) {
    if (rest === 0) {
      finishProduced(o);
      return;
    }
    const cur = Math.max(0, o.hours - effDone);
    const patch = rest >= cur ? { hours: round1(effDone + rest), done_hours: round1(effDone), hours_plan: o.hours_plan ?? o.hours } : { done_hours: round1(o.hours - rest) };
    patchOrder(o.id, { ...patch, progress_date: today });
  }

  // Arbeitsvorbereitung: Punkt einer Position ändern (sofort sichtbar, dann speichern)
  function setAv(id, item, patch) {
    setChecks((prev) => {
      const next = new Map(prev);
      const cur = prev.get(avKey(id, item)) || { status: item === "pruefplan" || item === "empb" ? "entfaellt" : "offen", due: null, note: "", assignee: null };
      next.set(avKey(id, item), { ...cur, ...patch });
      return next;
    });
    send("/api/av", "PUT", { order_id: id, item, ...patch });
  }
  function applyRepeat(o, src) {
    REPEAT_ITEMS.forEach((item) => {
      const s = avState(checks, src.id, item);
      if (s.status === "offen") return;
      setAv(o.id, item, { status: s.status, due: null, note: s.note || "übernommen von " + posNo(src), assignee: s.assignee || null });
    });
    toast("AV-Stand von " + posNo(src) + " übernommen: Programm, Werkzeuge, Spannmittel, Prüfplan, EMPB");
  }
  function bulkAv(ids, item, patch) {
    setChecks((prev) => {
      const next = new Map(prev);
      ids.forEach((id) => {
        const cur = prev.get(avKey(id, item)) || { status: item === "pruefplan" || item === "empb" ? "entfaellt" : "offen", due: null, note: "", assignee: null };
        next.set(avKey(id, item), { ...cur, ...patch });
      });
      return next;
    });
    send("/api/av/bulk", "POST", { order_ids: ids, item, ...patch });
  }

  // Löschen mit Rückfrage direkt in der App (Browser-Dialoge erscheinen nicht überall)
  function askDelete(id) {
    setConfirmDeleteId(id);
    setTimeout(() => setConfirmDeleteId((cur) => (cur === id ? null : cur)), 5000);
  }
  function removeOrder(o) {
    setConfirmDeleteId(null);
    setOrders((prev) => prev.filter((x) => x.id !== o.id));
    setDetailId((cur) => (cur === o.id ? null : cur));
    setLaneDetail((cur) => (cur ? cur.filter((x) => x !== o.id) : cur));
    send(`/api/orders/${o.id}`, "DELETE");
  }

  // Einzelnen Tag oder Zeitraum (Betriebsurlaub) als arbeitsfrei eintragen
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const freeFromOk = dateRe.test(newFree.from);
  const freeToOk = newFree.to === "" || dateRe.test(newFree.to);
  const freeSpan = freeFromOk && freeToOk ? daysBetween(newFree.from, newFree.to || newFree.from) + 1 : 0;
  const canAddFree = freeFromOk && freeToOk && freeSpan >= 1 && freeSpan <= 120 && newFree.name.trim() !== "";
  async function addFreeDays() {
    if (!canAddFree) return;
    const list = Array.from({ length: freeSpan }, (_, i) => ({ date: addDays(newFree.from, i), name: newFree.name.trim() }));
    const data = await send("/api/free-days", "POST", { days: list });
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
    const m = MACHINES.find((x) => x.id === machine);
    const first = list[0];
    // Zeile fliegt kurz heraus, dann steht der Balken im Zeitstrahl
    setLeaving(Object.fromEntries(list.map((o) => [o.id, true])));
    await new Promise((r) => setTimeout(r, 300));
    setLeaving({});
    const prevState = list.map((o) => ({ id: o.id, machine: o.machine, position: o.position }));
    const base = Math.max(-1, ...orders.filter((x) => x.machine === machine).map((x) => x.position)) + 1;
    const position = new Map(list.map((o, k) => [o.id, base + k]));
    setOrders((prev) => prev.map((x) => (position.has(x.id) ? { ...x, machine, position: position.get(x.id) } : x)));
    setSelected({});
    setFresh(first.id);
    setTimeout(() => setFresh(null), 1800);
    toast(`${list.length > 1 ? `${list.length} Positionen` : posNo(first)} → ${m.short} eingeplant`, () => {
      setOrders((prev) => prev.map((x) => (prevState.some((p) => p.id === x.id) ? { ...x, machine: "", position: prevState.find((p) => p.id === x.id).position } : x)));
      prevState.forEach((p) => send(`/api/orders/${p.id}`, "PUT", { machine: "" }));
    });
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
    try {
      const items = parseOdooExport(await file.arrayBuffer());
      const result = await send("/api/orders/import", "POST", { items, dryRun: true });
      if (!result || result.error) throw new Error("Der Server hat den Import abgelehnt");
      setImportPreview({ items, result, fileName: file.name });
    } catch (err) {
      setImportPreview(null);
      toast(`Import nicht möglich: ${err.message}`);
    }
  }

  async function applyImport() {
    const { items } = importPreview;
    const result = await send("/api/orders/import", "POST", { items, dryRun: false });
    if (!result || result.error) {
      toast("Der Import konnte nicht gespeichert werden.");
      return;
    }
    const fresh2 = await fetch("/api/orders").then((r) => r.json());
    setOrders(fresh2.orders);
    setImportPreview(null);
    toast(`Import fertig: ${result.created.length} neu, ${result.updated.length} aktualisiert, ${result.closed.length} auf erledigt gesetzt.`);
  }

  function changeTightDays(raw) {
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 60) return;
    setTightDays(value);
    send("/api/plan-settings", "PUT", { tight_days: value });
  }

  function changeAvLead(raw) {
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 60) return;
    setAvLead(value);
    send("/api/plan-settings", "PUT", { av_lead_days: value });
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

  // QS-Ablauf: "Fertig produziert" schiebt die Position in die QS (Beginn heute), ohne QS-Pflicht ist sie damit erledigt.
  // In der QS bestätigt "Geprüft" den Abschluss (mit Stichpunkten geht es weiter zur Oberfläche) oder "Nacharbeit"
  // schickt die Position mit dem noch nötigen Rest zurück an ihre Maschine.
  function finishProduced(o) {
    const patch = { done_hours: o.hours, produced_date: today, progress_date: today };
    const hasNext = orders.some((x) => x.after_id === o.id && !x.done);
    setDetailId(null);
    if (hasNext) {
      // Arbeitsgang fertig: der nächste Arbeitsgang ist frei, QS und Oberfläche kommen erst nach dem letzten
      patchOrder(o.id, { ...patch, done: true, done_date: today });
    } else if (o.qs_required !== false) {
      const qs = laneOf("qs");
      const extra = { ...patch, from_machine: o.machine };
      setOrders((prev) => applyLaneMove(prev, [o.id], today, qs).map((x) => (x.id === o.id ? { ...x, ...extra } : x)));
      send(`/api/orders/${o.id}`, "PUT", { machine: qs.id, extern_start: today, ...extra });
    } else {
      patchOrder(o.id, { ...patch, done: true, done_date: today });
    }
    toast(`${posNo(o)} ist fertig produziert${hasNext ? "" : o.qs_required !== false ? " und geht in die QS" : ""}`);
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

  async function openSync() {
    setSyncDlg({ loading: true });
    try {
      const res = await fetch("/api/odoo/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: true }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Der Abgleich hat nicht geklappt");
      setSyncDlg({ result: data, closeSel: new Set((data.closing || []).map((c) => c.ref)) });
    } catch (err) {
      setSyncDlg({ error: err.message });
    }
  }
  async function applySync() {
    const sel = [...syncDlg.closeSel];
    setSyncDlg({ ...syncDlg, saving: true });
    try {
      const res = await fetch("/api/odoo/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: false, close: sel }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Der Abgleich hat nicht geklappt");
      const [d, s] = await Promise.all([fetch("/api/orders").then((r) => r.json()), fetch("/api/odoo/status").then((r) => r.json())]);
      setOrders(d.orders);
      setOdooStatus(s);
      lastChangeSeen.current = s.lastChange || "";
      setSyncDlg(null);
      toast(data.baseline ? "Erster Abgleich fertig" + (data.created.length ? ": " + data.created.length + " neu übernommen. " : ". ") + "Ab jetzt kommen neue Fertigungsaufträge von selbst." : "Abgleich fertig: " + data.created.length + " neu übernommen" + (sel.length ? ", " + sel.length + " geschlossen" : "") + ".");
    } catch (err) {
      setSyncDlg({ ...syncDlg, saving: false, error: err.message });
    }
  }

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
    toast("Teillieferung angelegt");
  }

  async function doSplitMany(source) {
    const n = Number(String(splitGroup.qty).replace(",", "."));
    const { ok, data } = await postSplit("/api/orders/split-many", { source, quantity: n, due: splitGroup.due || null });
    if (!ok) {
      setSplitGroup((cur) => cur && { ...cur, error: data.error || "Das Teilen hat nicht geklappt" });
      return;
    }
    setSplitGroup(null);
    toast(`Teillieferung: ${data.split} Positionen geteilt, ${data.whole} liefern vollständig mit der ersten Lieferung.${data.skipped ? ` ${data.skipped} Arbeitsgänge wurden übersprungen.` : ""}`);
    reloadOrders();
  }

  function startOps(o) {
    const own = MACHINES.some((m) => m.id === o.machine) ? o.machine : MACHINES[1].id;
    const other = MACHINES.find((m) => m.id !== own) || MACHINES[0];
    setOpsFor({
      id: o.id,
      error: null,
      rows: [
        { label: "", machine: other.id, hours: "" },
        { label: "", machine: own, hours: "" },
      ],
    });
  }

  async function doOps(o) {
    const ops = opsFor.rows.map((r) => ({ label: r.label, machine: r.machine, hours: Number(String(r.hours).replace(",", ".")) }));
    const { ok, data } = await postSplit("/api/orders/ops", { id: o.id, ops });
    if (!ok) {
      setOpsFor((cur) => cur && { ...cur, error: data.error || "Das Aufteilen hat nicht geklappt" });
      return;
    }
    setOpsFor(null);
    setDetailId(null);
    reloadOrders();
    toast(`${ops.length} Arbeitsgänge für ${posNo(o)} angelegt`);
  }

  // ---------- Öffnen von außen (Suche, Hinweise) ----------
  const openDetail = (id) => {
    const o = orders.find((x) => x.id === id);
    if (!o) return;
    if (LANE_IDS.includes(o.machine) && !o.done) {
      setLaneDetail([id]);
      setDetailId(null);
    } else {
      setDetailId(id);
      setLaneDetail(null);
    }
  };
  useEffect(() => {
    setDetailId(null);
    setLaneDetail(null);
    if (pendingOpen.current != null && section === "planung") {
      const id = pendingOpen.current;
      pendingOpen.current = null;
      setTimeout(() => openDetail(id), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);
  useEffect(() => {
    if (openReq && orders.length) {
      openDetail(openReq.id);
      if (onOpenHandled) onOpenHandled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReq, orders.length > 0]);
  const closeDrawer = () => {
    setDetailId(null);
    setLaneDetail(null);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (opsFor || splitFor || splitGroup || importPreview) {
        setOpsFor(null);
        setSplitFor(null);
        setSplitGroup(null);
        setImportPreview(null);
      } else {
        setDetailId(null);
        setLaneDetail(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [opsFor, splitFor, splitGroup, importPreview]);

  // ---------- abgeleitete Listen ----------
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
          const b = { key: k, groupKey: groupKeyOf(o), label: groupLabelOf(o), ids: [], tags: new Set(), start, end: start + duration, duration };
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

  const itemById = useMemo(() => {
    const m = new Map();
    plan.forEach((pl) => pl.items.forEach((it) => m.set(it.o.id, { pl, it })));
    return m;
  }, [plan]);

  const waitText = (it) => {
    if (!it || !it.scheduled || it.waitFrom == null || !(it.start > it.waitFrom)) return null;
    const pred = it.o.after_id ? orders.find((x) => x.id === it.o.after_id && !x.done) : null;
    if (it.waitReason === "dep" && pred) return `Wartet auf ${posNo(pred)} (Arbeitsgang davor), bis ${fmtShort(dateOf(it.start))}.`;
    if (it.waitReason === "av") return `Wartet auf die Arbeitsvorbereitung, bereit ab ${fmtShort(dateOf(it.start))}.`;
    return `Wartet bis ${fmtShort(dateOf(it.start))} (Start frühestens).`;
  };
  const waitShort = (it) => {
    const pred = it.o.after_id ? orders.find((x) => x.id === it.o.after_id && !x.done) : null;
    if (it.waitReason === "dep" && pred) return `wartet auf ${pred.part_label || posNo(pred)}`;
    if (it.waitReason === "av") return "wartet auf AV";
    return `wartet bis ${fmtShort(dateOf(it.start))}`;
  };

  // Einfache Liste der offenen Positionen für Suche, Hinweise und Talos
  const positions = useMemo(() => {
    const out = [];
    orders
      .filter((o) => !o.done)
      .forEach((o) => {
        const lane = laneOf(o.machine);
        const found = itemById.get(o.id);
        const g = groupByKey.get(groupKeyOf(o));
        const av = avSummary(checks, o.id);
        const sched = found && found.it.scheduled ? found.it : null;
        const ps = planStart.get(o.id);
        const startStr = sched ? ps.start : lane && o.extern_start ? o.extern_start : null;
        const endStr = sched ? endDateOf(sched.end) : lane && o.extern_start ? endDateOf(daysBetween(monday0, o.extern_start) + daysIn(o)) : null;
        const mach = found ? found.pl.m : null;
        out.push({
          id: o.id,
          o,
          no: posNo(o),
          source: groupLabelOf(o),
          product: o.product,
          qty: o.quantity,
          place: mach ? mach.name : lane ? lane.name : null,
          placeColor: mach ? mach.c : lane ? lane.c : null,
          machineId: mach ? mach.id : null,
          start: startStr,
          end: endStr,
          endIdx: sched ? sched.end : 0,
          startIn: startStr ? daysBetween(today, startStr) : null,
          status: sched && g ? g.status : null,
          lateDays: g ? g.lateDays : 0,
          puffer: g && g.diff != null ? -g.diff : null,
          due: o.due,
          endName: g ? g.endMachine : null,
          endIsLane: g ? LANES.some((l) => l.name === g.endMachine) : false,
          av,
          urgent: !!sched && ps && daysBetween(today, ps.start) <= 7 && !av.ready,
          materialOpen: avState(checks, o.id, "material").status === "offen",
          materialMissing: /nicht verf/i.test(o.component_status || ""),
          waitText: waitText(found && found.it),
        });
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, itemById, groupByKey, checks, planStart, today]);
  useEffect(() => {
    if (onShared) onShared({ positions, today });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);
  const posRec = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions]);
  // Wiederholteile: Gleicher Artikel (Code in eckigen Klammern oder gleiche Bezeichnung) wurde schon einmal gefertigt und hat einen AV-Stand
  const productKey = (o) => {
    if (!o.product) return null;
    const m = o.product.match(/^\[([^\]]+)\]/);
    return (m ? m[1] : o.product).trim().toLowerCase();
  };
  const repeatOf = useMemo(() => {
    const byKey = new Map();
    orders.forEach((o) => {
      const k = productKey(o);
      if (!k) return;
      const hasAv = ["programm", "werkzeuge", "spannmittel"].some((it) => avState(checks, o.id, it).status === "bereit");
      if (!hasAv) return;
      const cur = byKey.get(k);
      if (!cur || o.id > cur.id) byKey.set(k, o);
    });
    const m = new Map();
    orders.forEach((o) => {
      if (o.done) return;
      const k = productKey(o);
      const src = k ? byKey.get(k) : null;
      if (!src || src.id === o.id) return;
      // nur anzeigen, wenn es etwas zu übernehmen gibt
      const differs = REPEAT_ITEMS.some((it) => {
        const s = avState(checks, src.id, it);
        const mine = avState(checks, o.id, it);
        return s.status !== "offen" && (s.status !== mine.status || (s.assignee || null) !== (mine.assignee || null));
      });
      if (differs) m.set(o.id, src);
    });
    return m;
  }, [orders, checks]); // eslint-disable-line react-hooks/exhaustive-deps
  // Zuständig für eine Tätigkeit an einer Position (Abweichung, sonst Stammbediener bzw. Rolle)
  const whoOf = (o, activity) => responsible(o, activity, staff.defaults, staff.overrides);
  const avStdOf = (o, item) => avResponsible(o, item, null, staff.defaults, staff.overrides, true);
  function setOrderStaff(orderId, activity, name) {
    setStaff((st) => {
      const overrides = new Map(st.overrides);
      if (name) overrides.set(`${orderId}|${activity}`, name);
      else overrides.delete(`${orderId}|${activity}`);
      return { ...st, overrides };
    });
    fetch("/api/staff/order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_id: orderId, activity, name: name || null }) }).catch((err) => console.error("Speichern fehlgeschlagen", err));
  }
  function changeInfo(rule, remove) {
    fetch("/api/staff/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...rule, remove }) })
      .then((r) => r.json())
      .then((d) => d.info && setStaff((st) => ({ ...st, info: d.info })))
      .catch((err) => console.error("Speichern fehlgeschlagen", err));
  }
  function setStaffDefault(key, name) {
    setStaff((st) => ({ ...st, defaults: { ...st.defaults, [key]: name } }));
    fetch("/api/staff/defaults", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, name }) }).catch((err) => console.error("Speichern fehlgeschlagen", err));
  }
  const people = useMemo(() => [...AV_TEAM, ...[...new Set([...checks.values()].map((c) => c.assignee).filter((n) => n && !AV_TEAM.includes(n)))].sort((a, b) => a.localeCompare(b))], [checks]);
  const urgentIds = useMemo(() => new Set(positions.filter((p) => p.urgent).map((p) => p.id)), [positions]);
  const lateIds = useMemo(() => new Set(positions.filter((p) => p.status === "late").map((p) => p.id)), [positions]);

  // Hervorhebung über die Kennzahlen: die betroffenen Balken bleiben, der Rest tritt zurück
  const hlSet = hl && hlSel ? new Set(hlSel.ids) : null;
  const causeSet = useMemo(() => {
    const c = new Set();
    if (hl !== "late" || !hlSel) return c;
    [hlSel.anchor].forEach((id) => {
      const f = itemById.get(id);
      if (!f) return;
      const o = f.it.o;
      if (o.after_id && itemById.get(o.after_id)) c.add(o.after_id);
      else if (f.it.waitFrom == null) {
        const idx = f.pl.items.indexOf(f.it);
        for (let k = idx - 1; k >= 0; k--) if (f.pl.items[k].scheduled) { c.add(f.pl.items[k].o.id); break; }
      }
    });
    return c;
  }, [hl, hlSel, itemById]);

  const nextFree = useMemo(() => {
    let best = null;
    plan.forEach((p) => {
      const at = p.freeAt == null ? todayOff : p.freeAt;
      if (!best || at < best.at) best = { at, m: p.m };
    });
    return best;
  }, [plan, todayOff]);

  // Zum gewählten Eintrag der Kennzahlen-Liste scrollen (Hooks stehen vor dem frühen Return der AV-Seite)
  useEffect(() => {
    if (!hlSel) return undefined;
    const t = setTimeout(() => {
      const el = hl === "pool" ? document.querySelector(`[data-pid="${hlSel.anchor}"]`) : document.querySelector(`.bar[data-ids~="i${hlSel.anchor}"]:not(.wait)`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    return () => clearTimeout(t);
  }, [hlSel, viewOffset, viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gewählte Position im Zeitstrahl ins Bild holen (auch beim Sprung aus der Arbeitsvorbereitung oder der Suche)
  useEffect(() => {
    if (detailId == null || section !== "planung" || tab !== "zeit") return undefined;
    const t = setTimeout(() => {
      const el = document.querySelector(`.bar.sel:not(.wait)`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }, 250);
    return () => clearTimeout(t);
  }, [detailId, section, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Verbindungslinien zwischen Arbeitsgängen und Erklärungen zur Hervorhebung ----------
  const layoutKey = `${tab}|${viewMode}|${viewOffset}|${viewWeeks}|${hl}|${hlSel ? hlSel.anchor : ""}|${Object.keys(expanded).join(",")}|${section}`;
  useLayoutEffect(() => {
    const tin = tlRef.current;
    if (!tin || section !== "planung" || tab !== "zeit") {
      setLinks((l) => (l.length ? [] : l));
      setCallouts((c) => (c.length ? [] : c));
      return undefined;
    }
    const compute = () => {
      const r0 = tin.getBoundingClientRect();
      const barOf = (id) => tin.querySelector(`.bar[data-ids~="i${id}"]:not(.wait)`);
      const nl = [];
      plan.forEach((p) =>
        p.items.forEach((it) => {
          if (!it.scheduled || !it.o.after_id) return;
          const a = barOf(it.o.after_id);
          const b = barOf(it.o.id);
          if (!a || !b || a === b) return;
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          nl.push({ id: it.o.id, x1: ra.right - r0.left, y1: ra.top + ra.height / 2 - r0.top, x2: rb.left - r0.left, y2: rb.top + rb.height / 2 - r0.top });
        })
      );
      const nc = [];
      if (hl && hl !== "pool" && hlSel) {
        const id = hlSel.anchor;
        const bar = barOf(id);
        if (bar && posRec.get(id)) {
          const rb = bar.getBoundingClientRect();
          let left = rb.right - r0.left + 14;
          let flip = false;
          if (left + 270 > r0.width) {
            left = rb.left - r0.left - 276;
            flip = true;
          }
          nc.push({ id, left: Math.max(4, left), top: Math.max(2, rb.top - r0.top - 6), flip });
        }
      }
      nc.sort((x, y) => x.top - y.top);
      nc.forEach((c, i) => {
        for (let j = 0; j < i; j++) if (Math.abs(nc[j].left - c.left) < 280 && c.top < nc[j].top + 125) c.top = nc[j].top + 125;
      });
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      setLinks((l) => (same(l, nl) ? l : nl));
      setCallouts((c) => (same(c, nc) ? c : nc));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  });

  useLayoutEffect(() => {
    const measure = () => {
      const el = Object.values(trackRefs.current).find(Boolean);
      if (el) setTrackW((w) => (Math.abs(w - el.clientWidth) > 8 ? el.clientWidth : w));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });

  // ---------- Hinweiskarte beim Darüberfahren ----------
  const onBarMove = (e, tipHtml) => {
    const tip = tipRef.current;
    if (!tip || dragActive) return;
    if (tip.dataset.html !== tipHtml) {
      tip.innerHTML = tipHtml;
      tip.dataset.html = tipHtml;
    }
    const w = 290;
    const h = 160;
    let x = e.clientX + 16;
    let y = e.clientY + 16;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 12;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 12;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
    tip.classList.add("on");
  };
  const hideTip = () => tipRef.current && tipRef.current.classList.remove("on");
  useEffect(() => {
    document.addEventListener("scroll", hideTip, true);
    return () => document.removeEventListener("scroll", hideTip, true);
  }, []);
  const tipFor = (title, lines, img) => {
    const text = `<b>${esc(title)}</b>${lines.filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join("")}`;
    if (!img) return text;
    return `<div class="tiprow"><span class="thumb" style="--s:64px"><img src="${esc(img)}" alt="" onerror="this.closest('.thumb').style.display='none'"></span><div>${text}</div></div>`;
  };

  // ---------- Bausteine der Darstellung ----------
  const pillOf = (g) => {
    if (!g || g.end == null) return null;
    if (g.status === "late") return { cls: "bad", text: `${days(g.lateDays)} nach Liefertermin` };
    if (g.diff != null) return { cls: g.status === "tight" ? "warn" : "ok", text: `Puffer ${fmtH(-g.diff)} Tage` };
    return null;
  };
  const avPill = (id) => {
    const s = avSummary(checks, id);
    const done = s.states.filter((x) => x.status === "bereit" || x.status === "entfaellt").length;
    return { s, done, total: s.states.length };
  };

  const deleteButton = (o, compact) =>
    confirmDeleteId === o.id ? (
      <>
        <button type="button" className="btn danger" style={{ background: "var(--bad)", color: "#fff", borderColor: "var(--bad)" }} onClick={() => removeOrder(o)}>
          Wirklich löschen?
        </button>
        <button type="button" className="btn" onClick={() => setConfirmDeleteId(null)}>
          Abbrechen
        </button>
      </>
    ) : (
      <button type="button" className={`btn danger ${compact ? "sm" : "icon"}`} aria-label="Löschen" title="Löschen" onClick={() => askDelete(o.id)}>
        <Ico n="trash" s={17} />
        {compact ? "Löschen" : null}
      </button>
    );

  // Stichpunkte für die externe Oberflächenbearbeitung einer Position (mehrere möglich) und die Dauer;
  // in QS und FERTIGUNG EXTERN gibt es nur die Dauer
  const externEditor = (o) => {
    const lane = laneOf(o.machine);
    const tags = tagsOf(o);
    const setTags = (next) => patchOrder(o.id, { extern_tags: next });
    const toggle = (tag) => setTags(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]);
    const durationSelect = (
      <select
        value={daysIn(o)}
        title={lane ? `Dauer in ${lane.name}` : "Dauer der externen Bearbeitung"}
        onChange={(ev) => patchOrder(o.id, { [o.machine === "qs" ? "qs_days" : "extern_days"]: Number(ev.target.value) })}
        aria-label="Dauer"
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
        <div className="chips">
          <span className="clab">Dauer</span>
          {durationSelect}
        </div>
      );
    }
    return (
      <div className="chips">
        <span className="clab">Danach extern</span>
        {[...EXTERN_SUGGESTIONS, ...tags.filter((t) => !EXTERN_SUGGESTIONS.includes(t))].map((tag) => (
          <button key={tag} type="button" className={`chipf${tags.includes(tag) ? " on" : ""}`} onClick={() => toggle(tag)}>
            {tag}
          </button>
        ))}
        <input
          type="text"
          maxLength={40}
          placeholder="+ Stichpunkt"
          style={{ width: 120 }}
          onKeyDown={(ev) => {
            const value = ev.target.value.trim();
            if (ev.key === "Enter" && value) {
              if (!tags.includes(value) && tags.length < 10) setTags([...tags, value]);
              ev.target.value = "";
            }
          }}
        />
        {(tags.length > 0 || o.machine === EXTERN) && durationSelect}
      </div>
    );
  };

  // Schaltflächen einer Position, die an einem Ort liegt (QS: Geprüft / Nacharbeit, sonst Erledigt)
  const laneButtons = (o) => {
    if (o.machine !== "qs") {
      return (
        <button type="button" className="btn sm" onClick={() => { patchOrder(o.id, { done: true, done_date: today }); toast(`${posNo(o)} erledigt`); }}>
          <Ico n="check" s={14} />
          Erledigt
        </button>
      );
    }
    if (reworkId === o.id) {
      const n = Number(String(reworkText).replace(",", "."));
      return (
        <>
          <span style={{ fontSize: 13 }}>Noch nötig:</span>
          <input type="number" min={0} step="any" autoFocus value={reworkText} onChange={(ev) => setReworkText(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && Number.isFinite(n) && n > 0 && sendRework(o, n)} style={{ width: 80 }} aria-label="Noch nötige Stunden" />
          <span style={{ fontSize: 13 }}>h</span>
          <button type="button" className="btn sm primary" disabled={!(Number.isFinite(n) && n > 0)} onClick={() => sendRework(o, n)}>
            Zurück an {MACHINES.find((m) => m.id === (o.from_machine || MACHINES[0].id))?.short}
          </button>
          <button type="button" className="btn sm" onClick={() => setReworkId(null)}>
            Abbrechen
          </button>
        </>
      );
    }
    return (
      <>
        <button type="button" className="btn sm primary" onClick={() => markChecked(o)} title={tagsOf(o).length ? "Geprüft: weiter zu OBERFLÄCHE EXTERN" : "Geprüft: Position ist erledigt"}>
          <Ico n="check" s={14} />
          Geprüft
        </button>
        <button type="button" className="btn sm" onClick={() => { setReworkId(o.id); setReworkText(""); }} title="Nicht in Ordnung: zurück an die Maschine">
          Nacharbeit
        </button>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{tagsOf(o).length > 0 ? `danach: ${tagsOf(o).join(", ")} (OBERFLÄCHE EXTERN)` : "danach: erledigt"}</span>
      </>
    );
  };

  // ---------- Schublade: eine Position bearbeiten ----------
  const positionDrawer = () => {
    if (detailId == null) return null;
    const o = orders.find((x) => x.id === detailId);
    if (!o) return null;
    const found = itemById.get(o.id);
    const it = found ? found.it : null;
    const pl = found ? found.pl : null;
    const g = groupByKey.get(groupKeyOf(o));
    const rec = posRec.get(o.id);
    const sum = avSummary(checks, o.id);
    const avDone = sum.states.filter((x) => x.status === "bereit" || x.status === "entfaellt").length;
    const pp = pillOf(g);
    const percent = it ? it.percent : null;
    const remaining = it ? it.remaining : Math.max(0, o.hours - (o.done_hours || 0));
    const effDone = it ? it.effDone : doneHoursOf(o);
    const ids = orders.filter((x) => !x.done && !LANE_IDS.includes(x.machine) && groupKeyOf(x) === groupKeyOf(o)).map((x) => x.id);
    const onMachine = !!pl;
    const idx = pl ? pl.items.indexOf(it) : -1;
    const pred = o.after_id ? orders.find((x) => x.id === o.after_id && !x.done) : null;
    const pm = pred ? MACHINES.find((m) => m.id === pred.machine) : null;
    const wt = waitText(it);
    return (
      <>
        <div className={`scrim${section === "planung" && tab === "zeit" ? " lite" : ""}`} onClick={closeDrawer} />
        <aside className="drawer" role="dialog" aria-label={`Position ${posNo(o)}`}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start", minWidth: 0 }}>
              <Thumb src={partImg(o)} size={88} />
              <div style={{ minWidth: 0 }}>
                <h3>{posNo(o)}</h3>
                <div style={{ color: "var(--muted)", marginTop: 4 }}>
                  {o.source ? `Auftrag ${o.source}` : "ohne Auftrag"}
                  {o.quantity != null ? ` · ${fmtH(o.quantity)} Stück` : ""}
                </div>
                {o.product && <div style={{ marginTop: 2 }}>{o.product}</div>}
              </div>
            </div>
            <button type="button" className="btn icon quiet" aria-label="Schließen" onClick={closeDrawer}>
              <Ico n="x" />
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            {pl ? (
              <span className="pill mute"><i className="dot" style={{ "--c": pl.m.c }} />{pl.m.name}</span>
            ) : (
              <span className="pill mute">noch keine Maschine</span>
            )}
            {pp && <span className={`pill ${pp.cls}`}>{pp.text}</span>}
            {wt && <span className="pill warn">{it.waitReason === "dep" ? "wartet auf Arbeitsgang" : it.waitReason === "av" ? "wartet auf AV" : "wartet auf Start"}</span>}
            <span className={`pill ${sum.ready ? "ok" : "mute"}`}>AV {avDone}/{sum.states.length}</span>
            <MaterialBadge o={o} />
          </div>
          {(o.odoo_id || goTo) && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {o.odoo_id && <OdooLink o={o} btn />}
              {goTo && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setAvFocus(o.id);
                    goTo("av");
                  }}
                >
                  In Arbeitsvorbereitung öffnen <Ico n="muss" s={15} />
                </button>
              )}
            </div>
          )}

          <div className="dsec">
            <h4>Plan</h4>
            <div style={{ fontSize: 13, marginBottom: 10 }}>
              {it && it.scheduled
                ? `${it.pastStart != null ? "Seit " : "Start "}${fmtShort(dateOf(it.pastStart ?? it.start))} · Ende ca. ${fmtShort(endDateOf(it.end))}`
                : onMachine
                ? !(o.hours > 0)
                  ? "Stunden eintragen, dann wird die Position eingeplant."
                  : remaining === 0
                  ? "Stunden erreicht, bitte als erledigt markieren."
                  : "Wochenleistung fehlt."
                : "Noch nicht eingeplant. Stunden eintragen, dann eine Maschine wählen."}
              {g && g.end != null && ` · Auftrag fertig ca. ${fmtShort(endDateOf(g.end))} (${g.endMachine})`}
            </div>
            {wt && <div style={{ fontSize: 12.5, color: "var(--warn)", marginBottom: 10 }}>{wt}</div>}
            {planStart.get(o.id) && (
              <div style={{ fontSize: 12.5, marginBottom: 10, color: sum.ready ? "var(--ok)" : addDays(planStart.get(o.id).start, -avLead) < today ? "var(--bad)" : "var(--muted)", fontWeight: sum.ready ? 600 : addDays(planStart.get(o.id).start, -avLead) < today ? 600 : 400 }}>
                {sum.ready ? "Arbeitsvorbereitung ist bereit." : "Arbeitsvorbereitung muss bis " + fmtShort(addDays(planStart.get(o.id).start, -avLead)) + " fertig sein" + (addDays(planStart.get(o.id).start, -avLead) < today ? " und ist überfällig" : "") + " (" + avLead + " Tage vor dem Start)."}
              </div>
            )}
            {pred && (
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 10 }}>
                ↳ folgt auf {posNo(pred)}
                {pm ? ` (${pm.short})` : ""}: startet, wenn dieser Arbeitsgang fertig ist
              </div>
            )}
            {o.hours > 0 && (
              <>
                <div className="bigbar" style={{ "--mc": pl ? pl.m.c : "var(--ink)" }}>
                  <i style={{ width: `${percent || 0}%` }} />
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", margin: "5px 0 14px" }}>
                  {percent != null ? `${it && it.estimated ? "~" : ""}${percent} % ${it && it.estimated ? "geschätzt" : "erledigt"} · ` : ""}Rest {fmtH(remaining)} h
                  {it && it.stale ? " · Fortschritt prüfen" : ""}
                  {o.hours_plan != null && o.hours > o.hours_plan + 0.05 ? ` · Mehraufwand +${fmtH(o.hours - o.hours_plan)} h (Plan ${fmtH(o.hours_plan)} h)` : ""}
                </div>
              </>
            )}
            <div className="fgrid">
              <label className="f">
                Auftrag / Nummer
                <input type="text" maxLength={40} placeholder="Auftrag" value={o.order_no} onChange={(ev) => patchOrder(o.id, { order_no: ev.target.value })} />
              </label>
              <label className="f">
                Gesamt (h)
                <input
                  type="number"
                  min={0}
                  step="any"
                  placeholder="Gesamt"
                  title="Gesamtstunden der Position"
                  value={o.hours || ""}
                  onChange={(ev) => {
                    const h = ev.target.value === "" ? 0 : Math.max(0, Number(ev.target.value));
                    patchOrder(o.id, { hours: h, hours_plan: h });
                  }}
                />
              </label>
              <label className="f">
                Noch nötig (h)
                <RestInput value={o.hours > 0 ? round1(remaining) : ""} title="Wie viele Stunden braucht die Position noch? (Stand heute). Mehr als geplant verlängert den Balken." onCommit={(n) => setRest(o, effDone, n)} />
              </label>
              <label className="f">
                Liefertermin
                <input type="date" title="Liefertermin" value={o.due || ""} onChange={(ev) => patchOrder(o.id, { due: ev.target.value || null })} />
              </label>
              <label className="f">
                Start frühestens
                <input
                  type="date"
                  title="Start frühestens, z. B. wenn Rohmaterial und Werkzeuge da sind. Ein Datum in der Vergangenheit gilt als tatsächlicher Start: Der Balken beginnt dann dort. Leer = sobald die Maschine frei ist."
                  value={o.earliest_start || ""}
                  onChange={(ev) => patchOrder(o.id, { earliest_start: ev.target.value || null })}
                />
              </label>
            </div>
            {externEditor(o)}
            {metaLine(o) && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>{metaLine(o)}</div>}
          </div>

          <div className="dsec">
            <h4>Zuständig</h4>
            <div className="staffgrid">
              {ACTIVITIES.map((a) => {
                const own = staff.overrides.get(`${o.id}|${a.id}`) || "";
                const name = whoOf(o, a.id);
                const std = responsible(o, a.id, staff.defaults, new Map());
                return (
                  <label key={a.id} className="staffrow">
                    <Avatar name={name || "?"} size={30} />
                    <span className="sl">{a.label}</span>
                    <select value={own} onChange={(ev) => setOrderStaff(o.id, a.id, ev.target.value || null)} aria-label={`${a.label} zuständig`} className={own ? "own" : ""}>
                      <option value="">{std ? `Standard: ${std}` : a.id !== "qs" && sharedMachine(staff.defaults, o.machine) ? "Standard: alle gleich" : "Standard: noch offen (keine Maschine)"}</option>
                      {STAFF.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="dsec">
            <h4>Arbeitsvorbereitung</h4>
            {repeatOf.get(o.id) && (
              <div className="note" style={{ marginBottom: 12 }}>
                <b>Wiederholteil:</b> Das gleiche Teil wurde schon als {posNo(repeatOf.get(o.id))} vorbereitet. Programm, Werkzeuge, Spannmittel, Prüfplan und EMPB samt Zuständigem können übernommen werden.
                <div className="actions" style={{ marginTop: 8 }}>
                  <button type="button" className="btn sm primary" onClick={() => applyRepeat(o, repeatOf.get(o.id))}>
                    AV-Stand übernehmen
                  </button>
                </div>
              </div>
            )}
            {AV_ITEMS.map((item) => {
              const st = avState(checks, o.id, item.id);
              return (
                <div className="avrow" key={item.id}>
                  <div className="top">
                    <b style={{ fontWeight: 600 }}>
                      <AppTile id={item.id} size={30} />
                      {item.label}
                    </b>
                    <div className="seg" role="group" aria-label={item.label}>
                      {AV_STATUS.map((s) => (
                        <button key={s.id} type="button" className={st.status === s.id ? "on" : ""} onClick={() => setAv(o.id, item.id, { status: s.id })}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {st.status !== "entfaellt" && (
                    <div className="sub">
                      <input type="date" value={st.due || ""} onChange={(ev) => setAv(o.id, item.id, { due: ev.target.value || null })} aria-label={`${item.label} ${st.status === "bereit" ? "bereit seit" : "bereit am"}`} title={st.status === "bereit" ? "bereit seit" : "bereit am"} />
                      <select title="Wer kümmert sich darum?" aria-label={item.label + " zuständig"} value={st.assignee || ""} onChange={(ev) => setAv(o.id, item.id, { assignee: ev.target.value || null })} style={{ flex: "0 1 150px" }}>
                        <option value="">{avStdOf(o, item.id) ? `Standard: ${avStdOf(o, item.id)}` : "Zuständig: –"}</option>
                        {people.concat(st.assignee && !people.includes(st.assignee) ? [st.assignee] : []).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      <input type="text" maxLength={500} placeholder={item.hint} value={st.note} onChange={(ev) => setAv(o.id, item.id, { note: ev.target.value })} />
                      {ids.length > 1 && (
                        <button type="button" className="btn sm" title="Status und Termin dieses Punkts für alle Positionen des Auftrags übernehmen" onClick={() => bulkAv(ids, item.id, { status: st.status, due: st.due, assignee: st.assignee || null })}>
                          Für alle {ids.length}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {sum.ready ? (
              <div style={{ marginTop: 6, color: "var(--ok)", fontWeight: 600, fontSize: 13 }}>Alles bereit. Die Planung kann starten.</div>
            ) : (
              <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 13 }}>
                Fehlt: {sum.open.map((s) => s.label).join(", ")}
                {sum.readyDate ? ` · bereit ab ${fmtShort(sum.readyDate)}` : ""}. Das ist nur eine Warnung, einplanen geht trotzdem.
              </div>
            )}
          </div>

          <div className="dact">
            {onMachine && (
              <button type="button" className="btn primary" title="Fertig produziert: die Position geht in die QS (ohne QS-Prüfung ist sie damit erledigt)" onClick={() => finishProduced(o)}>
                <Ico n="check" s={16} />
                Fertig produziert
              </button>
            )}
            <label className="chk" title="Muss die Position durch die QS-Prüfung?">
              <input type="checkbox" checked={o.qs_required !== false} onChange={(ev) => patchOrder(o.id, { qs_required: ev.target.checked })} />
              QS-Prüfung
            </label>
            {!o.part_label && (
              <button type="button" className="btn" title="Auf Arbeitsgänge aufteilen: z. B. Seite 1 auf einer Maschine, Seite 2 und 3 auf einer anderen" onClick={() => startOps(o)}>
                Arbeitsgänge
              </button>
            )}
            {o.quantity > 1 && !isOp(o) && (
              <button type="button" className="btn" title="Teillieferung: einen Teil der Stückzahl vorab liefern" onClick={() => setSplitFor({ id: o.id, qty: "", due: "", error: null })}>
                Teillieferung
              </button>
            )}
            {onMachine && (
              <span className="seg" aria-label="Reihenfolge">
                <button type="button" disabled={idx === 0} onClick={() => move(pl.m.id, o.id, -1)} aria-label="Nach vorn" title="In der Reihenfolge der Maschine nach vorn">
                  <Ico n="up" s={14} />
                </button>
                <button type="button" disabled={idx === pl.items.length - 1} onClick={() => move(pl.m.id, o.id, 1)} aria-label="Nach hinten" title="In der Reihenfolge der Maschine nach hinten">
                  <Ico n="down" s={14} />
                </button>
              </span>
            )}
            <span style={{ flex: 1 }} />
            {deleteButton(o)}
          </div>
        </aside>
      </>
    );
  };

  // ---------- Schublade: Positionen in QS / Extern ----------
  const laneDrawer = () => {
    if (!laneDetail) return null;
    const list = laneDetail.map((id) => orders.find((x) => x.id === id)).filter((x) => x && !x.done);
    if (list.length === 0) return null;
    const lane = laneOf(list[0].machine);
    if (!lane) return null;
    return (
      <>
        <div className="scrim" onClick={closeDrawer} />
        <aside className="drawer" role="dialog" aria-label={lane.name}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <LaneTile id={lane.id} c={lane.c} />
              <div>
                <h3 style={{ fontFamily: "var(--f-display)" }}>{lane.name}</h3>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>{lane.cap}</div>
              </div>
            </div>
            <button type="button" className="btn icon quiet" aria-label="Schließen" onClick={closeDrawer}>
              <Ico n="x" />
            </button>
          </div>
          {list.map((o) => {
            const start = o.extern_start ? daysBetween(monday0, o.extern_start) : null;
            const end = start != null ? start + daysIn(o) : null;
            const g = groupByKey.get(groupKeyOf(o));
            return (
              <div className="dsec" key={o.id}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  {o.odoo_ref ? <b className="mono" style={{ fontSize: 15 }}>{posNo(o)}</b> : <input type="text" placeholder="Nummer / Bezeichnung" maxLength={40} value={o.order_no} onChange={(ev) => patchOrder(o.id, { order_no: ev.target.value })} style={{ width: 170 }} />}
                  <OdooLink o={o} />
                </div>
                <div style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 4 }}>
                  {o.source ? `Auftrag ${o.source} · ` : ""}
                  {start != null ? `seit ${fmtShort(o.extern_start)}, ${fmtDuration(daysIn(o))} (bis ca. ${fmtShort(endDateOf(start + daysIn(o)))})` : "ohne Beginn"}
                  {g && g.status === "late" ? ` · Auftrag ${days(g.lateDays)} zu spät` : ""}
                </div>
                {metaLine(o, false) && <div style={{ fontSize: 12.5, marginTop: 4 }}>{metaLine(o, false)}</div>}
                <div className="fgrid" style={{ marginTop: 12 }}>
                  <label className="f">
                    Beginn
                    <input type="date" title={`Beginn in ${lane.name}`} value={o.extern_start || ""} onChange={(ev) => patchOrder(o.id, { extern_start: ev.target.value || null })} />
                  </label>
                  {lane.id !== "qs" && end != null && (
                    <label className="f">
                      Rückkehr
                      <input
                        type="date"
                        title="Wann kommt das Teil zurück? Ersetzt die Dauer."
                        value={endDateOf(end)}
                        onChange={(ev) => {
                          const d = ev.target.value;
                          if (!d || !o.extern_start) return;
                          patchOrder(o.id, { extern_days: Math.min(120, Math.max(1, daysBetween(o.extern_start, d) + 1)) });
                        }}
                      />
                    </label>
                  )}
                </div>
                {!o.odoo_ref && (
                  <div className="fgrid" style={{ marginTop: 12 }}>
                    <label className="f">
                      Auftrag (z. B. A01234)
                      <input type="text" title="Zu welchem Auftrag gehört das? Dann zählt es im Auftragsende mit." maxLength={40} value={o.source || ""} onChange={(ev) => patchOrder(o.id, { source: ev.target.value || null })} />
                    </label>
                    <label className="f">
                      Stück
                      <input type="number" min={0} step="any" value={o.quantity ?? ""} onChange={(ev) => patchOrder(o.id, { quantity: ev.target.value === "" ? null : Math.max(0, Number(ev.target.value)) })} />
                    </label>
                    <label className="f" style={{ gridColumn: "1 / -1" }}>
                      Teil / Lieferant
                      <input type="text" maxLength={200} value={o.product || ""} onChange={(ev) => patchOrder(o.id, { product: ev.target.value || null })} />
                    </label>
                    <label className="f">
                      Liefertermin
                      <input type="date" title="Liefertermin des Auftrags an den Kunden" value={o.due || ""} onChange={(ev) => patchOrder(o.id, { due: ev.target.value || null })} />
                    </label>
                  </div>
                )}
                {externEditor(o)}
                <div className="dact" style={{ marginTop: 14 }}>
                  {laneButtons(o)}
                  <span style={{ flex: 1 }} />
                  {deleteButton(o)}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>{end != null ? `${lane.id === "qs" ? "fertig" : "zurück"} ca. ${fmtShort(endDateOf(end))}` : "Beginn eintragen"}</div>
              </div>
            );
          })}
        </aside>
      </>
    );
  };

  // ---------- Dialoge ----------
  const opsDialog = () => {
    if (!opsFor) return null;
    const o = orders.find((x) => x.id === opsFor.id);
    if (!o) return null;
    const rows = opsFor.rows;
    const nums = rows.map((r) => Number(String(r.hours).replace(",", ".")));
    const valid = rows.length >= 2 && nums.every((n) => Number.isFinite(n) && n > 0);
    const sum = nums.reduce((t, n) => t + (Number.isFinite(n) ? n : 0), 0);
    const setRow = (i, patch) => setOpsFor({ ...opsFor, error: null, rows: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
    return (
      <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setOpsFor(null)}>
        <div className="dialog" role="dialog" aria-modal="true" aria-label="Arbeitsgänge">
          <h3>Arbeitsgänge für {posNo(o)}</h3>
          <p>Die Stücke durchlaufen die Arbeitsgänge nacheinander (von oben nach unten). Jeder startet, wenn der davor fertig ist.</p>
          {rows.map((r, i) => (
            <div className="agrow" key={i}>
              <b className="mono">AG {i + 1}</b>
              <input type="text" placeholder="z. B. Seite 1" maxLength={40} value={r.label} onChange={(ev) => setRow(i, { label: ev.target.value })} aria-label={`Bezeichnung AG ${i + 1}`} />
              <select value={r.machine} onChange={(ev) => setRow(i, { machine: ev.target.value })} aria-label={`Maschine AG ${i + 1}`}>
                {MACHINES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.short}
                  </option>
                ))}
              </select>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input className="hh" type="number" min={0} step="any" placeholder="Std" value={r.hours} onChange={(ev) => setRow(i, { hours: ev.target.value })} aria-label={`Stunden AG ${i + 1}`} style={{ width: 80 }} />
                {rows.length > 2 && (
                  <button type="button" className="btn icon quiet" aria-label="Arbeitsgang entfernen" onClick={() => setOpsFor({ ...opsFor, rows: rows.filter((_, j) => j !== i) })}>
                    <Ico n="x" s={14} />
                  </button>
                )}
              </span>
            </div>
          ))}
          <div className="actions" style={{ marginTop: 16 }}>
            {rows.length < 6 && (
              <button type="button" className="btn sm" onClick={() => setOpsFor({ ...opsFor, rows: [...rows, { label: "", machine: rows[rows.length - 1].machine, hours: "" }] })}>
                <Ico n="plus" s={14} />
                Arbeitsgang
              </button>
            )}
            <span style={{ color: "var(--muted)", fontSize: 13 }}>Summe {fmtH(sum)} h (bisher {fmtH(o.hours)} h)</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" onClick={() => setOpsFor(null)}>
              Abbrechen
            </button>
            <button type="button" className="btn primary" disabled={!valid} onClick={() => doOps(o)}>
              Anlegen
            </button>
          </div>
          <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>Der letzte Arbeitsgang behält Odoo-Link, QS und Oberfläche.</div>
          {opsFor.error && <div style={{ color: "var(--bad)", marginTop: 8 }}>{opsFor.error}</div>}
        </div>
      </div>
    );
  };

  const splitDialog = () => {
    if (!splitFor) return null;
    const o = orders.find((x) => x.id === splitFor.id);
    if (!o) return null;
    const n = Number(String(splitFor.qty).replace(",", "."));
    const okQty = Number.isFinite(n) && n > 0 && n < o.quantity;
    const ok = okQty && splitFor.due;
    const part1 = okQty ? round1((o.hours * n) / o.quantity) : null;
    return (
      <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setSplitFor(null)}>
        <div className="dialog" role="dialog" aria-modal="true" aria-label="Teillieferung">
          <h3>Teillieferung für {posNo(o)}</h3>
          <p>Einen Teil der {fmtH(o.quantity)} Stück vorab liefern. Stück und Stunden werden anteilig aufgeteilt.</p>
          <div className="fgrid">
            <label className="f">
              Erste Lieferung (Stück)
              <input type="number" min={0} step="any" autoFocus value={splitFor.qty} onChange={(ev) => setSplitFor({ ...splitFor, qty: ev.target.value, error: null })} />
            </label>
            <label className="f">
              Liefertermin der ersten Lieferung
              <input type="date" value={splitFor.due} onChange={(ev) => setSplitFor({ ...splitFor, due: ev.target.value, error: null })} />
            </label>
          </div>
          {part1 != null && (
            <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 12 }}>
              Teil 1: {fmtH(n)} Stück, {fmtH(part1)} h · Rest: {fmtH(o.quantity - n)} Stück, {fmtH(round1(o.hours - part1))} h
            </div>
          )}
          {splitFor.error && <div style={{ color: "var(--bad)", marginTop: 8 }}>{splitFor.error}</div>}
          <div className="actions" style={{ marginTop: 16, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => setSplitFor(null)}>
              Abbrechen
            </button>
            <button type="button" className="btn primary" disabled={!ok} onClick={() => doSplit(o)}>
              Anlegen
            </button>
          </div>
        </div>
      </div>
    );
  };

  const splitGroupDialog = () => {
    if (!splitGroup) return null;
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
      <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setSplitGroup(null)}>
        <div className="dialog" role="dialog" aria-modal="true" aria-label="Teillieferung für den Auftrag">
          <h3>Teillieferung für Auftrag {g.label}</h3>
          <p>Erste Lieferung je Position: Positionen mit mehr Stück werden geteilt, die übrigen liefern vollständig mit der ersten Lieferung.</p>
          <div className="fgrid">
            <label className="f">
              Erste Lieferung (Stück je Position)
              <input type="number" min={0} step="any" autoFocus value={splitGroup.qty} onChange={(ev) => setSplitGroup({ ...splitGroup, qty: ev.target.value, error: null })} />
            </label>
            <label className="f">
              Liefertermin der ersten Lieferung
              <input type="date" value={splitGroup.due} onChange={(ev) => setSplitGroup({ ...splitGroup, due: ev.target.value, error: null })} />
            </label>
          </div>
          {valid && (
            <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 12 }}>
              {toSplit} Positionen werden geteilt, {whole} liefern vollständig mit der ersten Lieferung (höchstens {fmtH(n)} Stück).
            </div>
          )}
          {splitGroup.error && <div style={{ color: "var(--bad)", marginTop: 8 }}>{splitGroup.error}</div>}
          <div className="actions" style={{ marginTop: 16, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => setSplitGroup(null)}>
              Abbrechen
            </button>
            <button type="button" className="btn primary" disabled={!ok} onClick={() => doSplitMany(source)}>
              Anlegen
            </button>
          </div>
        </div>
      </div>
    );
  };

  const importDialog = () => {
    if (!importPreview) return null;
    const r = importPreview.result;
    return (
      <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setImportPreview(null)}>
        <div className="dialog" role="dialog" aria-modal="true" aria-label="Import aus Odoo">
          <h3>Aus Odoo importieren</h3>
          <p>Vorschau, bevor etwas geändert wird · {importPreview.fileName}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
            {[
              [r.created.length, "neu (landen in „Noch nicht eingeplant“)"],
              [r.updated.length, "schon vorhanden (Menge und Produkt aus Odoo, Liefertermine bleiben)"],
              [r.closed.length, "werden auf erledigt gesetzt"],
            ].map(([n, t]) => (
              <div className="card" key={t} style={{ padding: 14, boxShadow: "none" }}>
                <b style={{ font: "600 26px var(--f-display)" }}>{n}</b>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>{t}</div>
              </div>
            ))}
          </div>
          {r.closed.length > 0 && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 12 }}>Auf erledigt, weil sie im Export fehlen: {r.closed.join(", ")}</div>}
          <div className="actions" style={{ marginTop: 18, justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => setImportPreview(null)}>
              Abbrechen
            </button>
            <button type="button" className="btn primary" onClick={applyImport}>
              Übernehmen
            </button>
          </div>
        </div>
      </div>
    );
  };

  const syncDialog = () => {
    if (!syncDlg) return null;
    const close = () => setSyncDlg(null);
    const r = syncDlg.result;
    return (
      <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div className="dialog" role="dialog" aria-modal="true" aria-label="Abgleich mit Odoo" style={{ width: "min(640px, 100%)" }}>
          <h3>Abgleich mit Odoo</h3>
          {syncDlg.loading && <p>Odoo wird gelesen…</p>}
          {syncDlg.error && <div className="note" style={{ borderColor: "var(--bad)", color: "var(--bad)" }}>{syncDlg.error}</div>}
          {r && r.baseline && (
            <>
              <p>
                Erster Abgleich: Odoo hat <b>{r.openCount}</b> offene Fertigungsaufträge, davon kennt die App schon <b>{r.knownInApp}</b>. Die alten übrigen werden nur als „bekannt“ gemerkt und <b>nicht</b> importiert.
                {r.created.length > 0 ? " Neu angelegte (letzte 3 Tage) kommen jetzt in „Noch nicht eingeplant“:" : " Ab jetzt kommen neu bestätigte Fertigungsaufträge von selbst in „Noch nicht eingeplant“."}
              </p>
              {r.created.map((c) => (
                <div key={c.ref} style={{ fontSize: 13, padding: "3px 0" }}>
                  <b className="mono">{c.ref}</b> · {c.source || "ohne Auftrag"} · {c.quantity != null ? fmtH(c.quantity) + " Stück · " : ""}{c.product}
                </div>
              ))}
              <div className="actions" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="btn" onClick={close}>Abbrechen</button>
                <button type="button" className="btn primary" disabled={syncDlg.saving} onClick={applySync}>Verstanden, starten</button>
              </div>
            </>
          )}
          {r && !r.baseline && (
            <>
              <p>Vorschau, bevor etwas geändert wird. Die Frist der Aufträge bleibt bei Ihnen unverändert.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
                {[[r.created.length, "neu in „Noch nicht eingeplant“"], [r.updated, "bekannte Aufträge aktualisiert (Menge, Produkt, Material)"], [r.closing.length, "zum Schließen vorgeschlagen"]].map(([n, t]) => (
                  <div className="card" key={t} style={{ padding: 14, boxShadow: "none" }}>
                    <b style={{ font: "600 26px var(--f-display)" }}>{n}</b>
                    <div style={{ color: "var(--muted)", fontSize: 13 }}>{t}</div>
                  </div>
                ))}
              </div>
              {r.created.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ font: "600 12px var(--f-display)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>Neu</div>
                  {r.created.map((c) => (
                    <div key={c.ref} style={{ fontSize: 13, padding: "3px 0" }}>
                      <b className="mono">{c.ref}</b> · {c.source || "ohne Auftrag"} · {c.quantity != null ? fmtH(c.quantity) + " Stück · " : ""}{c.product}{c.supplier ? " · extern bei " + c.supplier : ""}
                    </div>
                  ))}
                </div>
              )}
              {r.closing.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ font: "600 12px var(--f-display)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>In der App schließen? (angekreuzt = wird geschlossen)</div>
                  {r.closing.map((c) => (
                    <label key={c.ref} className="chk" style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0", fontSize: 13, color: "var(--ink)" }}>
                      <input
                        type="checkbox"
                        checked={syncDlg.closeSel.has(c.ref)}
                        onChange={() => {
                          const next = new Set(syncDlg.closeSel);
                          if (next.has(c.ref)) next.delete(c.ref);
                          else next.add(c.ref);
                          setSyncDlg({ ...syncDlg, closeSel: next });
                        }}
                      />
                      <span>
                        <b className="mono">{c.ref}</b> {c.source ? "· " + c.source : ""} <span style={{ color: "var(--muted)" }}>· {c.reason}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="actions" style={{ marginTop: 18, justifyContent: "flex-end" }}>
                <button type="button" className="btn" onClick={close}>Abbrechen</button>
                <button type="button" className="btn primary" disabled={syncDlg.saving} onClick={applySync}>Übernehmen</button>
              </div>
            </>
          )}
          {!syncDlg.loading && !r && (
            <div className="actions" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={close}>Schließen</button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const layer = (
    <>
      {syncDialog()}
      {section === "planung" && positionDrawer()}
      {section === "planung" && laneDrawer()}
      {section === "av" && positionDrawer()}
      {opsDialog()}
      {splitDialog()}
      {splitGroupDialog()}
      {importDialog()}
      <div className="tip" ref={tipRef} role="tooltip" />
    </>
  );

  if (section === "av") {
    return (
      <>
        <AvView
          avStdOf={avStdOf}
          orders={orders}
          checks={checks}
          planStart={planStart}
          today={today}
          onSet={setAv}
          selectedId={detailId}
          onOpen={(id) => openDetail(id)}
          filter={avFilter}
          setFilter={setAvFilter}
          leadDays={avLead}
          repeatOf={repeatOf}
          people={people}
          onBulk={bulkAv}
          onApplyRepeat={applyRepeat}
          focusId={avFocus}
          onFocusDone={() => setAvFocus(null)}
          openPlanning={(id) => {
            pendingOpen.current = id;
            goTo("planung");
          }}
          orderGroup={groupKeyOf}
        />
        {layer}
      </>
    );
  }

  // ---------- Zeitstrahl ----------
  const dayCells = [];
  for (let i = 0; i < total; i++) {
    const idx = viewStart + i;
    const date = addDays(monday0, idx);
    const wd = ((idx % 7) + 7) % 7;
    dayCells.push({ idx, date, wd, off: isFreeDay(idx, free), tdy: date === today, outside: monthKey != null && date.slice(0, 7) !== monthKey });
  }
  const dense = total > 21;

  const dueMarkers = (blocks) => {
    // Liefertermine dieser Zeile: Aufträge mit demselben Tag ergeben eine Marke, außerhalb des Fensters am Rand, überlappende untereinander
    const SEV = { none: 0, ok: 1, tight: 2, late: 3 };
    const byDay = new Map();
    const seenGroups = new Set();
    blocks.forEach((block) => {
      const g = groupByKey.get(block.key);
      if (!g || g.dueEnd == null || seenGroups.has(g.key)) return;
      seenGroups.add(g.key);
      const side = g.dueEnd < viewStart ? "left" : g.dueEnd > viewEnd ? "right" : "in";
      const key = side === "in" ? String(Math.floor(g.dueEnd)) : side;
      if (!byDay.has(key)) byDay.set(key, { side, dueEnd: g.dueEnd, due: g.due, groups: [] });
      byDay.get(key).groups.push(g);
    });
    const markers = [...byDay.values()].map((m) => {
      m.amp = m.groups.reduce((a, g) => (SEV[ampel(g)] > SEV[a] ? ampel(g) : a), "none");
      const n = m.groups.length;
      const label = n === 1 ? m.groups[0].label : n + " Aufträge";
      const dateText = n > 1 && m.side !== "in" ? "" : " · " + fmtShort(m.due);
      m.text = (m.side === "left" ? "◀ " : "") + label + dateText + (m.side === "right" ? " ▶" : "");
      m.widthPct = ((m.text.length * 6.4 + 38) / trackW) * 100;
      const at = posPct(m.dueEnd);
      m.r = m.side === "in" && at + m.widthPct > 100; // Marke rechts am Rand: das Etikett endet am Tag
      m.x = m.side === "left" ? 0 : m.side === "right" ? 100 - m.widthPct : m.r ? at - m.widthPct : at;
      return m;
    });
    markers.sort((a, b) => a.x - b.x);
    const laneEnds = [];
    markers.forEach((m) => {
      let lane = laneEnds.findIndex((end) => end <= m.x);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = m.x + m.widthPct;
      m.lane = lane;
    });
    return { markers, lanes: laneEnds.length };
  };

  const machineLane = (p, bi) => {
    const blocks = buildBlocks(p.items);
    const strips = [];
    const bars = [];
    p.items
      .filter((it) => it.scheduled && it.waitFrom != null && it.start > it.waitFrom)
      .forEach((it) => {
        const { cs, ce } = span(it.waitFrom, it.start);
        if (ce <= cs) return;
        const dim = hlSet && !hlSet.has(it.o.id) ? (causeSet.has(it.o.id) ? " cause" : " dim") : "";
        bars.push(
          <div
            key={`wait-${it.o.id}`}
            className={`bar wait${dim}`}
            data-ids={`i${it.o.id}`}
            style={{ left: `${posPct(cs)}%`, width: `calc(${((ce - cs) / total) * 100}% - 2px)` }}
            onClick={() => openDetail(it.o.id)}
            onMouseMove={(e) => onBarMove(e, tipFor(`${posNo(it.o)} wartet`, [waitText(it)], partImg(it.o)))}
            onMouseLeave={hideTip}
          >
            <b>{waitShort(it)}</b>
            <span>{groupLabelOf(it.o)}</span>
          </div>
        );
      });
    blocks.forEach((block, bIdx) => {
      const g = groupByKey.get(block.key);
      const status = stat(g);
      const multi = block.items.length > 1;
      const externCount = block.items.filter((i) => tagsOf(i.o).length > 0).length;
      const toggleKey = `${p.m.id}|${block.key}`;
      const open = multi && expanded[toggleKey];
      const groupTip = [g && g.due ? `Liefertermin ${fmtShort(g.due)}` : "", status === "late" ? `Achtung: Auftrag ${days(g.lateDays)} zu spät (Ende: ${g.endMachine})` : status === "tight" ? `Puffer des Auftrags nur ${fmtH(-g.diff)} Tage` : ""];
      const parts = open
        ? block.items.map((it) => ({
            ids: [it.o.id],
            start: it.pastStart ?? it.start,
            pastEnd: it.pastStart != null ? it.start : null,
            end: it.end,
            label: posNo(it.o),
            sub: `${fmtH(it.remaining)} h${it.percent != null ? ` · ${it.estimated ? "~" : ""}${it.percent} %` : ""}${tagsOf(it.o).length ? " · extern" : ""}`,
            percent: it.percent,
            toggle: null,
            select: it.o.id,
            tipTitle: it.o.order_no || "ohne Nummer",
            tip: [
              [it.o.source ? `Auftrag ${it.o.source}` : "", it.o.quantity != null ? `${fmtH(it.o.quantity)} Stück` : ""].filter(Boolean).join(" · "),
              it.o.product || "",
              `gesamt ${fmtH(it.o.hours)} h${it.percent != null ? ` · ${it.estimated ? "~" : ""}${it.percent} % ${it.estimated ? "geschätzt" : "erledigt"}` : ""}, Rest ${fmtH(it.remaining)} h`,
              tagsOf(it.o).length ? `Danach extern: ${tagsOf(it.o).join(", ")} (${fmtDuration(it.o.extern_days || 7)})` : "",
              `Start ca. ${fmtShort(dateOf(it.start))} · Ende ca. ${fmtShort(endDateOf(it.end))}`,
              ...groupTip,
              "Klicken für Details · ziehen zum Verschieben",
            ],
          }))
        : [
            {
              ids: block.items.map((i) => i.o.id),
              start: block.start,
              pastEnd: block.doneEnd,
              end: block.end,
              label: g ? g.label : groupLabelOf(block.items[0].o),
              sub: `${multi ? `${block.items.length} Pos. · ` : ""}${fmtH(block.remaining)} h${block.percent != null ? ` · ${block.estimated ? "~" : ""}${block.percent} %` : ""}${externCount ? ` · ${externCount} extern` : ""}`,
              percent: block.percent,
              toggle: multi ? toggleKey : null,
              select: multi ? null : block.items[0].o.id,
              tipTitle: multi ? `${g ? g.label : groupLabelOf(block.items[0].o)} · ${block.items.length} Positionen` : block.items[0].o.order_no || "ohne Nummer",
              tip: [
                multi ? `FA: ${block.items.slice(0, 6).map((i) => i.o.order_no).join(", ")}${block.items.length > 6 ? " …" : ""}` : [block.items[0].o.source ? `Auftrag ${block.items[0].o.source}` : "", block.items[0].o.quantity != null ? `${fmtH(block.items[0].o.quantity)} Stück` : ""].filter(Boolean).join(" · "),
                multi ? "" : block.items[0].o.product || "",
                `gesamt ${fmtH(block.hours)} h${block.percent != null ? ` · ${block.estimated ? "~" : ""}${block.percent} % ${block.estimated ? "geschätzt" : "erledigt"}` : ""}, Rest ${fmtH(block.remaining)} h`,
                externCount ? `Danach extern (${externCount} Pos.): ${[...new Set(block.items.flatMap((i) => tagsOf(i.o)))].join(", ")}` : "",
                `Start ca. ${fmtShort(dateOf(block.start))} · Ende ca. ${fmtShort(endDateOf(block.end))}`,
                ...groupTip,
                multi ? "Klicken zum Aufklappen · ziehen zum Verschieben" : "Klicken für Details · ziehen zum Verschieben",
              ],
            },
          ];
      parts.forEach((part, idx) => {
        const { cs, ce, cutL, cutR } = span(part.start, part.end);
        if (ce <= cs) return;
        if (g && g.dueEnd != null && !part.ids.every((id) => orders.find((x) => x.id === id)?.done)) {
          const gap = g.dueEnd - part.end; // > 0: Puffer in Tagen, < 0: Tage zu spät
          const amp = gap < 0 ? "late" : gap < tightDays ? "tight" : "ok";
          const lo = Math.min(part.end, g.dueEnd);
          const hi = Math.max(part.end, g.dueEnd);
          const a = posPct(Math.max(lo, viewStart));
          const b = posPct(Math.min(hi, viewEnd));
          const days0 = Math.floor(Math.abs(gap));
          const label =
            (g.dueEnd < viewStart ? "◀ " : "") +
            g.label +
            " · " +
            fmtShort(g.due) +
            " · " +
            (gap < 0 ? Math.max(1, Math.ceil(-gap)) + " T zu spät" : days0 + " T Puffer") +
            (g.dueEnd > viewEnd ? " ▶" : "");
          if (b > a || g.dueEnd < viewStart || g.dueEnd > viewEnd) {
            strips.push({
              key: block.key + "-" + part.ids[0],
              amp,
              a,
              b: Math.max(b, a + 0.4),
              dueAtLeft: gap < 0,
              inView: g.dueEnd >= viewStart && g.dueEnd <= viewEnd,
              label,
              widthPct: ((label.length * 6 + 22) / trackW) * 100,
              ids: part.ids,
              blockKey: block.key,
              tip: tipFor(posNo(block.items[0].o) + (multi ? " u. a." : ""), [
                "Liefertermin " + fmtShort(g.due),
                gap < 0 ? "Der Balken endet ca. " + Math.ceil(-gap) + " Tage nach dem Liefertermin" : "Der Balken endet ca. " + days0 + " Tage vor dem Liefertermin (Puffer)",
              ]),
            });
          }
        }
        const isDragged = dragActive && part.ids.some((id) => drag.ids.includes(id));
        const inHl = hlSet && part.ids.some((id) => hlSet.has(id));
        const isCause = hlSet && !inHl && part.ids.some((id) => causeSet.has(id));
        const hlCls = hlSet ? (inHl ? " hl" : isCause ? " cause" : " dim") : "";
        const linked = hoverStrip && part.ids.some((id) => hoverStrip.includes(id));
        const dim2 = hoverStrip ? (linked ? "" : " dim2") : hoverGroup && hoverGroup !== block.key ? " dim2" : "";
        const isSel = part.select != null && part.select === detailId;
        const isFresh = fresh != null && part.ids.includes(fresh);
        const tag = status === "late" ? <em className="tag bad" style={{ fontStyle: "normal" }}>+{g.lateDays} T</em> : status === "tight" && g && g.diff != null ? <em className="tag warn" style={{ fontStyle: "normal" }}>Puffer {Math.max(1, Math.floor(-g.diff))} T</em> : null;
        const tipHtml = tipFor(part.tipTitle, part.tip, partImg(orders.find((x) => x.id === part.ids[0])));
        bars.push(
          <div
            key={`${block.key}-${part.ids[0]}`}
            className={`bar amp-${ampel(g)}${status === "late" ? " late" : ""}${hlCls}${dim2}${isSel ? " sel" : ""}${linked ? " linked" : ""}${isFresh ? " fresh" : ""}${isDragged ? " dragged" : ""}`}
            data-bar="1"
            data-ids={part.ids.map((id) => `i${id}`).join(" ")}
            role="button"
            tabIndex={0}
            onPointerDown={(e) => startDrag(e, part)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (part.select != null) openDetail(part.select);
                else if (part.toggle) setExpanded((prev) => ({ ...prev, [part.toggle]: !prev[part.toggle] }));
              }
            }}
            onMouseEnter={() => setHoverGroup(block.key)}
            onMouseMove={(e) => onBarMove(e, tipHtml)}
            onMouseLeave={() => {
              setHoverGroup(null);
              hideTip();
            }}
            style={{ "--mc": p.m.c, "--i": bIdx + idx, left: `${posPct(cs)}%`, width: `calc(${((ce - cs) / total) * 100}% - 2px)`, minWidth: MIN_BAR_PX, zIndex: Math.max(1, 20 - bIdx - idx) }}
          >
            {part.pastEnd != null &&
              (() => {
                const w = ((Math.min(part.pastEnd, ce) - cs) / (ce - cs)) * 100;
                return w > 0 ? <div className="pastrun" title="schon gelaufen (ab dem eingetragenen Start)" style={{ width: `${Math.min(100, w)}%` }} /> : null;
              })()}
            {(() => {
              // Wer an dieser Position arbeitet (Programmierung, Rüsten, Fräsen): kleine Fotos links, der Text rückt nach rechts
              const o0 = orders.find((x) => x.id === part.ids[0]);
              const names = o0 ? [...new Set(["programmierung", "ruesten", "fraesen"].map((a) => whoOf(o0, a)).filter(Boolean))] : [];
              return names.length ? (
                <span className="bar-who" title={names.join(", ")}>
                  {names.slice(0, 2).map((n) => (
                    <Avatar key={n} name={n} size={22} />
                  ))}
                </span>
              ) : null;
            })()}
            <b>
              {cutL ? "◀ " : ""}
              {part.label}
            </b>
            <span>
              {part.sub}
              {cutR ? " ▶" : ""}
              {tag}
            </span>
            {part.percent != null && (
              <div className="prog">
                <i style={{ width: `${part.percent}%` }} />
              </div>
            )}
          </div>
        );
      });
    });
    // Terminlinien so auf Zeilen verteilen, dass sie sich (samt Text) nicht überdecken
    strips.sort((x, y) => x.a - y.a);
    const rowEnds = [];
    strips.forEach((s) => {
      s.textRight = s.b + s.widthPct <= 100;
      const from = s.textRight ? s.a : s.a - s.widthPct;
      const to = s.textRight ? s.b + s.widthPct : s.b;
      let row = rowEnds.findIndex((end) => end <= from);
      if (row === -1) row = rowEnds.length;
      rowEnds[row] = to + 0.4;
      s.row = row;
    });
    const trackH = Math.max(66, 60 + Math.max(1, rowEnds.length) * 16 + 6);
    return (
      <div className="lane" key={p.m.id}>
        <div className="lab">
          <MTile c={p.m.c} img={p.m.img} imgZoom={p.m.imgZoom} title={p.m.name} />
          <div className="lt">
            <b>{p.m.name}</b>
            <small>{p.rate ? `${fmtH(p.rate)} h/Woche` : "keine Wochenleistung"}</small>

          </div>
          <button type="button" className="btn icon quiet addb" title="Auftrag von Hand hinzufügen" aria-label={`Auftrag zu ${p.m.short} hinzufügen`} onClick={() => addOrder(p.m.id)}>
            <Ico n="plus" s={15} />
          </button>
        </div>
        <div
          className={`track${dragActive && drag.target?.machine === p.m.id ? " droptarget" : ""}`}
          ref={(el) => {
            trackRefs.current[p.m.id] = el;
          }}
          onClick={clearSelection}
          style={{ minHeight: trackH }}
        >
          <div className="grid">
            {dayCells.map((d) => (
              <i key={d.idx} className={`${d.off ? "off " : ""}${d.wd === 0 ? "kw" : ""}`} title={d.off ? freeNames.get(d.idx) || undefined : undefined} />
            ))}
          </div>
          {bars}
          {strips.map((s) => {
            const dim = hlSet && !s.ids.some((id) => hlSet.has(id));
            const hot = hoverGroup === s.blockKey || (hoverStrip && hoverStrip.some((id) => s.ids.includes(id)));
            const top = 58 + s.row * 16;
            return (
              <React.Fragment key={"dl-" + s.key}>
                <div
                  className={"dl dl-" + s.amp + (s.dueAtLeft ? " dl-left" : "") + (dim ? " dim" : "") + (hot ? " hot" : "")}
                  style={{ left: s.a + "%", width: s.b - s.a + "%", top }}
                  onMouseEnter={() => setHoverStrip(s.ids)}
                  onMouseMove={(e) => onBarMove(e, s.tip)}
                  onMouseLeave={() => {
                    setHoverStrip(null);
                    hideTip();
                  }}
                >
                  <i className="dl-line" />
                  <i className={"dl-dia" + (s.inView ? "" : " edge")} />
                </div>
                <span
                  className={"dl-text dl-" + s.amp + (dim ? " dim" : "") + (hot ? " hot" : "")}
                  style={s.textRight ? { left: "calc(" + s.b + "% + 9px)", top: top - 4 } : { right: "calc(" + (100 - s.a) + "% + 9px)", top: top - 4 }}
                >
                  {s.label}
                </span>
              </React.Fragment>
            );
          })}
          {p.freeAt != null &&
            (() => {
              const label = `frei ab ca. ${fmtShort(dateOf(p.freeAt))}`;
              if (p.freeAt >= viewEnd) return <span className="freeat" style={{ right: 6 }}>{label} ▶</span>;
              if (p.freeAt < viewStart) return <span className="freeat" style={{ left: 6 }}>{label}</span>;
              const lastStart = Math.max(p.scheduled[p.scheduled.length - 1].start, viewStart);
              return <span className="freeat" style={{ left: `max(calc(${posPct(p.freeAt)}% + 6px), calc(${posPct(lastStart)}% + ${MIN_BAR_PX + 6}px))` }}>{label}</span>;
            })()}
        </div>
      </div>
    );
  };

  const minorLane = ({ lane, blocks, rows }) => (
    <div className="lane minor" key={lane.id}>
      <div className="lab">
        <LaneTile id={lane.id} c={lane.c} />
        <div className="lt">
          <b>{lane.name}</b>
          <small>{lane.cap}</small>

        </div>
        {lane.id !== "qs" && (
          <button type="button" className="btn icon quiet addb" title="Auftrag von Hand hinzufügen" aria-label={`Auftrag zu ${lane.name} hinzufügen`} onClick={() => addLaneOrder(lane)}>
            <Ico n="plus" s={15} />
          </button>
        )}
      </div>
      <div
        className={`track${dragActive && drag.target?.machine === lane.id ? " droptarget" : ""}`}
        ref={(el) => {
          laneTracks.current[lane.id] = el;
        }}
        onClick={clearSelection}
        style={{ minHeight: Math.max(52, rows * 44 + 8) }}
      >
        <div className="grid">
          {dayCells.map((d) => (
            <i key={d.idx} className={`${d.off ? "off " : ""}${d.wd === 0 ? "kw" : ""}`} />
          ))}
        </div>
        {blocks.map((b) => {
          const g = groupByKey.get(b.groupKey);
          const overdue = lane.id === "qs" && b.end <= todayOff; // Prüfung länger als geplant
          const isDragged = dragActive && b.ids.some((id) => drag.ids.includes(id));
          const tags = [...b.tags];
          const sup = (orders.find((x) => x.id === b.ids[0]) || {}).supplier || "";
          const { cs, ce } = span(b.start, b.end);
          if (ce <= cs) return null;
          const tipHtml = tipFor(`${b.label} · ${b.ids.length} ${b.ids.length === 1 ? "Position" : "Positionen"} in ${lane.name}`, [
            tags.length ? tags.join(", ") : "",
            sup ? `Lieferant: ${sup}` : "",
            `${fmtDuration(b.duration)}, ab ${fmtShort(dateOf(b.start))} bis ca. ${fmtShort(endDateOf(b.end))}${overdue ? " – Prüfung überfällig" : ""}`,
            g && g.due ? `Liefertermin ${fmtShort(g.due)}` : "",
            g && g.status === "late" ? `Achtung: Auftrag ${days(g.lateDays)} zu spät (Ende: ${g.endMachine})` : "",
            "Klicken für Details · ziehen zum Verschieben (auch zurück auf eine Maschine)",
          ], partImg(orders.find((x) => x.id === b.ids[0])));
          return (
            <div
              key={b.key}
              className={`bar amp-${overdue ? "late" : ampel(g)}${lane.tags || lane.id === "extern_fert" ? " ext" : ""}${overdue ? " late" : ""}${hlSet ? " dim" : ""}${isDragged ? " dragged" : ""}`}
              data-bar="1"
              data-ids={b.ids.map((id) => `i${id}`).join(" ")}
              role="button"
              tabIndex={0}
              style={{ "--mc": overdue ? "var(--bad)" : lane.c, top: 5 + b.row * 44, left: `${posPct(cs)}%`, width: `calc(${((ce - cs) / total) * 100}% - 2px)`, minWidth: MIN_BAR_PX }}
              onPointerDown={(e) => startDrag(e, { ids: b.ids, label: b.label, sub: `${b.ids.length} Pos.`, toggle: null, laneSelect: b.ids })}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setLaneDetail(b.ids), setDetailId(null))}
              onMouseMove={(e) => onBarMove(e, tipHtml)}
              onMouseLeave={hideTip}
            >
              {lane.id === "qs" &&
                (() => {
                  const o0 = orders.find((x) => x.id === b.ids[0]);
                  const n = o0 && whoOf(o0, "qs");
                  return n ? (
                    <span className="bar-who" title={`QS: ${n}`}>
                      <Avatar name={n} size={22} />
                    </span>
                  ) : null;
                })()}
              <b>{b.label}</b>
              <span>
                {b.ids.length > 1 ? `${b.ids.length} Pos. · ` : ""}
                {sup ? `${sup} · ` : ""}
                {tags.length ? tags.join(", ") : fmtDuration(b.duration)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  // Liste hinter der angeklickten Kennzahl: jede Zeile öffnet die Position
  const hlRows = () => {
    if (hl === "late") {
      const seen = new Set();
      return positions
        .filter((x) => x.status === "late")
        .sort((x, y) => y.lateDays - x.lateDays)
        .filter((x) => !seen.has(x.source) && seen.add(x.source))
        .map((x) => {
          const places = [...new Set(positions.filter((y) => y.source === x.source && y.place).map((y) => y.place))];
          return { id: x.id, ids: positions.filter((y) => y.source === x.source).map((y) => y.id), o: x.o, title: x.source, text: days(x.lateDays) + " nach dem Liefertermin (" + fmtShort(x.due) + ")" + (x.endIsLane ? ", verzögert durch " + x.endName : ""), where: places.join(", "), color: "var(--bad)" };
        });
    }
    if (hl === "soon") {
      return positions
        .filter((x) => x.urgent)
        .sort((x, y) => String(x.start).localeCompare(String(y.start)))
        .map((x) => ({ id: x.id, ids: [x.id], o: x.o, title: x.no, text: x.source + " · startet " + fmtShort(x.start) + ", fehlt: " + x.av.open.map((s) => s.label).join(", "), where: x.place, color: "var(--warn)" }));
    }
    return poolOrders.map((o) => ({ id: o.id, ids: [o.id], o, title: posNo(o), text: [groupLabelOf(o), o.quantity != null ? fmtH(o.quantity) + " Stück" : "", o.product || ""].filter(Boolean).join(" · "), where: o.hours > 0 ? fmtH(o.hours) + " h" : "Stunden fehlen", color: "var(--faint)" }));
  };
  // Eintrag der Liste wählen: Zeitstrahl springt zum Balken, nur dieser leuchtet; zweiter Klick hebt die Auswahl auf
  const selectRow = (r) => {
    if (hlSel && hlSel.anchor === r.id) {
      setHlSel(null);
      return;
    }
    setHlSel({ ids: r.ids, anchor: r.id });
    setLaneDetail(null);
    setDetailId(null);
    const f = itemById.get(r.id);
    const o = orders.find((x) => x.id === r.id);
    const startDay = f && f.it.scheduled ? Math.floor(f.it.pastStart ?? f.it.start) : o && LANE_IDS.includes(o.machine) && o.extern_start ? daysBetween(monday0, o.extern_start) : null;
    if (startDay != null && (viewMode !== "weeks" || startDay < viewStart || startDay >= viewEnd)) {
      setViewMode("weeks");
      setViewOffset(Math.floor(startDay / 7));
    }
  };
  const hlBanner = () => {
    if (!hl) return null;
    const rows = hlRows();
    const n = rows.length;
    const lab = hl === "late" ? "Liefertermin gefährdet" : hl === "soon" ? "Starten bald, nicht bereit" : "Noch keine Maschine";
    const unit = hl === "late" ? (n === 1 ? "Auftrag" : "Aufträge") : n === 1 ? "Position" : "Positionen";
    return (
      <>
        <div className="hlbar">
          <span>
            <b>{lab}</b> · {n} {unit}
            {hlSel ? " · Ausgewählt: " + (rows.find((r) => r.id === hlSel.anchor)?.title || "") : hl === "pool" ? ". Wähle eine aus, um sie in der Liste zu sehen." : ". Wähle einen aus, um ihn im Zeitstrahl zu sehen."}
          </span>
          <span className="sp" />
          {hl === "soon" && (
            <button type="button" onClick={() => { setAvFilter("bald"); goTo("av"); }}>
              In der Arbeitsvorbereitung ansehen
            </button>
          )}
          <button type="button" onClick={() => { setHl(null); setHlSel(null); }}>
            Zurücksetzen
          </button>
        </div>
        {n > 0 && (
          <div className="card hlist" style={{ marginBottom: 12 }}>
            {rows.map((r) => (
              <div className={"hrow" + (hlSel && hlSel.anchor === r.id ? " on" : "")} key={r.id}>
                <button type="button" className="hmain" onClick={() => selectRow(r)} title={hl === "pool" ? "In der Liste zeigen" : "Im Zeitstrahl zeigen"}>
                  <Thumb src={partImg(r.o)} size={32} />
                  <b>{r.title}</b>
                  <span className="t">{r.text}</span>
                  {r.where && <span className="pill mute">{r.where}</span>}
                </button>
                <button type="button" className="btn icon quiet" title="Details öffnen" aria-label={"Details " + r.title} onClick={() => openDetail(r.id)}>
                  <Ico n="right" s={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  const timeline = (
    <>
      {hlBanner()}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="tl-bar">
          <div className="actions">
            <div className="seg">
              <button type="button" className={viewMode === "weeks" ? "on" : ""} onClick={() => { setViewMode("weeks"); setViewOffset(0); }}>
                Wochen
              </button>
              <button type="button" className={viewMode === "month" ? "on" : ""} onClick={() => { setViewMode("month"); setViewOffset(0); }}>
                Monat
              </button>
            </div>
            {viewMode === "weeks" && (
              <div className="seg" aria-label="Anzahl Wochen">
                {[1, 2, 3].map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={viewWeeks === w ? "on" : ""}
                    onClick={() => {
                      setViewWeeks(w);
                      try {
                        window.localStorage.setItem("kratos-view-weeks", String(w));
                      } catch {
                        /* ohne Speicher bleibt es bei der Auswahl dieser Sitzung */
                      }
                    }}
                  >
                    {w} {w === 1 ? "Woche" : "Wochen"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="actions">
            <button className="btn icon" type="button" aria-label={viewMode === "weeks" ? "Eine Woche zurück" : "Voriger Monat"} onClick={() => setViewOffset((o) => o - 1)}>
              <Ico n="left" s={16} />
            </button>
            <span className="num" style={{ minWidth: 170, textAlign: "center", fontWeight: 500 }}>{viewLabel}</span>
            <button className="btn icon" type="button" aria-label={viewMode === "weeks" ? "Eine Woche vor" : "Nächster Monat"} onClick={() => setViewOffset((o) => o + 1)}>
              <Ico n="right" s={16} />
            </button>
            {viewOffset !== 0 && (
              <button className="btn sm" type="button" onClick={() => setViewOffset(0)}>
                Heute
              </button>
            )}
          </div>
        </div>
        <div className={`tl${dense ? " dense" : ""}${detailId != null ? " has-sel" : ""}`} style={{ "--n": total }}>
          <div className="tl-in" ref={tlRef}>
            <div className="tl-head">
              <div />
              <div style={{ position: "relative", paddingTop: 14 }}>
                <div className="days">
                  {dayCells.map((d) => (
                    <div key={d.idx} className={`d${d.off ? " off" : ""}${d.wd === 0 ? " kw" : ""}${d.tdy ? " tdy" : ""}${d.outside ? " out" : ""}`} title={d.off ? freeNames.get(d.idx) || "Sonntag" : undefined}>
                      {!dense && DAY_NAMES[d.wd]}
                      <b>{d.date.slice(8, 10)}</b>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {dayCells.map((d, i) =>
              d.wd === 0 || i === 0 ? (
                <span key={`kw${d.idx}`} className="kwlab" style={{ left: `calc(var(--lab) + (100% - var(--lab)) * ${i / total})` }}>
                  KW {isoWeekOf(d.date).week}
                </span>
              ) : null
            )}
            {plan.map((p, bi) => machineLane(p, bi))}
            {laneBlocks.map(minorLane)}
            {todayOff >= viewStart && todayOff <= viewEnd && (
              <div className="today" style={{ left: `calc(var(--lab) + (100% - var(--lab)) * ${(todayOff - viewStart) / total})` }}>
                <em>HEUTE</em>
              </div>
            )}
            {links.length > 0 && (
              <svg className="links" width="100%" height="100%" aria-hidden="true">
                {links.map((l) => (
                  <g key={l.id}>
                    <path d={`M${l.x1} ${l.y1} C${l.x1 + 30} ${l.y1} ${l.x2 - 30} ${l.y2} ${l.x2} ${l.y2}`} />
                    <polygon points={`${l.x2},${l.y2} ${l.x2 - 8},${l.y2 - 4} ${l.x2 - 8},${l.y2 + 4}`} />
                  </g>
                ))}
              </svg>
            )}
            {callouts.map((c) => {
              const p = posRec.get(c.id);
              if (!p) return null;
              const f = itemById.get(c.id);
              const why = waitText(f && f.it) || (causeText(c.id) ?? "Die Maschine ist bis dahin belegt. Ein anderer Platz oder mehr Kapazität würde helfen.");
              return (
                <div className={`callout${c.flip ? " l" : ""}`} key={c.id} role="note" style={{ left: c.left, top: c.top }}>
                  {hl === "soon" ? (
                    <>
                      <b>{p.no}</b> · startet {fmtShort(p.start)}
                      <div className="why">Fehlt noch: {p.av.open.map((s) => s.label).join(", ")}. Bis alles bereit ist, wartet die Position in der Planung.</div>
                    </>
                  ) : (
                    <>
                      <b>{p.no}</b> · {days(p.lateDays)} nach dem Liefertermin ({fmtShort(p.due)})
                      <div className="why">{why}</div>
                    </>
                  )}
                  <div className="bt">
                    <button className="go" type="button" onClick={() => openDetail(c.id)}>
                      Position öffnen
                    </button>
                    <button type="button" onClick={() => openTalos(hl === "soon" ? `Was fehlt noch bei ${p.no}?` : `Warum ist ${p.no} zu spät?`)}>
                      Talos fragen
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="tl-foot">
          <span><i className="sw amp-ok" />im Plan</span>
          <span><i className="sw amp-tight" />Puffer unter {tightDays} Tage, gefährdet</span>
          <span><i className="sw amp-late" />Liefertermin wird verfehlt <i className="tag bad">+3 T</i></span>
          <span><i className="sw" style={{ border: "1.5px dashed var(--line-strong)" }} />wartet auf Material, Arbeitsgang oder Start</span>
          <span><i className="sw" style={{ background: "repeating-linear-gradient(135deg, var(--hatch) 0 3px, transparent 3px 6px)", border: "1px solid var(--line)" }} />Sonntag, freier Tag</span>
          <span><i className="sw" style={{ background: "repeating-linear-gradient(135deg, rgba(0,0,0,.25) 0 3px, transparent 3px 6px)", border: "1px solid var(--line)" }} />schon gelaufen</span>
          <span style={{ marginLeft: "auto" }}>◆ Liefertermin des Auftrags: Linie unter dem Balken = Puffer (grün) oder Verspätung (rot) · Balken ziehen zum Verschieben (Esc bricht ab)</span>
        </div>
      </div>
    </>
  );

  // Ursache für eine verspätete Position, wenn sie nicht wartet
  function causeText(id) {
    const f = itemById.get(id);
    if (!f) return null;
    const idx = f.pl.items.indexOf(f.it);
    for (let k = idx - 1; k >= 0; k--) if (f.pl.items[k].scheduled) return `Die Maschine ist bis dahin mit ${posNo(f.pl.items[k].o)} belegt. Ein anderer Platz oder mehr Kapazität würde helfen.`;
    return null;
  }

  // ---------- Noch nicht eingeplant ----------
  const poolCard = (
    <div className="card" id="pool">
      <div className="sec-head">
        <div>
          <h2>Noch nicht eingeplant</h2>
          <p>Ungefähre Gesamtstunden eintragen, dann die Maschine wählen. Die Position erscheint im Zeitstrahl. Mehrere ankreuzen und gemeinsam zuweisen geht auch.</p>
        </div>
        {poolOrders.length > 0 && <span className="pill mute">{poolOrders.length} Positionen</span>}
      </div>
      {poolOrders.length === 0 && (
        <div className="empty">
          <div className="ring">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          </div>
          <b style={{ color: "var(--ink)", font: "600 18px var(--f-display)" }}>Alles eingeplant</b>
          <span>Alle Positionen haben eine Maschine.</span>
        </div>
      )}
      {selectedOrders.length > 0 && (
        <div className="bulkbar">
          <b>{selectedOrders.length} ausgewählt</b>
          <div className="seg" role="group" aria-label="Maschine für Auswahl">
            {MACHINES.map((m) => (
              <button key={m.id} type="button" disabled={assignable.length === 0} onClick={() => assignMany(assignable, m.id)}>
                {m.short}
              </button>
            ))}
          </div>
          {assignable.length === 0 ? <span style={{ color: "var(--muted)", fontSize: 12 }}>Stunden fehlen</span> : assignable.length < selectedOrders.length && <span style={{ color: "var(--muted)", fontSize: 12 }}>{selectedOrders.length - assignable.length} ohne Stunden werden übersprungen</span>}
          <button type="button" className="btn sm quiet" onClick={() => setSelected({})}>
            Auswahl aufheben
          </button>
        </div>
      )}
      <div style={{ maxHeight: 520, overflowY: "auto" }}>
        {poolGroups.map((g) => {
          const allSelected = g.items.every((o) => selected[o.id]);
          return (
            <div key={g.key}>
              <div className="grp">
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    aria-label={`Alle Positionen von ${g.label} auswählen`}
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
                  />
                </label>
                <b>{g.label}</b>
                {g.items.length} {g.items.length === 1 ? "Position" : "Positionen"} ·{" "}
                <span style={{ color: g.due && g.due < today ? "var(--bad)" : undefined, fontWeight: g.due && g.due < today ? 600 : 400 }}>{g.due ? `Liefertermin ${fmtShort(g.due)}` : "ohne Liefertermin"}</span>
              </div>
              {g.items.map((o) => {
                const av = avPill(o.id);
                return (
                  <div key={o.id} data-pid={o.id} className={`pool-row${hl === "pool" && hlSel && hlSel.anchor === o.id ? " hlrow" : ""}${leaving[o.id] ? " leaving" : ""}`}>
                    <div className="pname">
                      <label className="chk" style={{ marginRight: 2 }}>
                        <input
                          type="checkbox"
                          checked={!!selected[o.id]}
                          aria-label={`${posNo(o)} auswählen`}
                          onChange={() =>
                            setSelected((prev) => {
                              const next = { ...prev };
                              if (next[o.id]) delete next[o.id];
                              else next[o.id] = true;
                              return next;
                            })
                          }
                        />
                      </label>
                      <Thumb src={partImg(o)} size={38} />
                      <div>
                        <b onClick={() => openDetail(o.id)}>{o.order_no || "ohne Nummer"}</b> <OdooLink o={o} />{isNewPlan(o) && <span className="newpill" title="Neu aus Odoo übernommen">NEU</span>}
                        <div title={metaLine(o, false)}>{metaLine(o, false)}</div>
                      </div>
                    </div>
                    <div className="hrs">
                      <input
                        type="number"
                        min={0}
                        step="any"
                        placeholder="Std"
                        title="Ungefähre Gesamtstunden dieser Position"
                        value={o.hours || ""}
                        onChange={(ev) => {
                          const h = ev.target.value === "" ? 0 : Math.max(0, Number(ev.target.value));
                          patchOrder(o.id, { hours: h, hours_plan: h });
                        }}
                        aria-label={`Gesamtstunden ${posNo(o)}`}
                      />
                      Std
                    </div>
                    <span className={`av ${av.s.ready ? "bereit" : ""}`} title={av.s.ready ? "Arbeitsvorbereitung bereit" : `Arbeitsvorbereitung: fehlt ${av.s.open.map((s) => s.label).join(", ")}${av.s.readyDate ? ` · bereit ab ${fmtShort(av.s.readyDate)}` : ""}`}>
                      AV {av.done}/{av.total}
                    </span>
                    <div className="segwrap">
                      <div className="seg" role="group" aria-label="Maschine wählen">
                        {MACHINES.map((m) => (
                          <button key={m.id} type="button" disabled={!(o.hours > 0)} title={o.hours > 0 ? `Auf ${m.name} einplanen` : "Erst Stunden eintragen"} onClick={() => assignMany([o], m.id)}>
                            {m.short}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="actions">
                      {!o.part_label && (
                        <button type="button" className="btn sm quiet" title="Auf Arbeitsgänge aufteilen und gleich einplanen: z. B. Seite 1 auf einer Maschine, Seite 2 und 3 auf einer anderen" onClick={() => startOps(o)}>
                          Arbeitsgänge
                        </button>
                      )}
                      <button type="button" className="btn sm quiet" onClick={() => openDetail(o.id)}>
                        Details
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );

  // ---------- Maschinen-Board: jede Zeile des Zeitstrahls ist unten eine Spalte (spiegelbildlich) ----------
  // Karten ziehen funktioniert wie im Zeitstrahl (gleiche Planung, gleiches Speichern). Mit Suche oder Filter ist das Ziehen aus, weil
  // dann nicht alle Karten sichtbar sind und die Einfügeposition nicht stimmen würde.
  const boardDrag = boardQuery.trim() === "" && boardFilter === "alle";
  const boardNeedle = boardQuery.trim().toLowerCase();
  const isLateOrder = (o) => {
    const g = groupByKey.get(groupKeyOf(o));
    return !!g && g.status === "late";
  };
  const boardColumns = [
    ...MACHINES.map((m) => ({ id: m.id, name: m.short, sub: m.name, c: m.c, img: m.img, imgZoom: m.imgZoom, machine: true })),
    ...LANES.map((l) => ({ id: l.id, name: l.name, sub: l.cap, c: l.c, machine: false })),
  ].map((col) => {
    const all = viewOrders
      .filter((o) => o.machine === col.id && !o.done)
      .sort(col.machine ? byPosition : (a, b) => (a.extern_start || "").localeCompare(b.extern_start || "") || byPosition(a, b));
    const cards = all.filter((o) => {
      if (boardFilter === "spaet" && !isLateOrder(o)) return false;
      if (boardFilter === "neu" && !isNewPlan(o)) return false;
      if (!boardNeedle) return true;
      return [o.order_no, o.source, o.product, o.part_label].some((s) => s && String(s).toLowerCase().includes(boardNeedle));
    });
    return { ...col, all, cards, hours: col.machine ? all.reduce((s, o) => s + remainingOf(o), 0) : 0, late: all.filter(isLateOrder).length };
  });
  const boardCardOf = (o, col) => {
    const g = groupByKey.get(groupKeyOf(o));
    const it = col.machine ? itemById.get(o.id)?.it : null;
    const pill = pillOf(g);
    const av = avPill(o.id);
    const dd = o.due ? daysBetween(today, o.due) : null;
    const dueText = dd == null ? "ohne Liefertermin" : dd === 0 ? "Liefertermin heute" : dd > 0 ? `Liefertermin in ${days(dd)} (${fmtShort(o.due)})` : `Liefertermin seit ${days(-dd)} überschritten (${fmtShort(o.due)})`;
    let when;
    if (col.machine) {
      if (!(o.hours > 0)) when = "Stunden fehlen";
      else if (it && it.scheduled) when = `${fmtShort(dateOf(it.pastStart ?? it.start))} bis ${fmtShort(endDateOf(it.end))}`;
      else when = "Arbeit erledigt";
    } else when = o.extern_start ? `ab ${fmtShort(o.extern_start)} · ${fmtDuration(daysIn(o))}` : "ohne Beginn";
    const waiting = it && it.scheduled && it.waitFrom != null && it.start > it.waitFrom ? waitShort(it) : null;
    const dragged = dragActive && drag.ids.includes(o.id);
    return (
      <div
        key={o.id}
        data-card={o.id}
        className={`bd-card${boardDrag ? " can" : ""}${dragged ? " dragging" : ""}${detailId === o.id || (laneDetail && laneDetail.includes(o.id)) ? " sel" : ""}`}
        title={dueText}
        onPointerDown={
          boardDrag
            ? (e) => startDrag(e, { ids: [o.id], label: o.source || posNo(o), sub: o.product || "", toggle: null, ...(col.machine ? { select: o.id } : { laneSelect: [o.id] }) })
            : undefined
        }
        onClick={boardDrag ? undefined : () => openDetail(o.id)}
      >
        <div className="bd-top">
          <Thumb src={partImg(o)} size={36} />
          <div className="bd-title">
            <b>{o.source || posNo(o)}</b>
            {isNewPlan(o) && <span className="newpill" title="Neu aus Odoo übernommen">NEU</span>}
            <span className="bd-no">{o.source ? posNo(o) : ""}</span>
          </div>
        </div>
        {o.product && <div className="bd-prod">{o.product}</div>}
        <div className="bd-facts">
          {o.quantity != null && <span>{fmtH(o.quantity)} Stück</span>}
          {o.hours > 0 && <span>{fmtH(round1(o.hours))} h</span>}
          <span className="bd-when">{when}</span>
        </div>
        {it && it.percent != null && (
          <div className="bd-bar" title={`${it.percent} % erledigt`}>
            <i style={{ width: `${it.percent}%` }} />
          </div>
        )}
        <div className="bd-chips">
          {pill ? <span className={`pill ${pill.cls}`}>{pill.text}</span> : <span className="pill mute">{dd == null ? "kein Termin" : `Termin ${fmtShort(o.due)}`}</span>}
          <span className={`av ${av.s.ready ? "bereit" : ""}`} title={av.s.ready ? "Arbeitsvorbereitung bereit" : `Arbeitsvorbereitung: fehlt ${av.s.open.map((s) => s.label).join(", ")}`}>
            AV {av.done}/{av.total}
          </span>
          {waiting && <span className="pill warn">{waiting}</span>}
        </div>
      </div>
    );
  };
  const boardCard = (
    <div className="card" id="board">
      <div className="sec-head">
        <div>
          <h2>Maschinen-Board</h2>
          <p>Alle offenen Positionen je Station, in der Reihenfolge des Zeitstrahls. Karte ziehen verschiebt wie im Zeitstrahl, anklicken öffnet die Details.</p>
        </div>
        <div className="bd-tools">
          <input className="bd-search" type="search" placeholder="Suchen: Auftrag, Artikel …" value={boardQuery} onChange={(e) => setBoardQuery(e.target.value)} aria-label="Im Board suchen" />
          <div className="seg" role="group" aria-label="Filter">
            {[["alle", "Alle"], ["spaet", "Verspätet"], ["neu", "Neu"]].map(([k, label]) => (
              <button key={k} type="button" className={boardFilter === k ? "on" : ""} onClick={() => setBoardFilter(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!boardDrag && <div className="bd-hint">Mit Suche oder Filter ist das Verschieben ausgeschaltet. Zum Ziehen Suche und Filter zurücksetzen.</div>}
      <div className="bd-cols">
        {boardColumns.map((col) => (
          <div key={col.id} className="bd-col" style={{ "--c": col.c }}>
            <div className="bd-head">
              {col.machine ? <MTile c={col.c} img={col.img} imgZoom={col.imgZoom} size={36} title={col.sub} /> : <i className="bd-dot" />}
              <div className="bd-name">
                <b>{col.name}</b>
                <span>{col.sub}</span>
              </div>
              <span className="pill mute">{col.all.length}</span>
            </div>
            <div className="bd-sum">
              {col.machine && <span>{fmtH(round1(col.hours))} h offen</span>}
              {col.late > 0 && <span className="pill bad">{col.late} verspätet</span>}
            </div>
            <div ref={(el) => (boardCols.current[col.id] = el)} className={`bd-body${dragActive && drag.target?.machine === col.id ? " droptarget" : ""}`}>
              {col.cards.map((o) => boardCardOf(o, col))}
              {col.cards.length === 0 && <div className="bd-empty">{col.all.length === 0 ? "Keine Aufträge" : "Nichts gefunden"}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ---------- Aufträge im Überblick ----------
  const ordersCard = (
    <div className="card">
      <div className="sec-head">
        <div>
          <h2>Aufträge im Überblick</h2>
          <p>Liefertermin und Start frühestens gelten für alle offenen Positionen des Auftrags. Ein Klick auf die Nummer zeigt die Positionen.</p>
        </div>
      </div>
      {groups.length === 0 ? (
        <div style={{ padding: "22px 18px", color: "var(--muted)" }}>Noch keine Aufträge. Importiere sie aus Odoo.</div>
      ) : (
        <div className="scroll">
          <table className="tbl" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th>Auftrag</th>
                <th>Liefertermin</th>
                <th>Start frühestens</th>
                <th>Fertig ca.</th>
                <th>Status</th>
                <th>Positionen</th>
                <th>Fortschritt</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const open = g.positions.filter((o) => !o.done);
                const dues = [...new Set(open.map((o) => o.due).filter(Boolean))].sort();
                const deviating = dues.length > 1;
                const pending = pendingDue && pendingDue.key === g.key ? pendingDue : null;
                const applyDue = (value) => {
                  setGroupDue(g, value);
                  setPendingDue(null);
                };
                const pp = pillOf(g);
                const isOpen = !!expandedOrders[g.key];
                return (
                  <React.Fragment key={g.key}>
                    <tr className="row" onClick={() => setExpandedOrders((p) => ({ ...p, [g.key]: !p[g.key] }))}>
                      <td>
                        <b className="mono">{g.label}</b>
                        {g.positions.some((o) => o.source) && g.positions.some((o) => !o.done && o.quantity > 1) && (
                          <div>
                            <button type="button" className="btn sm quiet" style={{ marginTop: 4, padding: "1px 8px" }} title="Teillieferung für alle Positionen dieses Auftrags" onClick={(e) => { e.stopPropagation(); setSplitGroup({ key: g.key, qty: "", due: "", error: null }); }}>
                              Teillieferung
                            </button>
                          </div>
                        )}
                        {g.externTags.length > 0 && (
                          <div title={g.externTags.join(", ")} style={{ fontSize: 12, color: "var(--muted)" }}>
                            extern: {g.externTags.join(", ")}
                            {g.externDays ? ` · ${fmtDuration(g.externDays)}` : ""}
                          </div>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="date"
                          title="Liefertermin des Auftrags (gilt für alle seine Positionen)"
                          value={pending ? pending.value : g.due || ""}
                          onChange={(ev) => (deviating ? setPendingDue({ key: g.key, value: ev.target.value }) : applyDue(ev.target.value))}
                          style={{ width: 150, color: g.due && g.due < today ? "var(--bad)" : undefined }}
                          aria-label={`Liefertermin ${g.label}`}
                        />
                        {deviating && !pending && (
                          <div title={`Abweichende Liefertermine in diesem Auftrag: ${dues.map((d) => fmtShort(d)).join(", ")}`} style={{ fontSize: 12, color: "var(--warn)", marginTop: 3 }}>
                            {dues.length} verschiedene Termine
                          </div>
                        )}
                        {pending && (
                          <div style={{ fontSize: 12, marginTop: 4 }}>
                            <div style={{ color: "var(--warn)" }}>{open.filter((o) => o.due && o.due !== pending.value).length} Positionen mit eigenem Termin überschreiben?</div>
                            <div className="actions" style={{ marginTop: 4 }}>
                              <button type="button" className="btn sm" onClick={() => applyDue(pending.value)}>Ja</button>
                              <button type="button" className="btn sm" onClick={() => setPendingDue(null)}>Nein</button>
                            </div>
                          </div>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="date" title="Start frühestens für den ganzen Auftrag (z. B. wenn Rohmaterial und Werkzeuge da sind). Leer = sobald die Maschine frei ist. Gilt für alle offenen Positionen." value={earliestOf(g)} onChange={(ev) => setGroupEarliest(g, ev.target.value)} style={{ width: 150 }} aria-label={`Start frühestens ${g.label}`} />
                      </td>
                      <td>{g.end != null ? `${fmtShort(endDateOf(g.end))} · ${g.endMachine}` : "–"}</td>
                      <td>
                        {g.end == null ? <span className="pill mute">noch nicht eingeplant</span> : pp ? <span className={`pill ${pp.cls}`}>{pp.text}</span> : <span className="pill ok">im Plan</span>}
                        {g.end != null && g.unscheduled > 0 && <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 6 }}>{g.unscheduled} Pos. offen</span>}
                      </td>
                      <td className="num">{g.finished}/{g.total} erledigt</td>
                      <td>
                        <span className="meter"><i style={{ width: `${g.percent || 0}%` }} /></span>{" "}
                        <span className="num" style={{ color: "var(--muted)", fontSize: 12 }}>{g.percent != null ? `${g.percent} %` : "–"}</span>
                      </td>
                    </tr>
                    {isOpen &&
                      g.positions
                        .filter((o) => !o.done)
                        .sort(byPosition)
                        .map((o) => {
                          const f = itemById.get(o.id);
                          const lane = laneOf(o.machine);
                          return (
                            <tr className="row sub" key={o.id} onClick={() => openDetail(o.id)}>
                              <td colSpan={2}>
                                <div className="pname" style={{ paddingLeft: 14 }}>
                                  <Thumb src={partImg(o)} size={32} />
                                  <div>
                                    <b>{posNo(o)}</b>
                                    <div>{metaLine(o, false)}</div>
                                  </div>
                                </div>
                              </td>
                              <td colSpan={2}>
                                {f ? (
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                                    <i className="dot" style={{ "--c": f.pl.m.c }} />
                                    {f.pl.m.short}
                                    {f.it.scheduled ? ` · ab ${fmtShort(dateOf(f.it.pastStart ?? f.it.start))}` : ""}
                                  </span>
                                ) : lane ? (
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                                    <i className="dot" style={{ "--c": lane.c }} />
                                    {lane.name}
                                  </span>
                                ) : (
                                  <span style={{ color: "var(--faint)" }}>nicht eingeplant</span>
                                )}
                              </td>
                              <td colSpan={3}>
                                <span className="num" style={{ color: "var(--muted)", fontSize: 12.5 }}>
                                  {o.hours > 0 ? `${fmtH(o.hours)} h` : "Stunden fehlen"}
                                  {f && f.it.percent != null ? ` · ${f.it.estimated ? "~" : ""}${f.it.percent} %` : ""}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {doneOrders.length > 0 && (
        <div style={{ borderTop: "1px solid var(--line)", padding: "12px 18px" }}>
          <button type="button" className="btn sm" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Erledigte ausblenden" : `Erledigte anzeigen (${doneOrders.length})`}
          </button>
          {showDone && (
            <div style={{ marginTop: 10 }}>
              {doneOrders.map((o) => (
                <div key={o.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
                  <span className="mono" style={{ fontWeight: 600 }}>{posNo(o)}</span>
                  <span style={{ color: "var(--muted)" }}>
                    {laneOf(o.machine)?.name ?? MACHINES.find((m) => m.id === o.machine)?.short ?? "nicht eingeplant"} · {fmtH(o.hours)} h{o.source ? ` · ${o.source}` : ""}
                    {o.checked_date ? ` · geprüft am ${fmtShort(o.checked_date)}` : ""}
                    {o.done_date ? ` · erledigt am ${fmtShort(o.done_date)}` : ""}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="btn sm" onClick={() => patchOrder(o.id, { done: false, done_date: null })}>
                    Wieder öffnen
                  </button>
                  {deleteButton(o, true)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  // ---------- Einstellungen ----------
  const future = Object.keys(weekCap)
    .filter((d) => d > today)
    .sort();
  const modelName = (h) => SHIFT_MODELS.find((s) => s.hours === h)?.label ?? "Eigener Wert";
  const formDate = newShift.date ? mondayOf(newShift.date) : "";
  const formOk = /^\d{4}-\d{2}-\d{2}$/.test(newShift.date) && formDate > today;
  const upcomingFree = freeDays.filter((d) => d.date >= today);
  const nextFreeDay = upcomingFree[0];
  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const wd = (date) => WD[new Date(`${date}T00:00:00Z`).getUTCDay()];

  const staffRow = (key, label, allowMachineOwner) => (
    <label className="staffrow" key={key}>
      <Avatar name={staff.defaults[key] || "?"} size={30} />
      <span className="sl">{label}</span>
      <select value={staff.defaults[key] || ""} onChange={(ev) => setStaffDefault(key, ev.target.value)} aria-label={label}>
        {allowMachineOwner && <option value="">{typeof allowMachineOwner === "string" ? allowMachineOwner : "Stammbediener der Maschine"}</option>}
        {STAFF.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );

  const settings = (
    <div className="setgrid">
      <div className="card">
        <div className="sec-head">
          <div>
            <h2>Zuständigkeiten</h2>
            <p>Wer standardmäßig was macht. Je Position lässt sich das in der Schublade unter „Zuständig“ ändern. Daraus entsteht die Liste in „Mein Arbeitsplatz“.</p>
          </div>
        </div>
        <div className="staffgrid" style={{ padding: "4px 18px 16px" }}>
          {MACHINES.map((m) => staffRow(`machine:${m.id}`, `Stammbediener ${m.name}`, sharedMachine(STAFF_DEFAULTS, m.id) ? "Alle gleich (kein Stammbediener)" : undefined))}
          {staffRow("role:programmierung", "Programmierung", true)}
          {staffRow("role:qs", "QS")}
          {staffRow("role:av", "Arbeitsvorbereitung (sonst)")}
          {staffRow("role:planung", "Produktionsplanung")}
        </div>
        <div className="sec-head" style={{ paddingTop: 0 }}>
          <div>
            <h2 style={{ fontSize: 16 }}>Arbeitsvorbereitung je Punkt</h2>
            <p>Wer sich standardmäßig um welchen Punkt kümmert. Steht bei einer Position jemand anderes am Punkt, gilt der.</p>
          </div>
        </div>
        <div className="staffgrid" style={{ padding: "4px 18px 16px" }}>
          {AV_ITEMS.map((it) => staffRow(`av:${it.id}`, it.label, it.id === "programm" ? "Wie Programmierung" : false))}
        </div>
        <div className="sec-head" style={{ paddingTop: 0 }}>
          <div>
            <h2 style={{ fontSize: 16 }}>Zur Info</h2>
            <p>Wer bei wem nur mitschaut, z. B. während der Einarbeitung. Er sieht die Punkte in „Mein Arbeitsplatz“ zugeklappt unter „Zur Info“, ohne Knöpfe. Zuständig bleibt der andere.</p>
          </div>
        </div>
        <div className="infolist">
          {staff.info.length === 0 && <div className="bsubtext">Niemand bekommt etwas zur Info.</div>}
          {staff.info.map((x) => (
            <div className="inforow" key={`${x.source}|${x.target}|${x.scope}`}>
              <Avatar name={x.source} size={26} />
              <span>
                {x.scope === "av" ? "Arbeitsvorbereitung" : "Teile"} von <b>{x.source}</b> zur Info an <b>{x.target}</b>
              </span>
              <Avatar name={x.target} size={26} />
              <button type="button" className="btn sm quiet" onClick={() => changeInfo(x, true)} aria-label="Entfernen" title="Entfernen">
                <Ico n="x" s={14} />
              </button>
            </div>
          ))}
          <div className="inforow add">
            <select value={newInfo.scope} onChange={(ev) => setNewInfo((n) => ({ ...n, scope: ev.target.value }))} aria-label="Was">
              <option value="av">Arbeitsvorbereitung</option>
              <option value="teile">Teile</option>
            </select>
            <span>von</span>
            <select value={newInfo.source} onChange={(ev) => setNewInfo((n) => ({ ...n, source: ev.target.value }))} aria-label="Von wem">
              {STAFF.map((p) => (
                <option key={p.name}>{p.name}</option>
              ))}
            </select>
            <span>zur Info an</span>
            <select value={newInfo.target} onChange={(ev) => setNewInfo((n) => ({ ...n, target: ev.target.value }))} aria-label="An wen">
              {STAFF.map((p) => (
                <option key={p.name}>{p.name}</option>
              ))}
            </select>
            <button type="button" className="btn sm" disabled={newInfo.source === newInfo.target} onClick={() => changeInfo(newInfo, false)}>
              Hinzufügen
            </button>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="sec-head">
          <div>
            <h2>Planungsregeln</h2>
            <p>Womit die Planung rechnet und wann ein Auftrag gelb wird.</p>
          </div>
        </div>
        <div style={{ padding: "14px 18px", display: "grid", gap: 14 }}>
          <label className="f" title="Die Planung rechnet je Maschine mit Betriebszeit des Schichtmodells x Nutzung. Ein eigener Wert pro Maschine hat Vorrang.">
            Nutzung der Betriebszeit (%)
            <span style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--ink)", fontWeight: 400 }}>
              <input type="number" min={1} max={100} step={1} value={utilization || ""} onChange={(ev) => changeUtilization(ev.target.value)} style={{ width: 90 }} />
              Planung: {shift.label} {fmtH(shift.hours)} h × {utilization} %
            </span>
          </label>
          <label className="f" title="So viele Tage vor dem Start auf der Maschine muss die Arbeitsvorbereitung fertig sein (Spalte Muss bis)">
            Vorlauf der Arbeitsvorbereitung (Tage)
            <span style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--ink)", fontWeight: 400 }}>
              <input type="number" min={0} max={60} step={1} value={avLead} onChange={(ev) => changeAvLead(ev.target.value)} style={{ width: 90 }} />
              Muss bis = Start auf der Maschine minus {avLead} {avLead === 1 ? "Tag" : "Tage"}
            </span>
          </label>
          <label className="f" title="Mindestpuffer in Tagen: darunter wird ein Auftrag gelb markiert">
            Mindestpuffer (Tage)
            <span style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--ink)", fontWeight: 400 }}>
              <input type="number" min={0} max={60} step={1} value={tightDays} onChange={(ev) => changeTightDays(ev.target.value)} style={{ width: 90 }} />
              Aufträge mit weniger Puffer werden gelb markiert
            </span>
          </label>
        </div>
      </div>

      <div className="card">
        <div className="sec-head">
          <div>
            <h2>Wochenleistung je Maschine</h2>
            <p>Leer = Schichtmodell × Nutzung. Ein eigener Wert hat Vorrang.</p>
          </div>
        </div>
        <div style={{ padding: "6px 18px 14px" }}>
          {MACHINES.map((m) => {
            const own = rates[m.id] > 0;
            return (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
                <MTile c={m.c} img={m.img} imgZoom={m.imgZoom} size={40} />
                <b style={{ font: "600 15px var(--f-display)", minWidth: 120 }}>{m.name}</b>
                <input type="number" min={0} step="any" placeholder={fmtH(defaults.now)} value={rates[m.id] ?? ""} onChange={(ev) => setRate(m.id, ev.target.value)} style={{ width: 90 }} aria-label={`Wochenleistung ${m.short}`} />
                <span style={{ color: "var(--muted)", fontSize: 12.5 }}>h pro Woche · {own ? `eigener Wert (leer = ${shift.label} ${fmtH(shift.hours)} h × ${utilization} %)` : `${shift.label} ${fmtH(shift.hours)} h × ${utilization} %`}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="sec-head">
          <div>
            <h2>Schichtmodell der Planung</h2>
            <p>Jetzt: {shift.label} {fmtH(shift.hours)} h pro Woche (das Modell vom letzten Montag). Ein anderes Modell ab einer künftigen Woche kannst du hier ausprobieren oder festlegen.</p>
          </div>
        </div>
        <div style={{ padding: "6px 18px 16px" }}>
          {future.map((d) => (
            <div key={d} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="mono" style={{ width: 150 }}>ab KW {isoWeekOf(d).week} ({fmtShort(d)})</span>
              <span>{modelName(weekCap[d])} · {fmtH(weekCap[d])} h</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn icon quiet" title="Entfernen" aria-label="Entfernen" onClick={() => onDeleteShift(d)}>
                <Ico n="x" s={14} />
              </button>
            </div>
          ))}
          <div className="actions" style={{ marginTop: 12, alignItems: "flex-end" }}>
            <label className="f">
              Ab Woche mit Montag
              <input type="date" value={newShift.date} onChange={(ev) => setNewShift({ ...newShift, date: ev.target.value })} />
            </label>
            <label className="f">
              Schichtmodell
              <select value={newShift.hours} onChange={(ev) => setNewShift({ ...newShift, hours: Number(ev.target.value) })}>
                {SHIFT_MODELS.map((s) => (
                  <option key={s.label} value={s.hours}>
                    {s.label} · {s.hours} h
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn" disabled={!formOk} onClick={() => { setPreview({ date: formDate, hours: newShift.hours }); setTab("zeit"); }}>
              Vorschau ansehen
            </button>
            {newShift.date && !formOk && <span style={{ fontSize: 12, color: "var(--bad)" }}>Das Datum muss in der Zukunft liegen</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="sec-head">
          <div>
            <h2>Freie Tage</h2>
            <p>Feiertage und Betriebsurlaub zählen in der Planung wie der Sonntag. {nextFreeDay ? `Nächster: ${nextFreeDay.name}, ${wd(nextFreeDay.date)} ${fmtShort(nextFreeDay.date)}` : "Keine freien Tage in der Zukunft"}</p>
          </div>
        </div>
        <div style={{ padding: "14px 18px" }}>
          <div className="actions" style={{ alignItems: "flex-end", marginBottom: 14 }}>
            <label className="f">
              Von
              <input type="date" value={newFree.from} onChange={(ev) => setNewFree({ ...newFree, from: ev.target.value })} />
            </label>
            <label className="f">
              Bis (optional)
              <input type="date" value={newFree.to} onChange={(ev) => setNewFree({ ...newFree, to: ev.target.value })} />
            </label>
            <label className="f">
              Bezeichnung
              <input type="text" maxLength={60} placeholder="z. B. Betriebsurlaub" value={newFree.name} onChange={(ev) => setNewFree({ ...newFree, name: ev.target.value })} onKeyDown={(ev) => ev.key === "Enter" && addFreeDays()} style={{ width: 200 }} />
            </label>
            <button type="button" className="btn" onClick={addFreeDays} disabled={!canAddFree}>
              Hinzufügen
            </button>
            {freeFromOk && freeToOk && freeSpan > 120 && <span style={{ fontSize: 12, color: "var(--bad)" }}>Höchstens 120 Tage auf einmal</span>}
            {freeFromOk && freeToOk && freeSpan < 1 && <span style={{ fontSize: 12, color: "var(--bad)" }}>„Bis“ liegt vor „Von“</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "0 18px" }}>
            {upcomingFree.map((d) => (
              <div key={d.date} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
                <span className="mono" style={{ width: 92, color: "var(--muted)" }}>
                  {wd(d.date)} {fmtShort(d.date)}
                  {d.date.slice(2, 4)}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.name}>
                  {d.name}
                </span>
                <button type="button" className="btn icon quiet" title={`${d.name} entfernen`} aria-label={`${d.name} entfernen`} onClick={() => removeFreeDay(d.date)}>
                  <Ico n="x" s={14} />
                </button>
              </div>
            ))}
            {upcomingFree.length === 0 && <div style={{ fontSize: 13, color: "var(--muted)" }}>Keine freien Tage in der Zukunft.</div>}
          </div>
        </div>
      </div>
    </div>
  );

  const header = new Date(`${today}T00:00:00Z`);
  const dayName = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"][header.getUTCDay()];

  return (
    <>
      <div className="page-head rise" style={{ "--i": 0 }}>
        <div>
          <h1>Produktionsplanung</h1>
          <p>
            {dayName}, {fmtShort(today)}
            {today.slice(0, 4)} · KW {isoWeekOf(today).week} · {shift.label}, {fmtH(shift.hours)} h pro Woche × {utilization} % Nutzung
          </p>
        </div>
        <div className="actions">
          {odooStatus && odooStatus.enabled && (
            <button className="sync" type="button" onClick={openSync} title="Jetzt mit Odoo abgleichen">
              <span className={"ok" + (odooStatus.lastError ? " err" : "")} />
              {odooStatus.lastSync ? "Odoo · vor " + (Math.max(0, Math.round((Date.now() - Date.parse(odooStatus.lastSync)) / 60000)) || "<1") + " Min." : "Odoo abgleichen"}
              {odooStatus.pendingClosing && odooStatus.pendingClosing.length > 0 && <b className="tag warn" style={{ fontStyle: "normal" }}>{odooStatus.pendingClosing.length} zu schließen</b>}
              <Ico n="refresh" s={15} />
            </button>
          )}
          <input ref={fileInput} type="file" accept=".xlsx" onChange={onImportFile} style={{ display: "none" }} />
          <button className="btn" type="button" onClick={() => fileInput.current.click()} title="Reserve: Fertigungsaufträge aus einer Excel-Datei aus Odoo importieren">
            <Ico n="down" s={16} />
            Aus Excel importieren
          </button>
        </div>
      </div>

      {preview && (
        <div className="note warn rise" style={{ "--i": 1 }}>
          <b>
            Vorschau, nicht gespeichert: ab KW {isoWeekOf(preview.date).week} ({fmtShort(preview.date)}) {SHIFT_MODELS.find((s) => s.hours === preview.hours)?.label ?? "Eigener Wert"} · {fmtH(preview.hours)} h
          </b>
          {previewStats && (
            <div style={{ marginTop: 4 }}>
              Aufträge, die den Liefertermin verfehlen: <b>{previewStats.before.late}</b> → <b>{previewStats.after.late}</b> · Verspätung zusammen: <b>{previewStats.before.days}</b> → <b>{previewStats.after.days}</b> Tage
            </div>
          )}
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn sm primary" onClick={() => { onSaveShift(preview.date, preview.hours); setPreview(null); }}>
              Übernehmen
            </button>
            <button type="button" className="btn sm" onClick={() => setPreview(null)}>
              Verwerfen
            </button>
          </div>
        </div>
      )}

      <div className="card stats rise" style={{ "--i": 1 }}>
        <button className={`stat${hl === "late" ? " active" : ""}`} type="button" onClick={() => { setHl(hl === "late" ? null : "late"); setHlSel(null); setTab("zeit"); }}>
          <span className="k"><i className="dot" style={{ "--c": "var(--bad)" }} /><span>Liefertermin gefährdet</span></span>
          <b><span>{warnings.length}</span> {warnings.length === 1 ? "Auftrag" : "Aufträge"}</b>
        </button>
        <button className={`stat${hl === "pool" ? " active" : ""}`} type="button" onClick={() => { setHl(hl === "pool" ? null : "pool"); setHlSel(null); setTab("zeit"); }}>
          <span className="k"><i className="dot" style={{ "--c": "var(--faint)" }} /><span>Noch keine Maschine</span></span>
          <b><span>{poolOrders.length}</span> Positionen</b>
        </button>
        <button className={`stat${hl === "soon" ? " active" : ""}`} type="button" onClick={() => { setHl(hl === "soon" ? null : "soon"); setHlSel(null); setTab("zeit"); }}>
          <span className="k"><i className="dot" style={{ "--c": "var(--warn)" }} /><span>Starten bald, nicht bereit</span></span>
          <b><span>{urgentIds.size}</span> Positionen</b>
        </button>
        <div className="stat">
          <span className="k"><i className="dot" style={{ "--c": "var(--ok)" }} /><span>Nächste freie Maschine</span></span>
          <b>{nextFree ? `${nextFree.m.short} ${nextFree.at <= todayOff ? "jetzt frei" : `ab ${fmtShort(dateOf(nextFree.at))}`}` : "–"}</b>
        </div>
      </div>

      <div className="tabs rise" style={{ "--i": 2 }}>
        <button type="button" className={tab === "zeit" ? "on" : ""} onClick={() => setTab("zeit")}>
          Zeitstrahl
        </button>
        <button type="button" className={tab === "auf" ? "on" : ""} onClick={() => setTab("auf")}>
          Aufträge<span className="cnt">{groups.length}</span>
        </button>
        <button type="button" className={tab === "einst" ? "on" : ""} onClick={() => setTab("einst")}>
          Einstellungen
        </button>
      </div>

      {tab === "zeit" && (
        <>
          <div className="rise" style={{ "--i": 3 }}>{timeline}</div>
          <div className="rise" style={{ "--i": 4 }}>{poolCard}</div>
          <div className="rise" style={{ "--i": 5 }}>{boardCard}</div>
        </>
      )}
      {tab === "auf" && <div className="rise" style={{ "--i": 3 }}>{ordersCard}</div>}
      {tab === "einst" && <div className="rise" style={{ "--i": 3 }}>{settings}</div>}

      {draggedBar && (
        <div className="ghost" style={{ left: draggedBar.x - draggedBar.offX, top: draggedBar.y - draggedBar.offY, width: draggedBar.w, height: draggedBar.h }}>
          <b>{draggedBar.label}</b>
          <span>{draggedBar.sub}</span>
        </div>
      )}
      {layer}
    </>
  );
}
