// Test-Odoo für die Betriebsdatenerfassung: bildet die benutzten Odoo-19-Schnittstellen im Speicher nach (JSON-2 und den Kiosk-Weg),
// damit Stempeln, Wechseln, Endzeit und Kommen/Gehen ohne echtes Odoo geprüft werden können. Nichts davon erreicht die echte Instanz.
//
// Start:  node scripts/mockOdoo.mjs   (Port 8069, Kiosk-Schlüssel "mocktoken")
// Danach den Server mit BDE_ODOO_URL=http://localhost:8069 BDE_ODOO_API_KEY=test BDE_WRITE=1 starten.
// GET /__log zeigt alle schreibenden Aufrufe, GET /__state die Daten.

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8069);
const API_USER = 2;
const now = () => Date.now();
const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const parse = (s) => Date.parse(s.replace(" ", "T") + "Z");
const ago = (h) => fmt(now() - h * 3600000);
const day = (n) => new Date(now() + n * 86400000).toISOString().slice(0, 10);

// Welche Felder verweisen auf welches Modell (für [id, Name] und Pfade wie production_id.name)
const M2O = {
  "hr.employee": { user_id: "res.users", resource_calendar_id: "resource.calendar" },
  "hr.attendance": { employee_id: "hr.employee" },
  "mrp.workorder": { production_id: "mrp.production", workcenter_id: "mrp.workcenter", product_id: "product.product" },
  "mrp.production": { product_id: "product.product" },
  "sale.order": { partner_id: "res.partner" },
  "mrp.workcenter.productivity": { employee_id: "hr.employee", user_id: "res.users", workorder_id: "mrp.workorder", workcenter_id: "mrp.workcenter", production_id: "mrp.production" },
  "hr.leave.allocation": { employee_id: "hr.employee" },
  "quality.alert": { product_id: "product.product", product_tmpl_id: "product.template", production_id: "mrp.production" },
  "product.product": { product_tmpl_id: "product.template" },
  "mail.activity": { activity_type_id: "mail.activity.type", user_id: "res.users", create_uid: "res.users" },
  "res.users": { partner_id: "res.partner" },
  "project.task": { project_id: "project.project", stage_id: "project.task.type", sale_order_id: "sale.order" },
  "account.analytic.line": { project_id: "project.project", task_id: "project.task", employee_id: "hr.employee" },
  "discuss.channel.member": { partner_id: "res.partner", channel_id: "discuss.channel" },
  "mail.message": { author_id: "res.partner" },
  "mail.notification": { res_partner_id: "res.partner", mail_message_id: "mail.message" },
};
const O2M = { "product.template": { product_variant_ids: ["product.product", "product_tmpl_id"] } };

