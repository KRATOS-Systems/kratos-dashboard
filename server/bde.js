// Betriebsdatenerfassung (BDE): Team-Tafel, Mein Arbeitsplatz, Hinweise für die Leitung.
//
// Odoo ist die einzige Wahrheit. Die App speichert keine Zeiten, sie liest bei Bedarf aus Odoo und bucht über Odoos eigene Methoden:
// - Team-Tafel: wer ist da, was läuft gerade (ohne Stunden, ohne Urlaub). Ein Abruf für alle Geräte, höchstens alle 25 Sekunden.
// - Mein Arbeitsplatz: laufende Tätigkeiten, Zeiten der Woche, Resturlaub, zuletzt gemachte Tätigkeiten; nur nach Anmeldung mit PIN.
//   Die Leitung darf auch die Daten der anderen ansehen und bekommt die Hinweise (vergessen, doppelt, Maschine zu lang).
// - Die PIN wird nie aus Odoo gelesen. Der Server fragt Odoo nur, ob Mitarbeiter und PIN zusammenpassen (search_count).
// - Bedienen (Version 2) steht in bdeActions.js, der Kiosk für Kommen und Gehen (Version 3) in bdeKiosk.js,
//   die Prüfung der Maschinenzeit gegen die Zählerstände in bdeMachines.js, Meine Aufgaben (Odoo-Aktivitäten) in bdeTasks.js.
// Zeiten speichert Odoo in UTC, gerechnet und angezeigt wird in Europe/Berlin.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createOdooClient } from "./odooClient.js";
import registerBdeActions from "./bdeActions.js";
import registerBdeKiosk from "./bdeKiosk.js";
import registerBdeMachines from "./bdeMachines.js";
import registerBdeTasks from "./bdeTasks.js";
import registerBdePhotos from "./bdePhotos.js";
import registerBdeParts from "./bdeParts.js";

const TZ = "Europe/Berlin";
const TEAM_TTL = 25 * 1000;
const PERSONAL_TTL = 60 * 1000;
const EMPLOYEES_TTL = 60 * 60 * 1000;
const ALARM_MS = 12 * 60 * 60 * 1000;
const MACHINE_NO_PLAN_MS = 24 * 60 * 60 * 1000;
const MACHINE_TOLERANCE = 1.2;
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

// Mitarbeiter-IDs aus Odoo (hr.employee). Team = Karten auf der Tafel, Leitung = sieht alles, bekommt die Hinweise, darf fremde Buchungen beenden.
export const idList = (s, def) =>
  String(s || def)
    .split(",")
    .map((x) => parseInt(x, 10))
    .filter(Number.isInteger);
const TEAM = idList(process.env.BDE_TEAM, "3,2,11,5,14,10");
const LEITUNG = idList(process.env.BDE_LEITUNG, "3,1");
const PEOPLE = [...new Set([...TEAM, ...LEITUNG])];

