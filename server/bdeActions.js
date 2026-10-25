// Bedienen (Version 2): Wechseln, Unterbrechen, Weiter, Stopp und die Schnellauswahl.
//
// Gebucht wird nur über Odoos Methoden am Arbeitsgang: start_employee / stop_employee (so trägt Odoo den richtigen Mitarbeiter ein).
// Regeln:
// - Personentätigkeiten sind exklusiv: Starten einer neuen beendet die laufende. Maschinenlauf läuft parallel weiter.
// - Unterbrechen beendet die laufende Personentätigkeit, "Weiter" startet die zuletzt beendete wieder.
// - Jeder bedient nur seine eigenen Buchungen; die Leitung darf fremde beenden.
// - Ein Maschinenlauf kann mit der echten Endzeit beendet werden ("fertig um 22:10"): nach dem Stopp wird am Zeiteintrag nur das Ende
//   auf diese Zeit gesetzt und eine Markierung in die Beschreibung geschrieben. Nicht vor dem Start, nicht in der Zukunft.
// - Am Handy gibt es keine Bedienung.

import { kindOf, labelOf, m2o, parseOdoo, toOdoo, isPhone } from "./bde.js";

const PLAN_MACHINES = ["dmu40", "m1", "h800u"];
const userErr = (msg) => Object.assign(new Error(msg), { user: true });
export const END_MARK = "Endzeit nachgetragen";

