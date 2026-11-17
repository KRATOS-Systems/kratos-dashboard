// Frühwarnung bei Lieferverzug.
//
// Rechnet mit derselben Planungslogik wie das Planungsfenster (über server/talosPlan.js), wann jeder Auftrag fertig wird, und meldet:
//   verzug   Der Auftrag wird laut Plan nach dem Liefertermin fertig, oder der Liefertermin ist schon überschritten.
//   risiko   Der Liefertermin liegt in den nächsten Tagen, aber noch nicht alle Positionen sind eingeplant.
// Zu jedem Verzug: Grund (was hält den Auftrag auf), Vorschlag für einen neuen Termin (Ende laut Plan plus Mindestpuffer, nächster Werktag)
// und ein Entwurf für die Nachricht an den Kunden. Gesendet wird nichts: Ein Mensch öffnet den Entwurf im Mailprogramm, prüft und schickt ihn ab.
// Die App merkt sich, seit wann ein Verzug bekannt ist und ob der Kunde informiert wurde. Verschiebt sich der Termin danach weiter, meldet sie das erneut.
// Odoo wird nur gelesen (Ansprechpartner und Bestellnummer des Kunden für den Entwurf).

import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { avSummary } from "../src/avLib.js";
import { addDays, daysBetween, todayStr } from "../src/lib.js";
import { LANE_IDS, tagsOf } from "../src/planLogic.js";
import { staffName } from "../src/staffLib.js";

