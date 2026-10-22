import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  DEFAULT_WEEK_CAPACITY,
  MACHINES,
  SHIFT_MODELS,
  addDays,
  daysBetween,
  fmtH,
  fmtShort,
  mondayOf,
  weekInfo,
} from "./lib.js";
import { Ico, MTile, SparkIcon, useToast } from "./ui.jsx";
import { setDashFacts } from "./store.js";

const TREND_WEEKS = 8;

// Ampel für die Kapazitätsauslastung (gerundet wie angezeigt): 80-100 % grün (im Soll), 65-79 % und 101-110 % gelb,
// darunter bzw. darüber rot. Über 100 % heißt: länger gelaufen als die Betriebszeit des Schichtmodells.
const capCol = (p) => (p >= 80 && p <= 100 ? "var(--ok)" : (p >= 65 && p < 80) || (p > 100 && p <= 110) ? "var(--warn)" : "var(--bad)");
// Ampel für die Spindelquote (gerundet wie angezeigt): ab 70 % grün, 55-69 % gelb, darunter rot
const spCol = (p) => (p >= 70 ? "var(--ok)" : p >= 55 ? "var(--warn)" : "var(--bad)");

const pct = (part, whole) => (whole ? part / whole : 0);
const rnd = (x) => Math.round(x * 100);
const dec = (n) => String(Math.round(n * 10) / 10).replace(".", ",");

// Wochenstunden = Differenz zweier aufeinanderfolgender Zählerstände. Die
// Stunden gehören zu der Kalenderwoche, in der sie gearbeitet wurden (Ablesung
// vom 28.9. = Stunden von KW 39, 21.-27.9.). Fehlt eine Ablesung, wird
// die Differenz gleichmäßig auf die Wochen dazwischen verteilt.
function computeWeekly(readings) {
  const result = {};
  MACHINES.forEach((m) => {
    const list = readings.filter((r) => r.machine === m.id).sort((a, b) => a.date.localeCompare(b.date));
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

function Count({ to }) {
  const [v, setV] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setV(to);
      return undefined;
    }
    let raf;
    let t0 = null;
    const from = first.current ? 0 : v;
    first.current = false;
    const step = (t) => {
      if (t0 === null) t0 = t;
      const p = Math.min(1, (t - t0) / 900);
      setV(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to]);
  return <>{v}</>;
}

function Delta({ d, good, unit = "Pp" }) {
  if (d == null || Number.isNaN(d)) return null;
  const r = Math.round(d * 10) / 10;
  if (Math.abs(r) < 0.05) return <span className="delta">± 0 {unit}</span>;
  const cls = good ? (r > 0 ? "up" : "down") : "";
  return (
    <span className={`delta ${cls}`}>
      {r > 0 ? "▲ +" : "▼ "}
      {dec(Math.abs(r))} {unit}
    </span>
  );
}

function Spark({ vals, color }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    return () => cancelAnimationFrame(r);
  }, []);
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return <div className="spark" style={{ height: 44 }} />;
  const w = 220;
  const hh = 44;
  const lo = Math.min(...v) - 4;
  const hi = Math.max(...v) + 4;
  const pts = v.map((x, i) => [(i / (v.length - 1)) * (w - 12) + 6, hh - 5 - ((x - lo) / (hi - lo)) * (hh - 12)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <div className={`spark${on ? " spark-in" : ""}`}>
      <svg viewBox={`0 0 ${w} ${hh}`} width="100%" style={{ height: "auto", display: "block" }} aria-hidden="true">
        <g className="spark-g">
          <path d={`${d} L${last[0]} ${hh - 2} L6 ${hh - 2} Z`} fill={color} opacity=".16" />
          <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={last[0]} cy={last[1]} r="3.4" fill={color} />
        </g>
      </svg>
    </div>
  );
}

function Rings({ cap, sp }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    return () => cancelAnimationFrame(r);
  }, []);
  const ring = (r, v, color) => (
    <>
      <circle cx="70" cy="70" r={r} fill="none" stroke="var(--sunken)" strokeWidth="10" />
      <circle
        cx="70"
        cy="70"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
        pathLength="100"
        data-dash=""
        style={{ strokeDasharray: `${on ? Math.max(0, Math.min(100, v)) : 0} 100` }}
      />
    </>
  );
  return (
    <svg viewBox="0 0 140 140" width="150" height="150" aria-hidden="true">
      <g transform="rotate(-90 70 70)">
        {ring(59, cap, capCol(cap))}
        {ring(43, sp, spCol(sp))}
      </g>
    </svg>
  );
}