const fmtBerlin = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function registerBdeActions(app, db, ctx) {
  const { odoo, overhead } = ctx;

  async function running(employeeId) {
    const rows = await odoo.read("mrp.workcenter.productivity", "search_read", {
      domain: [["date_end", "=", false], ["employee_id", "=", employeeId]],
      fields: ["workorder_id", "workcenter_id", "date_start"],
      limit: 50,
    });
    return rows.map((r) => ({ id: r.id, workorderId: m2o(r.workorder_id)?.id, kind: kindOf(m2o(r.workcenter_id)?.name), start: parseOdoo(r.date_start) }));
  }
  const stop = (workorderId, employeeId) => odoo.write("mrp.workorder", "stop_employee", { ids: [workorderId], employee_ids: [employeeId] });
  const start = (workorderId, employeeId) => odoo.write("mrp.workorder", "start_employee", { ids: [workorderId], employee_id: employeeId });

  async function workorder(id) {
    const [w] = await odoo.read("mrp.workorder", "read", { ids: [id], fields: ["state", "workcenter_id", "production_id", "name"] });
    if (!w) throw userErr("Arbeitsgang nicht gefunden");
    if (["done", "cancel"].includes(w.state)) throw userErr("Dieser Arbeitsgang ist schon abgeschlossen");
    return { ...w, kind: kindOf(m2o(w.workcenter_id)?.name) };
  }

  // Es läuft immer nur eine Personentätigkeit: Arbeitsgang am Auftrag oder Zeit ohne Auftrag (Gemeinkosten).
  // Maschinenläufe laufen davon unberührt parallel weiter.
  async function stopOverhead(emp, exceptTaskId = null) {
    for (const l of await overhead.running(emp)) if (l.taskId !== exceptTaskId) await overhead.stop(l);
  }

  // Tätigkeit starten (Wechseln, Helfen, Schnellauswahl)
  async function doStart(emp, workorderId) {
    const w = await workorder(workorderId);
    if (w.kind === "extern") throw userErr("Externe Arbeitsgänge werden nicht gestempelt");
    const runs = await running(emp);
    if (runs.some((r) => r.workorderId === workorderId)) return { already: true };
    if (w.kind === "person") {
      for (const r of runs.filter((x) => x.kind === "person")) await stop(r.workorderId, emp);
      await stopOverhead(emp);
    }
    await start(workorderId, emp);
    return { started: workorderId };
  }
  // Zeit ohne Auftrag starten: beendet die laufende Personentätigkeit (Auftrag oder andere Gemeinkosten-Aufgabe)
  async function doStartTask(emp, taskId) {
    if (!Number.isInteger(taskId) || taskId <= 0) throw userErr("Unbekannte Aufgabe");
    const oh = await overhead.running(emp);
    if (oh.some((l) => l.taskId === taskId)) return { already: true };
    for (const r of (await running(emp)).filter((x) => x.kind === "person")) await stop(r.workorderId, emp);
    await stopOverhead(emp, taskId);
    await overhead.start(emp, taskId);
    return { startedTask: taskId };
  }
  async function doPause(emp) {
    const runs = (await running(emp)).filter((r) => r.kind === "person");
    const oh = await overhead.running(emp);
    if (!runs.length && !oh.length) throw userErr("Es läuft keine Tätigkeit");
    for (const r of runs) await stop(r.workorderId, emp);
    for (const l of oh) await overhead.stop(l);
    return { paused: runs.map((r) => r.workorderId), pausedTasks: oh.map((l) => l.taskId) };
  }
  // Weiter: das, was zuletzt lief (Auftrag oder Zeit ohne Auftrag)
  async function doResume(emp) {
    const [last] = await odoo.read("mrp.workcenter.productivity", "search_read", {
      domain: [["employee_id", "=", emp], ["date_end", "!=", false]],
      fields: ["workorder_id", "workcenter_id", "date_end"],
      order: "date_end desc",
      limit: 20,
    }).then((rows) => rows.filter((r) => kindOf(m2o(r.workcenter_id)?.name) === "person"));
    const oh = (await overhead.personal(emp, Date.now(), Date.now())).last;
    const woEnd = last ? parseOdoo(last.date_end) : 0;
    if (oh && oh.closed && oh.taskId && (oh.end || 0) > (woEnd || 0)) return doStartTask(emp, oh.taskId);
    if (!last || !m2o(last.workorder_id)) throw userErr("Keine unterbrochene Tätigkeit gefunden");
    return doStart(emp, m2o(last.workorder_id).id);
  }
  async function doStopTask(emp, taskId) {
    const l = (await overhead.running(emp)).find((x) => x.taskId === taskId);
    if (!l) throw userErr("Diese Buchung läuft nicht mehr");
    await overhead.stop(l);
    return { stoppedTask: taskId };
  }
  // Stoppen; bei Maschinenlauf optional mit echter Endzeit
  async function doStop(emp, workorderId, endAt, byName) {
    const runs = await running(emp);
    const run = runs.find((r) => r.workorderId === workorderId);
    if (!run) throw userErr("Diese Buchung läuft nicht mehr");
    if (endAt != null) {
      if (run.kind !== "maschine") throw userErr("Eine abweichende Endzeit gibt es nur beim Maschinenlauf");
      if (!Number.isFinite(endAt) || endAt < run.start) throw userErr("Die Endzeit liegt vor dem Start");
      if (endAt > Date.now() + 60000) throw userErr("Die Endzeit liegt in der Zukunft");
    }
    const stoppedAt = Date.now();
    await stop(workorderId, emp);
    if (endAt != null && stoppedAt - endAt > 60000) {
      const [line] = await odoo.read("mrp.workcenter.productivity", "search_read", {
        domain: [["employee_id", "=", emp], ["workorder_id", "=", workorderId], ["date_end", "!=", false]],
        fields: ["date_start", "date_end", "description"],
        order: "date_end desc",
        limit: 1,
      });
      if (line && parseOdoo(line.date_start) <= endAt) {
        const mark = `${END_MARK}: Maschine fertig ${fmtBerlin.format(new Date(endAt))}, gestoppt ${fmtBerlin.format(new Date(stoppedAt))}${byName ? ` von ${byName}` : ""} (BDE)`;
        await odoo.write("mrp.workcenter.productivity", "write", {
          ids: [line.id],
          vals: { date_end: toOdoo(endAt), description: line.description ? `${line.description}\n${mark}` : mark },
        });
      }
    }
    return { stopped: workorderId };
  }

  app.post("/api/bde/act", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    if (isPhone(req)) return res.status(403).json({ error: "Am Handy gibt es nur die Anzeige. Bitte am Tablet oder PC stempeln." });
    if (!odoo.writeEnabled) return res.status(403).json({ error: "Bedienen ist noch nicht freigeschaltet (BDE_WRITE)" });
    const { action, workorderId, taskId, employeeId, endAt } = req.body || {};
    const task = taskId != null ? Number(taskId) : null; // Zeit ohne Auftrag (Aufgabe im Projekt Gemeinkosten)
    const target = employeeId != null ? Number(employeeId) : s.e;
    try {
      if (target !== s.e) {
        // Fremde Buchungen: nur die Leitung, und nur beenden
        if (!s.leitung) throw Object.assign(new Error("Nur die eigenen Buchungen"), { forbidden: true });
        if (action !== "stop") throw Object.assign(new Error("Fremde Buchungen kann die Leitung nur beenden"), { forbidden: true });
      }
      await ctx.ensureEmployees();
      const byName = target !== s.e ? ctx.employees().get(s.e)?.name : null;
      let out;
      if (action === "start") out = task != null ? await doStartTask(target, task) : await doStart(target, Number(workorderId));
      else if (action === "pause") out = await doPause(target);
      else if (action === "resume") out = await doResume(target);
      else if (action === "stop") out = task != null ? await doStopTask(target, task) : await doStop(target, Number(workorderId), endAt != null ? Number(endAt) : null, byName);
      else throw userErr("Unbekannte Aktion");
      ctx.invalidate(target);
      res.json({ ok: true, ...out });
    } catch (err) {
      ctx.invalidate(target);
      ctx.fail(res, err);
    }
  });

  // Schnellauswahl "Als Nächstes": offene Arbeitsgänge der Aufträge, die in der Planung auf einer Maschine als Nächstes kommen
  const woFields = ["name", "state", "production_id", "workcenter_id", "product_id", "duration_expected"];
  const pickOf = (w) => {
    const prod = m2o(w.production_id);
    return {
      workorderId: w.id,
      label: labelOf(m2o(w.workcenter_id)?.name),
      kind: kindOf(m2o(w.workcenter_id)?.name),
      fa: prod ? prod.name : null,
      productionId: prod ? prod.id : null,
      product: Array.isArray(w.product_id) ? String(w.product_id[1]) : null,
      state: w.state,
    };
  };
  // Auftragsnummer (A…) aus dem Ursprung des Fertigungsauftrags dazuschreiben
  async function withOrder(items) {
    const ids = [...new Set(items.map((p) => p.productionId).filter(Boolean))];
    if (!ids.length) return items;
    const prods = await odoo.read("mrp.production", "read", { ids, fields: ["origin"] });
    const origin = new Map(prods.map((p) => [p.id, p.origin || null]));
    return items.map((p) => ({ ...p, order: origin.get(p.productionId) || null }));
  }
  // Reiter "Ohne Auftrag": Aufgaben des Projekts Gemeinkosten
  app.get("/api/bde/gemeinkosten", async (req, res) => {
    if (!ctx.readSession(req)) return res.status(401).json({ error: "Bitte anmelden" });
    try {
      const c = await overhead.load();
      res.json({ project: c.projectId ? overhead.PROJECT_NAME : null, items: c.tasks.map((t) => ({ ...t, kind: "person", overhead: true, fa: null })) });
    } catch (err) {
      ctx.fail(res, err);
    }
  });
  const taskHits = async (q) => {
    try {
      const c = await overhead.load();
      const needle = q.toLocaleLowerCase("de-DE");
      return c.tasks.filter((t) => t.label.toLocaleLowerCase("de-DE").includes(needle)).map((t) => ({ ...t, kind: "person", overhead: true, fa: null }));
    } catch (err) {
      if (err.busy) throw err;
      return [];
    }
  };

  app.get("/api/bde/next", async (req, res) => {
    if (!ctx.readSession(req)) return res.status(401).json({ error: "Bitte anmelden" });
    try {
      const planned = db
        .prepare(`SELECT odoo_id, machine, position FROM orders WHERE done = 0 AND odoo_id IS NOT NULL AND machine IN (${PLAN_MACHINES.map(() => "?").join(",")}) ORDER BY position`)
        .all(...PLAN_MACHINES);
      const rank = new Map();
      planned.forEach((o, i) => !rank.has(o.odoo_id) && rank.set(o.odoo_id, i));
      const ids = [...rank.keys()].slice(0, 20);
      let rows = ids.length ? await odoo.read("mrp.workorder", "search_read", { domain: [["production_id", "in", ids], ["state", "in", ["ready", "progress"]]], fields: woFields, limit: 60 }) : [];
      rows.sort((a, b) => (rank.get(m2o(a.production_id)?.id) ?? 1e9) - (rank.get(m2o(b.production_id)?.id) ?? 1e9) || a.id - b.id);
      if (rows.length < 8) {
        const more = await odoo.read("mrp.workorder", "search_read", {
          domain: [["state", "in", ["ready", "progress"]], ["production_state", "in", ["confirmed", "progress"]], ["id", "not in", rows.map((r) => r.id)]],
          fields: woFields,
          order: "production_id desc, id asc",
          limit: 12,
        });
        rows = rows.concat(more);
      }
      res.json({ items: await withOrder(rows.map(pickOf).filter((p) => p.kind !== "extern").slice(0, 12)) });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Suchen: FA-Nummer, Auftragsnummer (A…) oder Artikel
  app.get("/api/bde/search", async (req, res) => {
    if (!ctx.readSession(req)) return res.status(401).json({ error: "Bitte anmelden" });
    const q = String(req.query.q || "").trim().slice(0, 60);
    if (q.length < 2) return res.json({ items: [] });
    try {
      const rows = await odoo.read("mrp.workorder", "search_read", {
        domain: [
          ["state", "not in", ["done", "cancel"]],
          "|",
          "|",
          "|",
          ["production_id.name", "ilike", q],
          ["production_id.origin", "ilike", q],
          ["production_id.product_id.name", "ilike", q],
          ["production_id.product_id.default_code", "ilike", q],
        ],
        fields: woFields,
        order: "production_id desc, id asc",
        limit: 40,
      });
      res.json({ items: [...(await taskHits(q)), ...(await withOrder(rows.map(pickOf).filter((p) => p.kind !== "extern")))] });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Markierte Buchungen für Auswertungen: alle nachgetragenen Endzeiten (Leitung)
  app.get("/api/bde/endzeiten", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s || !s.leitung) return res.status(403).json({ error: "Nur für die Leitung" });
    try {
      const rows = await odoo.read("mrp.workcenter.productivity", "search_read", {
        domain: [["description", "ilike", END_MARK]],
        fields: ["employee_id", "workorder_id", "date_start", "date_end", "description"],
        order: "date_end desc",
        limit: 100,
      });
      res.json({ items: rows.map((r) => ({ who: m2o(r.employee_id)?.name, wo: m2o(r.workorder_id)?.name, start: parseOdoo(r.date_start), end: parseOdoo(r.date_end), note: r.description })) });
    } catch (err) {
      ctx.fail(res, err);
    }
  });
}

