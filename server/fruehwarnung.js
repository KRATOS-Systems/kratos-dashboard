// Frühwarnung bei Lieferverzug.
//
// Rechnet mit derselben Planungslogik wie das Planungsfenster (über server/talosPlan.js), wann jeder Auftrag fertig wird, und meldet:
//   verzug   Der Auftrag wird laut Plan nach dem Liefertermin fertig, oder der Liefertermin ist schon überschritten.
//   risiko   Der Liefertermin liegt in den nächsten Tagen, aber noch nicht alle Positionen sind eingeplant.
// Zu jedem Verzug: Grund (was hält den Auftrag auf), Vorschlag für einen neuen Termin (Ende laut Plan plus Mindestpuffer, nächster Werktag),
// eine Empfehlung für den Weg (anrufen oder Mail) und die Kontaktdaten des Kunden aus Odoo.
// Der Kunde wird telefonisch oder per Mail informiert, eins von beiden reicht. Für die Mail gibt es einen Entwurf (auch als Bestätigung nach einem
// Telefonat), gesendet wird nichts: Ein Mensch öffnet den Entwurf im Mailprogramm, prüft und schickt ihn ab.
// Beim Abhaken "Kunde informiert" wird der genannte neue Termin zum Liefertermin des Auftrags, der ursprüngliche bleibt im Terminverlauf
// (server/dueHistory.js). Verschiebt sich der Termin danach weiter, meldet die App den Auftrag erneut.
// Odoo wird nur gelesen (Ansprechpartner, Telefon, E-Mail und Bestellnummer des Kunden).

import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { avSummary } from "../src/avLib.js";
import { addDays, daysBetween, todayStr } from "../src/lib.js";
import { LANE_IDS, tagsOf } from "../src/planLogic.js";
import { staffName } from "../src/staffLib.js";