const RISK_DAYS = 10; // Liefertermin in so vielen Tagen und noch nicht alles eingeplant: Risiko
const EVERY = 30 * 60 * 1000;
const COMPANY = process.env.COMPANY_NAME || "KRATOS Precision GmbH";
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const fmt = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function registerFruehwarnung(app, db, helpers) {
  db.exec(`
    -- Verzug je Auftrag: seit wann bekannt, und ob (mit welchem Termin) der Kunde informiert wurde
    CREATE TABLE IF NOT EXISTS delay_notice (
      source TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      informed_at TEXT,
      informed_by TEXT,
      informed_date TEXT,
      note TEXT NOT NULL DEFAULT ''
    );
  `);

  function compute(today = todayStr()) {
    const inputs = loadPlanInputs(db, helpers, today);
    const ctx = makeContext(inputs);
    const { groups } = ctx.compute(inputs.orders);
    const buffer = Math.max(0, Math.round(Number(inputs.settings.tight_days) || 0));
    const freeDates = new Set(inputs.freeDays.map((d) => d.date));
    // Nächster Werktag (Montag bis Freitag, kein freier Tag) ab dem angegebenen Tag
    const workday = (d) => {
      let x = d;
      for (let i = 0; i < 30 && ([0, 6].includes(new Date(x + "T00:00:00Z").getUTCDay()) || freeDates.has(x)); i++) x = addDays(x, 1);
      return x;
    };
    const known = new Map(db.prepare("SELECT * FROM delay_notice").all().map((n) => [n.source, n]));
    const insert = db.prepare("INSERT OR IGNORE INTO delay_notice (source, first_seen) VALUES (?, ?)");
    const items = [];
    for (const g of groups) {
      if (!g.due) continue;
      const open = g.positions.filter((o) => !o.done);
      const forecast = g.end != null ? ctx.endDateOf(g.end) : null;
      const overdue = g.due < today;
      const late = g.status === "late" || overdue;
      const daysLeft = daysBetween(today, g.due);
      const risk = !late && g.unscheduled > 0 && daysLeft <= RISK_DAYS;
      if (!late && !risk) continue;
      // Belastbar ist die Prognose erst, wenn alle offenen Positionen eingeplant sind
      const complete = g.unscheduled === 0 && !!forecast;
      const base = complete ? (forecast > today ? forecast : today) : null;
      const proposal = late && base ? workday(addDays(base, buffer)) : null;
      const lateDays = proposal ? Math.max(0, daysBetween(g.due, proposal)) : overdue ? daysBetween(g.due, today) : g.lateDays || 0;

      const reasons = [];
      const drafts = open.filter((o) => o.odoo_draft);
      if (drafts.length) reasons.push(`In Odoo nicht freigegeben: ${drafts.map((o) => o.odoo_ref || o.order_no).join(", ")}`);
      const noMachine = open.filter((o) => o.machine === "").length;
      const noHours = open.filter((o) => o.machine !== "" && !LANE_IDS.includes(o.machine) && !(o.hours > 0)).length;
      if (noMachine) reasons.push(`${noMachine} von ${plural(open.length, "offenen Position", "offenen Positionen")} nicht eingeplant`);
      if (noHours) reasons.push(`${plural(noHours, "Position", "Positionen")} ohne Stunden, das Ende ist nicht berechenbar`);
      const avOpen = new Set();
      open.filter((o) => !LANE_IDS.includes(o.machine)).forEach((o) => avSummary(inputs.checks, o.id).open.forEach((x) => avOpen.add(x.label)));
      if (avOpen.size) reasons.push("Arbeitsvorbereitung offen: " + [...avOpen].join(", "));
      const material = open.some((o) => /nicht verf/i.test(o.component_status || ""));
      if (material) reasons.push("Material laut Odoo nicht verfügbar");
      const externTags = [...new Set(open.flatMap(tagsOf))];
      const extern = externTags.length > 0 || open.some((o) => o.machine === "extern" || o.machine === "extern_fert");
      if (extern) reasons.push(`Externe Bearbeitung${externTags.length ? ": " + externTags.join(", ") : ""}${g.externDays ? ` (${plural(g.externDays, "Tag", "Tage")})` : ""}`);
      if (complete) reasons.push(`Laut Plan fertig am ${fmt(forecast)}${g.endMachine ? " (" + g.endMachine + ")" : ""}`);

      const source = g.key;
      if (late) insert.run(source, today);
      const n = known.get(source) || (late ? { first_seen: today } : null);
      const informed = !!(n && n.informed_at);
      const again = informed && !!proposal && !!n.informed_date && proposal > n.informed_date;
      items.push({
        source,
        label: g.label,
        customer: open.map((o) => o.customer).find(Boolean) || null,
        due: g.due,
        forecast: complete ? forecast : null,
        proposal,
        lateDays,
        daysLeft,
        kind: late ? "verzug" : "risiko",
        // offen = Kunde noch nicht informiert, erneut = Termin hat sich nach der Information weiter verschoben
        state: !late ? "risiko" : !informed ? "offen" : again ? "erneut" : "informiert",
        since: n ? n.first_seen : null,
        informedAt: informed ? n.informed_at : null,
        informedBy: informed ? n.informed_by : null,
        informedDate: informed ? n.informed_date : null,
        note: n && n.note ? n.note : "",
        reasons,
        customerReason: material ? "eine Verzögerung bei der Materialbeschaffung" : extern ? "eine längere Durchlaufzeit bei der externen Bearbeitung" : "die hohe Auslastung in unserer Fertigung",
        parts: [...new Set(open.map((o) => [o.quantity != null ? `${o.quantity} Stück` : null, o.product].filter(Boolean).join(" ")).filter(Boolean))].slice(0, 8),
        positions: open.length,
        unscheduled: g.unscheduled,
      });
    }
    // Aufräumen: Aufträge, die es nicht mehr gibt (erledigt), und nicht mehr gefährdete ohne Information an den Kunden
    const openKeys = new Set(groups.map((g) => g.key));
    const lateKeys = new Set(items.filter((i) => i.kind === "verzug").map((i) => i.source));
    const drop = db.prepare("DELETE FROM delay_notice WHERE source = ?");
    known.forEach((n, source) => {
      if (!openKeys.has(source) || (!lateKeys.has(source) && !n.informed_at)) drop.run(source);
    });
    const rank = { offen: 0, erneut: 0, risiko: 1, informiert: 2 };
    items.sort((a, b) => rank[a.state] - rank[b.state] || a.due.localeCompare(b.due) || a.label.localeCompare(b.label));
    return {
      today,
      riskDays: RISK_DAYS,
      buffer,
      items,
      counts: {
        verzug: items.filter((i) => i.kind === "verzug").length,
        nichtInformiert: items.filter((i) => i.state === "offen" || i.state === "erneut").length,
        risiko: items.filter((i) => i.kind === "risiko").length,
      },
    };
  }

  // Entwurf der Nachricht an den Kunden (nur Text, gesendet wird nichts)
  async function draft(item, date, sender) {
    let to = "";
    let ref = "";
    let contact = "";
    let hint = "";
    const read = app.locals.odooRead;
    if (read && /^[A-Z]\d{3,}$/.test(item.source)) {
      try {
        const so = await read("sale.order", { domain: [["name", "=", item.source]], fields: ["partner_id", "client_order_ref"], limit: 1 });
        if (so[0]) {
          ref = so[0].client_order_ref ? String(so[0].client_order_ref).trim() : "";
          const pid = Array.isArray(so[0].partner_id) ? so[0].partner_id[0] : null;
          const pname = Array.isArray(so[0].partner_id) ? String(so[0].partner_id[1]) : "";
          // "Firma, Ansprechpartner": Der Teil nach dem Komma ist die Person
          if (pname.includes(",")) contact = pname.split(",").slice(1).join(",").trim();
          if (pid) {
            const p = await read("res.partner", { domain: [["id", "=", pid]], fields: ["email"], limit: 1 });
            if (p[0] && typeof p[0].email === "string") to = p[0].email.trim();
          }
        }
      } catch (err) {
        hint = "Ansprechpartner konnte nicht aus Odoo gelesen werden: " + err.message;
      }
    } else if (!read) hint = "Odoo ist nicht verbunden: Empfänger und Bestellnummer bitte selbst eintragen.";
    if (!to && !hint) hint = "Beim Kunden ist in Odoo keine E-Mail-Adresse hinterlegt: Empfänger bitte selbst eintragen.";
    const order = ref ? `Ihrer Bestellung ${ref}` : "Ihrem Auftrag";
    const subject = `Liefertermin zu ${order} (unser Auftrag ${item.label})`;
    const lines = [
      contact ? `Guten Tag ${contact},` : "Sehr geehrte Damen und Herren,",
      "",
      `zu ${order} (unser Auftrag ${item.label}) müssen wir Ihnen leider eine Terminverschiebung mitteilen.`,
      "",
      ...(item.parts.length ? ["Betroffen:", ...item.parts.map((p) => "- " + p), ""] : []),
      `Bisher zugesagter Liefertermin: ${fmt(item.due)}`,
      date ? `Neuer voraussichtlicher Liefertermin: ${fmt(date)}` : "Neuer voraussichtlicher Liefertermin: [bitte eintragen]",
      "",
      `Grund ist ${item.customerReason}.`,
      "",
      "Wir bitten, die Verzögerung zu entschuldigen. Wenn der neue Termin für Sie kritisch ist, melden Sie sich bitte kurz. Wir prüfen dann eine Teillieferung oder eine andere Lösung.",
      "",
      "Mit freundlichen Grüßen",
      ...(sender ? [sender] : []),
      COMPANY,
    ];
    return { source: item.source, to, subject, body: lines.join("\n"), date: date || null, hint };
  }

  app.get("/api/fruehwarnung", (req, res) => res.json(compute()));

  app.get("/api/fruehwarnung/mail", async (req, res) => {
    const source = String(req.query.source || "").trim();
    const item = compute().items.find((i) => i.source === source && i.kind === "verzug");
    if (!item) return res.status(404).json({ error: "Für diesen Auftrag gibt es keinen Verzug" });
    const date = isDate(req.query.date) ? req.query.date : item.proposal;
    const session = app.locals.bdeSession ? app.locals.bdeSession(req) : null;
    res.json(await draft(item, date, session ? staffName(session.e) : null));
  });

  // Kunde wurde informiert (mit dem genannten neuen Termin) oder den Vermerk wieder lösen
  app.post("/api/fruehwarnung/informiert", (req, res) => {
    const { source, date, note, undo } = req.body || {};
    if (typeof source !== "string" || !source.trim() || source.length > 60) return res.status(400).json({ error: "Auftrag fehlt" });
    if (!db.prepare("SELECT 1 FROM delay_notice WHERE source = ?").get(source)) return res.status(404).json({ error: "Für diesen Auftrag gibt es keinen Verzug" });
    if (undo) db.prepare("UPDATE delay_notice SET informed_at = NULL, informed_by = NULL, informed_date = NULL, note = '' WHERE source = ?").run(source);
    else {
      if (date !== undefined && date !== null && !isDate(date)) return res.status(400).json({ error: "Der neue Termin ist kein gültiges Datum" });
      const session = app.locals.bdeSession ? app.locals.bdeSession(req) : null;
      db.prepare("UPDATE delay_notice SET informed_at = ?, informed_by = ?, informed_date = ?, note = ? WHERE source = ?").run(
        new Date().toISOString(),
        session ? staffName(session.e) || null : null,
        date || null,
        String(note || "").trim().slice(0, 300),
        source
      );
    }
    res.json(compute());
  });

  // Regelmäßig rechnen, damit der Tag festgehalten wird, an dem ein Verzug entsteht, auch wenn niemand die Seite offen hat
  const tick = () => {
    try {
      compute();
    } catch (err) {
      console.error("Frühwarnung: Berechnung fehlgeschlagen", err.message);
    }
  };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, EVERY).unref();
}
