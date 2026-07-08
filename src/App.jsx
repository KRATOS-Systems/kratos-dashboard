import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { THEMES } from "./theme.js";

const STUNDENSATZ = 60;
const THEME_STORAGE_KEY = "kratos-dashboard-theme";

const MACHINES = [
  { id: "dmu40", name: "DMG DMU 40 eVo", short: "DMU 40", colorKey: "red" },
  { id: "m1", name: "DMG M1", short: "M1", colorKey: "graphite" },
  { id: "h800u", name: "POS Mill H800U", short: "H800U", colorKey: "steel" },
];

const DEFAULT_CAPACITY = { dmu40: 40, m1: 40, h800u: 40 };
const EMPTY_ENTRY = { on: 0, spindle: 0 };

function pct(part, whole) {
  if (!whole) return 0;
  return part / whole;
}

function fmtPct(x) {
  return `${Math.round(x * 100)}`;
}

function fmtEuro(x) {
  return x.toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });
}

function initialMode() {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
        <path
          d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"
          fill="currentColor"
        />
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

  const [loading, setLoading] = useState(true);
  const [weeks, setWeeks] = useState([]);
  const [entries, setEntries] = useState({});
  const [capacity, setCapacity] = useState(DEFAULT_CAPACITY);
  const [trendMetric, setTrendMetric] = useState("spindle"); // spindle | beleg

  useEffect(() => {
    async function load() {
      const [entriesRes, settingsRes] = await Promise.all([
        fetch("/api/entries").then((r) => r.json()),
        fetch("/api/settings").then((r) => r.json()),
      ]);
      setWeeks(entriesRes.weeks);
      setEntries(entriesRes.entries);
      setCapacity({ ...DEFAULT_CAPACITY, ...settingsRes.capacities });
      setLoading(false);
    }
    load();
  }, []);

  const currentWeek = weeks[weeks.length - 1];

  const getEntry = useCallback(
    (weekKey, machineId) => (entries[weekKey] && entries[weekKey][machineId]) || EMPTY_ENTRY,
    [entries]
  );

  function updateEntry(machineId, field, raw) {
    if (!currentWeek) return;
    const num = raw === "" ? 0 : Math.max(0, Number(raw));
    const prevEntry = getEntry(currentWeek.key, machineId);
    const nextEntry = { ...prevEntry, [field]: num };

    setEntries((prev) => ({
      ...prev,
      [currentWeek.key]: { ...prev[currentWeek.key], [machineId]: nextEntry },
    }));

    fetch("/api/entries", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        year: currentWeek.year,
        week: currentWeek.week,
        machine: machineId,
        on_hours: nextEntry.on,
        spindle: nextEntry.spindle,
      }),
    }).catch((err) => console.error("Speichern fehlgeschlagen", err));
  }

  function updateCapacity(machineId, raw) {
    const num = raw === "" ? 0 : Math.max(0, Number(raw));
    setCapacity((c) => ({ ...c, [machineId]: num }));

    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine: machineId, capacity_hours: num }),
    }).catch((err) => console.error("Speichern fehlgeschlagen", err));
  }

  const current = currentWeek
    ? {
        dmu40: getEntry(currentWeek.key, "dmu40"),
        m1: getEntry(currentWeek.key, "m1"),
        h800u: getEntry(currentWeek.key, "h800u"),
      }
    : { dmu40: EMPTY_ENTRY, m1: EMPTY_ENTRY, h800u: EMPTY_ENTRY };

  // Summen der aktuellen Woche
  const totals = useMemo(() => {
    let on = 0;
    let spindle = 0;
    let cap = 0;
    MACHINES.forEach((m) => {
      on += current[m.id].on;
      spindle += current[m.id].spindle;
      cap += capacity[m.id] || 0;
    });
    return { on, spindle, cap };
  }, [current, capacity]);

  // Trenddaten für das Chart
  const trend = useMemo(() => {
    return weeks.map((wk) => {
      const row = { week: wk.label };
      MACHINES.forEach((m) => {
        const e = getEntry(wk.key, m.id);
        const val = trendMetric === "spindle" ? pct(e.spindle, e.on) : pct(e.on, capacity[m.id]);
        row[m.id] = Math.round(val * 100);
      });
      return row;
    });
  }, [weeks, getEntry, capacity, trendMetric]);

  const eyebrow = {
    fontSize: 10,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: theme.steel,
    fontWeight: 600,
  };

  const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

  if (loading) {
    return (
      <div style={{ background: theme.bg, minHeight: "100%", padding: 28, color: theme.ink }}>
        <span style={eyebrow}>Lädt…</span>
      </div>
    );
  }

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
            alignItems: "baseline",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
            borderBottom: `2px solid ${theme.ink}`,
            paddingBottom: 16,
            marginBottom: 28,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <span style={{ fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em", color: theme.ink }}>
              KRATOS
              <span style={{ color: theme.red }}>.</span>
            </span>
            <span style={{ ...eyebrow, fontSize: 11 }}>Produktionsdashboard</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ ...eyebrow, fontSize: 11, color: theme.ink }}>
              Aktuelle Woche{" "}
              <span style={{ ...mono, color: theme.red, marginLeft: 6 }}>
                {currentWeek ? currentWeek.label : "–"}
              </span>
            </div>
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
            const e = current[m.id];
            const color = theme[m.colorKey];
            const spindelquote = pct(e.spindle, e.on);
            const belegung = pct(e.on, capacity[m.id]);
            return (
              <div
                key={m.id}
                style={{ background: theme.panel, border: `1px solid ${theme.line}`, borderRadius: 10, padding: 20 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{m.name}</div>
                    <div style={eyebrow}>Spindelquote</div>
                  </div>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: color, marginTop: 4 }} />
                </div>

                <div style={{ display: "flex", justifyContent: "center", margin: "4px 0 14px" }}>
                  <Gauge value={spindelquote} color={color} theme={theme} />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={eyebrow}>Belegungsgrad</span>
                    <span style={{ ...mono, fontSize: 13, fontWeight: 600 }}>{fmtPct(belegung)} %</span>
                  </div>
                  <Bar value={belegung} color={theme.graphite} theme={theme} />
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
                  <label style={{ display: "block" }}>
                    <span style={eyebrow}>Maschine an</span>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginTop: 4 }}>
                      <input
                        type="number"
                        value={e.on}
                        min={0}
                        onChange={(ev) => updateEntry(m.id, "on", ev.target.value)}
                        style={{
                          ...mono,
                          width: "100%",
                          border: `1px solid ${theme.line}`,
                          borderRadius: 6,
                          padding: "6px 8px",
                          fontSize: 16,
                          fontWeight: 600,
                          color: theme.ink,
                          background: theme.panel,
                          outline: "none",
                        }}
                      />
                      <span style={{ ...eyebrow, fontSize: 11 }}>h</span>
                    </div>
                  </label>
                  <label style={{ display: "block" }}>
                    <span style={eyebrow}>Spindelstunden</span>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginTop: 4 }}>
                      <input
                        type="number"
                        value={e.spindle}
                        min={0}
                        onChange={(ev) => updateEntry(m.id, "spindle", ev.target.value)}
                        style={{
                          ...mono,
                          width: "100%",
                          border: `1px solid ${theme.line}`,
                          borderRadius: 6,
                          padding: "6px 8px",
                          fontSize: 16,
                          fontWeight: 600,
                          color: theme.red,
                          background: theme.panel,
                          outline: "none",
                        }}
                      />
                      <span style={{ ...eyebrow, fontSize: 11 }}>h</span>
                    </div>
                  </label>
                </div>

                <div style={{ ...eyebrow, fontSize: 10, marginTop: 10, color: theme.steel }}>
                  Kapazität{" "}
                  <input
                    type="number"
                    value={capacity[m.id]}
                    min={0}
                    onChange={(ev) => updateCapacity(m.id, ev.target.value)}
                    style={{
                      ...mono,
                      width: 46,
                      border: "none",
                      borderBottom: `1px solid ${theme.line}`,
                      textAlign: "center",
                      fontSize: 12,
                      color: theme.ink,
                      background: "transparent",
                      margin: "0 4px",
                      outline: "none",
                    }}
                  />
                  h pro Woche
                </div>
              </div>
            );
          })}
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
              <div style={eyebrow}>Verlauf {weeks.length} Wochen</div>
              <div style={{ fontWeight: 700, fontSize: 15, marginTop: 2 }}>
                {trendMetric === "spindle" ? "Spindelquote je Maschine" : "Belegungsgrad je Maschine"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {[
                { key: "spindle", label: "Spindelquote" },
                { key: "beleg", label: "Belegung" },
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
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: theme.steel }} axisLine={false} tickLine={false} unit="%" />
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
              label: "Belegung gesamt",
              value: `${fmtPct(pct(totals.on, totals.cap))} %`,
              sub: `${totals.on} von ${totals.cap} h`,
              color: theme.graphite,
            },
            {
              label: "Spindelquote gesamt",
              value: `${fmtPct(pct(totals.spindle, totals.on))} %`,
              sub: `${totals.spindle} von ${totals.on} h`,
              color: theme.red,
            },
            {
              label: "Spindelstunden diese Woche",
              value: `${totals.spindle} h`,
              sub: "produktive Zeit unter Span",
              color: theme.ink,
            },
            {
              label: "Verrechenbarer Spindelwert",
              value: fmtEuro(totals.spindle * STUNDENSATZ),
              sub: `bei ${STUNDENSATZ} Euro Stundensatz`,
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
      </div>
    </div>
  );
}
