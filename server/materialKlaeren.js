// Material klären: Fakten aus Odoo zum Rohmaterial eines Fertigungsauftrags, damit ein Widerspruch (AV „bereit“, Odoo „nicht verfügbar“)
// mit einem Klick gelöst werden kann. Nur lesen; die App bucht keinen Bestand (das macht ein Mensch in Odoo über „Bestand aktualisieren“).
//
//   GET /api/material/:id  -> { verfuegbar, fa, komponenten: [{ productId, tmplId, name, gebraucht, reserviert, bestand,
//                               bestellungen: [{ id, name, status, menge, erhalten, datum, wareneingang: { id, name } | null }] }] }
//
// Odoo-Abfragen nacheinander (parallele Abfragen laufen dort in das Anfrage-Limit).

const PO_STATUS = { draft: "Entwurf", sent: "Anfrage gesendet", "to approve": "zur Freigabe", purchase: "bestellt" };
const m2oId = (v) => (Array.isArray(v) ? v[0] : v || null);
const m2oName = (v) => (Array.isArray(v) ? v[1] : "");

export default function registerMaterialKlaeren(app, db) {
  app.get("/api/material/:id", async (req, res) => {
    const id = Number(req.params.id);
    const o = Number.isInteger(id) ? db.prepare("SELECT id, odoo_id, odoo_ref, component_status FROM orders WHERE id = ?").get(id) : null;
    if (!o) return res.status(404).json({ error: "Position nicht gefunden" });
    const read = app.locals.odooRead;
    if (!read) return res.json({ verfuegbar: false, grund: "Odoo ist nicht angebunden" });
    if (!o.odoo_id) return res.json({ verfuegbar: false, grund: "Position ohne Fertigungsauftrag in Odoo" });
    try {
      const [mo] = await read("mrp.production", { domain: [["id", "=", o.odoo_id]], fields: ["name", "move_raw_ids", "components_availability"], limit: 1 });
      if (!mo) return res.json({ verfuegbar: false, grund: "Fertigungsauftrag in Odoo nicht gefunden" });
      const moves = mo.move_raw_ids && mo.move_raw_ids.length ? await read("stock.move", { domain: [["id", "in", mo.move_raw_ids]], fields: ["product_id", "product_uom_qty", "quantity", "state"], limit: 50 }) : [];
      const pids = [...new Set(moves.map((m) => m2oId(m.product_id)).filter(Boolean))];
      const prods = pids.length ? await read("product.product", { domain: [["id", "in", pids]], fields: ["display_name", "product_tmpl_id", "qty_available"], limit: 50 }) : [];
      const lines = pids.length
        ? await read("purchase.order.line", {
            domain: [["product_id", "in", pids], ["state", "in", ["draft", "sent", "to approve", "purchase"]]],
            fields: ["order_id", "product_id", "product_qty", "qty_received", "state", "date_planned"],
            order: "id desc",
            limit: 50,
          })
        : [];
      // Offene Wareneingänge zu bestätigten Bestellungen (Herkunft = Bestellnummer)
      const poNamen = [...new Set(lines.filter((l) => l.state === "purchase" && (Number(l.qty_received) || 0) < (Number(l.product_qty) || 0)).map((l) => m2oName(l.order_id)).filter(Boolean))];
      const picks = poNamen.length
        ? await read("stock.picking", { domain: [["picking_type_code", "=", "incoming"], ["state", "not in", ["done", "cancel"]], ["origin", "in", poNamen]], fields: ["name", "origin"], limit: 50 })
        : [];
      const komponenten = moves.map((m) => {
        const pid = m2oId(m.product_id);
        const p = prods.find((x) => x.id === pid) || {};
        return {
          productId: pid,
          tmplId: m2oId(p.product_tmpl_id),
          name: p.display_name || m2oName(m.product_id),
          gebraucht: Number(m.product_uom_qty) || 0,
          reserviert: Number(m.quantity) || 0,
          bestand: p.qty_available != null ? Number(p.qty_available) : null,
          bestellungen: lines
            .filter((l) => m2oId(l.product_id) === pid)
            .map((l) => {
              const pk = picks.find((x) => x.origin === m2oName(l.order_id));
              return {
                id: m2oId(l.order_id),
                name: m2oName(l.order_id),
                status: PO_STATUS[l.state] || l.state,
                entwurf: l.state === "draft" || l.state === "sent",
                menge: Number(l.product_qty) || 0,
                erhalten: Number(l.qty_received) || 0,
                datum: l.date_planned ? String(l.date_planned).slice(0, 10) : null,
                wareneingang: pk ? { id: pk.id, name: pk.name } : null,
              };
            }),
        };
      });
      res.json({ verfuegbar: true, fa: { id: o.odoo_id, name: mo.name, status: mo.components_availability || o.component_status || null }, komponenten });
    } catch (err) {
      res.status(502).json({ error: `Odoo: ${err.message}` });
    }
  });
}
