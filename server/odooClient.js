// Odoo-Zugang der Betriebsdatenerfassung.
//
// - Lesen: nur search_read, read, search_count, fields_get.
// - Schreiben: nur die freigegebenen Odoo-Methoden der Werkstatt (Mitarbeiter am Arbeitsgang starten/stoppen und fertig melden, Fertigungsauftrag
//   abschließen, weiteren Arbeitsschritt anhängen, Notizen, Endzeit eines
//   Maschinenlaufs nachtragen, eigene Aktivität als erledigt melden, Aufgabe als Aktivität vergeben) und das Kommen/Gehen über den
//   Weg des Odoo-Kiosks. Alles andere wird abgewiesen, bevor eine Anfrage
//   an Odoo geht. Schreiben ist nur aktiv, wenn BDE_WRITE=1 gesetzt ist.
// - Anfragen laufen nacheinander mit kleiner Pause, damit das Anfragelimit von Odoo (HTTP 429) nicht greift. Meldet Odoo trotzdem
//   429, pausiert der Zugang eine Minute; die App zeigt so lange die letzten Daten.
// Zugangsdaten nur aus Umgebungsvariablen, nie im Code: BDE_ODOO_API_KEY (sonst ODOO_API_KEY), BDE_ODOO_URL (sonst ODOO_URL), ODOO_DB.

const READ_METHODS = new Set(["search_read", "read", "search_count", "fields_get"]);
// Modell -> erlaubte schreibende Methoden
const WRITE_METHODS = {
  // button_finish: Arbeitsgang fertig melden (beim Fräsen nur mit vollständigen Laufzeiten, server/bdeLaufzeit.js). create/write nur für die
  // "Weiterer Arbeitsschritt" (Rüsten und Fräsen auf einer anderen Maschine anhängen, QS dahinter verschieben), siehe SCHRITT_*_FIELDS.
  // Die Laufzeiten selbst stehen als interne Notiz im Fertigungsauftrag.
  "mrp.workorder": new Set(["start_employee", "stop_employee", "button_finish", "create", "write"]),
  "mrp.workcenter.productivity": new Set(["write"]),
  // Zeiten ohne Auftrag: Stundenzettel im Projekt Gemeinkosten anlegen und beim Stopp die Dauer eintragen
  "account.analytic.line": new Set(["create", "write"]),
  "mail.activity": new Set(["action_feedback"]),
  // Aufgabe vergeben: Odoo-Aktivität am Fertigungsauftrag, Verkaufsauftrag oder Mitarbeiter anlegen
  // und Rückfragen dazu als interne Notiz (message_post mit Untertyp Notiz, keine E-Mail)
  // button_mark_done: Fertigungsauftrag nach der QS abschließen; write nur für die produzierte Menge (qty_producing), die dafür gesetzt sein muss
  "mrp.production": new Set(["activity_schedule", "message_post", "button_mark_done", "write"]),
  "sale.order": new Set(["activity_schedule", "message_post"]),
  "hr.employee": new Set(["activity_schedule", "message_post"]),
};
// Beim Nachtragen der Endzeit darf nur Ende und Beschreibung geändert werden
const PRODUCTIVITY_FIELDS = new Set(["date_end", "description"]);
// Weiterer Arbeitsschritt: erlaubte Felder beim Anlegen und Ändern von Arbeitsgängen, an Zeiten und Status geht nichts
const SCHRITT_CREATE_FIELDS = new Set(["name", "workcenter_id", "production_id", "sequence", "duration_expected", "blocked_by_workorder_ids"]);
const SCHRITT_WRITE_FIELDS = new Set(["sequence", "blocked_by_workorder_ids"]);
// Am Fertigungsauftrag darf nur die produzierte Menge gesetzt werden
const PRODUCTION_WRITE_FIELDS = new Set(["qty_producing"]);
// Kiosk-Wege von Odoo (Anwesenheit); die Firma wird über ihren Kiosk-Schlüssel erkannt
const KIOSK_ROUTES = new Set(["/hr_attendance/attendance_barcode_scanned", "/hr_attendance/attendance_employee_data"]);
const KIOSK_WRITES = new Set(["/hr_attendance/attendance_barcode_scanned"]);

const GAP_MS = 250;
const PAUSE_AFTER_LIMIT_MS = 60 * 1000;

const busyError = () => Object.assign(new Error("Odoo meldet gerade zu viele Anfragen, bitte gleich noch einmal"), { busy: true });

// Fehlermeldung von Odoo lesbar machen (z. B. "Bitte den Arbeitsplatz entsperren")
async function odooError(res) {
  let msg = `Odoo antwortete mit HTTP ${res.status}`;
  try {
    const j = await res.json();
    if (j && j.message) msg = String(j.message).split("\n")[0].slice(0, 300);
  } catch {
    /* kein JSON */
  }
  return Object.assign(new Error(msg), { odoo: true, status: res.status });
}

