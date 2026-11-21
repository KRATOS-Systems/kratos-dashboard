// Versand und Abrechnung.
//
// Station VERSAND: Nach QS / Extern gehen Positionen eines Kundenauftrags (A-Nummer) in die Spur VERSAND (verpacken, Lieferschein).
// Versendet ist eine Position, sobald die Lieferung in Odoo bestätigt ist: Die Auftragsposition mit demselben Artikel ist vollständig
// geliefert (oder der ganze Kundenauftrag laut Odoo). Dann ist die Position erledigt, mit Versanddatum = Datum der letzten Lieferung.
// Teillieferung: „20 von 50 geliefert“ steht an der Position, sie bleibt im Versand. Ohne Odoo-Bezug geht „Versendet“ von Hand.
//
// Zu berechnen: Kundenaufträge, bei denen mehr geliefert als berechnet ist, je Auftragsposition nach Menge (höchstens die bestellte Menge,
// sonst zählen z. B. EMPB-Zeilen mit „3 von 1 geliefert“ falsch). Odoos eigenes „zu berechnen“ taugt nicht: Abgerechnet wird nach
// bestellter Menge, damit steht jeder bestätigte Auftrag schon auf „zu berechnen“.
//
// Aufgabe in Odoo (das Einzige, was hier in Odoo schreibt): je Kundenauftrag und Lieferstand einmal eine Aktivität „Rechnung stellen“
// am Kundenauftrag für RECHNUNG_USER_ID (Standard 2 = Alexander). Nur mit BDE_WRITE=1, nur für Lieferungen ab dem Start dieser Funktion
// (ältere Fälle stehen nur in der Liste) und nicht mit VERSAND_AUFGABE=0. Rechnungen schreibt die App nicht.
//
// Erledigt: versendete bzw. erledigte Aufträge der letzten Tage mit Versanddatum, pünktlich/verspätet, Teillieferungen und Rechnung.

const TTL = 5 * 60 * 1000;
const dayPart = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const m2oId = (v) => (Array.isArray(v) ? v[0] : typeof v === "number" ? v : null);
const m2oName = (v) => (Array.isArray(v) && v[1] ? String(v[1]) : null);
const codeOf = (s) => {
  const m = /^\s*\[([^\]]+)\]/.exec(String(s || ""));
  return m ? m[1].trim() : null;
};
const isA = (s) => typeof s === "string" && /^A\d{3,}$/.test(s.trim());
const todayBerlin = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const fmtDe = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");
const fmtN = (n) => (Math.round(n * 100) / 100).toLocaleString("de-DE");
const eur = (n) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const customerOf = (v) => {
  const n = m2oName(v);
  return n ? n.split(",")[0].trim().slice(0, 120) : null;
};

export const VERSAND_DDL = `
  CREATE TABLE IF NOT EXISTS versand_rechnung (
    sale TEXT PRIMARY KEY,
    sig TEXT NOT NULL,
    geplant_am TEXT NOT NULL,
    fehler TEXT
  );`;

// Noch zu berechnen je Auftragsposition: geliefert (höchstens bestellt) minus berechnet; Dienstleistungen und Abschnitte zählen nicht
export function offenZuBerechnen(lines) {
  return lines
    .filter((l) => !l.display_type && l.product_type !== "service" && (Number(l.price_unit) || 0) > 0)
    .map((l) => {
      const bestellt = Number(l.product_uom_qty) || 0;
      const geliefert = Math.min(Number(l.qty_delivered) || 0, bestellt);
      const berechnet = Number(l.qty_invoiced) || 0;
      const offen = Math.max(0, Math.round((geliefert - berechnet) * 1000) / 1000);
      return { artikel: m2oName(l.product_id) || String(l.name || "").split("\n")[0], code: codeOf(m2oName(l.product_id)), bestellt, geliefert, berechnet, offen, wert: offen * (Number(l.price_unit) || 0) };
    })
    .filter((x) => x.offen > 0);
}

