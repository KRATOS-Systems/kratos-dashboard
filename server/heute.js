// "Heute zu tun": alles, was in Planung und Arbeitsvorbereitung eine Entscheidung braucht, als kurze Liste mit Zahlen.
// Ersetzt die vielen einzelnen Hinweise oben auf der Planung; jede Zeile springt an die Stelle, wo man es erledigt.
// Gleichzeitig die Grundlage für eine Morgenübersicht (z. B. als Mail). Nur lesen.

import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { avSummary } from "../src/avLib.js";
import { addDays, daysBetween } from "../src/lib.js";
import { LANE_IDS } from "../src/planLogic.js";
import { MACHINES } from "../src/lib.js";
import { liveStand } from "./maschinenLive.js";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function heuteListe(inp, { fw, vollst, closing = 0, muster = 0, freigaben = null, extern = null } = {}) {
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
  // Maschine meldet eine Störung (Live-Daten aus dem Maschinen-Dienst): ganz oben, damit umgeplant wird, wenn es länger dauert
  const live = liveStand();
  const gestoert = Object.values(live).filter((m) => m.zustand === "stoerung");
  if (gestoert.length) {
    const names = gestoert.map((m) => (MACHINES.find((x) => x.id === m.id) || {}).short || m.id);
    add("stoerung", gestoert.length, `${names.join(", ")} ${gestoert.length === 1 ? "meldet" : "melden"} eine Störung`, "bad", "planverbessern", (gestoert[0].fehler || [])[0] || "Dauert es länger: Positionen auf andere Maschinen umlegen");
  }
  // Was die KI vorbereitet hat und auf eine Freigabe wartet, steht ganz oben
  if (freigaben) {
    const plan = freigaben.filter((f) => f.art === "plan").length;
    const av = freigaben.filter((f) => f.art === "av").length;
    const rest = freigaben.length - plan - av;
    const parts = [plan ? "Planvorschlag" : null, av ? plural(av, "AV-Paket", "AV-Pakete") : null, rest ? plural(rest, "Hinweis", "Hinweise") : null].filter(Boolean);
    add("freigaben", freigaben.length, `${plural(freigaben.length, "Vorschlag wartet", "Vorschläge warten")} auf Freigabe`, "warn", "freigaben", parts.join(", ") + " prüfen und freigeben");
  }
  if (fw) {
    const late = (fw.items || []).filter((i) => i.state === "offen" || i.state === "erneut");
    const kunden = new Set(late.map((i) => i.customer || i.label)).size;
    add("kunden", late.length, `${plural(late.length, "Auftrag", "Aufträge")} im Verzug, Kunde weiß noch nichts`, "bad", "fruehwarnung", `${plural(kunden, "Kunde", "Kunden")} anrufen oder anschreiben`);
  }
  if (extern) {
    add("lieferant", extern.anfragen, `${plural(extern.anfragen, "Lieferung ist", "Lieferungen sind")} überfällig, Lieferant anfragen`, "bad", "extern", extern.kundeGefahr ? `davon ${extern.kundeGefahr} mit Kundentermin in Gefahr` : "Wareneingang noch nicht validiert");
    add("bestellungFehlt", extern.fehltDringend, `${plural(extern.fehltDringend, "externer Arbeitsgang", "externe Arbeitsgänge")} ohne Bestellung`, "warn", "extern", "Maschine ist in 7 Tagen fertig, Lohnarbeit bestellen");
    add("lieferantVorab", extern.vorab, `${plural(extern.vorab, "Lieferung", "Lieferungen")} in 2 Werktagen fällig`, "warn", "extern", "beim Lieferanten vorab nachfragen");
  }
  if (vollst) add("fehlt", vollst.fehlt.length, `${plural(vollst.fehlt.length, "Kundenauftrag fehlt", "Kundenaufträge fehlen")} in der App`, "bad", "av", "In der Arbeitsvorbereitung übernehmen");
  add("avLate", avLate, `${plural(avLate, "Position ist", "Positionen sind")} in der AV überfällig`, "bad", "av", "„Muss bis“ ist überschritten, die Maschine wartet sonst");
  add("ohneStunden", noHours.length, `${plural(noHours.length, "Position hat", "Positionen haben")} noch keine Stunden`, "warn", "pool", withSuggest.length ? `für ${withSuggest.length} gibt es einen Vorschlag aus früheren Aufträgen` : "ohne Stunden kann nichts eingeplant werden");
  add("einplanen", ready.length, `${plural(ready.length, "Position wartet", "Positionen warten")} auf eine Maschine`, "warn", "planverbessern", "„Plan verbessern“ macht einen Vorschlag");
  add("material", notOrdered, `${plural(notOrdered, "Position", "Positionen")}: nur Anfrage in Odoo, Material klären`, "warn", "av", "bestellt? Dann in der AV „in Arbeit“ mit Datum oder „bereit“ eintragen");
  add("avSoon", avSoon, `${plural(avSoon, "Position startet", "Positionen starten")} in 7 Tagen, AV noch nicht fertig`, "warn", "av");
  if (vollst) add("ohneBeleg", vollst.ohneBeleg.length, `${plural(vollst.ohneBeleg.length, "Kundenauftrag", "Kundenaufträge")} ohne Fertigungs- oder Einkaufsbeleg`, "warn", "av", "prüfen oder abhaken");
  add("schliessen", closing, `${plural(closing, "Position ist", "Positionen sind")} in Odoo erledigt, in der App noch offen`, "mute", "sync", "beim Odoo-Abgleich schließen");
  add("muster", muster, `${plural(muster, "Auftrag läuft", "Aufträge laufen")} auf Musterwerten`, "mute", "av", "Maschine und Zeit in Odoo prüfen");
  return { stand: new Date().toISOString(), today, items, alles: !items.some((i) => i.tone !== "mute") };
}

export default function registerHeute(app, db, helpers) {
  const liste = () => {
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
    let freigaben = null;
    try {
      freigaben = app.locals.freigaben ? app.locals.freigaben.offen() : null;
    } catch {
      freigaben = null;
    }
    let extern = null;
    try {
      extern = app.locals.extern ? app.locals.extern.zahlen() : null;
    } catch {
      extern = null;
    }
    return heuteListe(inp, { fw, vollst: odoo.vollst || null, closing: odoo.closing || 0, muster: odoo.muster || 0, freigaben, extern });
  };
  app.locals.heuteListe = liste;
  app.get("/api/heute", (req, res) => res.json(liste()));
}
