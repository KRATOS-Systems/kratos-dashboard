// Meine Aufgaben: offene Odoo-Aktivitäten (mail.activity) des angemeldeten Mitarbeiters, sortiert nach Frist.
//
// Odoo weist Aktivitäten Benutzern zu, nicht Mitarbeitern: Wer keinen Odoo-Benutzer hat, hat keine Aufgaben.
// "Erledigt" schließt die Aktivität über Odoos eigene Methode action_feedback (wie der Haken in Odoo) mit dem Vermerk,
// wer sie über die BDE erledigt hat. Nur mit BDE_WRITE=1, nur eigene Aufgaben, nicht am Handy.

import { m2o, berlinDate, isPhone } from "./bde.js";

const CACHE_MS = 60 * 1000;
// Ausgeblendete Aktivitätstypen: 6 = "Ausnahme" (legt Odoo selbst an, wenn bei Verkauf, Fertigung oder Lieferung etwas nicht passt)
// (hier selbst eingelesen: Werte aus bde.js stehen beim Laden dieses Moduls noch nicht bereit)
const HIDDEN_TYPES = String(process.env.BDE_HIDE_ACTIVITY_TYPES || "6")
  .split(",")
  .map((x) => parseInt(x, 10))
  .filter(Number.isInteger);
const MODEL_LABELS = {
  "mrp.production": "Fertigungsauftrag",
  "sale.order": "Verkauf",
  "purchase.order": "Einkauf",
  "stock.picking": "Lieferung",
  "project.task": "Aufgabe",
  "crm.lead": "Anfrage",
  "account.move": "Rechnung",
  "knowledge.article": "Wissen",
  "res.partner": "Kontakt",
  "hr.employee": "Mitarbeiter",
  "quality.alert": "Reklamation",
};
const userErr = (msg) => Object.assign(new Error(msg), { user: true });

// Notiz aus Odoo (HTML) als kurzer Text
const plain = (html) =>
  String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

export default function registerBdeTasks(app, ctx) {
  const { odoo } = ctx;
  const cache = new Map();

  async function load(userId) {
    const rows = await odoo.read("mail.activity", "search_read", {
      domain: [["user_id", "=", userId], ["date_done", "=", false], ["activity_type_id", "not in", HIDDEN_TYPES]],
      fields: ["activity_type_id", "summary", "note", "date_deadline", "res_model", "res_id", "res_name"],
      order: "date_deadline asc, id asc",
      limit: 100,
    });
    return rows.map((a) => ({
      id: a.id,
      type: m2o(a.activity_type_id)?.name || "Aufgabe",
      summary: a.summary ? String(a.summary).slice(0, 160) : null,
      note: plain(a.note) || null,
      deadline: typeof a.date_deadline === "string" ? a.date_deadline.slice(0, 10) : null,
      model: a.res_model || null,
      modelLabel: MODEL_LABELS[a.res_model] || null,
      resId: Number.isInteger(a.res_id) ? a.res_id : null,
      resName: a.res_name ? String(a.res_name).slice(0, 120) : null,
    }));
  }

  // Ziel der Aufgabe: Session prüfen wie bei /api/bde/me (Leitung darf andere ansehen)
  function target(req, res) {
    const s = ctx.readSession(req);
    if (!s) {
      res.status(401).json({ error: "Bitte anmelden" });
      return null;
    }
    const id = req.query.id != null ? Number(req.query.id) : s.e;
    if (id !== s.e && !(s.leitung && ctx.PEOPLE.includes(id))) {
      res.status(403).json({ error: "Nur die eigenen Aufgaben" });
      return null;
    }
    return { s, id };
  }

  app.get("/api/bde/aufgaben", async (req, res) => {
    const t = target(req, res);
    if (!t) return;
    try {
      await ctx.ensureEmployees();
      const emp = ctx.employees().get(t.id);
      if (!emp || !emp.userId) return res.json({ items: [], noUser: true, today: berlinDate(Date.now()) });
      let c = cache.get(emp.userId);
      if (!c || Date.now() - c.at > CACHE_MS) {
        c = { at: Date.now(), items: await load(emp.userId) };
        cache.set(emp.userId, c);
      }
      const base = odoo.url || "";
      res.json({
        today: berlinDate(Date.now()),
        own: t.id === t.s.e,
        canDone: t.id === t.s.e && odoo.writeEnabled && !isPhone(req),
        items: c.items.map((a) => ({ ...a, link: base && a.model && a.resId ? `${base}/odoo/${a.model}/${a.resId}` : null })),
      });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  app.post("/api/bde/aufgaben/erledigt", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    if (isPhone(req)) return res.status(403).json({ error: "Am Handy gibt es nur die Anzeige." });
    if (!odoo.writeEnabled) return res.status(403).json({ error: "Erledigen ist noch nicht freigeschaltet (BDE_WRITE)" });
    const id = Number(req.body && req.body.id);
    try {
      await ctx.ensureEmployees();
      const emp = ctx.employees().get(s.e);
      if (!emp || !emp.userId) throw userErr("Ohne Odoo-Benutzer gibt es keine Aufgaben");
      const [a] = await odoo.read("mail.activity", "read", { ids: [id], fields: ["user_id", "date_done"] });
      if (!a || m2o(a.user_id)?.id !== emp.userId) throw Object.assign(new Error("Nur die eigenen Aufgaben"), { forbidden: true });
      if (a.date_done) throw userErr("Diese Aufgabe ist schon erledigt");
      await odoo.write("mail.activity", "action_feedback", { ids: [id], feedback: `Erledigt über Kratos BDE von ${emp.name}` });
      cache.delete(emp.userId);
      res.json({ ok: true });
    } catch (err) {
      ctx.fail(res, err);
    }
  });
}