const T = {
  "res.users": [{ id: 2, name: "Alexander Meimeteas", partner_id: 3 }, { id: 25, name: "Frank Häckl", partner_id: 41 }, { id: 30, name: "Aurel Rama", partner_id: 42 }, { id: 29, name: "Nino Posset", partner_id: 43 }],
  // Zeiten ohne Auftrag: Projekt Gemeinkosten mit Aufgaben, Stundenzettel
  "project.project": [{ id: 1, name: "Internal" }, { id: 18, name: "Gemeinkosten" }, { id: 6, name: "01 Fertigungsplanung" }],
  "project.task.type": [{ id: 68, name: "DMG M1" }, { id: 46, name: "DMG 40 EVO" }, { id: 42, name: "Geliefert & Abgerechnet" }],
  "project.task": [
    { id: 3, name: "Time Off", project_id: 1, sequence: 10 },
    { id: 699, name: "AV / Planung allgemein", project_id: 18, sequence: 10 },
    { id: 700, name: "QS allgemein", project_id: 18, sequence: 10 },
    { id: 701, name: "Instandhaltung", project_id: 18, sequence: 10 },
    { id: 702, name: "Unterbrechung", project_id: 18, sequence: 10 },
    // Odoo-Fertigungsplanung: A01365 steht offen auf der M1 (Original) und als Kopie bei 40 EVO, A00958 ist schon geliefert
    { id: 900, name: "A01365 - AV LT: 30.10. (Kopie)", project_id: 6, stage_id: 46, state: "03_approved", sale_order_id: 1365 },
    { id: 901, name: "A01365 - AV LT: 30.10.", project_id: 6, stage_id: 68, state: "03_approved", sale_order_id: 1365 },
    { id: 902, name: "A00958 - AV Rahmenvertrag", project_id: 6, stage_id: 42, state: "03_approved", sale_order_id: 958 },
  ],
  "account.analytic.line": [
    { id: 2600, name: "07:00–07:30 · Kratos BDE", date: day(0), unit_amount: 0.5, employee_id: 1, project_id: 18, task_id: 701, create_date: ago(3) },
  ],
  // Odoo-Nachrichten: Chats und Posteingang (für das kleine Fenster)
  "res.partner": [{ id: 3, name: "Alexander Meimeteas" }, { id: 41, name: "Frank Häckl" }, { id: 42, name: "Aurel Rama" }, { id: 43, name: "Nino Posset" }],
  "discuss.channel": [
    { id: 70, name: "Frank Häckl, Aurel Rama", channel_type: "chat" },
    { id: 71, name: "Fertigung", channel_type: "group" },
    { id: 72, name: "allgemein", channel_type: "channel" },
    { id: 73, name: "Frank Häckl, Nino Posset", channel_type: "chat" },
  ],
  "discuss.channel.member": [
    { id: 1, partner_id: 42, channel_id: 70, message_unread_counter: 2 },
    { id: 2, partner_id: 41, channel_id: 70, message_unread_counter: 0 },
    { id: 3, partner_id: 42, channel_id: 71, message_unread_counter: 1 },
    { id: 4, partner_id: 42, channel_id: 72, message_unread_counter: 5 },
    { id: 5, partner_id: 43, channel_id: 73, message_unread_counter: 1 },
  ],
  "mail.message": [
    { id: 900, model: "discuss.channel", res_id: 70, message_type: "comment", author_id: 41, body: "<p>Kannst du kurz in die Halle kommen? Die <b>Spannbacken</b> passen nicht.</p>", date: ago(0.2), record_name: false, subject: false },
    { id: 901, model: "discuss.channel", res_id: 71, message_type: "comment", author_id: 43, body: "<p>Material für FA01307 ist da</p>", date: ago(1), record_name: false, subject: false },
    { id: 902, model: "discuss.channel", res_id: 73, message_type: "comment", author_id: 41, body: "<p>Privat an Nino</p>", date: ago(0.5), record_name: false, subject: false },
    { id: 903, model: "mrp.production", res_id: 1307, message_type: "comment", author_id: 3, body: "<p>@Aurel Rama bitte Erstmuster vor Serienstart prüfen</p>", date: ago(2), record_name: "FA01307", subject: false },
    // Programmlaufzeiten des früheren Auftrags FA01100 (Wiederholteil), wie die App sie als Notiz ablegt
    { id: 910, model: "mrp.production", res_id: 1100, message_type: "comment", author_id: 3, body: "<p><b>Aufspannungen:</b> 2 (Aurel Rama, 29.09.2026)</p>", date: ago(24 * 30), record_name: "FA01100", subject: false },
    { id: 911, model: "mrp.production", res_id: 1100, message_type: "comment", author_id: 3, body: "<p><b>Laufzeit Aufspannung 1:</b> 7:30 Min:Sek für 1 Teil = 7:30 je Stück (Aurel Rama, 29.09.2026)</p>", date: ago(24 * 30), record_name: "FA01100", subject: false },
    { id: 912, model: "mrp.production", res_id: 1100, message_type: "comment", author_id: 3, body: "<p><b>Laufzeit Aufspannung 2:</b> 12:00 Min:Sek für 2 Teile = 6:00 je Stück (Aurel Rama, 29.09.2026)</p>", date: ago(24 * 30), record_name: "FA01100", subject: false },
  ],
  "mail.notification": [
    { id: 1, res_partner_id: 42, mail_message_id: 903, notification_type: "inbox", is_read: false },
    { id: 2, res_partner_id: 43, mail_message_id: 903, notification_type: "inbox", is_read: true },
  ],
  "resource.calendar": [{ id: 1, name: "Standard 40h / Woche", hours_per_week: 40 }, { id: 8, name: "Standard 30h/ Woche", hours_per_week: 30 }],
  "res.company": [{ id: 1, name: "KRATOS", attendance_kiosk_key: "mocktoken" }],
  "hr.employee": [
    { id: 1, name: "Alexander Meimeteas", user_id: 2, barcode: "0001730224", pin: "1111", resource_calendar_id: 1, total_overtime: 12.5 },
    { id: 2, name: "Aurel Rama", user_id: 30, barcode: "0001707183", pin: "2222", resource_calendar_id: 1, total_overtime: 3.25 },
    { id: 3, name: "Frank Häckl", user_id: 25, barcode: "0000698310", pin: "3333", resource_calendar_id: 1, total_overtime: -1.5 },
    { id: 5, name: "Alexander Barsukov", user_id: false, barcode: false, pin: false, resource_calendar_id: 1, total_overtime: 0 },
    { id: 10, name: "Dardan Rama", user_id: false, barcode: false, pin: false, resource_calendar_id: 1, total_overtime: 0 },
    { id: 11, name: "Nino Posset", user_id: 29, barcode: "0001729396", pin: "4444", resource_calendar_id: 8, total_overtime: 6 },
    { id: 14, name: "Thomas", user_id: false, barcode: false, pin: false, resource_calendar_id: 1, total_overtime: 0 },
  ],
  "mrp.workcenter": [
    { id: 1, name: "FRÄSEN" },
    { id: 5, name: "QUALITÄTSSICHERUNG (QS)" },
    { id: 6, name: "CAM-PROGRAMMIERUNG" },
    { id: 10, name: "RÜSTEN" },
    { id: 14, name: "DMU 40 EVO" },
    { id: 16, name: "DMU 40 EVO Rüsten" },
    { id: 15, name: "DMG M1" },
    { id: 17, name: "DMG M1 Rüsten" },
    { id: 21, name: "DMU 50" },
    { id: 22, name: "DMU 50 Rüsten" },
  ],
  "product.template": [{ id: 70, name: "Grundplatte" }, { id: 71, name: "Motorplatte" }],
  "product.product": [
    { id: 2901, name: "Grundplatte Bauteilaufnahme", default_code: "KSS.P2322-361", product_tmpl_id: 70 },
    { id: 2902, name: "Motorplatte für RFID", default_code: "212-12-025_R4", product_tmpl_id: 71 },
  ],
  "mrp.production": [
    { id: 1307, name: "FA01307", product_id: 2901, state: "confirmed", origin: "A01365", product_qty: 10, qty_producing: 0 },
    { id: 1070, name: "FA01070", product_id: 2902, state: "progress", origin: "A00958" },
    // früherer, erledigter Auftrag desselben Artikels (Wiederholteil)
    { id: 1100, name: "FA01100", product_id: 2901, state: "done", origin: "A01100" },
    // offener Auftrag, der in keiner Odoo-Planungsaufgabe steht (nur mit MOCK_A01378=1, für POST /api/odoo/nachholen)
    ...(process.env.MOCK_A01378 ? [{ id: 1302, name: "FA01302", product_id: 2902, state: "confirmed", origin: "A01378" }, { id: 1304, name: "FA01304", product_id: 2902, state: "confirmed", origin: "A01379" }] : []),
  ],
  "mrp.workorder": [
    // Fräsen von FA01302 auf der DMU 40 EVO mit 10 Stunden Plan (nur mit MOCK_A01378=1)
    ...(process.env.MOCK_A01378 ? [{ id: 6514, name: "Fräsen", sequence: 2, production_id: 1304, workcenter_id: 14, product_id: 2902, state: "blocked", duration_expected: 60000, duration: 0, qty_production: 1000 }, { id: 6513, name: "Fräsen", sequence: 2, production_id: 1302, workcenter_id: 14, product_id: 2902, state: "blocked", duration_expected: 600, duration: 0, qty_production: 4 }] : []),
    { id: 5000, name: "Fräsen", production_id: 1100, workcenter_id: 1, product_id: 2901, state: "done", duration_expected: 60, duration: 300, qty_production: 10 },
    { id: 6531, name: "Programmierung", sequence: 0, production_id: 1307, workcenter_id: 6, product_id: 2901, state: "ready", duration_expected: 900, duration: 0 },
    { id: 6532, name: "Rüsten", sequence: 1, production_id: 1307, workcenter_id: 10, product_id: 2901, state: "blocked", duration_expected: 120, duration: 0 },
    { id: 6533, name: "Fräsen", sequence: 2, production_id: 1307, workcenter_id: 1, product_id: 2901, state: "blocked", duration_expected: 60, duration: 0, qty_production: 10 },
    { id: 6534, name: "Qualitätssicherung", sequence: 3, production_id: 1307, workcenter_id: 5, product_id: 2901, state: "blocked", duration_expected: 0, duration: 0 },
    { id: 5590, name: "Fräsen", production_id: 1070, workcenter_id: 1, product_id: 2902, state: "progress", duration_expected: 0, duration: 0 },
    { id: 5591, name: "Qualitätssicherung", production_id: 1070, workcenter_id: 5, product_id: 2902, state: "ready", duration_expected: 60, duration: 0 },
  ],
  "mrp.workcenter.productivity": [
    // vergessener Maschinenlauf (wie FA01070 seit Juni)
    { id: 4157, employee_id: 2, user_id: 30, workorder_id: 5590, workcenter_id: 1, production_id: 1070, date_start: ago(24 * 140), date_end: false, description: false },
    // Aurel: Programmierung gestern beendet (für "Weiter")
    { id: 4200, employee_id: 2, user_id: 30, workorder_id: 6531, workcenter_id: 6, production_id: 1307, date_start: ago(26), date_end: ago(24), description: false },
  ],
  "hr.attendance": [
    { id: 1, employee_id: 2, check_in: ago(3), check_out: false, worked_hours: 0 },
    { id: 2, employee_id: 3, check_in: ago(2), check_out: false, worked_hours: 0 },
  ],
  "hr.leave.allocation": [
    { id: 14, employee_id: 2, number_of_days: 30, leaves_taken: 23, state: "validate", date_from: "2026-01-01", date_to: "2027-03-31" },
    { id: 8, employee_id: 3, number_of_days: 30, leaves_taken: 24, state: "validate", date_from: "2026-01-01", date_to: "2026-12-31" },
  ],
  "sale.order": [{ id: 1365, name: "A01365" }, { id: 958, name: "A00958" }, { id: 1378, name: "A01378" }],
  "mail.activity.type": [{ id: 1, name: "To-do" }, { id: 2, name: "Anruf" }, { id: 4, name: "E-Mail" }],
  "mail.activity": [
    { id: 501, activity_type_id: 1, user_id: 30, create_uid: 25, summary: "Programm für Grundplatte prüfen", note: "<p>Bohrbild mit <b>Zeichnung</b> abgleichen</p>", date_deadline: day(-2), res_model: "mrp.production", res_id: 1307, res_name: "FA01307", date_done: false },
    { id: 502, activity_type_id: 2, user_id: 30, summary: "Lieferant wegen Material anrufen", note: false, date_deadline: day(0), res_model: "purchase.order", res_id: 77, res_name: "P00077", date_done: false },
    { id: 503, activity_type_id: 1, user_id: 30, summary: false, note: false, date_deadline: day(3), res_model: "knowledge.article", res_id: 5, res_name: "Arbeitsanweisung Rüsten", date_done: false },
    { id: 504, activity_type_id: 1, user_id: 25, summary: "Prüfplan freigeben", note: false, date_deadline: day(1), res_model: "mrp.production", res_id: 1070, res_name: "FA01070", date_done: false },
  ],
  "quality.alert": [{ id: 1, name: "QA001", title: "Bohrung Ø8 außer Toleranz", product_id: false, product_tmpl_id: 70, production_id: false, date_close: false }],
};
const log = [];
const nextId = (m) => Math.max(0, ...T[m].map((r) => r.id)) + 1;
const byId = (m, id) => T[m].find((r) => r.id === id);
const nameOf = (m, id) => {
  const r = byId(m, id);
  return r ? (m === "mrp.workorder" ? `${byId("mrp.production", r.production_id)?.name} - ${r.name}` : r.name) : "";
};

