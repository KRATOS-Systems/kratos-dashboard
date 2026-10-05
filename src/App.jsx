import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceArea,
  Tooltip,
} from "recharts";
import { THEMES } from "./theme.js";
import {
  DEFAULT_WEEK_CAPACITY,
  MACHINES,
  SHIFT_MODELS,
  addDays,
  daysBetween,
  fmtH,
  fmtShort,
  makeStyles,
  mondayOf,
  todayStr,
  weekInfo,
} from "./lib.js";
import Planning from "./Planning.jsx";
import logoLight from "./assets/logo-light.png";
import logoDark from "./assets/logo-dark.png";

const THEME_STORAGE_KEY = "kratos-dashboard-theme";

// Die Planung ist die erste Seite und öffnet beim Start
const PAGES = [
  { id: "planung", label: "Produktionsplanung" },
  { id: "dashboard", label: "Produktionsdashboard" },
];
const readPage = () => (window.location.hash === "#dashboard" ? "dashboard" : "planung");

const TREND_WEEKS = 8;

function pct(part, whole) {
  if (!whole) return 0;
  return part / whole;
}

// Ampel für die Kapazitätsauslastung (gerundet wie angezeigt): 80-100 % grün (im Soll), 65-79 % und 101-110 % gelb,
// darunter bzw. darüber rot. Über 100 % heißt: länger gelaufen als die Betriebszeit des Schichtmodells.
const utilColor = (theme, v) => {
  const p = Math.round(v * 100);
  if (p >= 80 && p <= 100) return theme.green;
  if ((p >= 65 && p < 80) || (p > 100 && p <= 110)) return theme.amber;
  return theme.red;
};

// Ampel für die Spindelquote (gerundet wie angezeigt): ab 70 % grün, 55-69 % gelb, darunter rot
const spindleColor = (theme, v) => {
  const p = Math.round(v * 100);
  return p >= 70 ? theme.green : p >= 55 ? theme.amber : theme.red;
};

function fmtPct(x) {
  return `${Math.round(x * 100)}`;
}

function initialMode() {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Wochenstunden = Differenz zweier aufeinanderfolgender Zählerstände. Die
// Stunden gehören zu der Kalenderwoche, in der sie gearbeitet wurden (Ablesung
// vom 28.9. = Stunden von KW 39, 21.-27.9.). Fehlt eine Ablesung, wird
// die Differenz gleichmäßig auf die Wochen dazwischen verteilt.
function computeWeekly(readings) {
  const result = {};
  MACHINES.forEach((m) => {
    const list = readings
      .filter((r) => r.machine === m.id)
      .sort((a, b) => a.date.localeCompare(b.date));

    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const next = list[i];
      const weeks = Math.max(1, Math.round(daysBetween(prev.date, next.date) / 7));
      const diff = (a, b) => (a == null || b == null || b < a ? null : (b - a) / weeks);
      const on = diff(prev.machine_total, next.machine_total);
      const spindle = diff(prev.spindle_total, next.spindle_total);
      if (on == null && spindle == null) continue;

      for (let k = 0; k < weeks; k++) {
        const info = weekInfo(mondayOf(addDays(next.date, -7 * (k + 1))));
        const entry = result[info.key] || (result[info.key] = { ...info, machines: {} });
        entry.machines[m.id] = { on, spindle, spread: weeks > 1, from: prev.date, to: next.date };
      }
    }
  });
  return result;
}

// Kapazität einer Woche: Schichtmodell wählen oder die Stunden von Hand eintragen
function CapacityPicker({ value, onChange, theme, mode, label = "Kapazität" }) {
  const { eyebrow, mono } = makeStyles(theme);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={eyebrow}>{label}</span>
      {SHIFT_MODELS.map((s) => {
        const active = value === s.hours;
        return (
          <button
            key={s.label}
            onClick={() => onChange(s.hours)}
            title={`${s.label}: ${s.hours} h pro Woche`}
            style={{
              ...eyebrow,
              fontSize: 10,
              padding: "5px 9px",
              borderRadius: 6,
              cursor: "pointer",
              border: `1px solid ${active ? theme.ink : theme.line}`,
              background: active ? theme.ink : "transparent",
              color: active ? theme.bg : theme.steel,
            }}
          >
            {s.label} · {s.hours} h
          </button>
        );
      })}
      <input
        type="number"
        min={0}
        max={168}
        value={value}
        onChange={(ev) => ev.target.value !== "" && onChange(Math.min(168, Math.max(0, Number(ev.target.value))))}
        title="Stunden pro Woche von Hand eintragen, z. B. bei einem Feiertag"
        style={{
          ...mono,
          width: 52,
          fontSize: 12,
          textAlign: "center",
          color: theme.ink,
          background: "transparent",
          border: "none",
          borderBottom: `1px solid ${theme.line}`,
          outline: "none",
          colorScheme: mode,
        }}
      />
      <span style={eyebrow}>h pro Woche</span>
    </div>
  );
}

