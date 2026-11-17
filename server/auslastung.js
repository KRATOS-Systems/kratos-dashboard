// Auslastung nach vorn: Wie voll ist jede Maschine in den nächsten Wochen laut Plan, und wo wird es eng?
//
// Je Maschine und Kalenderwoche (ab der laufenden Woche):
//   kapazitaet  Stunden, die die Maschine in der Woche leisten kann (Wochenleistung der Planung, freie Tage abgezogen, laufende Woche ab heute)
//   belegt      Stunden, die laut Plan in dieser Woche laufen
//   zuSpaet     Positionen, die in dieser Woche fertig werden und ihren Liefertermin verfehlen
//   ampel       rot = in der Woche wird etwas zu spät fertig, gelb = voll (ab 90 %), grün = es ist Luft
// Dazu je Maschine, bis wann sie ausgebucht ist, und die Stunden, die noch auf keiner Maschine stehen (nach Liefertermin-Woche).
// Gerechnet wird mit derselben Planungslogik wie im Zeitstrahl (server/talosPlan.js). Nur lesen.

import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { addDays, daysBetween, isoWeekOf } from "../src/lib.js";
import { isFreeDay } from "../src/planLogic.js";

const WEEKS = 8;
const FULL = 90; // ab so viel Prozent gilt eine Woche als voll
const round1 = (x) => Math.round(x * 10) / 10;

export function capacityOutlook(inp, weeks = WEEKS) {
  const ctx = makeContext(inp);
  const { plan } = ctx.compute(inp.orders);
  const { monday0, todayOff, free, rates, defaults } = ctx;
  const cols = Array.from({ length: weeks }, (_, w) => {
    const monday = addDays(monday0, w * 7);
    return { from: w * 7, to: w * 7 + 7, monday, kw: isoWeekOf(monday).week };
  });
  const machines = plan.map((p) => {
    const own = rates[p.m.id] > 0;
    const perDay = own ? () => rates[p.m.id] / 6 : defaults.perDayAt;
    // Stunden je Tag aus den geplanten Balken: Anteil des Tages, den der Balken belegt, mal Tagesleistung
    const dayHours = new Map();
    p.scheduled.forEach((i) => {
      for (let d = Math.floor(i.start); d < Math.ceil(i.end); d++) {
        if (isFreeDay(d, free)) continue;
        const part = Math.max(0, Math.min(i.end, d + 1) - Math.max(i.start, d));
        if (part > 0) dayHours.set(d, (dayHours.get(d) || 0) + part * perDay(d));
      }
    });
    const wochen = cols.map((c) => {
      let kapazitaet = 0;
      let belegt = 0;
      for (let d = Math.max(c.from, Math.floor(todayOff)); d < c.to; d++) {
        if (isFreeDay(d, free)) continue;
        kapazitaet += perDay(d);
        belegt += dayHours.get(d) || 0;
      }
      const late = p.scheduled.filter((i) => i.status === "late" && i.end > c.from && i.end <= c.to);
      const prozent = kapazitaet > 0 ? Math.min(100, Math.round((belegt / kapazitaet) * 100)) : 0;
      return {
        kw: c.kw,
        monday: c.monday,
        kapazitaet: round1(kapazitaet),
        belegt: round1(Math.min(belegt, kapazitaet)),
        frei: round1(Math.max(0, kapazitaet - belegt)),
        prozent,
        zuSpaet: late.map((i) => ({ auftrag: i.o.source || i.o.order_no || "ohne Nummer", fa: i.o.order_no || null, tage: i.lateDays })),
        ampel: late.length ? "rot" : prozent >= FULL ? "gelb" : "gruen",
      };
    });
    const end = p.scheduled.length ? Math.max(...p.scheduled.map((i) => i.end)) : null;
    return {
      id: p.m.id,
      name: p.m.short,
      wochenleistung: round1(p.rate),
      ausgebuchtBis: end != null && end > todayOff ? ctx.endDateOf(end) : null,
      positionen: p.scheduled.length,
      wochen,
    };
  });
  // Noch auf keiner Maschine: Stunden nach der Woche des Liefertermins (überfällige zählen zur laufenden Woche)
  const pool = inp.orders.filter((o) => !o.done && o.machine === "");
  const offen = cols.map((c) => ({ kw: c.kw, monday: c.monday, stunden: 0, positionen: 0 }));
  let spaeter = 0;
  let ohneTermin = 0;
  let ohneStunden = 0;
  pool.forEach((o) => {
    if (!(o.hours > 0)) return void ohneStunden++;
    if (!o.due) return void (ohneTermin += o.hours);
    const w = Math.max(0, Math.floor(daysBetween(monday0, o.due) / 7));
    if (w >= weeks) return void (spaeter += o.hours);
    offen[w].stunden = round1(offen[w].stunden + o.hours);
    offen[w].positionen++;
  });
  return {
    stand: new Date().toISOString(),
    today: inp.today,
    vollAb: FULL,
    wochen: cols.map((c) => ({ kw: c.kw, monday: c.monday })),
    maschinen: machines,
    nichtEingeplant: { wochen: offen, spaeter: round1(spaeter), ohneTermin: round1(ohneTermin), ohneStunden },
  };
}

export default function registerAuslastung(app, db, helpers) {
  app.get("/api/auslastung", (req, res) => res.json(capacityOutlook(loadPlanInputs(db, helpers))));
}
