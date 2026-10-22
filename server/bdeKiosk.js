// Kiosk für Kommen und Gehen (Version 3), ersetzt den Odoo-Kiosk der Anwesenheit.
//
// Ablauf: Chip an den Leser (er tippt die Nummer wie eine Tastatur) -> /scan erkennt den Mitarbeiter über hr.employee.barcode und sagt,
// ob es Kommen oder Gehen ist, und welche Maschinenläufe noch laufen. -> /confirm bucht:
//   Gehen: alle laufenden Personentätigkeiten enden jetzt, Maschinenläufe enden nur, wenn "Beenden" gewählt wurde, dann ausstempeln.
//   Kommen: einstempeln.
// Kommen/Gehen läuft über denselben Weg wie der Odoo-Kiosk (/hr_attendance/attendance_barcode_scanned mit dem Kiosk-Schlüssel der Firma),
// nicht durch direktes Schreiben in hr.attendance. Danach zeigt der Kiosk 5 Sekunden die persönliche Stundenkarte.
// Der Kiosk ist nur auf freigeschalteten Geräten nutzbar (Schlüssel BDE_KIOSK_KEY, einmal am Gerät eingegeben).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { kindOf, labelOf, m2o, parseOdoo } from "./bde.js";

const TICKET_MS = 90 * 1000;

export default function registerBdeKiosk(app, ctx) {
  const { odoo } = ctx;
  const tickets = new Map();
  let kioskToken = process.env.BDE_ODOO_KIOSK_TOKEN || null;

  function deviceOk(req) {
    const want = process.env.BDE_KIOSK_KEY || "";
    const got = String(req.headers["x-bde-kiosk"] || "");
    return !!want && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  }
  function guard(req, res) {
    if (!process.env.BDE_KIOSK_KEY) {
      res.status(403).json({ error: "Der Kiosk ist noch nicht eingerichtet (BDE_KIOSK_KEY fehlt)" });
      return false;
    }
    if (!deviceOk(req)) {
      res.status(403).json({ error: "Dieses Gerät ist nicht als Kiosk freigeschaltet", device: true });
      return false;
    }
    return true;
  }
  // Kiosk-Schlüssel der Firma aus Odoo (nur lesen), oder fest aus BDE_ODOO_KIOSK_TOKEN
  async function token() {
    if (kioskToken) return kioskToken;
    const [c] = await odoo.read("res.company", "search_read", { domain: [], fields: ["attendance_kiosk_key"], limit: 1 });
    if (!c || !c.attendance_kiosk_key) throw new Error("In Odoo ist kein Kiosk-Schlüssel für die Anwesenheit hinterlegt");
    kioskToken = String(c.attendance_kiosk_key);
    return kioskToken;
  }

  app.get("/api/bde/kiosk/check", (req, res) => {
    if (!guard(req, res)) return;
    res.json({ ok: true, write: odoo.writeEnabled });
  });

  app.post("/api/bde/kiosk/scan", async (req, res) => {
    if (!guard(req, res)) return;
    if (!odoo.writeEnabled) return res.status(403).json({ error: "Kommen und Gehen ist noch nicht freigeschaltet (BDE_WRITE)" });
    const barcode = String((req.body && req.body.barcode) || "").trim();
    if (!/^[0-9A-Za-z]{3,32}$/.test(barcode)) return res.status(400).json({ error: "Chip nicht lesbar, bitte noch einmal" });
    try {
      const [emp] = await odoo.read("hr.employee", "search_read", { domain: [["barcode", "=", barcode]], fields: ["name", "attendance_state"], limit: 1 });
      if (!emp) return res.status(404).json({ error: "Chip unbekannt" });
      const action = emp.attendance_state === "checked_in" ? "out" : "in";
      let machine = [];
      let persons = [];
      if (action === "out") {
        const rows = await odoo.read("mrp.workcenter.productivity", "search_read", {
          domain: [["date_end", "=", false], ["employee_id", "=", emp.id]],
          fields: ["workorder_id", "workcenter_id", "production_id", "date_start"],
          limit: 50,
        });
        const list = rows.map((r) => ({
          workorderId: m2o(r.workorder_id)?.id,
          kind: kindOf(m2o(r.workcenter_id)?.name),
          label: labelOf(m2o(r.workcenter_id)?.name),
          fa: m2o(r.production_id)?.name || null,
          start: parseOdoo(r.date_start),
        }));
        machine = list.filter((r) => r.kind === "maschine");
        persons = list.filter((r) => r.kind === "person");
      }
      const ticket = randomBytes(16).toString("hex");
      tickets.set(ticket, { employeeId: emp.id, barcode, action, machine: machine.map((m) => m.workorderId), persons: persons.map((p) => p.workorderId), exp: Date.now() + TICKET_MS });
      for (const [k, t] of tickets) if (t.exp < Date.now()) tickets.delete(k);
      res.json({ ticket, name: String(emp.name), action, machine, persons });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  app.post("/api/bde/kiosk/confirm", async (req, res) => {
    if (!guard(req, res)) return;
    const t = tickets.get(String((req.body && req.body.ticket) || ""));
    if (!t || t.exp < Date.now()) return res.status(400).json({ error: "Zu lange gewartet, bitte den Chip noch einmal anhalten" });
    tickets.delete(req.body.ticket);
    const keep = (req.body && req.body.keep) || {};
    try {
      if (t.action === "out") {
        // a) Personentätigkeiten enden zur Ausstempelzeit
        for (const wo of t.persons) await odoo.write("mrp.workorder", "stop_employee", { ids: [wo], employee_ids: [t.employeeId] });
        // b) Maschinenläufe nur, wenn "Beenden" gewählt wurde
        for (const wo of t.machine) if (keep[wo] === false) await odoo.write("mrp.workorder", "stop_employee", { ids: [wo], employee_ids: [t.employeeId] });
      }
      // c) Kommen oder Gehen wie der Odoo-Kiosk
      const result = await odoo.kiosk("/hr_attendance/attendance_barcode_scanned", { token: await token(), barcode: t.barcode });
      if (!result || typeof result !== "object" || !Object.keys(result).length) throw new Error("Odoo hat Kommen/Gehen nicht angenommen (Chip oder Kiosk-Schlüssel prüfen)");
      ctx.invalidate(t.employeeId);
      const p = await ctx.getPersonal(t.employeeId, true);
      res.json({
        action: t.action,
        employeeId: t.employeeId,
        name: result.employee_name || null,
        card: { todayH: p.todayH, weekH: p.attendanceH, weekTargetH: p.weekTargetH, overtimeH: p.overtimeH, vacation: p.vacation },
      });
    } catch (err) {
      ctx.invalidate(t.employeeId);
      ctx.fail(res, err);
    }
  });
}
