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

const MARK = "über Kratos BDE";
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default function registerBdeTasks(app, ctx) {
  const { odoo } = ctx;
  const cache = new Map();
  // Wer Aufgaben vergeben und bekommen kann: Mitarbeiter der BDE mit Odoo-Benutzer (Aktivitäten gehören in Odoo einem Benutzer)
  const withUser = () => ctx.PEOPLE.map((id) => ctx.employees().get(id)).filter((e) => e && e.userId);

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

  // Aufgabe vergeben: Odoo-Aktivität (To-do) beim Empfänger, am Fertigungsauftrag / Auftrag oder sonst am Mitarbeiter
  app.get("/api/bde/aufgaben/empfaenger", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    try {
      await ctx.ensureEmployees();
      const list = withUser();
      res.json({ canAssign: odoo.writeEnabled && !isPhone(req) && list.some((e) => e.id === s.e), people: list.map((e) => ({ id: e.id, name: e.name })) });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  app.post("/api/bde/aufgaben/neu", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    if (isPhone(req)) return res.status(403).json({ error: "Am Handy gibt es nur die Anzeige." });
    if (!odoo.writeEnabled) return res.status(403).json({ error: "Aufgaben vergeben ist noch nicht freigeschaltet (BDE_WRITE)" });
    const { to, summary, deadline, ref } = req.body || {};
    const text = String(summary || "").trim();
    const today = berlinDate(Date.now());
    try {
      await ctx.ensureEmployees();
      const list = withUser();
      const from = list.find((e) => e.id === s.e);
      const target = list.find((e) => e.id === Number(to));
      if (!from) throw Object.assign(new Error("Ohne Odoo-Benutzer können keine Aufgaben vergeben werden"), { forbidden: true });
      if (!target) throw userErr("Diese Person kann keine Aufgaben bekommen");
      if (text.length < 2 || text.length > 160) throw userErr("Bitte kurz beschreiben, was zu tun ist");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(deadline || "")) || deadline < today) throw userErr("Bitte eine Frist ab heute wählen");
      // Bezug: Fertigungsauftrag (FA…) oder Auftrag (A…), sonst der Mitarbeiter selbst
      let model = "hr.employee";
      let recId = target.id;
      const refText = String(ref || "").trim().toUpperCase();
      if (refText) {
        if (!/^[A-Z]{1,3}\d{3,}$/.test(refText)) throw userErr("Bezug bitte als Nummer, z. B. FA01212 oder A01365");
        model = refText.startsWith("FA") ? "mrp.production" : "sale.order";
        const [hit] = await odoo.read(model, "search_read", { domain: [["name", "=", refText]], fields: ["name"], limit: 1 });
        if (!hit) throw userErr(`${refText} gibt es in Odoo nicht`);
        recId = hit.id;
      }
      await odoo.write(model, "activity_schedule", {
        ids: [recId],
        act_type_xmlid: "mail.mail_activity_data_todo",
        date_deadline: deadline,
        summary: text,
        note: `<p>Vergeben von ${escHtml(from.name)} ${MARK}</p>`,
        user_id: target.userId,
      });
      cache.delete(target.userId);
      sentCache.delete(from.id);
      res.json({ ok: true });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Von mir vergebene, noch offene Aufgaben (erkannt am Vermerk in der Notiz)
  const sentCache = new Map();
  app.get("/api/bde/aufgaben/vergeben", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    try {
      await ctx.ensureEmployees();
      const me = ctx.employees().get(s.e);
      let c = sentCache.get(s.e);
      if (!c || Date.now() - c.at > CACHE_MS) {
        const rows = await odoo.read("mail.activity", "search_read", {
          domain: [["note", "ilike", `Vergeben von ${me ? me.name : "?"} ${MARK}`], ["date_done", "=", false]],
          fields: ["summary", "date_deadline", "user_id", "res_model", "res_id", "res_name"],
          order: "date_deadline asc, id asc",
          limit: 100,
        });
        const byUser = new Map([...ctx.employees().values()].filter((e) => e.userId).map((e) => [e.userId, e]));
        c = {
          at: Date.now(),
          items: rows.map((a) => {
            const u = m2o(a.user_id);
            const emp = u ? byUser.get(u.id) : null;
            return { id: a.id, summary: a.summary || "", deadline: a.date_deadline || null, toId: emp ? emp.id : null, toName: emp ? emp.name : u ? u.name : "?", model: a.res_model, resName: a.res_model === "hr.employee" ? null : a.res_name || null };
          }),
        };
        sentCache.set(s.e, c);
      }
      res.json({ today: berlinDate(Date.now()), items: c.items });
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