// berechnete Felder
function computed(model, r, f) {
  if (model === "hr.employee" && f === "attendance_state") return T["hr.attendance"].some((a) => a.employee_id === r.id && !a.check_out) ? "checked_in" : "checked_out";
  if (model === "hr.employee" && f === "hours_today")
    return T["hr.attendance"].filter((a) => a.employee_id === r.id).reduce((s, a) => s + ((a.check_out ? parse(a.check_out) : now()) - parse(a.check_in)) / 3600000, 0);
  if (model === "mrp.workorder" && f === "production_state") return byId("mrp.production", r.production_id)?.state;
  if (model === "mrp.workcenter.productivity" && f === "duration") return r.date_end ? (parse(r.date_end) - parse(r.date_start)) / 60000 : 0;
  return undefined;
}
function value(model, r, f) {
  const c = computed(model, r, f);
  return c !== undefined ? c : r[f];
}
function out(model, r, fields) {
  const o = { id: r.id };
  (fields && fields.length ? fields : Object.keys(r)).forEach((f) => {
    const v = value(model, r, f);
    const target = M2O[model] && M2O[model][f];
    o[f] = target ? (v ? [v, nameOf(target, v)] : false) : v === undefined ? false : v;
  });
  return o;
}
// Pfad wie "production_id.product_id.name" -> Liste von Werten
function pathValues(model, r, path) {
  const [head, ...rest] = path.split(".");
  if (!rest.length && O2M[model] && O2M[model][head]) return pathValues(model, r, head + ".id");
  if (!rest.length) return [value(model, r, head)];
  if (M2O[model] && M2O[model][head]) {
    const t = M2O[model][head];
    const sub = byId(t, value(model, r, head));
    return sub ? pathValues(t, sub, rest.join(".")) : [false];
  }
  if (O2M[model] && O2M[model][head]) {
    const [t, inv] = O2M[model][head];
    const subs = T[t].filter((x) => x[inv] === r.id);
    return rest.length === 1 && rest[0] === "id" ? subs.map((s) => s.id) : subs.flatMap((s) => pathValues(t, s, rest.join(".")));
  }
  return [false];
}
function term(model, r, [f, op, v]) {
  let path = f;
  if (O2M[model] && O2M[model][f.split(".")[0]] && !f.includes(".")) path = f + ".id";
  const vals = pathValues(model, r, path);
  const one = (x) => {
    switch (op) {
      case "=":
        return v === false ? !x : x === v;
      case "!=":
        return v === false ? !!x : x !== v;
      case "in":
        return v.includes(x);
      case "not in":
        return !v.includes(x);
      case "<":
        return x !== false && x < v;
      case "<=":
        return x !== false && x <= v;
      case ">":
        return x !== false && x > v;
      case ">=":
        return x !== false && x >= v;
      case "ilike":
        return typeof x === "string" && x.toLowerCase().includes(String(v).toLowerCase());
      case "=like":
        return typeof x === "string" && new RegExp("^" + String(v).replace(/%/g, ".*") + "$").test(x);
      default:
        throw new Error("Operator " + op);
    }
  };
  return op === "not in" || op === "!=" ? vals.every(one) : vals.some(one);
}
function match(model, r, domain) {
  const stack = [];
  for (let i = domain.length - 1; i >= 0; i--) {
    const d = domain[i];
    if (d === "|" || d === "&") {
      const a = stack.pop();
      const b = stack.pop();
      stack.push(d === "|" ? a || b : a && b);
    } else if (d === "!") stack.push(!stack.pop());
    else stack.push(term(model, r, d));
  }
  return stack.every(Boolean);
}
function search(model, { domain = [], order, limit, offset = 0 }) {
  let rows = T[model].filter((r) => match(model, r, domain));
  if (order) {
    const [f, dir] = order.split(",")[0].trim().split(/\s+/);
    rows = rows.slice().sort((a, b) => {
      const x = value(model, a, f);
      const y = value(model, b, f);
      return (x > y ? 1 : x < y ? -1 : 0) * (dir === "desc" ? -1 : 1);
    });
  }
  return rows.slice(offset, limit ? offset + limit : undefined);
}
function recomputeWo(woId) {
  const wo = byId("mrp.workorder", woId);
  wo.duration = T["mrp.workcenter.productivity"].filter((p) => p.workorder_id === woId).reduce((s, p) => s + computed("mrp.workcenter.productivity", p, "duration"), 0);
}