// Wert des Gelieferten (höchstens die bestellte Menge) – zum Vergleich mit den gebuchten Rechnungsbeträgen
export function gelieferterWert(lines) {
  return lines
    .filter((l) => !l.display_type && (Number(l.price_unit) || 0) > 0)
    .reduce((t, l) => t + Math.min(Number(l.qty_delivered) || 0, Number(l.product_uom_qty) || 0) * (Number(l.price_unit) || 0), 0);
}
// Gebuchte Rechnungen minus Gutschriften (netto)
export function berechneterWert(moves) {
  return moves.filter((m) => m.state === "posted").reduce((t, m) => t + (m.move_type === "out_refund" ? -1 : m.move_type === "out_invoice" ? 1 : 0) * (Number(m.amount_untaxed) || 0), 0);
}

// Versandstand einer Position aus den Zeilen ihres Kundenauftrags (gleicher Artikel: Name, sonst Artikelnummer)
export function versandStand(o, lines, sale) {
  const code = codeOf(o.product);
  const passend = lines.filter((l) => !l.display_type && (m2oName(l.product_id) === o.product || (code && (codeOf(m2oName(l.product_id)) === code || codeOf(l.name) === code))));
  if (!passend.length) return sale && sale.delivery_status === "full" ? { versendet: true, info: "Kundenauftrag vollständig geliefert" } : { versendet: false, info: null };
  const bestellt = passend.reduce((s, l) => s + (Number(l.product_uom_qty) || 0), 0);
  const geliefert = passend.reduce((s, l) => s + (Number(l.qty_delivered) || 0), 0);
  if (bestellt > 0 && geliefert + 1e-6 >= bestellt) return { versendet: true, info: `${fmtN(bestellt)} von ${fmtN(bestellt)} geliefert` };
  if (geliefert > 0) return { versendet: false, info: `${fmtN(geliefert)} von ${fmtN(bestellt)} geliefert (Teillieferung)` };
  return { versendet: false, info: null };
}

