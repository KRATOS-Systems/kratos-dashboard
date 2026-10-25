// Zeiten ohne Auftrag: Stundenzettel (account.analytic.line) auf die Aufgaben des Odoo-Projekts "Gemeinkosten"
// (AV / Planung allgemein, QS allgemein, Instandhaltung, Unterbrechung, …). Die Aufgaben kommen per Projektname aus Odoo,
// neue erscheinen also von selbst.
//
// Odoos Stundenzettel-Timer (timer.timer) passt hier nicht: er gehört immer dem Odoo-Benutzer, der ihn startet (bei uns der
// eine Zugang des Dashboards), je Benutzer läuft nur einer, und beim Stoppen rundet Odoo auf 15 Minuten. Deshalb:
// - Start: Stundenzettel mit Dauer 0 und der Beschreibung "läuft seit 08:51 · Kratos BDE" anlegen. Maßgebliche Startzeit ist
//   der Anlegezeitpunkt in Odoo (sekundengenau), die Uhrzeit im Text ist für Menschen. Daran erkennt jedes Gerät die laufende Buchung.
//   Laufende Einträge zählen nie als fertige Buchung, nur als laufend (bis jetzt).
// - Stopp/Pause: echte Dauer in Stunden eintragen (ohne Rundung), Beschreibung "08:51–10:15 · Kratos BDE".
// Geschrieben wird nur im Projekt Gemeinkosten und nur auf laufende Einträge der BDE; gelöscht wird nichts.
//
// Hier bewusst ohne Import aus bde.js (Ringimport); Hilfsfunktionen kommen als Parameter.

const PROJECT_NAME = String(process.env.BDE_GEMEINKOSTEN_PROJEKT || "Gemeinkosten").trim();
const TASKS_TTL = 5 * 60 * 1000;
const RUN_SUFFIX = " · Kratos BDE";
const RUN_LIKE = ["name", "=like", `läuft seit %${RUN_SUFFIX}`]; // laufend, von der BDE angelegt
const isRunning = (name) => /^läuft seit .* · Kratos BDE$/.test(String(name || ""));
const userErr = (msg) => Object.assign(new Error(msg), { user: true });
const fmtHM = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });

export function createOverhead({ odoo, m2o, parseOdoo, berlinDate }) {
  let cache = null; // { at, projectId, tasks: [{ taskId, label }] }

  // Projekt und Aufgaben (5 Minuten zwischengespeichert); ohne Projekt gibt es keine Gemeinkosten
  async function load(force = false) {
    if (!force && cache && Date.now() - cache.at < TASKS_TTL) return cache;
    const [project] = await odoo.read("project.project", "search_read", { domain: [["name", "=", PROJECT_NAME]], fields: ["name"], limit: 1 });
    let tasks = [];
    if (project) {
      const rows = await odoo.read("project.task", "search_read", {
        domain: [["project_id", "=", project.id]],
        fields: ["name", "sequence"],
        order: "sequence asc, id asc",
        limit: 50,
      });
      tasks = rows.map((t) => ({ taskId: t.id, label: String(t.name || "").slice(0, 60) }));
    }
    cache = { at: Date.now(), projectId: project ? project.id : null, tasks };
    return cache;
  }
  const taskName = (c, taskId, fallback) => c.tasks.find((t) => t.taskId === taskId)?.label || fallback || "Ohne Auftrag";

  const lineOf = (c, l) => {
    const t = m2o(l.task_id);
    return { lineId: l.id, employeeId: m2o(l.employee_id)?.id ?? null, taskId: t ? t.id : null, label: taskName(c, t?.id, t?.name), start: parseOdoo(l.create_date) };
  };

  // Laufende Buchungen ohne Auftrag (alle oder eines Mitarbeiters)
  async function running(employeeId) {
    const c = await load();
    if (!c.projectId) return [];
    const rows = await odoo.read("account.analytic.line", "search_read", {
      domain: [["project_id", "=", c.projectId], RUN_LIKE, ...(employeeId != null ? [["employee_id", "=", employeeId]] : [])],
      fields: ["employee_id", "task_id", "create_date"],
      limit: 300,
    });
    return rows.map((l) => lineOf(c, l));
  }

  async function start(employeeId, taskId) {
    const c = await load();
    if (!c.projectId) throw userErr(`Das Projekt „${PROJECT_NAME}“ gibt es in Odoo nicht`);
    if (!c.tasks.some((t) => t.taskId === taskId)) {
      const fresh = await load(true);
      if (!fresh.tasks.some((t) => t.taskId === taskId)) throw userErr("Diese Aufgabe gibt es im Projekt Gemeinkosten nicht");
    }
    const res = await odoo.write("account.analytic.line", "create", {
      vals_list: [{ project_id: c.projectId, task_id: taskId, employee_id: employeeId, name: `läuft seit ${fmtHM.format(new Date())}${RUN_SUFFIX}`, date: berlinDate(Date.now()), unit_amount: 0 }],
    });
    return Array.isArray(res) ? res[0] : res;
  }

  // Beenden: echte Dauer eintragen (Stunden, auf die Sekunde genau gerundet auf 4 Stellen)
  async function stop(line, endAt = Date.now()) {
    const ms = Math.max(0, endAt - line.start);
    await odoo.write("account.analytic.line", "write", {
      ids: [line.lineId],
      vals: { unit_amount: Math.round((ms / 3600000) * 10000) / 10000, name: `${fmtHM.format(new Date(line.start))}–${fmtHM.format(new Date(endAt))}${RUN_SUFFIX}` },
    });
  }

  // Wochenzeit ohne Auftrag (ms) und die zuletzt benutzten Aufgaben eines Mitarbeiters
  async function personal(employeeId, ws, now) {
    const c = await load();
    if (!c.projectId) return { ms: 0, recent: [], last: null };
    const week = await odoo.read("account.analytic.line", "search_read", {
      domain: [["project_id", "=", c.projectId], ["employee_id", "=", employeeId], ["date", ">=", berlinDate(ws)]],
      fields: ["name", "unit_amount", "create_date"],
      limit: 500,
    });
    const ms = week.reduce((sum, l) => sum + (isRunning(l.name) ? Math.max(0, now - (parseOdoo(l.create_date) ?? now)) : (Number(l.unit_amount) || 0) * 3600000), 0);
    const rows = await odoo.read("account.analytic.line", "search_read", {
      domain: [["project_id", "=", c.projectId], ["employee_id", "=", employeeId]],
      fields: ["employee_id", "task_id", "create_date", "name", "unit_amount"],
      order: "id desc",
      limit: 20,
    });
    const seen = new Set();
    const recent = [];
    rows.forEach((l) => {
      const x = lineOf(c, l);
      if (!x.taskId || seen.has(x.taskId) || !c.tasks.some((t) => t.taskId === x.taskId)) return;
      seen.add(x.taskId);
      recent.push({ taskId: x.taskId, label: x.label, kind: "person", overhead: true, fa: null, last: x.start, open: true });
    });
    const l0 = rows[0];
    const last = l0 ? { ...lineOf(c, l0), closed: !isRunning(l0.name), end: !isRunning(l0.name) ? (parseOdoo(l0.create_date) ?? 0) + (Number(l0.unit_amount) || 0) * 3600000 : null } : null;
    return { ms, recent, last };
  }

  return { load, running, start, stop, personal, PROJECT_NAME };
}