function call(model, method, p) {
  if (!T[model]) throw new Error(`Modell ${model} gibt es im Test-Odoo nicht`);
  switch (method) {
    case "search_read":
      return search(model, p).map((r) => out(model, r, p.fields));
    case "read":
      return p.ids.map((id) => byId(model, id)).filter(Boolean).map((r) => out(model, r, p.fields));
    case "search_count":
      return search(model, { domain: p.domain }).length;
    case "fields_get":
      return {};
    case "button_finish": {
      const wo = byId("mrp.workorder", p.ids[0]);
      if (["done", "cancel"].includes(wo.state)) throw new Error("Arbeitsgang ist schon erledigt");
      wo.state = "done";
      log.push({ at: fmt(now()), call: `mrp.workorder.button_finish(${wo.id})` });
      return true;
    }
    case "button_mark_done": {
      const rec = byId(model, p.ids[0]);
      log.push({ at: fmt(now()), call: `${model}.button_mark_done(${rec.id})` });
      if (rec.wizard) return { type: "ir.actions.act_window", res_model: "mrp.consumption.warning" };
      rec.state = "done";
      return true;
    }
    case "start_employee": {
      const wo = byId("mrp.workorder", p.ids[0]);
      if (["done", "cancel"].includes(wo.state)) throw new Error("Arbeitsgang ist erledigt");
      const emp = byId("hr.employee", p.employee_id);
      T["mrp.workcenter.productivity"].push({ id: nextId("mrp.workcenter.productivity"), employee_id: emp.id, user_id: API_USER, workorder_id: wo.id, workcenter_id: wo.workcenter_id, production_id: wo.production_id, date_start: fmt(now()), date_end: false, description: false });
      wo.state = "progress";
      log.push({ at: fmt(now()), call: `mrp.workorder.start_employee(${wo.id}, employee ${emp.id})` });
      return true;
    }
    case "stop_employee": {
      const woId = p.ids[0];
      T["mrp.workcenter.productivity"].filter((x) => x.workorder_id === woId && !x.date_end && p.employee_ids.includes(x.employee_id)).forEach((x) => (x.date_end = fmt(now())));
      recomputeWo(woId);
      log.push({ at: fmt(now()), call: `mrp.workorder.stop_employee(${woId}, employees ${p.employee_ids})` });
      return true;
    }
    case "activity_schedule": {
      const rec = byId(model, p.ids[0]);
      T["mail.activity"].push({ id: nextId("mail.activity"), activity_type_id: 1, create_uid: API_USER, user_id: p.user_id, summary: p.summary, note: p.note, date_deadline: p.date_deadline, res_model: model, res_id: rec.id, res_name: rec.name, date_done: false });
      log.push({ at: fmt(now()), call: `${model}.activity_schedule(${rec.name}, user ${p.user_id}, "${p.summary}", ${p.date_deadline})` });
      return true;
    }
    case "create": {
      const ids = p.vals_list.map((v) => {
        const id = nextId(model);
        T[model].push({ ...v, id, create_date: fmt(now()), ...(model === "mrp.workorder" ? { state: v.state || "blocked" } : {}) });
        return id;
      });
      log.push({ at: fmt(now()), call: `${model}.create(${JSON.stringify(p.vals_list)}) -> ${ids}` });
      return ids;
    }
    case "message_post": {
      const rec = byId(model, p.ids[0]);
      T["mail.message"].push({ id: nextId("mail.message"), model, res_id: p.ids[0], message_type: p.message_type || "comment", author_id: 3, body: `<p>${String(p.body).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`, date: fmt(now()), record_name: rec ? rec.name : false, subject: false });
      log.push({ at: fmt(now()), call: `${model}.message_post(${p.ids}, ${p.subtype_xmlid}): ${String(p.body).replace(/<[^>]+>/g, " ").slice(0, 120)}` });
      return 1;
    }
    case "action_feedback": {
      p.ids.forEach((id) => (byId(model, id).date_done = new Date().toISOString().slice(0, 10)));
      log.push({ at: fmt(now()), call: `${model}.action_feedback(${p.ids}, "${p.feedback}")` });
      return true;
    }
    case "write": {
      p.ids.forEach((id) => Object.assign(byId(model, id), p.vals));
      if (model === "mrp.workcenter.productivity") p.ids.forEach((id) => recomputeWo(byId(model, id).workorder_id));
      log.push({ at: fmt(now()), call: `${model}.write(${p.ids}, ${JSON.stringify(p.vals)})` });
      return true;
    }
    default:
      throw new Error(`Methode ${method} gibt es im Test-Odoo nicht`);
  }
}