export function createOdooClient() {
  const url = (process.env.BDE_ODOO_URL || process.env.ODOO_URL || "").replace(/\/+$/, "");
  const key = process.env.BDE_ODOO_API_KEY || process.env.ODOO_API_KEY || "";
  const database = process.env.ODOO_DB || "";
  const enabled = !!(url && key);
  const writeEnabled = enabled && process.env.BDE_WRITE === "1";
  let busyUntil = 0;

  function precheck() {
    if (!enabled) throw Object.assign(new Error("Odoo ist nicht eingerichtet (ODOO_URL / ODOO_API_KEY fehlen)"), { offline: true });
    if (Date.now() < busyUntil) throw busyError();
  }
  function checkLimit(res) {
    if (res.status === 429) {
      busyUntil = Date.now() + PAUSE_AFTER_LIMIT_MS;
      throw busyError();
    }
  }

  async function json2(model, method, params) {
    precheck();
    const headers = { "Content-Type": "application/json; charset=utf-8", Authorization: `bearer ${key}`, "User-Agent": "kratos-dashboard-bde/1.0" };
    if (database) headers["X-Odoo-Database"] = database;
    const res = await fetch(`${url}/json/2/${model}/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ context: { lang: "de_DE", tz: "Europe/Berlin" }, ...params }),
      signal: AbortSignal.timeout(25000),
    });
    checkLimit(res);
    if (!res.ok) throw await odooError(res);
    return res.json();
  }

  async function jsonrpc(route, params) {
    precheck();
    const headers = { "Content-Type": "application/json; charset=utf-8", "User-Agent": "kratos-dashboard-bde/1.0" };
    if (database) headers["X-Odoo-Database"] = database;
    const res = await fetch(`${url}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params }),
      signal: AbortSignal.timeout(25000),
    });
    checkLimit(res);
    if (!res.ok) throw await odooError(res);
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(String((j.error.data && j.error.data.message) || j.error.message || "Odoo-Fehler").slice(0, 300)), { odoo: true });
    return j.result;
  }

  // Eine Anfrage nach der anderen
  let chain = Promise.resolve();
  function queued(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, GAP_MS)));
    return run;
  }

  function read(model, method, params) {
    if (!READ_METHODS.has(method)) return Promise.reject(new Error(`Odoo-Methode ${method} ist hier gesperrt (nur lesen)`));
    return queued(() => json2(model, method, params));
  }

  function write(model, method, params) {
    // Notizen nur intern: kein anderer Untertyp, keine Empfänger
    if (method === "message_post" && (params.subtype_xmlid !== "mail.mt_note" || params.partner_ids)) return Promise.reject(new Error("Nur interne Notizen erlaubt"));
    if (!writeEnabled) return Promise.reject(Object.assign(new Error("Bedienen ist noch nicht freigeschaltet (BDE_WRITE)"), { forbidden: true }));
    if (!WRITE_METHODS[model] || !WRITE_METHODS[model].has(method)) return Promise.reject(new Error(`Odoo-Methode ${model}.${method} ist gesperrt`));
    if (model === "mrp.workcenter.productivity" && Object.keys(params.vals || {}).some((f) => !PRODUCTIVITY_FIELDS.has(f)))
      return Promise.reject(new Error("Am Zeiteintrag dürfen nur Ende und Beschreibung geändert werden"));
    if (model === "mrp.workorder" && method === "create" && (!Array.isArray(params.vals_list) || params.vals_list.some((v) => Object.keys(v).some((f) => !SCHRITT_CREATE_FIELDS.has(f)))))
      return Promise.reject(new Error("Beim Anlegen eines Arbeitsgangs sind nur Name, Arbeitsplatz, Fertigungsauftrag, Reihenfolge, Plandauer und Abhängigkeit erlaubt"));
    if (model === "mrp.workorder" && method === "write" && (!params.vals || Object.keys(params.vals).some((f) => !SCHRITT_WRITE_FIELDS.has(f))))
      return Promise.reject(new Error("Am Arbeitsgang dürfen nur Reihenfolge und Abhängigkeit geändert werden"));
    if (model === "mrp.production" && method === "write" && (!params.vals || Object.keys(params.vals).some((f) => !PRODUCTION_WRITE_FIELDS.has(f))))
      return Promise.reject(new Error("Am Fertigungsauftrag darf nur die produzierte Menge gesetzt werden"));
    return queued(() => json2(model, method, params));
  }

  function kiosk(route, params) {
    if (!KIOSK_ROUTES.has(route)) return Promise.reject(new Error(`Odoo-Weg ${route} ist gesperrt`));
    if (KIOSK_WRITES.has(route) && !writeEnabled) return Promise.reject(Object.assign(new Error("Kommen und Gehen ist noch nicht freigeschaltet (BDE_WRITE)"), { forbidden: true }));
    return queued(() => jsonrpc(route, params));
  }

  return { enabled, writeEnabled, url, read, write, kiosk };
}