export default function registerVersand(app, db) {
  db.exec(VERSAND_DDL);
  const getState = (k) => {
    const r = db.prepare("SELECT value FROM plan_settings WHERE key = ?").get(k);
    return r ? r.value : null;
  };
  const setState = (k, v) => db.prepare("INSERT INTO plan_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v);
  // Ab wann gibt es Aufgaben in Odoo? Ältere Lieferungen stehen nur in der Liste.
  if (!getState("versand_start")) setState("versand_start", todayBerlin());
  const userId = Number(process.env.RECHNUNG_USER_ID) || 2;
  const ORDERS_SINCE = /^\d{4}-\d{2}-\d{2}$/.test(process.env.ORDERS_SINCE || "") ? process.env.ORDERS_SINCE : "2026-01-01";

  async function readAll(model, domain, fields, limit = 500) {
    const read = app.locals.odooRead;
    return read(model, { domain, fields, limit });
  }
  async function byNames(names, fields) {
    const out = [];
    for (let i = 0; i < names.length; i += 80) out.push(...(await readAll("sale.order", [["name", "in", names.slice(i, i + 80)]], fields, 200)));
    return out;
  }
  async function linesOf(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100)
      out.push(...(await readAll("sale.order.line", [["order_id", "in", ids.slice(i, i + 100)]], ["order_id", "product_id", "name", "product_uom_qty", "qty_delivered", "qty_invoiced", "price_unit", "display_type", "product_type"], 3000)));
    return out;
  }
  // Erledigte Lieferungen (Ausgang) je Kundenauftrag: über sale_id oder Herkunft (manche Lieferungen hängen nur über die Herkunft am Auftrag)
  async function lieferungenOf(sales) {
    if (!sales.length) return new Map();
    const ids = sales.map((s) => s.id);
    const names = sales.map((s) => s.name);
    const out = [];
    for (let i = 0; i < ids.length; i += 80)
      out.push(
        ...(await readAll(
          "stock.picking",
          ["&", ["picking_type_code", "=", "outgoing"], "|", ["sale_id", "in", ids.slice(i, i + 80)], ["origin", "in", names.slice(i, i + 80)]],
          ["name", "state", "date_done", "sale_id", "origin", "backorder_id"],
          1000
        ))
      );
    const byName = new Map(sales.map((s) => [s.name, s]));
    const map = new Map();
    for (const p of out) {
      const s = sales.find((x) => x.id === m2oId(p.sale_id)) || byName.get(String(p.origin || "").trim());
      if (!s) continue;
      if (!map.has(s.name)) map.set(s.name, []);
      map.get(s.name).push({ name: p.name, state: p.state, datum: dayPart(p.date_done), rueckstand: !!p.backorder_id });
    }
    return map;
  }

  let cache = null;
  let running = null;

  async function compute() {
    const enabled = !!app.locals.odooRead;
    const versandRows = db.prepare("SELECT * FROM orders WHERE done = 0 AND machine = 'versand' ORDER BY due_date, source, id").all();
    if (!enabled) return { enabled: false, stand: new Date().toISOString(), versand: versandRows.map((o) => ({ id: o.id, info: o.ship_info || null })), zuBerechnen: [], aufgabe: null };
    const today = todayBerlin();

    // 1. Versand: Stand der Kundenaufträge der Positionen im Versand
    const quellen = [...new Set(versandRows.map((o) => (o.source || "").trim()).filter(isA))];
    const vSales = quellen.length ? await byNames(quellen, ["name", "delivery_status", "state", "partner_id", "commitment_date"]) : [];
    const vLines = vSales.length ? await linesOf(vSales.map((s) => s.id)) : [];
    const vPicks = await lieferungenOf(vSales);
    const shipped = [];
    const versand = versandRows.map((o) => {
      const sale = vSales.find((s) => s.name === (o.source || "").trim());
      if (!sale) return { id: o.id, info: o.ship_info || null };
      const st = versandStand(o, vLines.filter((l) => m2oId(l.order_id) === sale.id), sale);
      const done = (vPicks.get(sale.name) || []).filter((p) => p.state === "done" && p.datum).sort((a, b) => b.datum.localeCompare(a.datum));
      const last = done[0] || null;
      const info = st.info ? st.info + (last ? `, zuletzt ${fmtDe(last.datum)} (${last.name})` : "") : null;
      if (st.versendet) shipped.push({ id: o.id, datum: (last && last.datum) || today, info });
      return { id: o.id, info, kunde: customerOf(sale.partner_id), lieferungen: done.length };
    });
    if (shipped.length) {
      const upd = db.prepare("UPDATE orders SET done = 1, done_date = ?, shipped_date = ?, ship_info = ? WHERE id = ? AND done = 0 AND machine = 'versand'");
      const info = db.prepare("UPDATE orders SET ship_info = ? WHERE id = ?");
      db.exec("BEGIN");
      try {
        shipped.forEach((s) => upd.run(s.datum, s.datum, s.info, s.id));
        versand.filter((v) => v.info && !shipped.some((s) => s.id === v.id)).forEach((v) => info.run(v.info, v.id));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } else {
      const info = db.prepare("UPDATE orders SET ship_info = ? WHERE id = ?");
      versand.filter((v) => v.info).forEach((v) => info.run(v.info, v.id));
    }

    // 2. Zu berechnen: geliefert, aber noch nicht (vollständig) berechnet.
    //    Erst je Auftragsposition nach Mengen; dann gegen die gebuchten Rechnungsbeträge geprüft (Odoo verknüpft Rechnungszeilen nicht
    //    immer mit der Auftragszeile, z. B. A01086) – auch über Duplikate hinweg: gleicher Kunde und gleiche Bestellnummer des Kunden
    //    (Lieferung auf dem einen, Rechnung auf dem anderen Auftrag, z. B. A01233/A01091). Aufträge über 0 € zählen nicht.
    const kandidaten = (
      await readAll(
        "sale.order",
        [["state", "=", "sale"], ["date_order", ">=", ORDERS_SINCE + " 00:00:00"], ["delivery_status", "in", ["partial", "full"]], ["invoice_status", "!=", "invoiced"]],
        ["name", "partner_id", "commitment_date", "delivery_status", "invoice_status", "amount_untaxed", "invoice_ids", "client_order_ref", "origin"],
        500
      )
    ).filter((s) => (Number(s.amount_untaxed) || 0) > 0);
    const refOf = (s) => {
      const r = String(s.client_order_ref || s.origin || "").trim();
      return r && !/^A\d{3,}$/.test(r) ? r : null;
    };
    const gruppeOf = (s) => (refOf(s) ? `${customerOf(s.partner_id) || m2oId(s.partner_id)}|${refOf(s)}` : "#" + s.id);
    const refs = [...new Set(kandidaten.map(refOf).filter(Boolean))];
    const zwillinge = [];
    for (let i = 0; i < refs.length; i += 80) {
      const chunk = refs.slice(i, i + 80);
      zwillinge.push(...(await readAll("sale.order", [["state", "=", "sale"], "|", ["client_order_ref", "in", chunk], ["origin", "in", chunk]], ["name", "partner_id", "invoice_ids", "client_order_ref", "origin"], 500)));
    }
    const alle = [...kandidaten, ...zwillinge.filter((z) => !kandidaten.some((k) => k.id === z.id))];
    const kLines = alle.length ? await linesOf(alle.map((s) => s.id)) : [];
    const moveIds = [...new Set(alle.flatMap((s) => s.invoice_ids || []))];
    const moves = [];
    for (let i = 0; i < moveIds.length; i += 200) moves.push(...(await readAll("account.move", [["id", "in", moveIds.slice(i, i + 200)]], ["move_type", "state", "amount_untaxed"], 400)));
    const gruppen = new Map();
    alle.forEach((s) => {
      const g = gruppeOf(s);
      if (!gruppen.has(g)) gruppen.set(g, []);
      gruppen.get(g).push(s);
    });
    const kPicks = await lieferungenOf(kandidaten);
    const zuBerechnen = kandidaten
      .map((s) => {
        const offen = offenZuBerechnen(kLines.filter((l) => m2oId(l.order_id) === s.id));
        if (!offen.length) return null;
        const g = gruppen.get(gruppeOf(s)) || [s];
        const geliefert = g.reduce((t, x) => t + gelieferterWert(kLines.filter((l) => m2oId(l.order_id) === x.id)), 0);
        const berechnet = berechneterWert(moves.filter((m) => g.some((x) => (x.invoice_ids || []).includes(m.id))));
        const rest = Math.round((geliefert - berechnet) * 100) / 100;
        if (rest <= 1) return null; // die Rechnungen decken das Gelieferte (auch wenn Odoo die Zeilen nicht verknüpft hat)
        const done = (kPicks.get(s.name) || []).filter((p) => p.state === "done" && p.datum).sort((a, b) => b.datum.localeCompare(a.datum));
        const zeilenWert = offen.reduce((t, x) => t + x.wert, 0);
        return {
          sale: s.name,
          saleId: s.id,
          kunde: customerOf(s.partner_id),
          versendetAm: done.length ? done[0].datum : null,
          lieferung: done.length ? done[0].name : null,
          teil: s.delivery_status === "partial",
          positionen: offen,
          wert: Math.round(Math.min(zeilenWert, rest) * 100) / 100,
          duplikat: g.filter((x) => x.id !== s.id).map((x) => x.name),
          sig: offen.map((x) => `${x.code || x.artikel}:${x.geliefert}`).sort().join("|"),
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.versendetAm || "").localeCompare(String(a.versendetAm || "")) || a.sale.localeCompare(b.sale));

    // 3. Aufgabe „Rechnung stellen“ in Odoo (einmal je Auftrag und Lieferstand, nur für Lieferungen ab dem Start)
    const aufgabe = await aufgabenAnlegen(zuBerechnen, today);
    const gemacht = new Map(db.prepare("SELECT sale, sig, geplant_am, fehler FROM versand_rechnung").all().map((r) => [r.sale, r]));
    zuBerechnen.forEach((z) => {
      const r = gemacht.get(z.sale);
      z.aufgabe = r && r.sig === z.sig ? (r.fehler ? { fehler: r.fehler } : { am: r.geplant_am }) : null;
      delete z.sig;
    });
    return { enabled: true, stand: new Date().toISOString(), versand, versendet: shipped.length, zuBerechnen, aufgabe };
  }

  async function aufgabenAnlegen(list, today) {
    const odoo = app.locals.odooBde;
    const start = getState("versand_start") || today;
    const an = process.env.VERSAND_AUFGABE !== "0" && process.env.BDE_WRITE === "1" && !!odoo;
    const status = { an, userId, start };
    if (!an) return status;
    const prev = db.prepare("SELECT sig FROM versand_rechnung WHERE sale = ?");
    const save = db.prepare("INSERT INTO versand_rechnung (sale, sig, geplant_am, fehler) VALUES (?, ?, ?, ?) ON CONFLICT (sale) DO UPDATE SET sig = excluded.sig, geplant_am = excluded.geplant_am, fehler = excluded.fehler");
    let neu = 0;
    for (const z of list) {
      if (!z.versendetAm || z.versendetAm < start) continue;
      const p = prev.get(z.sale);
      if (p && p.sig === z.sig) continue;
      const zeilen = z.positionen.map((x) => `<li>${esc(fmtN(x.offen))} × ${esc(x.artikel)} (geliefert ${esc(fmtN(x.geliefert))}, berechnet ${esc(fmtN(x.berechnet))})</li>`).join("");
      try {
        await odoo.write("sale.order", "activity_schedule", {
          ids: [z.saleId],
          act_type_xmlid: "mail.mail_activity_data_todo",
          date_deadline: today,
          summary: `Rechnung stellen: ${z.sale}`.slice(0, 100),
          note: `<p>Ware versendet am ${esc(fmtDe(z.versendetAm))}${z.lieferung ? ` (${esc(z.lieferung)})` : ""}${z.teil ? ", Teillieferung" : ""}. Geliefert, noch nicht berechnet${z.wert ? ` (ca. ${esc(eur(z.wert))} netto)` : ""}:</p><ul>${zeilen}</ul><p>Angelegt vom Produktionsdashboard (Versand).</p>`,
          user_id: userId,
        });
        save.run(z.sale, z.sig, today, null);
        neu++;
      } catch (err) {
        save.run(z.sale, z.sig, today, String(err.message || err).slice(0, 200));
        console.error("Versand: Aufgabe für", z.sale, "nicht angelegt:", err.message);
      }
    }
    return { ...status, neu };
  }

  async function get(force) {
    if (!force && cache && Date.now() - cache.at < TTL) return cache.data;
    if (running) return running;
    running = compute()
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  app.get("/api/versand", async (req, res) => {
    try {
      res.json(await get(req.query.neu === "1"));
    } catch (err) {
      res.status(502).json({ error: "Odoo nicht lesbar: " + err.message });
    }
  });

  // Von Hand versendet (ohne Lieferung in Odoo, z. B. Abholung oder Position ohne Odoo-Bezug)
  app.post("/api/versand/:id/versendet", (req, res) => {
    const id = Number(req.params.id);
    const datum = /^\d{4}-\d{2}-\d{2}$/.test(String((req.body || {}).datum || "")) ? req.body.datum : todayBerlin();
    const info = db.prepare("UPDATE orders SET done = 1, done_date = ?, shipped_date = ?, ship_info = COALESCE(ship_info, 'von Hand als versendet gemeldet') WHERE id = ? AND done = 0").run(datum, datum, id);
    if (!info.changes) return res.status(404).json({ error: "Position nicht gefunden oder schon erledigt" });
    if (cache) cache.at = 0;
    res.json({ ok: true, datum });
  });

  // Erledigt: Aufträge, deren Positionen alle erledigt sind (Versanddatum, pünktlich, Teillieferungen, Rechnung)
  app.get("/api/erledigt", async (req, res) => {
    try {
      const tage = Math.min(366, Math.max(1, Number(req.query.tage) || 30));
      const q = String(req.query.q || "").trim().toLowerCase().slice(0, 60);
      const seit = addDays(todayBerlin(), -tage);
      const rows = db.prepare("SELECT * FROM orders WHERE done = 1 AND done_date IS NOT NULL AND done_date >= ? ORDER BY done_date DESC, id DESC").all(q ? "2000-01-01" : seit);
      const offenNoch = new Set(db.prepare("SELECT DISTINCT source FROM orders WHERE done = 0 AND source IS NOT NULL").all().map((r) => r.source));
      const groups = new Map();
      for (const o of rows) {
        const key = o.source || o.order_no || o.odoo_ref || "#" + o.id;
        if (!groups.has(key)) groups.set(key, { auftrag: key, positionen: [] });
        groups.get(key).positionen.push(o);
      }
      let list = [...groups.values()]
        .map((g) => {
          const ps = g.positionen;
          const versendet = ps.map((o) => o.shipped_date || o.done_date).filter(Boolean).sort().pop() || null;
          const due = ps.map((o) => o.due_date).filter(Boolean).sort()[0] || null;
          return {
            auftrag: g.auftrag,
            kunde: ps.find((o) => o.customer)?.customer || null,
            artikel: [...new Set(ps.map((o) => o.product).filter(Boolean))].slice(0, 4),
            ids: ps.map((o) => o.id),
            anzahl: ps.length,
            versendetAm: versendet,
            perOdoo: ps.some((o) => o.shipped_date && o.ship_info && !/von Hand/.test(o.ship_info)),
            liefertermin: due,
            puenktlich: due && versendet ? versendet <= due : null,
            tageZuSpaet: due && versendet && versendet > due ? Math.round((Date.parse(versendet) - Date.parse(due)) / 86400000) : 0,
            teilweiseOffen: offenNoch.has(g.auftrag),
          };
        })
        .filter((g) => !q || [g.auftrag, g.kunde, ...g.artikel].some((x) => String(x || "").toLowerCase().includes(q)))
        .slice(0, 300);
      // Rechnung und Lieferungen aus Odoo (nur Kundenaufträge)
      const names = list.map((g) => g.auftrag).filter(isA);
      if (app.locals.odooRead && names.length) {
        const sales = await byNames(names, ["name", "invoice_status", "delivery_status", "partner_id", "commitment_date"]);
        const lines = sales.length ? await linesOf(sales.map((s) => s.id)) : [];
        const picks = await lieferungenOf(sales);
        const bySale = new Map(sales.map((s) => [s.name, s]));
        list = list.map((g) => {
          const s = bySale.get(g.auftrag);
          if (!s) return g;
          const offen = offenZuBerechnen(lines.filter((l) => m2oId(l.order_id) === s.id));
          const lf = (picks.get(s.name) || []).filter((p) => p.state === "done");
          return {
            ...g,
            kunde: g.kunde || customerOf(s.partner_id),
            lieferungen: lf.length,
            lieferscheine: lf.map((p) => p.name),
            rechnung: s.invoice_status === "invoiced" ? "berechnet" : offen.length ? "offen" : "berechnet",
            offenWert: Math.round(offen.reduce((t, x) => t + x.wert, 0) * 100) / 100,
          };
        });
      }
      res.json({ tage, q, list });
    } catch (err) {
      res.status(502).json({ error: "Odoo nicht lesbar: " + err.message });
    }
  });

  app.locals.versand = { get, cached: () => (cache ? cache.data : null) };
  if (process.env.VERSAND_AUTO !== "0") {
    setTimeout(() => get(true).catch((err) => console.error("Versand:", err.message)), 90 * 1000).unref();
    setInterval(() => get(true).catch((err) => console.error("Versand:", err.message)), 10 * 60 * 1000).unref();
  }
}