function Bars8({ m, weeks, vals, spindle }) {
  const W = 280;
  const H = 84;
  const base = H - 16;
  const bw = 22;
  const gap = (W - 8 * bw) / 7;
  const top = 6;
  const hh = base - top;
  const y = (v) => base - (Math.min(v, 110) / 110) * hh;
  return (
    <svg className="bars8" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spindelauslastung der letzten 8 Wochen">
      {spindle && (
        <>
          <line x1="0" x2={W} y1={y(70)} y2={y(70)} stroke="var(--line-strong)" strokeDasharray="3 4" />
          <text x={W} y={y(70) - 3} textAnchor="end">
            Soll 70 %
          </text>
        </>
      )}
      {vals.map((v, i) =>
        v == null ? null : (
          <rect
            key={i}
            style={{ "--i": i }}
            x={i * (bw + gap)}
            y={y(v)}
            width={bw}
            height={base - y(v)}
            rx="4"
            fill={i === vals.length - 1 ? m.c : `color-mix(in srgb, ${m.c} 38%, var(--sunken))`}
          >
            <title>{`${weeks[i]}: ${v} %`}</title>
          </rect>
        )
      )}
      <text x="0" y={H - 3}>
        {weeks[0]}
      </text>
      <text x={W} y={H - 3} textAnchor="end">
        {weeks[weeks.length - 1]}
      </text>
    </svg>
  );
}

