// "Heute zu tun": alles, was in Planung und Arbeitsvorbereitung eine Entscheidung braucht, als kurze Liste mit Zahlen.
// Ersetzt die vielen einzelnen Hinweise oben auf der Planung; jede Zeile springt an die Stelle, wo man es erledigt.
// Gleichzeitig die Grundlage für eine Morgenübersicht (z. B. als Mail). Nur lesen.

import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { avSummary } from "../src/avLib.js";
import { addDays, daysBetween } from "../src/lib.js";
import { LANE_IDS } from "../src/planLogic.js";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function heuteListe(inp, { fw, vollst, closing = 0, muster = 0 } = {}) {
  const today = inp.today;
  const open = inp.orders.filter((o) => !o.done);
  const pool = open.filter((o) => o.machine === "");
  const noHours = pool.filter((o) => !(o.hours > 0));
  const withSuggest = noHours.filter((o) => o.hours_suggest > 0);
  const ready = pool.filter((o) => o.hours > 0);
  // AV: Positionen, deren "Muss bis" (Start auf der Maschine minus Vorlauf) überschritten ist, und die bald starten, aber nicht bereit sind
  const ctx = makeContext(inp);
  const { plan } = ctx.compute(inp.orders);
  const lead = Number(inp.settings.av_lead_days) || 0;
  let avLate = 0;
  let avSoon = 0;
  plan.forEach((p) =>
    p.scheduled.forEach((i) => {
      if (LANE_IDS.includes(i.o.machine) || avSummary(inp.checks, i.o.id).ready) return;
      const start = ctx.dateOf(i.pastStart ?? i.start);
      if (addDays(start, -lead) < today) avLate++;
      else if (daysBetween(today, start) <= 7) avSoon++;
    })
  );
  const notOrdered = open.filter((o) => /noch nicht bestellt/.test(o.material_info || "")).length;

  const items = [];
  const add = (id, n, text, tone, ziel, hint) => n > 0 && items.push({ id, n, text, tone, ziel, hint: hint || null });
  if (fw) {
    const late = (fw.items || []).filter((i) => i.state === "offen" || i.state === "erneut");
    const kunden = new Set(late.map((i) => i.customer || i.label)).size;
    add("kunden", late.length, `${plural(late.length, "Auftrag", "Aufträge")} im Verzug, Kunde weiß noch nichts`, "bad", "fruehwarnung", `${plural(kunden, "Kunde", "Kunden")} anrufen oder anschreiben`);
  }
  if (vollst) add("fehlt", vollst.fehlt.length, `${plural(vollst.fehlt.length, "Kundenauftrag fehlt", "Kundenaufträge fehlen")} in der App`, "bad", "av", "In der Arbeitsvorbereitung übernehmen");
  add("avLate", avLate, `${plural(avLate, "Position ist", "Positionen sind")} in der AV überfällig`, "bad", "av", "„Muss bis“ ist überschritten, die Maschine wartet sonst");
  add("ohneStunden", noHours.length, `${plural(noHours.length, "Position hat", "Positionen haben")} noch keine Stunden`, "warn", "pool", withSuggest.length ? `für ${withSuggest.length} gibt es einen Vorschlag aus früheren Aufträgen` : "ohne Stunden kann nichts eingeplant werden");
  add("einplanen", ready.length, `${plural(ready.length, "Position wartet", "Positionen warten")} auf eine Maschine`, "warn", "planverbessern", "„Plan verbessern“ macht einen Vorschlag");
  add("material", notOrdered, `${plural(notOrdered, "Position", "Positionen")}: Material nur angefragt, noch nicht bestellt`, "warn", "av", "Bestellung in Odoo auslösen");
  add("avSoon", avSoon, `${plural(avSoon, "Position startet", "Positionen starten")} in 7 Tagen, AV noch nicht fertig`, "warn", "av");
  if (vollst) add("ohneBeleg", vollst.ohneBeleg.length, `${plural(vollst.ohneBeleg.length, "Kundenauftrag", "Kundenaufträge")} ohne Fertigungs- oder Einkaufsbeleg`, "warn", "av", "prüfen oder abhaken");
  add("schliessen", closing, `${plural(closing, "Position ist", "Positionen sind")} in Odoo erledigt, in der App noch offen`, "mute", "sync", "beim Odoo-Abgleich schließen");
  add("muster", muster, `${plural(muster, "Auftrag läuft", "Aufträge laufen")} auf Musterwerten`, "mute", "av", "Maschine und Zeit in Odoo prüfen");
  return { stand: new Date().toISOString(), today, items, alles: !items.some((i) => i.tone !== "mute") };
}

export default function registerHeute(app, db, helpers) {
  app.get("/api/heute", (req, res) => {
    const inp = loadPlanInputs(db, helpers);
    let fw = null;
    let odoo = {};
    try {
      fw = app.locals.fruehwarnung ? app.locals.fruehwarnung() : null;
    } catch {
      fw = null;
    }
    try {
      odoo = app.locals.odooHeute ? app.locals.odooHeute() : {};
    } catch {
      odoo = {};
    }
    res.json(heuteListe(inp, { fw, vollst: odoo.vollst || null, closing: odoo.closing || 0, muster: odoo.muster || 0 }));
  });
}