// Instrumenten Anzeige, Halbkreis Gauge für die Spindelquote
function Gauge({ value, color, theme }) {
  const size = 132;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = Math.PI * r; // Halbkreis
  const clamped = Math.max(0, Math.min(1, value));
  const arc = clamped * circ;

  return (
    <div style={{ position: "relative", width: size, height: size / 2 + 18 }}>
      <svg width={size} height={size / 2 + 18} viewBox={`0 0 ${size} ${size / 2 + 18}`}>
        <path
          d={`M ${stroke / 2} ${cy} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${cy}`}
          fill="none"
          stroke={theme.line}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <path
          d={`M ${stroke / 2} ${cy} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${cy}`}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circ}`}
          style={{ transition: "stroke-dasharray 0.5s ease" }}
        />
      </svg>
      <div style={{ position: "absolute", top: 20, left: 0, right: 0, textAlign: "center" }}>
        <div
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 34,
            fontWeight: 600,
            color: theme.ink,
            lineHeight: 1,
          }}
        >
          {fmtPct(value)}
          <span style={{ fontSize: 16, color: theme.steel }}> %</span>
        </div>
      </div>
    </div>
  );
}

function Bar({ value, color, theme }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div style={{ height: 8, background: theme.line, borderRadius: 4, overflow: "hidden" }}>
      <div
        style={{
          width: `${clamped * 100}%`,
          height: "100%",
          background: color,
          transition: "width 0.5s ease",
        }}
      />
    </div>
  );
}

// Sonne und Mond Symbol für den Dark Mode Umschalter
function ThemeIcon({ mode }) {
  if (mode === "dark") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="12" y1="1.5" x2="12" y2="4" />
        <line x1="12" y1="20" x2="12" y2="22.5" />
        <line x1="1.5" y1="12" x2="4" y2="12" />
        <line x1="20" y1="12" x2="22.5" y2="12" />
        <line x1="4.2" y1="4.2" x2="6" y2="6" />
        <line x1="18" y1="18" x2="19.8" y2="19.8" />
        <line x1="4.2" y1="19.8" x2="6" y2="18" />
        <line x1="18" y1="6" x2="19.8" y2="4.2" />
      </g>
    </svg>
  );
}

export default function Dashboard() {
  const [mode, setMode] = useState(initialMode);
  const theme = THEMES[mode];

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  }, [mode]);

  const [page, setPage] = useState(readPage);
  useEffect(() => {
    const onHash = () => setPage(readPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    document.title = `Kratos ${PAGES.find((p) => p.id === page).label}`;
  }, [page]);
  const goTo = (id) => {
    window.location.hash = id;
  };

  const today = useMemo(() => todayStr(), []);
  const [loading, setLoading] = useState(true);
  const [readings, setReadings] = useState([]);
  const [restore, setRestore] = useState(null); // { backup, counts, created } oder { error }
  const [freeDays, setFreeDays] = useState([]); // arbeitsfreie Tage (Feiertage, Betriebsurlaub) aus der Planung
  const [weekCap, setWeekCap] = useState({}); // Schichtmodell (Stunden) je Woche. Schlüssel = Montag der Ablesung, ab dem es für die KOMMENDE Woche gilt
  const [trendMetric, setTrendMetric] = useState("spindle"); // spindle | beleg
  const [pickedWeek, setPickedWeek] = useState(null);
  const [showEntry, setShowEntry] = useState(false);
  const [entryDate, setEntryDate] = useState(() => mondayOf(todayStr()));

  useEffect(() => {
    async function load() {
      const [readingsRes, capRes] = await Promise.all([
        fetch("/api/readings").then((r) => r.json()),
        fetch("/api/week-capacity").then((r) => r.json()),
      ]);
      setReadings(readingsRes.readings);
      setWeekCap(capRes.capacities);
      setLoading(false);
    }
    load();
  }, []);

  useEffect(() => {
    if (page !== "dashboard") return;
    fetch("/api/free-days")
      .then((r) => r.json())
      .then((d) => setFreeDays(d.days || []))
      .catch(() => {});
  }, [page]);

  const weekly = useMemo(() => computeWeekly(readings), [readings]);
  const weekOptions = useMemo(
    () => Object.values(weekly).sort((a, b) => b.monday.localeCompare(a.monday)),
    [weekly]
  );
  const selectedKey = weekly[pickedWeek] ? pickedWeek : weekOptions[0]?.key;
  const selected = selectedKey ? weekly[selectedKey] : undefined;
  const period = selected ? Object.values(selected.machines)[0] : undefined;

  const entryValid = /^\d{4}-\d{2}-\d{2}$/.test(entryDate) && !Number.isNaN(Date.parse(entryDate));
  const readingFor = (machineId, date) =>
    readings.find((r) => r.date === date && r.machine === machineId);
  const previousReading = (machineId) =>
    readings
      .filter((r) => r.machine === machineId && r.date < entryDate)
      .sort((a, b) => b.date.localeCompare(a.date))[0];

  function updateReading(machineId, field, raw) {
    if (!entryValid) return;
    // Das Schichtmodell der kommenden Woche wird mit der ersten Eingabe festgeschrieben (Vorbelegung: Vorwoche)
    if (weekCap[entryDate] === undefined) saveCapacity(entryDate, capPrefill(entryDate));
    const cur = readingFor(machineId, entryDate) || { machine_total: null, spindle_total: null };
    const next = { ...cur, [field]: raw === "" ? null : Math.max(0, Number(raw)) };

    setReadings((prev) => {
      const rest = prev.filter((r) => !(r.date === entryDate && r.machine === machineId));
      if (next.machine_total == null && next.spindle_total == null) return rest;
      return [
        ...rest,
        {
          date: entryDate,
          machine: machineId,
          machine_total: next.machine_total,
          spindle_total: next.spindle_total,
        },
      ];
    });

    fetch("/api/readings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: entryDate,
        machine: machineId,
        machine_total: next.machine_total,
        spindle_total: next.spindle_total,
      }),
    }).catch((err) => console.error("Speichern fehlgeschlagen", err));
  }

  // Schichtmodell (Stunden pro Woche) der Woche, die mit der Ablesung `date` beginnt
  const modelOf = (date) => weekCap[date] ?? DEFAULT_WEEK_CAPACITY;
  // Arbeitstage (Mo-Sa) der Woche ab `date`, die auf einen freien Tag fallen
  const freeDates = useMemo(() => new Set(freeDays.map((d) => d.date)), [freeDays]);
  const lostDays = (date) => {
    let n = 0;
    for (let k = 0; k < 7; k++) {
      const d = addDays(date, k);
      if (freeDates.has(d) && new Date(d + "T00:00:00Z").getUTCDay() !== 0) n++;
    }
    return n;
  };
  // Die Stunden einer Woche (Ablesung A bis B) gehören zum Modell, das bei A für die kommende Woche eingetragen wurde;
  // jeder freie Arbeitstag kürzt die Kapazität um 1/6
  const capOf = (date) => (modelOf(date) * (6 - lostDays(date))) / 6;
  // Vorbelegung für eine neue Woche: der zuletzt eingetragene Wert davor
  const capPrefill = (date) => {
    const before = Object.keys(weekCap)
      .filter((d) => d < date)
      .sort()
      .pop();
    return weekCap[date] ?? (before ? weekCap[before] : DEFAULT_WEEK_CAPACITY);
  };

  // Schichtmodell der laufenden Woche: der zuletzt eingetragene Wert bis heute (gilt, bis ein neuer eingetragen wird)
  const shiftNow = (() => {
    const last = Object.keys(weekCap)
      .filter((d) => d <= today)
      .sort()
      .pop();
    const hours = last ? weekCap[last] : DEFAULT_WEEK_CAPACITY;
    const model = SHIFT_MODELS.find((s) => s.hours === hours);
    return { hours, label: model ? model.label : "Eigener Wert" };
  })();

  // Backup einspielen: Datei lesen, Inhalt prüfen und zählen, erst nach Bestätigung ersetzen
  async function onRestoreFile(ev) {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const res = await fetch("/api/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup, dryRun: true }),
      });
      const data = await res.json();
      setRestore(res.ok ? { backup, counts: data.counts, created: data.created, name: file.name } : { error: data.error });
    } catch {
      setRestore({ error: "Die Datei konnte nicht gelesen werden" });
    }
  }

  async function doRestore() {
    const res = await fetch("/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backup: restore.backup }),
    });
    const data = await res.json();
    if (res.ok) window.location.reload();
    else setRestore({ error: data.error });
  }

  function deleteCapacity(date) {
    setWeekCap((c) => {
      const next = { ...c };
      delete next[date];
      return next;
    });
    fetch(`/api/week-capacity/${date}`, { method: "DELETE" }).catch((err) => console.error("Löschen fehlgeschlagen", err));
  }

  function saveCapacity(date, hours) {
    setWeekCap((c) => ({ ...c, [date]: hours }));
    fetch("/api/week-capacity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, capacity_hours: hours }),
    }).catch((err) => console.error("Speichern fehlgeschlagen", err));
  }

  // Summen der ausgewählten Woche
  const totals = useMemo(() => {
    let on = 0;
    let spindle = 0;
    let cap = 0;
    MACHINES.forEach((m) => {
      const e = selected?.machines[m.id];
      on += e?.on ?? 0;
      spindle += e?.spindle ?? 0;
      cap += e ? capOf(e.from) : 0;
    });
    return { on, spindle, cap };
  }, [selected, weekCap, freeDates]);

  // Trenddaten: die letzten Wochen bis zur aktuellen, fehlende Werte als Lücke
  const trend = useMemo(() => {
    const lastMonday = addDays(mondayOf(today), -7); // die zuletzt abgeschlossene Woche
    const rows = [];
    for (let i = TREND_WEEKS - 1; i >= 0; i--) {
      const info = weekInfo(addDays(lastMonday, -7 * i));
      const row = { week: info.label };
      MACHINES.forEach((m) => {
        const e = weekly[info.key]?.machines[m.id];
        let val = null;
        if (e) {
          if (trendMetric === "spindle") {
            val = e.on && e.spindle != null ? e.spindle / e.on : null;
          } else {
            val = e.on != null && capOf(e.from) ? e.on / capOf(e.from) : null;
          }
        }
        row[m.id] = val == null ? null : Math.round(val * 100);
      });
      rows.push(row);
    }
    return rows;
  }, [weekly, weekCap, freeDates, trendMetric, today]);

  const { eyebrow, mono } = makeStyles(theme);

  const inputStyle = {
    ...mono,
    width: "100%",
    boxSizing: "border-box",
    border: `1px solid ${theme.line}`,
    borderRadius: 6,
    padding: "6px 8px",
    fontSize: 15,
    fontWeight: 600,
    color: theme.ink,
    background: theme.panel,
    outline: "none",
  };

  if (loading) {
    return (
      <div style={{ background: theme.bg, minHeight: "100%", padding: 28, color: theme.ink }}>
        <span style={eyebrow}>Lädt…</span>
      </div>
    );
  }

  const anySpread = selected && Object.values(selected.machines).some((e) => e.spread);

  return (
    <div
      style={{
        background: theme.bg,
        minHeight: "100%",
        padding: "28px 24px 48px",
        color: theme.ink,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        transition: "background-color 0.25s ease, color 0.25s ease",
      }}
    >
      <style>{`
        * { transition: background-color 0.25s ease, border-color 0.25s ease, color 0.25s ease; }
      `}</style>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        {/* Kopf */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
            borderBottom: `2px solid ${theme.ink}`,
            paddingBottom: 16,
            marginBottom: 28,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap" }}>
            <img
              src={mode === "dark" ? logoDark : logoLight}
              alt="Kratos"
              style={{ height: 22, width: "auto", display: "block" }}
            />
            <nav style={{ display: "flex", gap: 20 }}>
              {PAGES.map((p) => {
                const active = page === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => goTo(p.id)}
                    style={{
                      ...eyebrow,
                      fontSize: 11,
                      color: active ? theme.ink : theme.steel,
                      background: "none",
                      border: "none",
                      borderBottom: `2px solid ${active ? theme.red : "transparent"}`,
                      padding: "6px 0",
                      cursor: "pointer",
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </nav>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {page === "dashboard" && (
              <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ ...eyebrow, fontSize: 11 }}>Auswertung</span>
              <select
                value={selectedKey || ""}
                onChange={(ev) => setPickedWeek(ev.target.value)}
                disabled={!weekOptions.length}
                style={{
                  ...mono,
                  fontSize: 13,
                  fontWeight: 600,
                  color: theme.red,
                  background: theme.panel,
                  border: `1px solid ${theme.line}`,
                  borderRadius: 6,
                  padding: "5px 8px",
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                {!weekOptions.length && <option value="">Keine Daten</option>}
                {weekOptions.map((w) => (
                  <option key={w.key} value={w.key}>
                    {w.label} ({fmtShort(Object.values(w.machines)[0].from)} – {fmtShort(addDays(Object.values(w.machines)[0].to, -1))}, Ablesung {fmtShort(Object.values(w.machines)[0].to)})
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() => setShowEntry((v) => !v)}
              style={{
                ...eyebrow,
                fontSize: 11,
                padding: "7px 12px",
                borderRadius: 6,
                border: `1px solid ${theme.ink}`,
                background: showEntry ? theme.ink : theme.panel,
                color: showEntry ? theme.bg : theme.ink,
                cursor: "pointer",
              }}
            >
              Zählerstände eintragen
            </button>
              </>
            )}
            <button
              onClick={() => setMode((m) => (m === "dark" ? "light" : "dark"))}
              aria-label="Dark Mode umschalten"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 30,
                height: 30,
                borderRadius: "50%",
                border: `1px solid ${theme.line}`,
                background: theme.panel,
                color: theme.ink,
                cursor: "pointer",
              }}
            >
              <ThemeIcon mode={mode} />
            </button>
          </div>
        </div>

        {page === "planung" && <Planning theme={theme} mode={mode} shift={shiftNow} weekCap={weekCap} onSaveShift={saveCapacity} onDeleteShift={deleteCapacity} />}

        {page === "dashboard" && (
        <>
        {/* Zählerstände erfassen */}
        {showEntry && (
          <div
            style={{
              background: theme.panel,
              border: `1px solid ${theme.line}`,
              borderRadius: 10,
              padding: 20,
              marginBottom: 28,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
                marginBottom: 16,
              }}
            >
              <div>
                <div style={eyebrow}>Montags eintragen</div>
                <div style={{ fontWeight: 700, fontSize: 15, marginTop: 2 }}>
                  Gesamtzählerstände der Maschinen
                </div>
              </div>
              <label>
                <div style={eyebrow}>Datum der Ablesung</div>
                <input
                  type="date"
                  value={entryDate}
                  onChange={(ev) => setEntryDate(ev.target.value)}
                  style={{ ...inputStyle, width: 160, marginTop: 4, colorScheme: mode }}
                />
                {entryValid && mondayOf(entryDate) !== entryDate && (
                  <div style={{ ...eyebrow, fontSize: 10, marginTop: 4 }}>Kein Montag</div>
                )}
              </label>
            </div>

            {entryValid && (
              <div style={{ marginBottom: 16 }}>
                <CapacityPicker
                  value={capPrefill(entryDate)}
                  onChange={(h) => saveCapacity(entryDate, h)}
                  label={`Schichtmodell für ${weekInfo(mondayOf(addDays(entryDate, 3))).label} (${fmtShort(entryDate)} bis ${fmtShort(addDays(entryDate, 6))})`}
                  theme={theme}
                  mode={mode}
                />
              </div>
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: 16,
              }}
            >
              {MACHINES.map((m) => {
                const cur = readingFor(m.id, entryDate);
                const prev = entryValid ? previousReading(m.id) : undefined;
                const dOn =
                  prev && cur && prev.machine_total != null && cur.machine_total != null
                    ? cur.machine_total - prev.machine_total
                    : null;
                const dSp =
                  prev && cur && prev.spindle_total != null && cur.spindle_total != null
                    ? cur.spindle_total - prev.spindle_total
                    : null;
                const negative = (dOn != null && dOn < 0) || (dSp != null && dSp < 0);
                // Mehr Stunden, als der Zeitraum seit der letzten Ablesung hat, ist unmöglich; Spindel über Maschine an ist auffällig
                const hoursAvailable = prev && entryValid ? daysBetween(prev.date, entryDate) * 24 : null;
                const tooMuch = hoursAvailable != null && ((dOn != null && dOn > hoursAvailable) || (dSp != null && dSp > hoursAvailable));
                const spindleOver = dOn != null && dSp != null && dSp > dOn && dOn >= 0;
                return (
                  <div
                    key={m.id}
                    style={{
                      border: `1px solid ${theme.line}`,
                      borderRadius: 8,
                      padding: 14,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>{m.name}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <label>
                        <span style={eyebrow}>Maschine an</span>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          disabled={!entryValid}
                          value={cur?.machine_total ?? ""}
                          onChange={(ev) => updateReading(m.id, "machine_total", ev.target.value)}
                          style={{ ...inputStyle, marginTop: 4 }}
                        />
                      </label>
                      <label>
                        <span style={eyebrow}>Spindel</span>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          disabled={!entryValid}
                          value={cur?.spindle_total ?? ""}
                          onChange={(ev) => updateReading(m.id, "spindle_total", ev.target.value)}
                          style={{ ...inputStyle, marginTop: 4, color: theme.red }}
                        />
                      </label>
                    </div>
                    <div style={{ fontSize: 12, color: theme.steel, marginTop: 10, lineHeight: 1.5 }}>
                      {prev ? (
                        <>
                          Vorherige Ablesung {fmtShort(prev.date)}:{" "}
                          <span style={mono}>
                            {fmtH(prev.machine_total)} / {fmtH(prev.spindle_total)}
                          </span>
                          {(dOn != null || dSp != null) && (
                            <div style={{ color: negative ? theme.red : theme.ink, fontWeight: 600 }}>
                              Seitdem: Maschine {dOn != null ? `${dOn >= 0 ? "+" : ""}${fmtH(dOn)} h` : "–"}{" "}
                              · Spindel {dSp != null ? `${dSp >= 0 ? "+" : ""}${fmtH(dSp)} h` : "–"}
                              {negative && " (kleiner als zuvor, bitte prüfen)"}
                            </div>
                          )}
                          {tooMuch && (
                            <div style={{ color: theme.red, fontWeight: 600 }}>
                              Mehr Stunden, als seit {fmtShort(prev.date)} vergangen sind (höchstens {fmtH(hoursAvailable)} h). Zahlendreher?
                            </div>
                          )}
                          {spindleOver && !tooMuch && (
                            <div style={{ color: theme.amber, fontWeight: 600 }}>
                              Spindelstunden größer als „Maschine an“, bitte prüfen (Ablesezeitpunkt?)
                            </div>
                          )}
                        </>
                      ) : (
                        "Keine frühere Ablesung vorhanden."
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!selected && (
          <div
            style={{
              background: theme.panel,
              border: `1px solid ${theme.line}`,
              borderRadius: 10,
              padding: 16,
              marginBottom: 20,
              fontSize: 13,
              color: theme.steel,
            }}
          >
            Noch keine Auswertung. Für eine Woche werden zwei aufeinanderfolgende Ablesungen
            benötigt. Trage sie über „Zählerstände eintragen“ ein.
          </div>
        )}

        {anySpread && (
          <div style={{ ...eyebrow, marginBottom: 12 }}>
            Mindestens eine Ablesung fehlt: Die Werte sind gleichmäßig auf die Wochen dazwischen
            verteilt.
          </div>
        )}
        {period && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={eyebrow}>
              {anySpread ? "" : `Stunden von ${fmtShort(period.from)} bis ${fmtShort(period.to)}`}
            </div>
            <CapacityPicker
              value={modelOf(period.from)}
              onChange={(h) => saveCapacity(period.from, h)}
              label={`Kapazität ${selected.label} (${fmtShort(period.from)} bis ${fmtShort(addDays(period.to, -1))})`}
              theme={theme}
              mode={mode}
            />
          </div>
        )}

        {/* Maschinenkarten */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 16,
            marginBottom: 28,
          }}
        >
          {MACHINES.map((m) => {
            const e = selected?.machines[m.id] || { on: null, spindle: null };
            const color = theme[m.colorKey];
            const spindelquote = pct(e.spindle, e.on);
            const belegung = pct(e.on, e.from ? capOf(e.from) : DEFAULT_WEEK_CAPACITY);
            return (
              <div
                key={m.id}
                style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 20 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color }}>{m.name}</div>
                    <div style={eyebrow}>Spindelauslastung</div>
                  </div>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: color, marginTop: 4 }} />
                </div>

                <div style={{ display: "flex", justifyContent: "center", margin: "4px 0 14px" }}>
                  <Gauge value={spindelquote} color={spindleColor(theme, spindelquote)} theme={theme} />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={eyebrow}>Kapazitätsauslastung</span>
                    <span style={{ ...mono, fontSize: 13, fontWeight: 600 }}>{fmtPct(belegung)} %</span>
                  </div>
                  <Bar value={belegung} color={utilColor(theme, belegung)} theme={theme} />
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 10,
                    borderTop: `1px solid ${theme.line}`,
                    paddingTop: 12,
                  }}
                >
                  <div>
                    <span style={eyebrow}>Maschine an</span>
                    <div style={{ ...mono, fontSize: 18, fontWeight: 600, marginTop: 4 }}>
                      {fmtH(e.on)} <span style={{ ...eyebrow, fontSize: 11 }}>h</span>
                    </div>
                  </div>
                  <div>
                    <span style={eyebrow}>Spindelstunden</span>
                    <div style={{ ...mono, fontSize: 18, fontWeight: 600, marginTop: 4 }}>
                      {fmtH(e.spindle)} <span style={{ ...eyebrow, fontSize: 11 }}>h</span>
                    </div>
                  </div>
                </div>

                <div style={{ ...eyebrow, fontSize: 10, marginTop: 10, color: theme.steel }}>
                  Kapazität {fmtH(e.from ? capOf(e.from) : DEFAULT_WEEK_CAPACITY)} h in dieser Woche
                  {e.from && lostDays(e.from) > 0
                    ? ` (${lostDays(e.from)} freier Tag${lostDays(e.from) > 1 ? "e" : ""} abgezogen)`
                    : ""}
                </div>
              </div>
            );
          })}
        </div>

        {/* Legende Spindelauslastung */}
        <div style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 18, marginTop: -12, marginBottom: 12 }}>
          <div style={eyebrow}>Spindelauslastung: Bewertung</div>
          <div style={{ fontSize: 12, color: theme.steel, margin: "6px 0 12px" }}>
            Spindelstunden im Verhältnis zur Zeit „Maschine an“
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
            {[
              { color: theme.green, range: "ab 70 %", text: "Soll-Bereich erreicht" },
              {
                color: theme.amber,
                range: "55 – 69 %",
                text: "Akzeptabel für Einzelteil-Schichten, bei Serien-Schichten im Beobachtungsbereich",
              },
              {
                color: theme.red,
                range: "unter 55 %",
                text: "Handlungsbedarf, Stillstandsgründe erfassen",
              },
            ].map((l) => (
              <div key={l.range} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: l.color, marginTop: 3, flexShrink: 0 }} />
                <div>
                  <div style={{ ...mono, fontSize: 13, fontWeight: 600 }}>{l.range}</div>
                  <div style={{ fontSize: 12, color: theme.steel, marginTop: 2 }}>{l.text}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Legende Kapazitätsauslastung */}
        <div style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 18, marginBottom: 20 }}>
          <div style={eyebrow}>Kapazitätsauslastung: Bewertung</div>
          <div style={{ fontSize: 12, color: theme.steel, margin: "6px 0 12px" }}>
            Zeit „Maschine an“ im Verhältnis zur Kapazität der Woche (Schichtmodell)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
            {[
              { color: theme.red, range: "unter 65 %", text: "Deutlich unter Plan, Ursache prüfen (Stillstand, fehlende Aufträge)" },
              { color: theme.amber, range: "65 – 79 %", text: "Unter der Planungsannahme von 80 %, die Planung wird zu optimistisch" },
              { color: theme.green, range: "80 – 100 %", text: "Im Soll" },
              { color: theme.amber, range: "101 – 110 %", text: "Überlast: länger gelaufen als geplant, keine Reserve" },
              { color: theme.red, range: "über 110 %", text: "Deutlich über der Betriebszeit: Mehrarbeit oder falsches Schichtmodell eingetragen" },
            ].map((l) => (
              <div key={l.range} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: l.color, marginTop: 3, flexShrink: 0 }} />
                <div>
                  <div style={{ ...mono, fontSize: 13, fontWeight: 600 }}>{l.range}</div>
                  <div style={{ fontSize: 12, color: theme.steel, marginTop: 2 }}>{l.text}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Trend */}
        <div style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 20, marginBottom: 20 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 18,
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <div>
              <div style={eyebrow}>Verlauf {TREND_WEEKS} Wochen</div>
              <div style={{ fontWeight: 700, fontSize: 15, marginTop: 2 }}>
                {trendMetric === "spindle" ? "Spindelauslastung je Maschine" : "Kapazitätsauslastung je Maschine"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {[
                { key: "spindle", label: "Spindelauslastung" },
                { key: "beleg", label: "Kapazitätsauslastung" },
              ].map((opt) => {
                const active = trendMetric === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => setTrendMetric(opt.key)}
                    style={{
                      ...eyebrow,
                      fontSize: 11,
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: `1px solid ${active ? theme.ink : theme.line}`,
                      background: active ? theme.ink : theme.panel,
                      color: active ? theme.bg : theme.steel,
                      cursor: "pointer",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke={theme.line} vertical={false} />
                <XAxis dataKey="week" tick={{ fontSize: 11, fill: theme.steel }} axisLine={{ stroke: theme.line }} tickLine={false} />
                <YAxis
                  domain={[0, (dataMax) => Math.max(trendMetric === "beleg" ? 120 : 100, Math.ceil(dataMax / 20) * 20)]}
                  tick={{ fontSize: 11, fill: theme.steel }}
                  axisLine={false}
                  tickLine={false}
                  unit="%"
                />
                {/* Bewertungsbereiche wie in den Legenden, dezent hinterlegt */}
                {(trendMetric === "beleg"
                  ? [
                      [0, 64.5, theme.red],
                      [64.5, 79.5, theme.amber],
                      [79.5, 100.5, theme.green],
                      [100.5, 110.5, theme.amber],
                      [110.5, 400, theme.red],
                    ]
                  : [
                      [0, 54.5, theme.red],
                      [54.5, 69.5, theme.amber],
                      [69.5, 400, theme.green],
                    ]
                ).map(([y1, y2, fill]) => (
                  <ReferenceArea key={`${trendMetric}-${y1}`} y1={y1} y2={y2} fill={fill} fillOpacity={0.09} stroke="none" ifOverflow="hidden" />
                ))}
                <Tooltip
                  formatter={(v, name) => {
                    const m = MACHINES.find((x) => x.id === name);
                    return [`${v} %`, m ? m.short : name];
                  }}
                  contentStyle={{
                    border: `1px solid ${theme.line}`,
                    borderRadius: 8,
                    fontSize: 12,
                    background: theme.panel,
                    color: theme.ink,
                  }}
                />
                {MACHINES.map((m) => (
                  <Line
                    key={m.id}
                    type="monotone"
                    dataKey={m.id}
                    stroke={theme[m.colorKey]}
                    strokeWidth={2}
                    dot={{ r: 3, fill: theme[m.colorKey] }}
                    activeDot={{ r: 5 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div style={{ display: "flex", gap: 18, marginTop: 8, flexWrap: "wrap" }}>
            {MACHINES.map((m) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 14, height: 3, background: theme[m.colorKey], borderRadius: 2 }} />
                <span style={{ fontSize: 12, color: theme.steel }}>{m.short}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Wochenzusammenfassung */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
          {[
            {
              label: "Kapazitätsauslastung gesamt",
              value: `${fmtPct(pct(totals.on, totals.cap))} %`,
              sub: `${fmtH(totals.on)} von ${fmtH(totals.cap)} h`,
              color: utilColor(theme, pct(totals.on, totals.cap)),
            },
            {
              label: "Spindelauslastung gesamt",
              value: `${fmtPct(pct(totals.spindle, totals.on))} %`,
              sub: `${fmtH(totals.spindle)} von ${fmtH(totals.on)} h`,
              color: spindleColor(theme, pct(totals.spindle, totals.on)),
            },
            {
              label: "Spindelstunden in der Woche",
              value: `${fmtH(totals.spindle)} h`,
              sub: "produktive Zeit unter Span",
              color: theme.ink,
            },
          ].map((t) => (
            <div key={t.label} style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 18 }}>
              <div style={eyebrow}>{t.label}</div>
              <div style={{ ...mono, fontSize: 26, fontWeight: 700, color: t.color, margin: "8px 0 4px" }}>{t.value}</div>
              <div style={{ fontSize: 12, color: theme.steel }}>{t.sub}</div>
            </div>
          ))}
        </div>

        </>
        )}

        {/* Datensicherung */}
        <div
          style={{
            marginTop: 44,
            paddingTop: 16,
            borderTop: `1px solid ${theme.line}`,
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <a
            href="/api/backup"
            download
            style={{
              ...eyebrow,
              fontSize: 10,
              padding: "6px 10px",
              borderRadius: 6,
              border: `1px solid ${theme.line}`,
              background: theme.panel,
              textDecoration: "none",
            }}
          >
            Backup herunterladen
          </a>
          <span style={{ fontSize: 12, color: theme.steel }}>
            Speichert alle Zählerstände, Aufträge und Einstellungen als Datei.
          </span>
          <label
            style={{
              ...eyebrow,
              fontSize: 10,
              padding: "6px 10px",
              borderRadius: 6,
              border: `1px solid ${theme.line}`,
              background: theme.panel,
              cursor: "pointer",
            }}
          >
            Backup einspielen
            <input type="file" accept=".json,application/json" onChange={onRestoreFile} style={{ display: "none" }} />
          </label>
        </div>
        {restore && (
          <div
            style={{
              marginTop: 12,
              padding: 14,
              border: `1px solid ${restore.error ? theme.red : theme.amber}`,
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            {restore.error ? (
              <>
                <div style={{ color: theme.red, fontWeight: 600 }}>{restore.error}</div>
                <button onClick={() => setRestore(null)} style={{ ...eyebrow, marginTop: 10, padding: "6px 10px", borderRadius: 6, border: `1px solid ${theme.line}`, background: theme.panel, cursor: "pointer" }}>
                  Schließen
                </button>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600 }}>
                  Backup {restore.created ? `vom ${restore.created.slice(0, 10)}` : restore.name} enthält: {restore.counts.readings} Zählerstände, {restore.counts.orders} Positionen,{" "}
                  {restore.counts.free_days} freie Tage
                </div>
                <div style={{ color: theme.red, marginTop: 6 }}>
                  Achtung: Beim Einspielen werden ALLE aktuellen Daten durch den Inhalt der Datei ersetzt. Lade vorher ein aktuelles Backup herunter, wenn du die jetzigen Daten behalten willst.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button onClick={doRestore} style={{ ...eyebrow, padding: "6px 10px", borderRadius: 6, border: `1px solid ${theme.red}`, background: theme.red, color: "#fff", cursor: "pointer" }}>
                    Jetzt einspielen
                  </button>
                  <button onClick={() => setRestore(null)} style={{ ...eyebrow, padding: "6px 10px", borderRadius: 6, border: `1px solid ${theme.line}`, background: theme.panel, cursor: "pointer" }}>
                    Abbrechen
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