// Verlauf: Linien je Maschine mit Fläche, Bewertungsbereichen und Wertanzeige beim Darüberfahren
function Trend({ rows, metric, hidden }) {
  const [hover, setHover] = useState(null);
  const boxRef = useRef(null);
  const W = 860;
  const H = 280;
  const L = 44;
  const R = 26;
  const T = 14;
  const B = 30;
  const iw = W - L - R;
  const ih = H - T - B;
  const vals = rows.flatMap((r) => MACHINES.map((m) => r[m.id]).filter((v) => v != null));
  const dom =
    metric === "spindle"
      ? [Math.max(0, Math.min(30, Math.floor((Math.min(...vals, 100) - 5) / 5) * 5)), Math.max(85, Math.ceil((Math.max(...vals, 0) + 5) / 5) * 5)]
      : [Math.max(0, Math.min(40, Math.floor((Math.min(...vals, 100) - 5) / 5) * 5)), Math.max(120, Math.ceil((Math.max(...vals, 0) + 5) / 5) * 5)];
  const [lo, hi] = dom;
  const yy = (v) => T + ih - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * ih;
  const x = (i) => L + (i / (rows.length - 1)) * iw;
  const zones =
    metric === "spindle"
      ? [
          [70, hi, "var(--ok)", 0.08],
          [lo, 55, "var(--bad)", 0.06],
        ]
      : [
          [80, 100, "var(--ok)", 0.09],
          [100, 110, "var(--warn)", 0.07],
          [lo, 65, "var(--bad)", 0.06],
          [110, hi, "var(--bad)", 0.06],
        ];
  const marks = metric === "spindle" ? [55, 70] : [65, 80, 100, 110];
  const ticks = [...new Set([...marks, ...Array.from({ length: Math.floor(hi / 20) + 1 }, (_, k) => k * 20).filter((v) => v >= lo && v <= hi && marks.every((m) => Math.abs(m - v) >= 8))])].sort((a, b) => a - b);
  const onMove = (e) => {
    const svg = e.currentTarget.ownerSVGElement;
    const r = svg.getBoundingClientRect();
    const sx = W / r.width;
    const px = (e.clientX - r.left) * sx;
    const i = Math.max(0, Math.min(rows.length - 1, Math.round(((px - L) / iw) * (rows.length - 1))));
    const bx = boxRef.current.getBoundingClientRect();
    let left = x(i) / sx + 14;
    if (left + 170 > bx.width) left = x(i) / sx - 170;
    setHover({ i, left, top: Math.max(4, e.clientY - bx.top - 20) });
  };
  return (
    <div className="tbox" ref={boxRef} style={{ padding: "8px 14px 4px" }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Verlauf der letzten 8 Wochen je Maschine">
        <defs>
          {MACHINES.map((m) => (
            <linearGradient key={m.id} id={`ga-${m.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={m.c} stopOpacity=".28" />
              <stop offset="1" stopColor={m.c} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {zones.map(([a, b, c, o], k) => (
          <rect key={k} x={L} y={yy(b)} width={iw} height={Math.max(0, yy(a) - yy(b))} fill={c} opacity={o} />
        ))}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={yy(v)} y2={yy(v)} stroke="var(--line)" strokeDasharray={v === 55 || v === 70 || v === 80 || v === 100 ? "4 4" : undefined} />
            <text x={L - 8} y={yy(v) + 4} textAnchor="end">
              {v} %
            </text>
          </g>
        ))}
        <text x={L + 8} y={yy(metric === "spindle" ? 70 : 80) - 6} style={{ fill: "var(--ok)", fontWeight: 600 }}>
          {metric === "spindle" ? "Soll ab 70 %" : "Soll 80 bis 100 %"}
        </text>
        {rows.map((r, i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle">
            {r.week}
          </text>
        ))}
        {MACHINES.map((m) => {
          if (hidden[m.id]) return null;
          // Lücken (fehlende Wochen) unterbrechen die Linie
          const segs = [];
          let cur = [];
          rows.forEach((r, i) => {
            if (r[m.id] == null) {
              if (cur.length) segs.push(cur);
              cur = [];
            } else cur.push(i);
          });
          if (cur.length) segs.push(cur);
          return (
            <g key={m.id}>
              {segs.map((s, k) => {
                const d = s.map((i, j) => `${j ? "L" : "M"}${x(i).toFixed(1)} ${yy(rows[i][m.id]).toFixed(1)}`).join(" ");
                return (
                  <g key={k}>
                    {s.length > 1 && <path d={`${d} L${x(s[s.length - 1])} ${yy(lo)} L${x(s[0])} ${yy(lo)} Z`} fill={`url(#ga-${m.id})`} />}
                    <path d={d} fill="none" stroke={m.c} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                );
              })}
              {rows.map((r, i) => (r[m.id] == null ? null : <circle key={i} cx={x(i)} cy={yy(r[m.id])} r={i === rows.length - 1 ? 4.5 : 2.8} fill={m.c} stroke="var(--surface)" strokeWidth="1.5" />))}
            </g>
          );
        })}
        {hover && <line x1={x(hover.i)} x2={x(hover.i)} y1={T} y2={T + ih} stroke="var(--ink)" strokeOpacity=".35" strokeDasharray="3 3" />}
        <rect x={L} y={T} width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      <div className={`ttip${hover ? " on" : ""}`} style={hover ? { left: hover.left, top: hover.top } : undefined}>
        {hover && (
          <>
            <b>{rows[hover.i].week}</b>
            {MACHINES.filter((m) => !hidden[m.id]).map((m) => (
              <div key={m.id}>
                <i className="dot" style={{ "--c": m.c }} />
                <span>{m.short}</span>
                <span>{rows[hover.i][m.id] == null ? "–" : `${rows[hover.i][m.id]} %`}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// Kapazität einer Woche: Schichtmodell wählen oder die Stunden von Hand eintragen
function CapacityPicker({ value, onChange, label }) {
  return (
    <div className="actions" style={{ gap: 10 }}>
      <span style={{ color: "var(--muted)", fontSize: 13 }}>{label}</span>
      <div className="seg">
        {SHIFT_MODELS.map((s) => (
          <button key={s.label} type="button" className={value === s.hours ? "on" : ""} title={`${s.label}: ${s.hours} h pro Woche`} onClick={() => onChange(s.hours)}>
            {s.label} · {s.hours} h
          </button>
        ))}
      </div>
      <input
        type="number"
        min={0}
        max={168}
        value={value}
        onChange={(ev) => ev.target.value !== "" && onChange(Math.min(168, Math.max(0, Number(ev.target.value))))}
        title="Stunden pro Woche von Hand eintragen, z. B. bei einem Feiertag"
        style={{ width: 70, textAlign: "center" }}
        aria-label="Stunden pro Woche"
      />
      <span style={{ color: "var(--muted)", fontSize: 13 }}>h pro Woche</span>
    </div>
  );
}

export default function Dashboard({ weekCap, saveCapacity, today, openTalos }) {
  const toast = useToast();
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [freeDays, setFreeDays] = useState([]);
  const [trendMetric, setTrendMetric] = useState("spindle"); // spindle | beleg
  const [hidden, setHidden] = useState({});
  const [pickedWeek, setPickedWeek] = useState(null);
  const [showEntry, setShowEntry] = useState(false);
  const [entryDate, setEntryDate] = useState(() => mondayOf(today));

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && setShowEntry(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    Promise.all([fetch("/api/readings").then((r) => r.json()), fetch("/api/free-days").then((r) => r.json()).catch(() => ({ days: [] }))])
      .then(([r, f]) => {
        setReadings(r.readings);
        setFreeDays(f.days || []);
      })
      .finally(() => setLoading(false));
  }, []);

  const weekly = useMemo(() => computeWeekly(readings), [readings]);
  const weekOptions = useMemo(() => Object.values(weekly).sort((a, b) => b.monday.localeCompare(a.monday)), [weekly]);
  const selectedKey = weekly[pickedWeek] ? pickedWeek : weekOptions[0]?.key;
  const selected = selectedKey ? weekly[selectedKey] : undefined;
  const period = selected ? Object.values(selected.machines)[0] : undefined;

  const freeDates = useMemo(() => new Set(freeDays.map((d) => d.date)), [freeDays]);
  const modelOf = (date) => weekCap[date] ?? DEFAULT_WEEK_CAPACITY;
  // Arbeitstage (Mo-Sa) der Woche ab `date`, die auf einen freien Tag fallen
  const lostDays = (date) => {
    let n = 0;
    for (let k = 0; k < 7; k++) {
      const d = addDays(date, k);
      if (freeDates.has(d) && new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) n++;
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

  // Kennzahlen einer Woche je Maschine
  const metricsOf = (week) =>
    MACHINES.map((m) => {
      const e = week?.machines[m.id];
      if (!e) return { m, e: null, on: null, spindle: null, cap: null, capPct: null, spPct: null };
      const cap = e.from ? capOf(e.from) : DEFAULT_WEEK_CAPACITY;
      return {
        m,
        e,
        on: e.on,
        spindle: e.spindle,
        cap,
        capPct: e.on != null ? rnd(pct(e.on, cap)) : null,
        spPct: e.on && e.spindle != null ? rnd(pct(e.spindle, e.on)) : null,
      };
    });

  const cur = useMemo(() => metricsOf(selected), [selected, weekCap, freeDates]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevWeek = selected ? weekly[weekInfo(addDays(selected.monday, -7)).key] : undefined;
  const prev = useMemo(() => (prevWeek ? metricsOf(prevWeek) : null), [prevWeek, weekCap, freeDates]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    let on = 0;
    let spindle = 0;
    let cap = 0;
    cur.forEach((c) => {
      on += c.on ?? 0;
      spindle += c.spindle ?? 0;
      cap += c.e ? c.cap : 0;
    });
    return { on, spindle, cap };
  }, [cur]);
  const spAll = rnd(pct(totals.spindle, totals.on));
  const capAll = rnd(pct(totals.on, totals.cap));
  const prevTotals = useMemo(() => {
    if (!prev) return null;
    let on = 0;
    let spindle = 0;
    let cap = 0;
    prev.forEach((c) => {
      on += c.on ?? 0;
      spindle += c.spindle ?? 0;
      cap += c.e ? c.cap : 0;
    });
    return cap ? { sp: rnd(pct(spindle, on)), cap: rnd(pct(on, cap)) } : null;
  }, [prev]);

  // Verlauf: die letzten Wochen bis zur zuletzt abgeschlossenen, fehlende Werte als Lücke
  const trend = useMemo(() => {
    const lastMonday = addDays(mondayOf(today), -7);
    const out = [];
    for (let i = TREND_WEEKS - 1; i >= 0; i--) {
      const info = weekInfo(addDays(lastMonday, -7 * i));
      const ms = metricsOf(weekly[info.key]);
      const row = { week: info.label, sp: {}, cap: {} };
      ms.forEach((c) => {
        row.sp[c.m.id] = c.spPct;
        row.cap[c.m.id] = c.capPct;
      });
      out.push(row);
    }
    return out;
  }, [weekly, weekCap, freeDates, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const trendRows = trend.map((r) => ({ week: r.week, ...(trendMetric === "spindle" ? r.sp : r.cap) }));
  const avgAt = (key, i) => {
    const v = MACHINES.map((m) => trend[i][key][m.id]).filter((x) => x != null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const spHist = trend.map((_, i) => avgAt("sp", i));
  const capHist = trend.map((_, i) => avgAt("cap", i));

  const insights = useMemo(() => {
    const list = [];
    cur.forEach(({ m, capPct, spPct }) => {
      if (capPct != null) {
        if (capPct > 110) list.push({ k: "warn", t: `${m.short}: Kapazität ${capPct} %`, d: "Deutlich länger gelaufen als das Schichtmodell vorsieht. Mehrarbeit oder falsches Modell eingetragen?" });
        else if (capPct > 100) list.push({ k: "warn", t: `${m.short}: Kapazität ${capPct} %`, d: "Über der Kapazität der Woche (Überlast, keine Reserve)." });
        else if (capPct < 65) list.push({ k: "bad", t: `${m.short}: Kapazität nur ${capPct} %`, d: "Deutlich unter Plan, Ursache prüfen (Stillstand, fehlende Aufträge)." });
        else if (capPct < 80) list.push({ k: "warn", t: `${m.short}: Kapazität nur ${capPct} %`, d: "Unter der Planungsannahme von 80 %. Die Planung rechnet damit zu optimistisch." });
      }
      if (spPct != null && spPct < 70) list.push({ k: spPct < 55 ? "bad" : "warn", t: `${m.short}: Spindelauslastung ${spPct} %`, d: spPct < 55 ? "Handlungsbedarf: Stillstandsgründe erfassen." : "Im Beobachtungsbereich (55 bis 69 %)." });
    });
    const spv = cur.filter((c) => c.spPct != null);
    if (spv.length && spv.every((c) => c.spPct >= 70)) list.push({ k: "ok", t: "Spindelauslastung überall im Soll", d: `Alle ${spv.length === 3 ? "drei " : ""}Maschinen liegen bei 70 % oder höher.` });
    return list;
  }, [cur]);

  // Fakten für Talos
  useEffect(() => {
    setDashFacts(selected ? { week: selected.label, insights, spAll, capAll, on: totals.on, spindle: totals.spindle } : null);
    return () => setDashFacts(null);
  }, [selected, insights, spAll, capAll, totals]);

  // --- Zählerstände eintragen ---
  const entryValid = /^\d{4}-\d{2}-\d{2}$/.test(entryDate) && !Number.isNaN(Date.parse(entryDate));
  const readingFor = (machineId, date) => readings.find((r) => r.date === date && r.machine === machineId);
  const previousReading = (machineId) =>
    readings
      .filter((r) => r.machine === machineId && r.date < entryDate)
      .sort((a, b) => b.date.localeCompare(a.date))[0];

  function updateReading(machineId, field, raw) {
    if (!entryValid) return;
    // Das Schichtmodell der kommenden Woche wird mit der ersten Eingabe festgeschrieben (Vorbelegung: Vorwoche)
    if (weekCap[entryDate] === undefined) saveCapacity(entryDate, capPrefill(entryDate));
    const c = readingFor(machineId, entryDate) || { machine_total: null, spindle_total: null };
    const next = { ...c, [field]: raw === "" ? null : Math.max(0, Number(raw)) };
    setReadings((prevList) => {
      const rest = prevList.filter((r) => !(r.date === entryDate && r.machine === machineId));
      if (next.machine_total == null && next.spindle_total == null) return rest;
      return [...rest, { date: entryDate, machine: machineId, machine_total: next.machine_total, spindle_total: next.spindle_total }];
    });
    fetch("/api/readings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: entryDate, machine: machineId, machine_total: next.machine_total, spindle_total: next.spindle_total }),
    }).catch((err) => console.error("Speichern fehlgeschlagen", err));
  }

  if (loading) {
    return (
      <div className="page-head rise">
        <div>
          <h1>Dashboard</h1>
          <p>Lädt…</p>
        </div>
      </div>
    );
  }

  const anySpread = selected && Object.values(selected.machines).some((e) => e.spread);
  const wkLabel = (w) => {
    const e = Object.values(w.machines)[0];
    return `${w.label} (${fmtShort(e.from)} – ${fmtShort(addDays(e.to, -1))}, Ablesung ${fmtShort(e.to)})`;
  };
  const weekNames = trend.map((r) => r.week);
  const capLabelWeek = selected ? `Kapazität ${selected.label} (${fmtShort(period.from)} bis ${fmtShort(addDays(period.to, -1))})` : "";

  return (
    <>
      <div className="page-head rise" style={{ "--i": 0 }}>
        <div>
          <h1>Produktionsdashboard</h1>
          <p>{selected ? `Auswertung ${selected.label} aus den Zählerständen vom ${fmtShort(period.to)}` : "Noch keine Auswertung"}</p>
        </div>
        <div className="actions">
          <select value={selectedKey || ""} onChange={(ev) => setPickedWeek(ev.target.value)} disabled={!weekOptions.length} aria-label="Woche">
            {!weekOptions.length && <option value="">Keine Daten</option>}
            {weekOptions.map((w) => (
              <option key={w.key} value={w.key}>
                {wkLabel(w)}
              </option>
            ))}
          </select>
          <button className="btn primary" type="button" onClick={() => setShowEntry(true)}>
            Zählerstände eintragen
          </button>
        </div>
      </div>

      {!selected && (
        <div className="card rise" style={{ "--i": 1, padding: 18, color: "var(--muted)" }}>
          Noch keine Auswertung. Für eine Woche werden zwei aufeinanderfolgende Ablesungen benötigt. Trage sie über „Zählerstände eintragen“ ein.
        </div>
      )}

      {selected && (
        <>
          <div className="card rise" style={{ "--i": 1, padding: "12px 18px", marginBottom: 14, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <CapacityPicker value={modelOf(period.from)} onChange={(h) => saveCapacity(period.from, h)} label={capLabelWeek} />
            <span style={{ color: "var(--muted)", fontSize: 13 }}>
              = {dec(totals.cap / Math.max(1, cur.filter((c) => c.e).length))} h pro Maschine
              {lostDays(period.from) > 0 ? ` (${lostDays(period.from)} freier Tag${lostDays(period.from) > 1 ? "e" : ""} abgezogen)` : ""}
            </span>
          </div>
          {anySpread && (
            <div className="rise" style={{ "--i": 1, color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
              Mindestens eine Ablesung fehlt: Die Werte sind gleichmäßig auf die Wochen dazwischen verteilt.
            </div>
          )}

          <div className="kpis rise" style={{ "--i": 2 }}>
            <div className="card kpi hero">
              <span className="lab">Spindelauslastung gesamt</span>
              <div className="val">
                <span><Count to={spAll} /></span>
                <small>%</small>
              </div>
              <div className="row">
                {prevTotals && <Delta d={spAll - prevTotals.sp} good />} <span>{prevTotals ? "zur Vorwoche" : `${dec(totals.spindle)} von ${dec(totals.on)} h`}</span>
              </div>
              <Spark vals={spHist} color="#5DE0A0" />
            </div>
            <div className="card kpi">
              <span className="lab">Kapazitätsauslastung gesamt</span>
              <div className="val" style={{ color: capCol(capAll) }}>
                <span><Count to={capAll} /></span>
                <small>%</small>
              </div>
              <div className="row">
                {prevTotals && <Delta d={capAll - prevTotals.cap} good={false} />} <span>{prevTotals ? "zur Vorwoche" : `${dec(totals.on)} von ${dec(totals.cap)} h`}</span>
              </div>
              <Spark vals={capHist} color="var(--ink)" />
            </div>
            <div className="card kpi">
              <span className="lab">Maschine an</span>
              <div className="val">
                <span><Count to={Math.round(totals.on)} /></span>
                <small>h</small>
              </div>
              <div className="row">von {dec(totals.cap)} h Kapazität</div>
              <div className="meter2"><i style={{ width: `${Math.min(100, capAll)}%`, transition: "width 1s cubic-bezier(.2,.7,.2,1) .3s" }} /></div>
            </div>
            <div className="card kpi">
              <span className="lab">Spindelstunden</span>
              <div className="val">
                <span><Count to={Math.round(totals.spindle)} /></span>
                <small>h</small>
              </div>
              <div className="row">{spAll} % der Laufzeit</div>
              <div className="meter2"><i style={{ width: `${Math.min(100, spAll)}%`, background: spCol(spAll), transition: "width 1s cubic-bezier(.2,.7,.2,1) .35s" }} /></div>
            </div>
          </div>

          <div className="mcards rise" style={{ "--i": 3 }}>
            {cur.map((c, mi) => {
              const { m } = c;
              const pm = prev ? prev[mi] : null;
              const stp = c.spPct == null ? null : c.spPct >= 70 ? ["ok", "Soll erreicht"] : c.spPct >= 55 ? ["warn", "Beobachten"] : ["bad", "Handlungsbedarf"];
              return (
                <div className="card mcard2" key={m.id}>
                  <header>
                    <MTile c={m.c} img={m.img} imgZoom={m.imgZoom} />
                    {m.name}
                    {stp && <span className={`pill ${stp[0]}`}>{stp[1]}</span>}
                  </header>
                  <div className="rings">
                    <div className="ringbox">
                      <Rings cap={c.capPct ?? 0} sp={c.spPct ?? 0} />
                      <div className="cn">
                        <b>
                          {c.spPct != null ? <Count to={c.spPct} /> : "–"}
                          <span style={{ fontSize: 15, color: "var(--muted)", marginLeft: 1 }}>%</span>
                        </b>
                        <span>Spindel</span>
                      </div>
                    </div>
                    <div className="rleg">
                      <div>
                        <span className="t">
                          <i className="dot" style={{ "--c": c.capPct != null ? capCol(c.capPct) : "var(--faint)" }} />
                          Kapazität
                        </span>
                        <span className="v">
                          {c.capPct != null ? <><Count to={c.capPct} /> %</> : "–"}
                          {pm && pm.capPct != null && c.capPct != null && <Delta d={c.capPct - pm.capPct} good={false} />}
                        </span>
                      </div>
                      <div>
                        <span className="t">
                          <i className="dot" style={{ "--c": c.spPct != null ? spCol(c.spPct) : "var(--faint)" }} />
                          Spindel
                        </span>
                        <span className="v">
                          {c.spPct != null ? `${c.spPct} %` : "–"}
                          {pm && pm.spPct != null && c.spPct != null && <Delta d={c.spPct - pm.spPct} good />}
                        </span>
                      </div>
                    </div>
                  </div>
                  <Bars8 m={m} weeks={weekNames} vals={trend.map((r) => r.sp[m.id])} spindle />
                  <div className="pair" style={{ marginTop: 0 }}>
                    <div>
                      Maschine an
                      <b>
                        {c.on != null ? fmtH(c.on) : "–"} <span>h</span>
                      </b>
                    </div>
                    <div>
                      Spindelstunden
                      <b>
                        {c.spindle != null ? fmtH(c.spindle) : "–"} <span>h</span>
                      </b>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="dgrid rise" style={{ "--i": 4 }}>
            <div className="card">
              <div className="sec-head">
                <div>
                  <h2>Verlauf der letzten {TREND_WEEKS} Wochen</h2>
                  <p>{trendMetric === "spindle" ? "Spindelauslastung" : "Kapazitätsauslastung"} je Maschine, fahre mit der Maus über das Bild</p>
                </div>
                <div className="actions">
                  <div className="seg">
                    <button type="button" className={trendMetric === "spindle" ? "on" : ""} onClick={() => setTrendMetric("spindle")}>
                      Spindelauslastung
                    </button>
                    <button type="button" className={trendMetric === "beleg" ? "on" : ""} onClick={() => setTrendMetric("beleg")}>
                      Kapazitätsauslastung
                    </button>
                  </div>
                  <div className="tgl">
                    {MACHINES.map((m) => (
                      <button key={m.id} type="button" className={hidden[m.id] ? "off" : ""} onClick={() => setHidden((h) => ({ ...h, [m.id]: !h[m.id] }))}>
                        <i className="dot" style={{ "--c": m.c }} />
                        {m.short}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <Trend rows={trendRows} metric={trendMetric} hidden={hidden} />
              <div className="legend">
                {trendMetric === "spindle" ? (
                  <>
                    <span><i className="dot" style={{ "--c": "var(--ok)" }} />ab 70 % Soll erreicht</span>
                    <span><i className="dot" style={{ "--c": "var(--warn)" }} />55 bis 69 % Beobachtungsbereich</span>
                    <span><i className="dot" style={{ "--c": "var(--bad)" }} />unter 55 % Handlungsbedarf</span>
                  </>
                ) : (
                  <>
                    <span><i className="dot" style={{ "--c": "var(--ok)" }} />80 bis 100 % im Soll</span>
                    <span><i className="dot" style={{ "--c": "var(--warn)" }} />65 bis 79 % oder 101 bis 110 %</span>
                    <span><i className="dot" style={{ "--c": "var(--bad)" }} />unter 65 % oder über 110 %</span>
                  </>
                )}
              </div>
            </div>
            <div className="card">
              <div className="sec-head">
                <div>
                  <h2>Auffälligkeiten dieser Woche</h2>
                  <p>Automatisch aus den Zahlen</p>
                </div>
              </div>
              {insights.length ? (
                insights.map((i, k) => (
                  <div className="insight" key={k}>
                    <span className={`ic ${i.k === "ok" ? "ok" : "warn"}`}>
                      <Ico n={i.k === "ok" ? "check" : "plus"} s={16} />
                    </span>
                    <div>
                      <b>{i.t}</b>
                      <span>{i.d}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="insight">
                  <span>Nichts Auffälliges.</span>
                </div>
              )}
              <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
                <button className="btn sm" type="button" onClick={() => openTalos("Was fällt im Dashboard auf?")}>
                  <span style={{ color: "var(--brand)", display: "inline-flex" }}><SparkIcon s={14} /></span>
                  Talos: Was fällt auf?
                </button>
              </div>
            </div>
          </div>

          <div className="card rise" style={{ "--i": 5 }}>
            <div className="sec-head">
              <div>
                <h2>Ampel-Kalender</h2>
                <p>{trendMetric === "spindle" ? "Spindelauslastung" : "Kapazitätsauslastung"} je Woche, Farbe nach Bewertung</p>
              </div>
            </div>
            <div className="heat">
              <span />
              {weekNames.map((k) => (
                <span className="cl" key={k}>{k}</span>
              ))}
              {MACHINES.map((m, r) => (
                <React.Fragment key={m.id}>
                  <span className="rl"><i className="dot" style={{ "--c": m.c }} />{m.short}</span>
                  {trendRows.map((row, i) => {
                    const v = row[m.id];
                    const col = v == null ? "var(--faint)" : trendMetric === "spindle" ? spCol(v) : capCol(v);
                    return (
                      <span key={i} className={`hc${i === trendRows.length - 1 ? " now" : ""}`} style={{ "--c": col, "--i": r * 8 + i }} title={`${m.short}, ${row.week}: ${v == null ? "keine Daten" : `${v} %`}`}>
                        {v == null ? "–" : v}
                      </span>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        </>
      )}

      {showEntry && (
        <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setShowEntry(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Zählerstände eintragen" style={{ width: "min(700px, 100%)" }}>
            <h3>Zählerstände eintragen</h3>
            <p>Montags die Gesamtzähler der Maschinen ablesen. Die Eingaben werden sofort gespeichert.</p>
            <div className="fgrid" style={{ marginBottom: 14 }}>
              <label className="f">
                Datum der Ablesung
                <input type="date" value={entryDate} onChange={(ev) => setEntryDate(ev.target.value)} />
                {entryValid && mondayOf(entryDate) !== entryDate && <span style={{ color: "var(--warn)" }}>Kein Montag</span>}
              </label>
              <div className="f">
                Schichtmodell für {entryValid ? `${weekInfo(mondayOf(addDays(entryDate, 3))).label} (${fmtShort(entryDate)} bis ${fmtShort(addDays(entryDate, 6))})` : "die kommende Woche"}
                {entryValid && (
                  <div className="seg" style={{ flexWrap: "wrap" }}>
                    {SHIFT_MODELS.map((s) => (
                      <button key={s.label} type="button" className={capPrefill(entryDate) === s.hours ? "on" : ""} onClick={() => saveCapacity(entryDate, s.hours)}>
                        {s.label} · {s.hours} h
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {MACHINES.map((m) => {
              const c = readingFor(m.id, entryDate);
              const pv = entryValid ? previousReading(m.id) : undefined;
              const dOn = pv && c && pv.machine_total != null && c.machine_total != null ? c.machine_total - pv.machine_total : null;
              const dSp = pv && c && pv.spindle_total != null && c.spindle_total != null ? c.spindle_total - pv.spindle_total : null;
              const negative = (dOn != null && dOn < 0) || (dSp != null && dSp < 0);
              // Mehr Stunden, als der Zeitraum seit der letzten Ablesung hat, ist unmöglich; Spindel über Maschine an ist auffällig
              const hoursAvailable = pv && entryValid ? daysBetween(pv.date, entryDate) * 24 : null;
              const tooMuch = hoursAvailable != null && ((dOn != null && dOn > hoursAvailable) || (dSp != null && dSp > hoursAvailable));
              const spindleOver = dOn != null && dSp != null && dSp > dOn && dOn >= 0;
              return (
                <div className="card" key={m.id} style={{ padding: 14, boxShadow: "none", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, font: "600 16px var(--f-display)" }}>
                    <MTile c={m.c} img={m.img} imgZoom={m.imgZoom} size={40} />
                    {m.name}
                  </div>
                  <div className="fgrid">
                    <label className="f">
                      Maschine an
                      <input type="number" min={0} step="any" disabled={!entryValid} value={c?.machine_total ?? ""} onChange={(ev) => updateReading(m.id, "machine_total", ev.target.value)} />
                    </label>
                    <label className="f">
                      Spindel
                      <input type="number" min={0} step="any" disabled={!entryValid} value={c?.spindle_total ?? ""} onChange={(ev) => updateReading(m.id, "spindle_total", ev.target.value)} />
                    </label>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, lineHeight: 1.5 }}>
                    {pv ? (
                      <>
                        Vorherige Ablesung {fmtShort(pv.date)}: <span className="mono">{fmtH(pv.machine_total)} / {fmtH(pv.spindle_total)}</span>
                        {(dOn != null || dSp != null) && (
                          <div style={{ color: negative ? "var(--bad)" : "var(--ink)", fontWeight: 600 }}>
                            Seitdem: Maschine {dOn != null ? `${dOn >= 0 ? "+" : ""}${fmtH(dOn)} h` : "–"} · Spindel {dSp != null ? `${dSp >= 0 ? "+" : ""}${fmtH(dSp)} h` : "–"}
                            {negative && " (kleiner als zuvor, bitte prüfen)"}
                          </div>
                        )}
                        {tooMuch && <div style={{ color: "var(--bad)", fontWeight: 600 }}>Mehr Stunden, als seit {fmtShort(pv.date)} vergangen sind (höchstens {fmtH(hoursAvailable)} h). Zahlendreher?</div>}
                        {spindleOver && !tooMuch && <div style={{ color: "var(--warn)", fontWeight: 600 }}>Spindelstunden größer als „Maschine an“, bitte prüfen (Ablesezeitpunkt?)</div>}
                      </>
                    ) : (
                      "Keine frühere Ablesung vorhanden."
                    )}
                  </div>
                </div>
              );
            })}
            <div className="actions" style={{ marginTop: 14, justifyContent: "flex-end" }}>
              <button type="button" className="btn primary" onClick={() => { setShowEntry(false); toast("Zählerstände gespeichert"); }}>
                Fertig
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
