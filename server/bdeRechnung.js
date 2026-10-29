// Hinweis "Zur Rechnung bereit" für die Leitung (Mein Arbeitsplatz).
//
// Ein Kundenauftrag (A-Nummer) ist fertig gefertigt, wenn es zu ihm Fertigungsaufträge gibt und keiner mehr offen ist. Ein Fertigungsauftrag zählt als fertig,
// wenn er in Odoo abgeschlossen ist oder alle seine Arbeitsgänge erledigt sind (bei uns wurde der Auftrag oft nicht abgeschlossen, obwohl alles fertig war).
// In die Liste kommen nur Aufträge, bei denen Odoo selbst noch etwas zu berechnen sieht (Rechnungsstatus "Zu berechnen"). Hat Odoo schon alles berechnet,
// verschwindet der Hinweis von selbst. Die App liefert und berechnet nichts, sie zeigt nur an.
// Nur lesen: sale.order, mrp.production, mrp.workorder.

import { m2o, toOdoo } from "./bde.js";

const TTL_MS = 5 * 60 * 1000;
const SINCE_DAYS = 180;
const DELIVERY = { full: "geliefert", partial: "teilweise geliefert", pending: "noch nicht geliefert" };

export default function registerBdeRechnung(app, ctx) {
  const { odoo } = ctx;
  let cache = { at: 0, items: [] };

  async function load() {
    const sales = await odoo.read("sale.order", "search_read", {
      domain: [["state", "=", "sale"], ["invoice_status", "=", "to invoice"], ["create_date", ">=", toOdoo(Date.now() - SINCE_DAYS * 24 * 3600 * 1000)]],
      fields: ["name", "partner_id", "amount_total", "invoice_count", "delivery_status"],
      order: "id desc",
      limit: 300,
    });
    if (!sales.length) return [];
    const mos = [];
    for (let i = 0; i < sales.length; i += 100) {
      const chunk = sales.slice(i, i + 100).map((s) => s.name);
      mos.push(...(await odoo.read("mrp.production", "search_read", { domain: [["origin", "in", chunk], ["state", "!=", "cancel"]], fields: ["name", "origin", "state"], limit: 1500 })));
    }
    // Fertigungsaufträge, die in Odoo noch offen sind, aber deren Arbeitsgänge alle erledigt sind
    const notDone = mos.filter((m) => m.state !== "done");
    const finished = new Set(mos.filter((m) => m.state === "done").map((m) => m.id));
    for (let i = 0; i < notDone.length; i += 150) {
      const ids = notDone.slice(i, i + 150).map((m) => m.id);
      const wos = await odoo.read("mrp.workorder", "search_read", { domain: [["production_id", "in", ids], ["state", "!=", "cancel"]], fields: ["production_id", "state"], limit: 1500 });
      const per = new Map();
      wos.forEach((w) => {
        const pid = m2o(w.production_id)?.id;
        if (!pid) return;
        const cur = per.get(pid) || { n: 0, done: 0 };
        cur.n += 1;
        if (w.state === "done") cur.done += 1;
        per.set(pid, cur);
      });
      per.forEach((v, pid) => v.n > 0 && v.n === v.done && finished.add(pid));
    }
    const byOrigin = new Map();
    mos.forEach((m) => {
      const o = String(m.origin || "").trim();
      if (!o) return;
      const cur = byOrigin.get(o) || { all: 0, done: 0 };
      cur.all += 1;
      if (finished.has(m.id)) cur.done += 1;
      byOrigin.set(o, cur);
    });
    return sales
      .filter((s) => {
        const v = byOrigin.get(s.name);
        return v && v.all > 0 && v.all === v.done;
      })
      .map((s) => ({
        id: s.id,
        name: s.name,
        partner: m2o(s.partner_id)?.name || null,
        total: typeof s.amount_total === "number" ? s.amount_total : null,
        invoices: s.invoice_count || 0,
        delivery: s.delivery_status || null,
        deliveryLabel: DELIVERY[s.delivery_status] || "",
        parts: byOrigin.get(s.name).all,
      }));
  }

  app.get("/api/bde/rechnung", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    if (!s.leitung) return res.json({ items: [] });
    try {
      if (Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), items: await load() };
      res.json({ items: cache.items });
    } catch (err) {
      ctx.fail(res, err);
    }
  });
}
