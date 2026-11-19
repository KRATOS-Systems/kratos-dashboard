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
import { addDays, daysBetween, todayStr, MACHINES } from "../src/lib.js";
import { ablaufOf } from "../src/ablauf.js";
import { LANE_IDS, tagsOf } from "../src/planLogic.js";
import { staffName } from "../src/staffLib.js";
import { postNotiz } from "./odooNotiz.js";

const RISK_DAYS = 10; // Liefertermin in so vielen Tagen und noch nicht alles eingeplant: Risiko
const CALL_WORKDAYS = 5; // weniger Arbeitstage bis zum Liefertermin: anrufen statt Mail
const EVERY = 30 * 60 * 1000;
const COMPANY = process.env.COMPANY_NAME || "KRATOS Precision GmbH";
const CHANNELS = ["telefon", "mail", "beides"];
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const fmt = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const DRAFT_COLS = ["draft_date", "draft_channel", "draft_contact", "draft_email", "draft_note", "draft_at", "draft_by"];

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
  // Entwurf vor dem Anruf: Termin, Weg, Gesprächspartner, E-Mail und Notiz bleiben gespeichert, bis „informiert“ geklickt wird
  DRAFT_COLS.forEach((c) => !cols.includes(c) && db.exec(`ALTER TABLE delay_notice ADD COLUMN ${c} TEXT`));
  // Jeder Kontakt mit dem Kunden zu einem Auftrag (für den Verlauf: was wurde wann wem gesagt)
  db.exec(`
    CREATE TABLE IF NOT EXISTS delay_contact (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      at TEXT NOT NULL,
      by_name TEXT,
      channel TEXT,
      contact TEXT,
      date TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS delay_contact_source ON delay_contact (source);
  `);
  const ORT = { qs: "QS", extern: "Oberfläche extern", extern_fert: "Fertigung extern", "": "nicht eingeplant" };
  const ortOf = (m) => (m in ORT ? ORT[m] : (MACHINES.find((x) => x.id === m) || {}).short || m);
  // Was hilft gegen den jeweiligen Grund (kurz, als Hinweis fürs Gespräch und für danach)
  const HILFT = [
    [/^In Odoo nicht freigegeben/, "FA in Odoo bestätigen (AV: „Fertigungsauftrag bestätigen“)"],
    [/nicht eingeplant/, "Einplanen: „Plan verbessern“ macht einen Vorschlag"],
    [/ohne Stunden/, "Stunden aus der Kalkulation übernehmen (AV)"],
    [/^Arbeitsvorbereitung offen/, "In der AV erledigen oder Termin für die offenen Punkte setzen"],
    [/^Material kommt laut Einkauf/, "Beim Lieferanten einen früheren Termin anfragen (Reiter Extern)"],
    [/^Material laut Odoo nicht verfügbar/, "Material klären: bestellt? Dann in der AV „in Arbeit“ mit Datum"],
    [/^Externe Bearbeitung/, "Beim Lieferanten nachfragen, ob es schneller geht (Reiter Extern)"],
    [/^Laut Plan fertig/, "Maschine ausgelastet: in „Plan verbessern“ andere Maschine oder Reihenfolge prüfen"],
  ];
  const hilftOf = (r) => (HILFT.find(([re]) => re.test(r)) || [null, null])[1];
  const dueRows = db.prepare("SELECT order_id, old_due, new_due, at, by_name, reason FROM due_history ORDER BY at");
  const contactRows = db.prepare("SELECT at, by_name, channel, contact, date, note FROM delay_contact WHERE source = ? ORDER BY at");
  if (!cols.includes("odoo_info")) db.exec("ALTER TABLE delay_notice ADD COLUMN odoo_info TEXT");

  // Liefert die Liste und (nur intern) die offenen Positionen je Auftrag
  function compute(today = todayStr()) {
    const inputs = loadPlanInputs(db, helpers, today);
    const ctx = makeContext(inputs);
    const { groups, plan } = ctx.compute(inputs.orders);
    // voraussichtliches Ende je Position (für die Teile-Liste)
    const endOf = new Map();
    plan.forEach((p) => p.items.forEach((i) => i.scheduled && endOf.set(i.o.id, ctx.endDateOf(i.end))));
    let dueAll = null; // Terminverlauf, nur einmal je Berechnung gelesen
    const dueOf = (ids) => {
      if (!dueAll) {
        dueAll = new Map();
        dueRows.all().forEach((r) => {
          if (!dueAll.has(r.order_id)) dueAll.set(r.order_id, []);
          dueAll.get(r.order_id).push(r);
        });
      }
      // dieselbe Verschiebung mehrerer Positionen nur einmal
      const seen = new Set();
      return ids
        .flatMap((id) => dueAll.get(id) || [])
        .sort((a, b) => a.at.localeCompare(b.at))
        .filter((r) => {
          const k = r.old_due + ">" + r.new_due + "@" + r.at.slice(0, 16);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .map((r) => ({ at: r.at, von: r.old_due, nach: r.new_due, wer: r.by_name || null, grund: r.reason || null }));
    };
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
      const matLate = open.filter((o) => o.material_date && o.material_date >= today && !(o.done_hours > 0)).sort((a, b) => b.material_date.localeCompare(a.material_date))[0];
      const material = !!matLate || open.some((o) => /nicht verf/i.test(o.component_status || ""));
      if (matLate) reasons.push(`Material kommt laut Einkauf am ${fmt(matLate.material_date)}${matLate.material_info ? " (" + matLate.material_info.split(",")[0] + ")" : ""}`);
      else if (material) reasons.push("Material laut Odoo nicht verfügbar");
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
        draft:
          n && (n.draft_note || n.draft_contact || n.draft_date || n.draft_email)
            ? { date: n.draft_date || null, channel: n.draft_channel || null, contact: n.draft_contact || "", email: n.draft_email || "", note: n.draft_note || "", at: n.draft_at || null, by: n.draft_by || null }
            : null,
        odooInfo: informed ? n.odoo_info || null : null,
        reasons,
        customerReason: material ? "eine Verzögerung bei der Materialbeschaffung" : extern ? "eine längere Durchlaufzeit bei der externen Bearbeitung" : "die hohe Auslastung in unserer Fertigung",
        parts: [...new Set(open.map((o) => [o.quantity != null ? `${o.quantity} Stück` : null, o.product].filter(Boolean).join(" ")).filter(Boolean))].slice(0, 8),
        positions: open.length,
        unscheduled: g.unscheduled,
        // Auftrag auf einen Blick: Teile mit Stand, Teillieferung, Gründe mit Hilfe, Verlauf
        teile: g.positions
          .slice()
          .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || String(a.odoo_ref || a.order_no).localeCompare(String(b.odoo_ref || b.order_no)))
          .map((o) => {
            const nx = o.done ? null : ablaufOf([o], inputs.checks).next;
            return {
              id: o.id,
              nr: o.odoo_ref || o.order_no || "",
              odooId: o.odoo_id || null,
              poId: o.po_id || null,
              produkt: o.product || "",
              menge: o.quantity != null ? o.quantity : null,
              ort: ortOf(o.machine || ""),
              fertig: !!o.done,
              ende: o.done ? o.done_date || null : endOf.get(o.id) || null,
              stand: o.done ? "fertig" : nx ? nx.label + (nx.detail ? ": " + nx.detail.replace(/^[A-Z]+\d[^:]*:\s*/, "") : "") : "fertig",
              laeuft: !!(nx && nx.running),
            };
          }),
        teillieferung: (() => {
          const fertig = g.positions.filter((o) => o.done);
          const gefertigt = open.filter((o) => o.produced_date);
          const stueck = (l) => l.reduce((s, o) => s + (Number(o.quantity) || 0), 0);
          const erst = open.map((o) => endOf.get(o.id)).filter(Boolean).sort()[0] || null;
          if (fertig.length && open.length)
            return { moeglich: true, text: `${fertig.length} von ${plural(g.positions.length, "Position", "Positionen")} fertig${stueck(fertig) ? ` (${stueck(fertig)} Stück)` : ""}: Teillieferung möglich` };
          if (gefertigt.length) return { moeglich: true, text: `${plural(gefertigt.length, "Position ist", "Positionen sind")} gefertigt (QS/extern): Teillieferung nach der Prüfung möglich` };
          if (open.length > 1 && erst) return { moeglich: false, text: `Noch nichts fertig. Erste Position voraussichtlich am ${fmt(erst)}` };
          return { moeglich: false, text: open.length > 1 ? "Noch nichts fertig" : "Nur eine Position: keine Teillieferung möglich" };
        })(),
        gruende: reasons.map((r) => ({ text: r, hilft: hilftOf(r) })),
        verlauf: {
          termine: dueOf(g.positions.map((o) => o.id)),
          kontakte: (() => {
            const list = contactRows.all(source).map((r) => ({ at: r.at, wer: r.by_name, weg: r.channel, mit: r.contact, termin: r.date, notiz: r.note || "" }));
            // vor dem Verlauf: nur der letzte Vermerk
            if (!list.length && n && n.informed_at) list.push({ at: n.informed_at, wer: n.informed_by, weg: n.channel, mit: n.contact, termin: n.informed_date, notiz: n.note || "" });
            return list;
          })(),
        },
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
    const c = { name: "", company: "", phone: "", email: "", ref: "", hint: "", personen: [], personId: null, soId: null, datum: null };
    const read = app.locals.odooRead;
    if (!read) return { ...c, hint: "Odoo ist nicht verbunden: Kontaktdaten bitte selbst nachschlagen." };
    if (!/^[A-Z]\d{3,}$/.test(source)) return { ...c, hint: "Zu diesem Auftrag gibt es keinen Kundenauftrag in Odoo." };
    try {
      const so = await read("sale.order", { domain: [["name", "=", source]], fields: ["partner_id", "client_order_ref", "date_order"], limit: 1 });
      if (!so[0]) return { ...c, hint: "Der Kundenauftrag wurde in Odoo nicht gefunden." };
      c.ref = so[0].client_order_ref ? String(so[0].client_order_ref).trim() : "";
      c.soId = so[0].id;
      c.datum = typeof so[0].date_order === "string" ? so[0].date_order.slice(0, 10) : null;
      const pid = Array.isArray(so[0].partner_id) ? so[0].partner_id[0] : null;
      const pname = Array.isArray(so[0].partner_id) ? String(so[0].partner_id[1]) : "";
      // "Firma, Ansprechpartner": Der Teil nach dem Komma ist die Person
      c.company = pname.split(",")[0].trim();
      if (pname.includes(",")) c.name = pname.split(",").slice(1).join(",").trim();
      if (pid) {
        const p = await read("res.partner", { domain: [["id", "=", pid]], fields: ["email", "phone", "parent_id"], limit: 1 });
        if (p[0]) {
          if (typeof p[0].email === "string") c.email = p[0].email.trim();
          if (typeof p[0].phone === "string") c.phone = p[0].phone.trim();
        }
        // Alle Ansprechpartner der Firma (Kontakte unter der Firma in Odoo) zur Auswahl, die Firma selbst zuerst
        c.personId = pid;
        const firmaId = p[0] && Array.isArray(p[0].parent_id) ? p[0].parent_id[0] : pid;
        const str = (v) => (typeof v === "string" ? v.trim() : "");
        const firma = await read("res.partner", { domain: [["id", "=", firmaId]], fields: ["name", "email", "phone"], limit: 1 });
        const leute = await read("res.partner", { domain: [["parent_id", "=", firmaId]], fields: ["name", "function", "email", "phone", "type"], limit: 60 });
        c.personen = [
          ...firma.map((f) => ({ id: f.id, name: str(f.name), funktion: "Firma (allgemein)", phone: str(f.phone), email: str(f.email), firma: true })),
          ...leute.filter((x) => x.type === "contact" || !x.type).map((x) => ({ id: x.id, name: str(x.name).includes(",") ? str(x.name).split(",").slice(1).join(",").trim() : str(x.name), funktion: str(x.function), phone: str(x.phone), email: str(x.email), firma: false })),
        ].filter((x) => x.name);
      }
    } catch (err) {
      c.hint = "Kontaktdaten konnten nicht aus Odoo gelesen werden: " + err.message;
    }
    return c;
  }

  // Entwurf der Nachricht an den Kunden (nur Text, gesendet wird nichts). afterCall = Bestätigung nach einem Telefonat
  async function draft(item, date, sender, afterCall, wahl = {}) {
    const c = await contactOf(item.source);
    if (wahl.email) c.email = wahl.email;
    if (wahl.name !== undefined && wahl.name !== null) c.name = wahl.name;
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
  // für "Heute zu tun" (server/heute.js)
  app.locals.fruehwarnung = () => compute().out;

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
    const an = String(req.query.an || "").trim().slice(0, 200);
    const name = req.query.name !== undefined ? String(req.query.name).trim().slice(0, 120) : undefined;
    res.json(await draft(item, date, sessionName(req), req.query.nachTelefon === "1", { email: an, name }));
  });

  // Entwurf vor dem Anruf speichern (wird beim Tippen laufend gesichert; erst „informiert“ übernimmt ihn)
  app.post("/api/fruehwarnung/entwurf", (req, res) => {
    const { source, date, channel, contact, email, note } = req.body || {};
    if (typeof source !== "string" || !source.trim() || source.length > 60) return res.status(400).json({ error: "Auftrag fehlt" });
    if (!db.prepare("SELECT 1 FROM delay_notice WHERE source = ?").get(source)) return res.status(404).json({ error: "Für diesen Auftrag gibt es keinen Verzug" });
    if (date !== undefined && date !== null && date !== "" && !isDate(date)) return res.status(400).json({ error: "Der Termin ist kein gültiges Datum" });
    if (channel !== undefined && channel !== null && !CHANNELS.includes(channel)) return res.status(400).json({ error: "Weg unbekannt" });
    const at = new Date().toISOString();
    db.prepare("UPDATE delay_notice SET draft_date = ?, draft_channel = ?, draft_contact = ?, draft_email = ?, draft_note = ?, draft_at = ?, draft_by = ? WHERE source = ?").run(
      date || null,
      channel || null,
      String(contact || "").trim().slice(0, 120) || null,
      String(email || "").trim().slice(0, 200) || null,
      String(note || "").slice(0, 1000) || null,
      at,
      sessionName(req),
      source
    );
    res.json({ ok: true, at });
  });

  // Neuen Liefertermin am Kundenauftrag in Odoo eintragen (nur „Zugesagtes Datum“) und die Verschiebung als interne Notiz in den Chatter
  async function odooTermin(item, { date, way, person, note, who }) {
    const w = app.locals.odooBde;
    const read = app.locals.odooRead;
    if (!w || !w.writeEnabled || !read) return { ok: false, grund: "Schreiben in Odoo ist nicht freigeschaltet (BDE_WRITE): Termin und Notiz bitte selbst in Odoo eintragen." };
    if (!/^[A-Z]\d{3,}$/.test(item.source)) return { ok: false, grund: "Zu diesem Auftrag gibt es keinen Kundenauftrag in Odoo." };
    try {
      const so = await read("sale.order", { domain: [["name", "=", item.source]], fields: ["commitment_date"], limit: 1 });
      if (!so[0]) return { ok: false, grund: "Der Kundenauftrag wurde in Odoo nicht gefunden." };
      const alt = typeof so[0].commitment_date === "string" ? so[0].commitment_date : null;
      const zeit = alt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(alt) ? alt.slice(11) : "07:00:00";
      const geschrieben = !alt || alt.slice(0, 10) !== date;
      if (geschrieben) await w.write("sale.order", "write", { ids: [so[0].id], vals: { commitment_date: `${date} ${zeit}` } });
      const vorher = alt ? alt.slice(0, 10) : item.due;
      const weg = way === "telefon" ? "Telefon" : way === "mail" ? "Mail" : "Telefon und Mail";
      const nr = item.dueShifts > 0 ? `${item.dueShifts}. Verschiebung` : "Verschiebung";
      const urspr = item.dueOriginal ? `, ursprünglich ${fmt(item.dueOriginal)}` : "";
      const body =
        (geschrieben
          ? `<p><b>Liefertermin verschoben: ${fmt(vorher)} → ${fmt(date)}</b> (${nr}${urspr})</p>`
          : `<p><b>Liefertermin ${fmt(date)} dem Kunden bestätigt</b>${item.dueOriginal ? ` (ursprünglich ${fmt(item.dueOriginal)})` : ""}</p>`) +
        `<p>Kunde informiert per ${weg}${person ? " (" + escHtml(person) + ")" : ""}.${note ? " Notiz: " + escHtml(note) : ""}</p>` +
        `<p>${escHtml(who || "Produktionsdashboard")} über das Produktionsdashboard</p>`;
      await postNotiz(w, "sale.order", so[0].id, body);
      return { ok: true, geschrieben, grund: null };
    } catch (err) {
      return { ok: false, grund: "Odoo: " + err.message };
    }
  }

  // Kunde wurde informiert (Weg, Gesprächspartner, genannter neuer Termin) oder den Vermerk wieder lösen
  app.post("/api/fruehwarnung/informiert", async (req, res) => {
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
        db.prepare(`UPDATE delay_notice SET ${DRAFT_COLS.map((c) => c + " = NULL").join(", ")} WHERE source = ?`).run(source);
        db.prepare("INSERT INTO delay_contact (source, at, by_name, channel, contact, date, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          source,
          new Date().toISOString(),
          who,
          way,
          person || null,
          date || null,
          String(note || "").trim().slice(0, 300) || null
        );
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
        return res.status(500).json({ error: "Speichern fehlgeschlagen: " + err.message });
      }
      // Termin und Chatter-Notiz in Odoo (nach dem Speichern in der App; ein Fehler dort hält den Vermerk nicht auf)
      if (date) {
        const item = compute().out.items.find((i) => i.source === source);
        if (item) {
          const odoo = await odooTermin(item, { date, way, person, note: String(note || "").trim().slice(0, 300), who });
          const info = odoo.ok ? `In Odoo eingetragen (${odoo.geschrieben ? "Termin und Notiz" : "Notiz, Termin stand schon"})` : odoo.grund;
          db.prepare("UPDATE delay_notice SET odoo_info = ? WHERE source = ?").run(info, source);
          return res.json({ ...compute().out, odoo: { ...odoo, info } });
        }
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