function kiosk(route, p) {
  if (p.token !== T["res.company"][0].attendance_kiosk_key) return {};
  if (route === "/hr_attendance/attendance_barcode_scanned") {
    const emp = T["hr.employee"].find((e) => e.barcode === p.barcode);
    if (!emp) return {};
    const open = T["hr.attendance"].find((a) => a.employee_id === emp.id && !a.check_out);
    if (open) {
      open.check_out = fmt(now());
      open.worked_hours = (parse(open.check_out) - parse(open.check_in)) / 3600000;
    } else T["hr.attendance"].push({ id: nextId("hr.attendance"), employee_id: emp.id, check_in: fmt(now()), check_out: false, worked_hours: 0 });
    log.push({ at: fmt(now()), call: `kiosk ${open ? "check_out" : "check_in"} employee ${emp.id}` });
    return { id: emp.id, employee_name: emp.name, attendance_state: open ? "checked_out" : "checked_in", hours_today: computed("hr.employee", emp, "hours_today"), total_overtime: emp.total_overtime };
  }
  return {};
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      try {
        if (req.method === "GET" && req.url === "/__log") return send(200, log);
        if (req.method === "GET" && req.url === "/__state") return send(200, T);
        const p = body ? JSON.parse(body) : {};
        const m = /^\/json\/2\/([\w.]+)\/(\w+)$/.exec(req.url);
        if (m) {
          if (!/^bearer /i.test(req.headers.authorization || "")) return send(401, { message: "Kein Schlüssel" });
          return send(200, call(m[1], m[2], p));
        }
        if (req.url.startsWith("/hr_attendance/")) return send(200, { jsonrpc: "2.0", id: p.id, result: kiosk(req.url, p.params || {}) });
        send(404, { message: "Unbekannter Weg" });
      } catch (err) {
        send(422, { message: err.message });
      }
    });
  })
  .listen(PORT, () => console.log(`Test-Odoo läuft auf http://localhost:${PORT}`));
