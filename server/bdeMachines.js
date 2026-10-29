// Plausibilitätsprüfung Maschinenzeit (nur lesen): gebuchte Maschinenzeit aus Odoo gegen die Zählerstände vom Montag.
//
// Die Zählerstände (Maschine an, Spindel an, kumuliert) liegen in der Tabelle "readings" des Dashboards. Zwischen zwei Ablesungen A und B
// ergibt die Differenz die Stunden der Woche (benannt nach der Woche, in der gearbeitet wurde, wie im Dashboard).
// Gebucht = Summe der Maschinenläufe (Fräsen, Drehen) in Odoo im selben Zeitraum, je Maschine über die Zuordnung Arbeitsplatz -> Maschine
// (BDE_MACHINES, z. B. "dmu40:15,m1:16,h800u:2"). Solange alle Maschinen auf dem einen Arbeitsplatz FRÄSEN buchen, gibt es nur die Gesamtsumme.
//
// Bewertung: Spindelstunden sind die Untergrenze (wenn die Spindel dreht, läuft ein Programm, das gebucht sein muss),
// Maschine-an-Stunden die Obergrenze (mehr kann nicht gelaufen sein).
//   gebucht < 80 % der Spindelstunden            -> rot,  "Buchungen fehlen"
//   gebucht 80–95 % der Spindelstunden           -> gelb, "Buchungen fehlen"
//   95 % der Spindelstunden bis Maschine an      -> grün
//   gebucht über Maschine an, bis 15 % darüber   -> gelb, "zu spät gestoppt oder zu großzügig gebucht"
//   gebucht mehr als 15 % über Maschine an       -> rot,  "zu spät gestoppt oder zu großzügig gebucht"

import { kindOf, m2o, parseOdoo, toOdoo, dateStart, mergedMs } from "./bde.js";

const MACHINES = [
  { id: "dmu40", name: "DMU 40 EVO" },
  { id: "dmu50", name: "DMU 50" },
  { id: "m1", name: "M1" },
  { id: "h800u", name: "POS H800U" },
];
const WEEKS = 8;
const CACHE_MS = 10 * 60 * 1000;

export function rate(booked, spindle, on) {
  if (spindle == null || spindle <= 0 || booked == null) return { level: "none", text: null };
  if (booked < spindle * 0.8) return { level: "bad", text: "Buchungen fehlen" };
  if (booked < spindle * 0.95) return { level: "warn", text: "Buchungen fehlen" };
  if (on == null || booked <= on) return { level: "ok", text: null };
  if (booked <= on * 1.15) return { level: "warn", text: "Zu spät gestoppt oder zu großzügig gebucht" };
  return { level: "bad", text: "Zu spät gestoppt oder zu großzügig gebucht" };
}

function machineMap() {
  const map = new Map();
  String(process.env.BDE_MACHINES || "")
    .split(",")
    .forEach((pair) => {
      const [m, ids] = pair.split(":");
      if (!MACHINES.some((x) => x.id === m)) return;
      String(ids || "")
        .split("|")
        .map((x) => parseInt(x, 10))
        .filter(Number.isInteger)
        .forEach((wc) => map.set(wc, m));
    });
  return map;
}

export default function registerBdeMachines(app, db, ctx) {
  let cache = null;

  async function compute() {
    const rows = db.prepare("SELECT reading_date, machine, machine_total, spindle_total FROM readings ORDER BY reading_date").all();
    const dates = [...new Set(rows.map((r) => r.reading_date))].slice(-(WEEKS + 1));
    if (dates.length < 2) return { weeks: [], mapped: [] };
    const get = (d, m) => rows.find((r) => r.reading_date === d && r.machine === m);
    const from = dateStart(dates[0]);
    const to = dateStart(dates[dates.length - 1]);
    const lines = await ctx.odoo.read("mrp.workcenter.productivity", "search_read", {
      domain: [["date_start", "<", toOdoo(to)], "|", ["date_end", "=", false], ["date_end", ">", toOdoo(from)]],
      fields: ["workcenter_id", "date_start", "date_end"],
      limit: 5000,
    });
    const map = machineMap();
    const now = Date.now();
    const runs = lines
      .filter((l) => kindOf(m2o(l.workcenter_id)?.name) === "maschine")
      .map((l) => ({ machine: map.get(m2o(l.workcenter_id)?.id) || null, a: parseOdoo(l.date_start), b: parseOdoo(l.date_end) ?? now }));

    const weeks = [];
    for (let i = 1; i < dates.length; i++) {
      const A = dates[i - 1];
      const B = dates[i];
      const a = dateStart(A);
      const b = dateStart(B);
      const inWeek = (r) => [Math.max(r.a, a), Math.min(r.b, b)];
      const per = MACHINES.map((m) => {
        const ra = get(A, m.id);
        const rb = get(B, m.id);
        const spindle = ra && rb && ra.spindle_total != null && rb.spindle_total != null ? rb.spindle_total - ra.spindle_total : null;
        const on = ra && rb && ra.machine_total != null && rb.machine_total != null ? rb.machine_total - ra.machine_total : null;
        const mine = runs.filter((r) => r.machine === m.id);
        const mapped = [...map.values()].includes(m.id);
        const booked = mapped ? mergedMs(mine.map(inWeek)) / 3600000 : null;
        return { id: m.id, name: m.name, spindle, on, booked, deviation: booked != null && spindle ? (booked - spindle) / spindle : null, ...rate(booked, spindle, on) };
      });
      // Gesamt: Maschinen mit Zuordnung je Maschine (Überschneidungen einmal), ohne Zuordnung einfach summiert
      const unassignedH = runs.filter((r) => !r.machine).reduce((s, r) => {
        const [x, y] = inWeek(r);
        return s + Math.max(0, y - x);
      }, 0) / 3600000;
      const sum = (k) => (per.every((p) => p[k] == null) ? null : per.reduce((s, p) => s + (p[k] || 0), 0));
      const bookedTotal = per.reduce((s, p) => s + (p.booked || 0), 0) + unassignedH;
      const spindleTotal = sum("spindle");
      const onTotal = sum("on");
      weeks.push({
        from: A,
        to: B,
        machines: per,
        unassignedH,
        total: { spindle: spindleTotal, on: onTotal, booked: bookedTotal, deviation: spindleTotal ? (bookedTotal - spindleTotal) / spindleTotal : null, ...rate(bookedTotal, spindleTotal, onTotal) },
      });
    }
    return { weeks: weeks.reverse(), mapped: [...new Set(map.values())] };
  }

  app.get("/api/bde/maschinenzeit", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s || !s.leitung) return res.status(403).json({ error: "Nur für die Leitung" });
    try {
      if (!cache || Date.now() - cache.at > CACHE_MS || req.query.neu === "1") cache = { at: Date.now(), data: await compute() };
      res.json({ ...cache.data, at: cache.at });
    } catch (err) {
      ctx.fail(res, err);
    }
  });
}