// Tätigkeiten: Maschinenlauf darf parallel laufen, externe Arbeitsplätze zählen nicht als Personenzeit, alles andere ist Personentätigkeit
export function kindOf(workcenter) {
  const n = String(workcenter || "").toUpperCase();
  if (/FRÄSEN|DREHEN/.test(n)) return "maschine";
  if (/EXTERN|TEST/.test(n)) return "extern";
  return "person";
}
const LABELS = [
  [/PROGRAMM/, "Programmierung"],
  [/RÜSTEN/, "Rüsten"],
  [/FRÄSEN/, "Fräsen"],
  [/DREHEN/, "Drehen"],
  [/QUALIT|\bQS\b/, "QS"],
  [/SÄGEN/, "Sägen"],
  [/VERSAND/, "Versand"],
  [/NACHARBEIT/, "Nacharbeit"],
  [/INSTANDHALT/, "Instandhaltung"],
  [/ARBEITSVORB|\(AV\)/, "Arbeitsvorbereitung"],
  [/PLANUNG/, "Produktionsplanung"],
];
export function labelOf(workcenter) {
  const n = String(workcenter || "").toUpperCase();
  const hit = LABELS.find(([re]) => re.test(n));
  if (hit) return hit[1];
  const s = String(workcenter || "Tätigkeit").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Zeit: Odoo liefert "YYYY-MM-DD HH:MM:SS" in UTC
export const parseOdoo = (s) => (typeof s === "string" && s ? Date.parse(s.replace(" ", "T") + "Z") : null);
export const toOdoo = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const partsFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function berlinParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
function offsetMs(ms) {
  const p = berlinParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
export function berlinMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  return guess - offsetMs(guess - offsetMs(guess));
}
export function dayStart(ms) {
  const p = berlinParts(ms);
  return berlinMidnight(p.y, p.m, p.d);
}
export function weekStart(ms) {
  const p = berlinParts(ms);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() || 7;
  return berlinMidnight(p.y, p.m, p.d - (dow - 1));
}
export function berlinDate(ms) {
  const p = berlinParts(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
// "2026-10-19" -> Mitternacht in Berlin
export const dateStart = (s) => berlinMidnight(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10));

export const m2o = (v) => (Array.isArray(v) ? { id: v[0], name: String(v[1]) } : null);

// Summe von Zeiträumen, Überschneidungen zählen nur einmal
export function mergedMs(intervals) {
  const list = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of list) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else if (b > cur[1]) cur[1] = b;
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

// Handy erkennen: dort gibt es nur Anzeige, keine Bedienung
export function isPhone(req) {
  if (String(req.headers["sec-ch-ua-mobile"] || "") === "?1") return true;
  const ua = String(req.headers["user-agent"] || "");
  return /iPhone|iPod|Android.+Mobile|Windows Phone|Mobile Safari(?!.*iPad)/i.test(ua) && !/iPad|Tablet/i.test(ua);
}

export default function registerBde(app, db, staff) {
  const odoo = createOdooClient();
  const SECRET = process.env.BDE_SECRET || randomBytes(32).toString("hex");
  if (!process.env.BDE_SECRET) console.warn("BDE: BDE_SECRET fehlt, Anmeldungen gelten nur bis zum nächsten Neustart");

  // Mitarbeiter (Name, Benutzer) für Team und Leitung, stündlich neu
  let employees = new Map();
  let employeesAt = 0;
  async function ensureEmployees() {
    if (employees.size && Date.now() - employeesAt < EMPLOYEES_TTL) return;
    const rows = await odoo.read("hr.employee", "search_read", { domain: [["id", "in", PEOPLE]], fields: ["name", "user_id"], limit: 100 });
    employees = new Map(rows.map((r) => [r.id, { id: r.id, name: String(r.name), userId: Array.isArray(r.user_id) ? r.user_id[0] : null }]));
    employeesAt = Date.now();
  }
  const empByUser = () => new Map([...employees.values()].filter((e) => e.userId).map((e) => [e.userId, e.id]));
  const peopleList = () => PEOPLE.filter((id) => employees.has(id)).map((id) => ({ id, name: employees.get(id).name }));

  // Laufende Buchungen, Anwesenheiten und offene Reklamationen (für alle Geräte gemeinsam)
  let team = null;
  let teamAt = 0;
  let teamErr = null;
  let teamP = null;
  async function loadTeam() {
    await ensureEmployees();
    const prods = await odoo.read("mrp.workcenter.productivity", "search_read", {
      domain: [["date_end", "=", false]],
      fields: ["employee_id", "user_id", "workorder_id", "workcenter_id", "production_id", "date_start", "description"],
      limit: 300,
    });
    const atts = await odoo.read("hr.attendance", "search_read", { domain: [["check_out", "=", false]], fields: ["employee_id", "check_in"], limit: 300 });
    const woIds = [...new Set(prods.map((p) => m2o(p.workorder_id)?.id).filter(Boolean))];
    const wos = woIds.length ? await odoo.read("mrp.workorder", "read", { ids: woIds, fields: ["name", "product_id", "duration_expected", "duration", "state"] }) : [];
    const woMap = new Map(wos.map((w) => [w.id, w]));
    // Auftrag (A-Nummer aus dem Verkauf) zu den Fertigungsaufträgen
    const prodIds = [...new Set(prods.map((p) => m2o(p.production_id)?.id).filter(Boolean))];
    const origins = new Map();
    if (prodIds.length) {
      const pr = await odoo.read("mrp.production", "read", { ids: prodIds, fields: ["origin"] });
      pr.forEach((x) => x.origin && origins.set(x.id, String(x.origin).trim().slice(0, 40)));
    }
    // Offene Reklamationen zu den Artikeln, an denen gerade gearbeitet wird
    const productIds = [...new Set(wos.map((w) => m2o(w.product_id)?.id).filter(Boolean))];
    let alerts = [];
    if (productIds.length) {
      try {
        alerts = await odoo.read("quality.alert", "search_read", {
          domain: [["date_close", "=", false], "|", ["product_id", "in", productIds], ["product_tmpl_id.product_variant_ids", "in", productIds]],
          fields: ["name", "title", "product_id", "product_tmpl_id", "production_id"],
          limit: 100,
        });
      } catch (err) {
        if (err.busy) throw err;
        alerts = []; // Qualitätsmodul fehlt oder kein Zugriff: ohne Reklamationshinweis weiter
      }
    }
    // Reklamationen, die nur am Artikel (Vorlage) hängen, über die Vorlage der Variante zuordnen
    const tmplOf = new Map();
    if (alerts.some((a) => !a.product_id && a.product_tmpl_id)) {
      const pp = await odoo.read("product.product", "read", { ids: productIds, fields: ["product_tmpl_id"] });
      pp.forEach((p) => tmplOf.set(p.id, m2o(p.product_tmpl_id)?.id));
    }
    const alertsFor = (productId) =>
      alerts.filter((a) => (a.product_id ? m2o(a.product_id).id === productId : m2o(a.product_tmpl_id)?.id === tmplOf.get(productId)));
    const byUser = empByUser();
    const bookings = prods.map((p) => {
      const emp = m2o(p.employee_id);
      const user = m2o(p.user_id);
      const wc = m2o(p.workcenter_id);
      const wo = woMap.get(m2o(p.workorder_id)?.id);
      const prod = m2o(p.production_id);
      const productId = wo ? m2o(wo.product_id)?.id : null;
      const complaints = productId ? alertsFor(productId) : [];
      return {
        id: p.id,
        employeeId: emp ? emp.id : user ? byUser.get(user.id) ?? null : null,
        who: emp ? emp.name : user ? user.name : "Unbekannt",
        workorderId: wo ? wo.id : null,
        kind: kindOf(wc?.name),
        label: labelOf(wc?.name),
        workcenter: wc ? wc.name : null,
        fa: prod ? prod.name : null,
        order: prod ? origins.get(prod.id) || null : null,
        productionId: prod ? prod.id : null,
        product: wo && Array.isArray(wo.product_id) ? String(wo.product_id[1]) : null,
        start: parseOdoo(p.date_start),
        expectedMin: wo && typeof wo.duration_expected === "number" ? wo.duration_expected : 0,
        doneMin: wo && typeof wo.duration === "number" ? wo.duration : 0,
        note: p.description ? String(p.description).slice(0, 200) : null,
        complaints: complaints.slice(0, 3).map((a) => String(a.title || a.name || "Reklamation").slice(0, 120)),
      };
    });
    const present = new Map(atts.map((a) => [m2o(a.employee_id)?.id, parseOdoo(a.check_in)]));
    return { bookings, present };
  }
  // Zählt Buchungen mit; ein Abruf, der vor einer Buchung begonnen hat, gilt danach nicht als frisch
  let teamGen = 0;
  async function getTeam(force = false) {
    if (!force && team && Date.now() - teamAt < TEAM_TTL) return;
    if (teamP && teamP.gen !== teamGen) await teamP;
    if (!teamP) {
      const gen = teamGen;
      teamP = loadTeam()
        .then((t) => {
          team = t;
          teamAt = gen === teamGen ? Date.now() : 0;
          teamErr = null;
        })
        .catch((err) => {
          teamErr = err;
          if (!err.busy && !err.offline) console.error("BDE: Odoo-Abruf fehlgeschlagen", err.message);
        })
        .finally(() => {
          teamP = null;
        });
      teamP.gen = gen;
    }
    await teamP;
  }

  // Regeln der Tafel
  // Personentätigkeit vergessen: läuft länger als 12 Stunden oder seit einem Vortag
  const isForgotten = (b, now) => b.kind === "person" && b.start != null && (now - b.start > ALARM_MS || b.start < dayStart(now));
  // Maschinenlauf zu lang: über Vorgabezeit + 20 %, ohne Vorgabezeit über 24 Stunden (nachts mannlos ist erlaubt)
  function isLong(b, now) {
    if (b.kind !== "maschine" || b.start == null) return false;
    const runMin = (now - b.start) / 60000;
    if (b.expectedMin > 0) return b.doneMin + runMin > b.expectedMin * MACHINE_TOLERANCE;
    return now - b.start > MACHINE_NO_PLAN_MS;
  }
  const publicBooking = (b, now) => ({
    workorderId: b.workorderId,
    label: b.label,
    kind: b.kind,
    fa: b.fa,
    order: b.order,
    productionId: b.productionId,
    product: b.product,
    start: b.start,
    expectedMin: b.expectedMin || null,
    forgotten: isForgotten(b, now),
    long: isLong(b, now),
    note: b.note,
    complaints: b.complaints,
  });

  function cardOf(id, now) {
    const emp = employees.get(id);
    const mine = team.bookings.filter((b) => b.employeeId === id).sort((a, b) => b.start - a.start);
    const persons = mine.filter((b) => b.kind === "person");
    const machine = mine.filter((b) => b.kind === "maschine");
    const present = team.present.has(id);
    const forgotten = persons.some((b) => isForgotten(b, now));
    const double = persons.length > 1;
    const state = forgotten ? "alarm" : double ? "double" : present ? (mine.length ? "run" : "idle") : "away";
    return {
      id,
      name: emp ? emp.name : `Mitarbeiter ${id}`,
      state,
      present,
      double,
      person: persons[0] ? publicBooking(persons[0], now) : null,
      persons: persons.map((b) => publicBooking(b, now)),
      machine: machine.map((b) => publicBooking(b, now)),
    };
  }
  // Hinweise für die Leitung: vergessen, doppelt gestempelt, Maschinenlauf zu lang (über alle Mitarbeiter)
  function hintList(now) {
    const pub = (b) => ({ who: b.who, employeeId: b.employeeId, ...publicBooking(b, now) });
    const forgotten = team.bookings.filter((b) => isForgotten(b, now)).sort((a, b) => a.start - b.start).map(pub);
    const groups = new Map();
    team.bookings.filter((b) => b.kind === "person").forEach((b) => {
      const k = b.employeeId ?? `u:${b.who}`;
      groups.set(k, [...(groups.get(k) || []), b]);
    });
    const double = [...groups.values()].filter((l) => l.length > 1).map((l) => ({ who: l[0].who, employeeId: l[0].employeeId, bookings: l.map(pub) }));
    const long = team.bookings.filter((b) => isLong(b, now)).sort((a, b) => a.start - b.start).map(pub);
    return { forgotten, double, long, count: forgotten.length + double.length + long.length };
  }
  const teamMeta = () => ({
    at: teamAt,
    stale: !!teamErr,
    notice: teamErr ? (teamErr.busy ? "Odoo meldet gerade zu viele Anfragen, es werden die letzten Daten gezeigt." : teamErr.offline ? teamErr.message : "Odoo ist gerade nicht erreichbar, es werden die letzten Daten gezeigt.") : null,
    odooUrl: odoo.url || null,
  });

  // Anmeldung: signiertes Cookie, für Skripte im Browser nicht lesbar
  const b64 = (s) => Buffer.from(s).toString("base64url");
  const sig = (s) => createHmac("sha256", SECRET).update(s).digest("base64url");
  function readSession(req) {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("bde="));
    if (!raw) return null;
    const [body, mac] = raw.slice(4).split(".");
    if (!body || !mac) return null;
    const a = Buffer.from(sig(body));
    const b = Buffer.from(mac);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return s && PEOPLE.includes(s.e) && s.exp > Date.now() ? { ...s, leitung: LEITUNG.includes(s.e) } : null;
    } catch {
      return null;
    }
  }
  function writeSession(req, res, value, maxAgeMs) {
    const secure = req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https");
    res.append("Set-Cookie", `bde=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`);
  }

  // Fehlversuche: nach 5 falschen PINs ist der Mitarbeiter (und das Gerät) 5 Minuten gesperrt
  const fails = new Map();
  const lockedFor = (k) => {
    const f = fails.get(k);
    return f && f.until > Date.now() ? f.until - Date.now() : 0;
  };
  const addFail = (k) => {
    const f = fails.get(k) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= MAX_FAILS) {
      f.until = Date.now() + LOCK_MS;
      f.n = 0;
    }
    fails.set(k, f);
  };

  const fail = (res, err) =>
    res.status(err && err.forbidden ? 403 : err && (err.busy || err.offline) ? 503 : err && err.user ? 400 : 502).json({ error: err ? err.message : "Odoo ist gerade nicht erreichbar" });

  app.get("/api/bde/team", async (req, res) => {
    await getTeam();
    if (!team) return fail(res, teamErr);
    const now = Date.now();
    const cards = TEAM.map((id) => cardOf(id, now));
    res.json({ ...teamMeta(), cards, hintCount: hintList(now).count });
  });

  app.get("/api/bde/people", async (req, res) => {
    try {
      await ensureEmployees();
    } catch (err) {
      return fail(res, err);
    }
    res.json({ people: peopleList() });
  });

  // Wer ist auf diesem Gerät angemeldet, und darf hier bedient werden?
  app.get("/api/bde/session", (req, res) => {
    const s = readSession(req);
    res.json({ id: s ? s.e : null, leitung: s ? s.leitung : false, write: odoo.writeEnabled, phone: isPhone(req) });
  });

  app.post("/api/bde/login", async (req, res) => {
    const id = Number(req.body && req.body.id);
    const pin = String((req.body && req.body.pin) || "");
    const ip = req.ip || "?";
    if (!PEOPLE.includes(id)) return res.status(400).json({ error: "Unbekannter Mitarbeiter" });
    const wait = Math.max(lockedFor(`e${id}`), lockedFor(`ip${ip}`));
    if (wait) return res.status(429).json({ error: `Zu viele falsche Versuche. Bitte in ${Math.ceil(wait / 60000)} Minuten noch einmal.` });
    if (!/^\d{4,8}$/.test(pin)) {
      addFail(`e${id}`);
      addFail(`ip${ip}`);
      return res.status(401).json({ error: "PIN stimmt nicht" });
    }
    let ok = false;
    try {
      ok = (await odoo.read("hr.employee", "search_count", { domain: [["id", "=", id], ["pin", "=", pin]] })) === 1;
    } catch (err) {
      return fail(res, err);
    }
    if (!ok) {
      addFail(`e${id}`);
      addFail(`ip${ip}`);
      return res.status(401).json({ error: "PIN stimmt nicht" });
    }
    fails.delete(`e${id}`);
    const body = b64(JSON.stringify({ e: id, exp: Date.now() + SESSION_MS }));
    writeSession(req, res, `${body}.${sig(body)}`, SESSION_MS);
    res.json({ ok: true });
  });

  app.post("/api/bde/logout", (req, res) => {
    writeSession(req, res, "", 0);
    res.json({ ok: true });
  });

  // Persönliche Daten, je Mitarbeiter höchstens einmal pro Minute aus Odoo
  const personalCache = new Map();
  const calendarHours = new Map();
  async function loadPersonal(id) {
    const now = Date.now();
    const ws = weekStart(now);
    const today = berlinDate(now);
    const emp = employees.get(id);
    const who = emp && emp.userId ? ["|", ["employee_id", "=", id], ["user_id", "=", emp.userId]] : [["employee_id", "=", id]];
    const atts = await odoo.read("hr.attendance", "search_read", {
      domain: [["employee_id", "=", id], ["check_in", "<", toOdoo(now)], "|", ["check_out", "=", false], ["check_out", ">=", toOdoo(ws)]],
      fields: ["check_in", "check_out", "worked_hours"],
      limit: 200,
    });
    const week = await odoo.read("mrp.workcenter.productivity", "search_read", {
      domain: [...who, ["date_start", "<", toOdoo(now)], "|", ["date_end", "=", false], ["date_end", ">=", toOdoo(ws)]],
      fields: ["workcenter_id", "date_start", "date_end"],
      limit: 500,
    });
    const recentRows = await odoo.read("mrp.workcenter.productivity", "search_read", {
      domain: who,
      fields: ["workorder_id", "workcenter_id", "production_id", "date_start", "date_end"],
      order: "date_start desc",
      limit: 40,
    });
    const alloc = await odoo.read("hr.leave.allocation", "search_read", {
      domain: [["employee_id", "=", id], ["state", "=", "validate"], ["date_from", "<=", today], "|", ["date_to", "=", false], ["date_to", ">=", today]],
      fields: ["number_of_days", "leaves_taken"],
      limit: 50,
    });
    const [me] = await odoo.read("hr.employee", "read", { ids: [id], fields: ["hours_today", "total_overtime", "resource_calendar_id"] });
    const cal = me && m2o(me.resource_calendar_id);
    if (cal && !calendarHours.has(cal.id)) {
      const [c] = await odoo.read("resource.calendar", "read", { ids: [cal.id], fields: ["hours_per_week"] });
      calendarHours.set(cal.id, c && typeof c.hours_per_week === "number" ? c.hours_per_week : null);
    }

    // Anwesenheit: abgeschlossene mit Odoos eigener Arbeitszeit (Pausen schon abgezogen), die laufende bis jetzt
    const clip = (a, b) => [Math.max(a, ws), Math.min(b, now)];
    const attendanceMs = atts.reduce((sum, a) => {
      const from = parseOdoo(a.check_in);
      const to = parseOdoo(a.check_out);
      if (to && from >= ws && typeof a.worked_hours === "number") return sum + a.worked_hours * 3600000;
      const [x, y] = clip(from, to ?? now);
      return sum + Math.max(0, y - x);
    }, 0);
    const personMs = mergedMs(week.filter((w) => kindOf(m2o(w.workcenter_id)?.name) === "person").map((w) => clip(parseOdoo(w.date_start), parseOdoo(w.date_end) ?? now)));

    // Zuletzt: die drei letzten unterschiedlichen Arbeitsgänge; "Weiter" = letzte beendete Personentätigkeit
    const seen = new Set();
    const recent = [];
    let lastPerson = null;
    for (const r of recentRows) {
      const wo = m2o(r.workorder_id);
      if (!wo) continue;
      const wc = m2o(r.workcenter_id);
      const kind = kindOf(wc?.name);
      if (!lastPerson && kind === "person") lastPerson = { workorderId: wo.id, closed: !!r.date_end };
      if (seen.has(wo.id) || recent.length === 3) continue;
      seen.add(wo.id);
      const prod = m2o(r.production_id);
      recent.push({ workorderId: wo.id, label: labelOf(wc?.name), kind, fa: prod ? prod.name : null, productionId: prod ? prod.id : null, last: parseOdoo(r.date_start) });
    }
    const readIds = [...new Set([...recent.map((r) => r.workorderId), ...(lastPerson ? [lastPerson.workorderId] : [])])];
    let resume = null;
    if (readIds.length) {
      const wos = await odoo.read("mrp.workorder", "read", { ids: readIds, fields: ["product_id", "state", "name", "production_id", "workcenter_id"] });
      const byId = new Map(wos.map((w) => [w.id, w]));
      recent.forEach((r) => {
        const w = byId.get(r.workorderId);
        r.product = w && Array.isArray(w.product_id) ? String(w.product_id[1]) : null;
        r.open = !!w && !["done", "cancel"].includes(w.state);
      });
      const w = lastPerson && lastPerson.closed && byId.get(lastPerson.workorderId);
      if (w && !["done", "cancel"].includes(w.state)) {
        const prod = m2o(w.production_id);
        resume = { workorderId: w.id, label: labelOf(m2o(w.workcenter_id)?.name), fa: prod ? prod.name : null, product: Array.isArray(w.product_id) ? String(w.product_id[1]) : null };
      }
    }

    const vacation = alloc.length ? Math.round(alloc.reduce((s, a) => s + (Number(a.number_of_days) || 0) - (Number(a.leaves_taken) || 0), 0) * 10) / 10 : null;
    return {
      weekFrom: ws,
      attendanceH: attendanceMs / 3600000,
      personH: personMs / 3600000,
      todayH: me && typeof me.hours_today === "number" ? me.hours_today : null,
      overtimeH: me && typeof me.total_overtime === "number" ? me.total_overtime : null,
      weekTargetH: cal ? calendarHours.get(cal.id) ?? null : null,
      vacation,
      recent,
      resume,
    };
  }
  async function getPersonal(id, force = false) {
    const c = personalCache.get(id);
    if (!force && c && c.data && Date.now() - c.at < PERSONAL_TTL) return c.data;
    if (!force && c && c.p) return c.p;
    const p = loadPersonal(id);
    personalCache.set(id, { ...(c || {}), p });
    try {
      const data = await p;
      personalCache.set(id, { at: Date.now(), data });
      return data;
    } catch (err) {
      if (c && c.data) {
        personalCache.set(id, { at: c.at, data: c.data });
        return { ...c.data, stale: true };
      }
      personalCache.delete(id);
      throw err;
    }
  }
  // Nach einer Buchung sofort frische Daten
  function invalidate(employeeId) {
    teamAt = 0;
    teamGen += 1;
    if (employeeId != null) personalCache.delete(employeeId);
  }

  app.get("/api/bde/me", async (req, res) => {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    const target = req.query.id != null ? Number(req.query.id) : s.e;
    if (target !== s.e && !(s.leitung && PEOPLE.includes(target))) return res.status(403).json({ error: "Nur die eigenen Daten" });
    try {
      await ensureEmployees();
      const personal = await getPersonal(target);
      await getTeam();
      const now = Date.now();
      res.json({
        ...teamMeta(),
        me: { id: s.e, name: employees.get(s.e)?.name || "", leitung: s.leitung, exp: s.exp },
        viewing: { id: target, name: employees.get(target)?.name || "" },
        people: s.leitung ? peopleList() : undefined,
        write: odoo.writeEnabled,
        phone: isPhone(req),
        card: team ? cardOf(target, now) : null,
        ...personal,
        hints: s.leitung && team ? hintList(now) : undefined,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  const ctx = {
    odoo,
    TEAM,
    LEITUNG,
    PEOPLE,
    employees: () => employees,
    ensureEmployees,
    getTeam,
    teamData: () => team,
    cardOf,
    hintList,
    teamMeta,
    getPersonal,
    invalidate,
    readSession,
    fail,
  };
  registerBdeActions(app, db, ctx);
  registerBdeKiosk(app, ctx);
  registerBdeMachines(app, db, ctx);
  registerBdeTasks(app, ctx);
  registerBdePhotos(app, ctx);
  if (staff) registerBdeParts(app, db, ctx, staff);

  // Für Erinnerungen über Talos (n8n): offene Hinweise mit Odoo-Benutzer, nur mit eigenem Schlüssel
  app.get("/api/bde/reminders", async (req, res) => {
    const want = process.env.BDE_REMINDER_KEY || "";
    const got = String(req.headers["x-bde-reminder-key"] || "");
    if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.status(403).json({ error: "Kein Zugriff" });
    await getTeam();
    if (!team) return fail(res, teamErr);
    const h = hintList(Date.now());
    const userOf = (id) => (id != null && employees.get(id) ? employees.get(id).userId : null);
    const add = (b) => ({ ...b, userId: userOf(b.employeeId) });
    res.json({ forgotten: h.forgotten.map(add), double: h.double.map(add), long: h.long.map(add), leitung: LEITUNG.map((id) => ({ employeeId: id, userId: userOf(id) })) });
  });
}