const RISK_DAYS = 10; // Liefertermin in so vielen Tagen und noch nicht alles eingeplant: Risiko
const CALL_WORKDAYS = 5; // weniger Arbeitstage bis zum Liefertermin: anrufen statt Mail
const EVERY = 30 * 60 * 1000;
const COMPANY = process.env.COMPANY_NAME || "KRATOS Precision GmbH";
const CHANNELS = ["telefon", "mail", "beides"];
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const fmt = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function registerFruehwarnung(app, db, helpers) {
  db.exec(`
    -- Verzug je Auftrag: seit wann bekannt, und ob (auf welchem Weg, mit welchem Termin) der Kunde informiert wurde
    CREATE TABLE IF NOT EXISTS delay_notice (
      source TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      informed_at TEXT,
      informed_by TEXT,
      informed_date TEXT,
      note TEXT NOT NULL DEFAULT ''
    );
  `);
  const cols = db.prepare("PRAGMA table_info(delay_notice)").all().map((c) => c.name);
  if (!cols.includes("channel")) db.exec("ALTER TABLE delay_notice ADD COLUMN channel TEXT");
  if (!cols.includes("contact")) db.exec("ALTER TABLE delay_notice ADD COLUMN contact TEXT");

  // Liefert die Liste und (nur intern) die offenen Positionen je Auftrag
  function compute(today = todayStr()) {
    const inputs = loadPlanInputs(db, helpers, today);
    const ctx = makeContext(inputs);
    const { groups } = ctx.compute(inputs.orders);
    const buffer = Math.max(0, Math.round(Number(inputs.settings.tight_days) || 0));
    const freeDates = new Set(inputs.freeDays.map((d) => d.date));
    const isWorkday = (d) => ![0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay()) && !freeDates.has(d);
    // Nächster Werktag (Montag bis Freitag, kein freier Tag) ab dem angegebenen Tag
    const workday = (d) => {
      let x = d;
      for (let i = 0; i < 30 && !isWorkday(x); i++) x = addDays(x, 1);
      return x;
    };
    // Arbeitstage von morgen bis einschließlich Liefertermin
    const workdaysUntil = (due) => {
      let n = 0;
      for (let d = addDays(today, 1), i = 0; d <= due && i < 400; d = addDays(d, 1), i++) if (isWorkday(d)) n++;
      return n;
    };
    const known = new Map(db.prepare("SELECT * FROM delay_notice").all().map((n) => [n.source, n]));
    const insert = db.prepare("INSERT OR IGNORE INTO delay_notice (source, first_seen) VALUES (?, ?)");
    const items = [];
    const openIds = new Map();
    for (const g of groups) {
      if (!g.due) continue;
      const open = g.positions.filter((o) => !o.done);
      const forecast = g.end != null ? ctx.endDateOf(g.end) : null;
      const overdue = g.due < today;
      const late = g.status === "late" || overdue;
      const daysLeft = daysBetween(today, g.due);
      const risk = !late && g.unscheduled > 0 && daysLeft <= RISK_DAYS;
      const source = g.key;
      const prior = known.get(source);
      // Aufträge, bei denen der Kunde schon informiert wurde, bleiben sichtbar, auch wenn der neue Termin jetzt hält
      if (!late && !risk && !(prior && prior.informed_at)) continue;
      openIds.set(source, open.map((o) => o.id));
      // Belastbar ist die Prognose erst, wenn alle offenen Positionen eingeplant sind
      const complete = g.unscheduled === 0 && !!forecast;
      const base = complete ? (forecast > today ? forecast : today) : null;
      const proposal = late && base ? workday(addDays(base, buffer)) : null;
      const lateDays = !late ? 0 : proposal ? Math.max(0, daysBetween(g.due, proposal)) : overdue ? daysBetween(g.due, today) : g.lateDays || 0;

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

      if (late) insert.run(source, today);
      const n = prior || (late ? { first_seen: today } : null);
      const informed = !!(n && n.informed_at);
      const again = late && informed && !!proposal && !!n.informed_date && proposal > n.informed_date;
      // Terminverlauf des Auftrags: frühester ursprünglicher Termin und die meisten Verschiebungen seiner offenen Positionen
      const shifted = open.filter((o) => o.due_shifts > 0 && o.due_original);
      const shifts = shifted.reduce((m, o) => Math.max(m, o.due_shifts), 0);
      const original = shifted.map((o) => o.due_original).sort()[0] || null;
      const workdaysLeft = overdue ? 0 : workdaysUntil(g.due);
      items.push({
        source,
        label: g.label,
        customer: open.map((o) => o.customer).find(Boolean) || null,
        due: g.due,
        dueOriginal: original && original !== g.due ? original : null,
        dueShifts: shifts,
        forecast: complete ? forecast : null,
        proposal,
        lateDays,
        daysLeft,
        kind: late ? "verzug" : risk ? "risiko" : "informiert",
        // offen = Kunde noch nicht informiert, erneut = Termin hat sich nach der Information weiter verschoben
        state: risk ? "risiko" : !informed ? "offen" : again ? "erneut" : "informiert",
        // Weg: kurzfristig, überfällig oder schon einmal verschoben = anrufen, sonst reicht eine Mail
        advice: overdue || workdaysLeft < CALL_WORKDAYS || shifts > 0 ? "anrufen" : "mail",
        adviceWhy: overdue ? "Liefertermin überschritten" : shifts > 0 ? "schon einmal verschoben" : workdaysLeft < CALL_WORKDAYS ? `nur noch ${plural(workdaysLeft, "Arbeitstag", "Arbeitstage")}` : "genug Vorlauf",
        since: n ? n.first_seen : null,
        informedAt: informed ? n.informed_at : null,
        informedBy: informed ? n.informed_by : null,
        informedDate: informed ? n.informed_date : null,
        channel: informed ? n.channel || null : null,
        contact: informed ? n.contact || null : null,
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
      openIds,
      out: {
        today,
        riskDays: RISK_DAYS,
        callWorkdays: CALL_WORKDAYS,
        buffer,
        items,
        counts: {
          verzug: items.filter((i) => i.kind === "verzug").length,
          nichtInformiert: items.filter((i) => i.state === "offen" || i.state === "erneut").length,
          risiko: items.filter((i) => i.kind === "risiko").length,
        },
      },
    };
  }

  // Ansprechpartner des Kundenauftrags aus Odoo (nur lesen): Person, Telefon, E-Mail, Bestellnummer des Kunden
  async function contactOf(source) {
    const c = { name: "", company: "", phone: "", email: "", ref: "", hint: "" };
    const read = app.locals.odooRead;
    if (!read) return { ...c, hint: "Odoo ist nicht verbunden: Kontaktdaten bitte selbst nachschlagen." };
    if (!/^[A-Z]\d{3,}$/.test(source)) return { ...c, hint: "Zu diesem Auftrag gibt es keinen Kundenauftrag in Odoo." };
    try {
      const so = await read("sale.order", { domain: [["name", "=", source]], fields: ["partner_id", "client_order_ref"], limit: 1 });
      if (!so[0]) return { ...c, hint: "Der Kundenauftrag wurde in Odoo nicht gefunden." };
      c.ref = so[0].client_order_ref ? String(so[0].client_order_ref).trim() : "";
      const pid = Array.isArray(so[0].partner_id) ? so[0].partner_id[0] : null;
      const pname = Array.isArray(so[0].partner_id) ? String(so[0].partner_id[1]) : "";
      // "Firma, Ansprechpartner": Der Teil nach dem Komma ist die Person
      c.company = pname.split(",")[0].trim();
      if (pname.includes(",")) c.name = pname.split(",").slice(1).join(",").trim();
      if (pid) {
        const p = await read("res.partner", { domain: [["id", "=", pid]], fields: ["email", "phone"], limit: 1 });
        if (p[0]) {
          if (typeof p[0].email === "string") c.email = p[0].email.trim();
          if (typeof p[0].phone === "string") c.phone = p[0].phone.trim();
        }
      }
    } catch (err) {
      c.hint = "Kontaktdaten konnten nicht aus Odoo gelesen werden: " + err.message;
    }
    return c;
  }

  // Entwurf der Nachricht an den Kunden (nur Text, gesendet wird nichts). afterCall = Bestätigung nach einem Telefonat
  async function draft(item, date, sender, afterCall) {
    const c = await contactOf(item.source);
    const hint = c.hint || (!c.email ? "Beim Kunden ist in Odoo keine E-Mail-Adresse hinterlegt: Empfänger bitte selbst eintragen." : "");
    const order = c.ref ? `Ihrer Bestellung ${c.ref}` : "Ihrem Auftrag";
    const was = item.dueOriginal || item.due;
    const head = afterCall
      ? [`wie eben telefonisch besprochen, bestätigen wir Ihnen den neuen Liefertermin zu ${order} (unser Auftrag ${item.label}).`]
      : [`zu ${order} (unser Auftrag ${item.label}) müssen wir Ihnen leider eine Terminverschiebung mitteilen.`];
    const tail = afterCall
      ? ["Vielen Dank für Ihr Verständnis."]
      : [`Grund ist ${item.customerReason}.`, "", "Wir bitten, die Verzögerung zu entschuldigen. Wenn der neue Termin für Sie kritisch ist, melden Sie sich bitte kurz. Wir prüfen dann eine Teillieferung oder eine andere Lösung."];
    const lines = [
      c.name ? `Guten Tag ${c.name},` : "Sehr geehrte Damen und Herren,",
      "",
      ...head,
      "",
      ...(item.parts.length ? ["Betroffen:", ...item.parts.map((p) => "- " + p), ""] : []),
      `Bisher zugesagter Liefertermin: ${fmt(was)}`,
      date ? `Neuer voraussichtlicher Liefertermin: ${fmt(date)}` : "Neuer voraussichtlicher Liefertermin: [bitte eintragen]",
      "",
      ...tail,
      "",
      "Mit freundlichen Grüßen",
      ...(sender ? [sender] : []),
      COMPANY,
    ];
    return { source: item.source, to: c.email, subject: `Liefertermin zu ${order} (unser Auftrag ${item.label})`, body: lines.join("\n"), date: date || null, afterCall: !!afterCall, hint };
  }

  const sessionName = (req) => {
    const s = app.locals.bdeSession ? app.locals.bdeSession(req) : null;
    return s ? staffName(s.e) || null : null;
  };

  app.get("/api/fruehwarnung", (req, res) => res.json(compute().out));

  app.get("/api/fruehwarnung/kontakt", async (req, res) => {
    const source = String(req.query.source || "").trim();
    if (!compute().out.items.some((i) => i.source === source)) return res.status(404).json({ error: "Dieser Auftrag steht nicht in der Frühwarnung" });
    res.json(await contactOf(source));
  });

  app.get("/api/fruehwarnung/mail", async (req, res) => {
    const source = String(req.query.source || "").trim();
    const item = compute().out.items.find((i) => i.source === source && i.kind !== "risiko");
    if (!item) return res.status(404).json({ error: "Für diesen Auftrag gibt es keinen Verzug" });
    const date = isDate(req.query.date) ? req.query.date : item.proposal || item.informedDate;
    res.json(await draft(item, date, sessionName(req), req.query.nachTelefon === "1"));
  });

  // Kunde wurde informiert (Weg, Gesprächspartner, genannter neuer Termin) oder den Vermerk wieder lösen
  app.post("/api/fruehwarnung/informiert", (req, res) => {
    const { source, date, note, undo, channel, contact } = req.body || {};
    if (typeof source !== "string" || !source.trim() || source.length > 60) return res.status(400).json({ error: "Auftrag fehlt" });
    if (!db.prepare("SELECT 1 FROM delay_notice WHERE source = ?").get(source)) return res.status(404).json({ error: "Für diesen Auftrag gibt es keinen Verzug" });
    if (undo) db.prepare("UPDATE delay_notice SET informed_at = NULL, informed_by = NULL, informed_date = NULL, channel = NULL, contact = NULL, note = '' WHERE source = ?").run(source);
    else {
      if (date !== undefined && date !== null && !isDate(date)) return res.status(400).json({ error: "Der neue Termin ist kein gültiges Datum" });
      if (channel !== undefined && channel !== null && !CHANNELS.includes(channel)) return res.status(400).json({ error: "Weg unbekannt (telefon, mail oder beides)" });
      const way = channel || "mail";
      const who = sessionName(req);
      const person = String(contact || "").trim().slice(0, 120);
      const ids = compute().openIds.get(source) || [];
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE delay_notice SET informed_at = ?, informed_by = ?, informed_date = COALESCE(?, informed_date), channel = ?, contact = ?, note = ? WHERE source = ?").run(
          new Date().toISOString(),
          who,
          date || null,
          way,
          person || null,
          String(note || "").trim().slice(0, 300),
          source
        );
        // Der dem Kunden genannte Termin wird der neue Liefertermin, der alte bleibt im Terminverlauf
        if (date) {
          const reason = `Kunde informiert (${way === "telefon" ? "Telefon" : way === "mail" ? "Mail" : "Telefon und Mail"}${person ? ", " + person : ""})`;
          const update = db.prepare("UPDATE orders SET due_date = ? WHERE id = ? AND done = 0");
          ids.forEach((id) => {
            if (helpers.dueChange) helpers.dueChange(id, date, { by: who, reason, via: "fruehwarnung" });
            update.run(date, id);
          });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
    res.json(compute().out);
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
