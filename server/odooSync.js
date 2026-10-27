// Abgleich der Fertigungsaufträge mit Odoo (nur lesen).
//
// Regeln:
// - Beim ersten Abgleich merkt sich die App alle alten offenen Fertigungsaufträge als "bekannt" (nichts wird geändert). Was in den
//   letzten drei Tagen angelegt wurde und der App noch fehlt, kommt gleich als neu in die Liste.
// - Danach kommt jeder neu bestätigte Fertigungsauftrag (FA-Nummer) automatisch in die Liste "noch nicht eingeplant", sofern der
//   Verkaufsauftrag noch nicht vollständig ausgeliefert ist. Der Abgleich läuft alle 10 Minuten und auf Knopfdruck.
// - Bei Aufträgen, die die App schon kennt, werden Menge, Produkt und Materialstatus aktualisiert (der Liefertermin bleibt).
// - Schließen schlägt die App nur vor: Der Fertigungsauftrag ist in Odoo nicht mehr offen oder der Verkaufsauftrag ist vollständig
//   ausgeliefert. Geschlossen wird erst nach Bestätigung.
// - Fremdfertigung: Eine bestätigte Einkaufsbestellung zu einem Kundenauftrag (A-Nummer), bei der das bestellte Teil das verkaufte Teil ist,
//   kommt automatisch in die Spur "Fertigung extern" (Beginn = Bestätigung, Ende = Liefertermin des Lieferanten). Zum Schließen
//   vorgeschlagen, sobald die Ware eingegangen ist.
// Odoo wird nur gelesen, und nur wenn ODOO_URL und ODOO_API_KEY gesetzt sind.

const OPEN_STATES = ["confirmed", "progress", "to_close"];
const EVERY = 10 * 60 * 1000;
const EXT_OFFSET = 1000000000; // Einkaufspositionen liegen in odoo_seen oberhalb dieser Zahl, getrennt von den Fertigungsaufträgen
const FRESH_DAYS = 3; // beim ersten Abgleich gelten Aufträge, die in den letzten Tagen angelegt wurden, als neu

export default function registerOdooSync(app, db, { isDate, nextPosition }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_seen (
      odoo_id INTEGER PRIMARY KEY,
      first_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS odoo_sync (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const getState = (k) => db.prepare("SELECT value FROM odoo_sync WHERE key = ?").get(k)?.value ?? null;
  const setState = (k, v) =>
    db.prepare("INSERT INTO odoo_sync (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v === null ? null : String(v));

  const url = (process.env.ODOO_URL || "").replace(/\/+$/, "");
  const key = process.env.ODOO_API_KEY || "";
  const database = process.env.ODOO_DB || "";
  const enabled = !!(url && key);

  async function odoo(model, method, params) {
    const headers = { "Content-Type": "application/json; charset=utf-8", Authorization: `bearer ${key}`, "User-Agent": "kratos-dashboard/1.0" };
    if (database) headers["X-Odoo-Database"] = database;
    const res = await fetch(`${url}/json/2/${model}/${method}`, { method: "POST", headers, body: JSON.stringify({ context: { lang: "de_DE" }, ...params }), signal: AbortSignal.timeout(30000) });
    if (res.status === 429) throw new Error("Odoo hat zu viele Anfragen gemeldet (Limit). Später noch einmal versuchen.");
    if (!res.ok) throw new Error(`Odoo antwortete mit HTTP ${res.status}`);
    return res.json();
  }

  // Offene Fertigungsaufträge mit FA-Nummer und der Lieferstatus ihrer Verkaufsaufträge
  async function fetchOpen() {
    const prods = await odoo("mrp.production", "search_read", {
      domain: [["state", "in", OPEN_STATES], ["name", "=like", "FA%"]],
      fields: ["name", "state", "origin", "product_id", "product_qty", "date_deadline", "components_availability", "create_date"],
      limit: 2000,
    });
    const origins = [...new Set(prods.map((p) => (p.origin || "").trim()).filter((o) => /^[A-Z]\d{3,}$/.test(o)))];
    const delivery = new Map();
    for (let i = 0; i < origins.length; i += 150) {
      const chunk = origins.slice(i, i + 150);
      const sales = await odoo("sale.order", "search_read", { domain: [["name", "in", chunk]], fields: ["name", "delivery_status", "state"], limit: 500 });
      sales.forEach((s) => delivery.set(s.name, s));
    }
    return prods.map((p) => {
      const origin = (p.origin || "").trim();
      const sale = delivery.get(origin);
      const due = typeof p.date_deadline === "string" ? p.date_deadline.slice(0, 10) : null;
      return {
        odoo_ref: String(p.name).trim(),
        odoo_id: Number.isInteger(p.id) ? p.id : null,
        source: origin && origin.length <= 40 ? origin : null,
        product: Array.isArray(p.product_id) ? String(p.product_id[1]).slice(0, 200) : null,
        quantity: typeof p.product_qty === "number" ? p.product_qty : null,
        due: due && isDate(due) ? due : null,
        component_status: p.components_availability ? String(p.components_availability).slice(0, 60) : null,
        created: typeof p.create_date === "string" ? p.create_date.replace(" ", "T") + "Z" : null,
        delivered: !!sale && sale.delivery_status === "full",
        saleCancelled: !!sale && sale.state === "cancel",
      };
    });
  }

  // Fremdgefertigte Teile: Einkaufsbestellungen zu Kundenaufträgen, bei denen das bestellte Teil das verkaufte ist (kein Materialeinkauf)
  const dayOf = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  async function fetchExternal() {
    const since = new Date(Date.now() - 150 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const lines = await odoo("purchase.order.line", "search_read", {
      domain: [["order_id.state", "in", ["purchase", "done"]], ["order_id.origin", "=like", "A%"], ["order_id.date_order", ">=", since], ["display_type", "=", false]],
      fields: ["order_id", "product_id", "product_qty", "qty_received", "date_planned", "name"],
      limit: 2000,
    });
    if (!lines.length) return [];
    const poIds = [...new Set(lines.map((l) => (Array.isArray(l.order_id) ? l.order_id[0] : null)).filter(Boolean))];
    const pos = new Map();
    for (let i = 0; i < poIds.length; i += 150) {
      const recs = await odoo("purchase.order", "read", { ids: poIds.slice(i, i + 150), fields: ["name", "origin", "partner_id", "date_approve", "date_order", "date_planned", "create_date"] });
      recs.forEach((p) => pos.set(p.id, p));
    }
    const sourceOf = (p) => {
      const m = /\bA\d{4,}\b/.exec(p.origin || "");
      return m ? m[0] : null;
    };
    const sources = [...new Set([...pos.values()].map(sourceOf).filter(Boolean))];
    const sales = new Map();
    const sold = new Map(); // Kundenauftrag -> Artikel, die verkauft wurden
    for (let i = 0; i < sources.length; i += 100) {
      const chunk = sources.slice(i, i + 100);
      const so = await odoo("sale.order", "search_read", { domain: [["name", "in", chunk]], fields: ["name", "state", "delivery_status", "commitment_date"], limit: 300 });
      so.forEach((r) => sales.set(r.name, r));
      const sl = await odoo("sale.order.line", "search_read", { domain: [["order_id.name", "in", chunk], ["display_type", "=", false]], fields: ["order_id", "product_id"], limit: 3000 });
      sl.forEach((r) => {
        const n = Array.isArray(r.order_id) ? r.order_id[1] : null;
        const pid = Array.isArray(r.product_id) ? r.product_id[0] : null;
        if (!n || !pid) return;
        if (!sold.has(n)) sold.set(n, new Set());
        sold.get(n).add(pid);
      });
    }
    const out = [];
    lines.forEach((l) => {
      const po = pos.get(Array.isArray(l.order_id) ? l.order_id[0] : null);
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : null;
      const source = po && sourceOf(po);
      if (!po || !pid || !source || !sold.has(source) || !sold.get(source).has(pid)) return;
      const sale = sales.get(source);
      const created = typeof po.create_date === "string" ? po.create_date.replace(" ", "T") + "Z" : null;
      const planned = dayOf(l.date_planned) || dayOf(po.date_planned);
      out.push({
        odoo_ref: String(po.name) + "-" + l.id,
        line_id: l.id,
        po: String(po.name),
        source,
        supplier: Array.isArray(po.partner_id) ? String(po.partner_id[1]).slice(0, 120) : null,
        product: Array.isArray(l.product_id) ? String(l.product_id[1]).slice(0, 200) : String(l.name || "").slice(0, 200),
        quantity: typeof l.product_qty === "number" ? l.product_qty : null,
        received: (l.product_qty || 0) > 0 && (l.qty_received || 0) >= l.product_qty,
        start: dayOf(po.date_approve) || dayOf(po.date_order) || (created && created.slice(0, 10)),
        planned,
        due: sale ? dayOf(sale.commitment_date) : null,
        delivered: !!sale && sale.delivery_status === "full",
        saleCancelled: !!sale && sale.state === "cancel",
        created,
      });
    });
    return out;
  }
  const extDays = (e) => {
    if (!e.start || !e.planned) return 7;
    const d = Math.round((Date.parse(e.planned) - Date.parse(e.start)) / 86400000);
    return Math.min(120, Math.max(1, d));
  };
  // Fremdfertigung: neue Positionen und Schließvorschläge (beim ersten Mal gelten nur frisch angelegte Bestellungen als neu)
  function computeExternal(ext) {
    const seenKey = (e) => EXT_OFFSET + e.line_id;
    const seen = new Set(db.prepare("SELECT odoo_id FROM odoo_seen WHERE odoo_id >= ?").all(EXT_OFFSET).map((r) => r.odoo_id));
    const inApp = new Map(db.prepare("SELECT odoo_ref, done, source, product FROM orders WHERE odoo_ref LIKE 'P%-%'").all().map((r) => [r.odoo_ref, r]));
    const manual = db.prepare("SELECT id FROM orders WHERE source = ? AND product = ? AND done = 0 AND odoo_ref IS NULL");
    const baseline = getState("ext_baseline_done") !== "1";
    const cutoff = Date.now() - FRESH_DAYS * 24 * 3600 * 1000;
    const isNew = (e) =>
      !inApp.has(e.odoo_ref) && !e.received && !e.delivered && !e.saleCancelled && !manual.get(e.source, e.product) && (baseline ? e.created && Date.parse(e.created) >= cutoff : !seen.has(seenKey(e)));
    const created = ext.filter(isNew);
    const byRef = new Map(ext.map((e) => [e.odoo_ref, e]));
    const closing = [];
    inApp.forEach((r, ref) => {
      if (r.done !== 0) return;
      const e = byRef.get(ref);
      if (!e) closing.push({ ref, source: r.source, product: r.product, reason: "Bestellung in Odoo nicht mehr offen (storniert oder zurückgesetzt)" });
      else if (e.received) closing.push({ ref, source: r.source, product: r.product, reason: "Ware vom Lieferanten laut Odoo eingegangen" });
      else if (e.delivered) closing.push({ ref, source: r.source, product: r.product, reason: "Ware laut Odoo vollständig an den Kunden ausgeliefert" });
      else if (e.saleCancelled) closing.push({ ref, source: r.source, product: r.product, reason: "Verkaufsauftrag in Odoo storniert" });
    });
    return { created, closing, baseline, seenKey };
  }
  function applyExternal(x, ext, closeRefs) {
    const now = new Date().toISOString();
    const insert = db.prepare(
      "INSERT INTO orders (machine, order_no, due_date, position, odoo_ref, source, product, quantity, extern_start, extern_days, supplier) VALUES ('extern_fert', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const seenNew = db.prepare("INSERT OR IGNORE INTO odoo_seen (odoo_id, first_seen) VALUES (?, ?)");
    const seenOld = db.prepare("INSERT OR IGNORE INTO odoo_seen (odoo_id, first_seen) VALUES (?, 'baseline')");
    const close = db.prepare("UPDATE orders SET done = 1, done_date = COALESCE(done_date, date('now')) WHERE odoo_ref = ?");
    const dueBySource = new Map(
      db
        .prepare("SELECT source, MIN(due_date) AS d FROM orders WHERE source IS NOT NULL AND done = 0 AND due_date IS NOT NULL GROUP BY source")
        .all()
        .map((r) => [r.source, r.d])
    );
    db.exec("BEGIN");
    try {
      let position = nextPosition("extern_fert");
      x.created.forEach((e) => {
        insert.run(e.po, e.due || dueBySource.get(e.source) || null, position++, e.odoo_ref, e.source, e.product, e.quantity, e.start || new Date().toISOString().slice(0, 10), extDays(e), e.supplier);
        seenNew.run(x.seenKey(e), now);
      });
      if (x.baseline) {
        const made = new Set(x.created.map((e) => e.odoo_ref));
        ext.filter((e) => !made.has(e.odoo_ref)).forEach((e) => seenOld.run(x.seenKey(e)));
      }
      closeRefs.forEach((ref) => close.run(ref));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    if (x.baseline) setState("ext_baseline_done", "1");
  }

  // Was würde passieren? (ohne etwas zu schreiben)
  function computePlan(items) {
    const seen = new Set(db.prepare("SELECT odoo_id FROM odoo_seen").all().map((r) => r.odoo_id));
    const inApp = new Map(db.prepare("SELECT id, odoo_ref, odoo_id, done, source, product FROM orders WHERE odoo_ref LIKE 'FA%'").all().map((r) => [r.odoo_ref, r]));
    const openIds = new Set(items.map((i) => i.odoo_ref));
    const byRef = new Map(items.map((i) => [i.odoo_ref, i]));
    const created = items.filter((i) => !inApp.has(i.odoo_ref) && !seen.has(i.odoo_id) && !i.delivered && !i.saleCancelled);
    const updated = items.filter((i) => inApp.has(i.odoo_ref) && inApp.get(i.odoo_ref).done === 0);
    const closing = [];
    inApp.forEach((r, ref) => {
      if (r.done !== 0) return;
      const i = byRef.get(ref);
      if (!openIds.has(ref)) closing.push({ ref, source: r.source, product: r.product, reason: "In Odoo nicht mehr offen (erledigt, storniert oder zurück im Entwurf)" });
      else if (i.delivered) closing.push({ ref, source: r.source, product: r.product, reason: "Ware laut Odoo vollständig ausgeliefert" });
      else if (i.saleCancelled) closing.push({ ref, source: r.source, product: r.product, reason: "Verkaufsauftrag in Odoo storniert" });
    });
    const known = items.filter((i) => inApp.has(i.odoo_ref)).length;
    return { created, updated, closing, openCount: items.length, knownInApp: known };
  }

  function applyPlan(plan, { closeRefs = [], markAllSeen = false } = {}) {
    const insert = db.prepare(
      "INSERT INTO orders (machine, order_no, due_date, position, odoo_ref, source, product, quantity, odoo_id, component_status, extern_days) VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, 7)"
    );
    const update = db.prepare(
      "UPDATE orders SET source = COALESCE(?, source), product = COALESCE(?, product), quantity = CASE WHEN is_split = 1 THEN quantity ELSE COALESCE(?, quantity) END, odoo_id = COALESCE(?, odoo_id), component_status = ? WHERE odoo_ref = ? AND done = 0"
    );
    const close = db.prepare("UPDATE orders SET done = 1, done_date = COALESCE(done_date, date('now')) WHERE odoo_ref = ? OR parent_ref = ?");
    const seen = db.prepare("INSERT OR IGNORE INTO odoo_seen (odoo_id, first_seen) VALUES (?, ?)");
    const seenOld = db.prepare("INSERT OR IGNORE INTO odoo_seen (odoo_id, first_seen) VALUES (?, 'baseline')");
    // Neue Positionen eines bekannten Auftrags übernehmen dessen aktuellen Liefertermin (den frühesten der offenen Positionen)
    const dueBySource = new Map(
      db
        .prepare("SELECT source, MIN(due_date) AS d FROM orders WHERE source IS NOT NULL AND done = 0 AND due_date IS NOT NULL GROUP BY source")
        .all()
        .map((r) => [r.source, r.d])
    );
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      let position = nextPosition("");
      plan.created.forEach((i) => {
        insert.run(i.odoo_ref, (i.source && dueBySource.get(i.source)) || i.due, position++, i.odoo_ref, i.source, i.product, i.quantity, i.odoo_id, i.component_status);
        seen.run(i.odoo_id, now);
      });
      plan.updated.forEach((i) => update.run(i.source, i.product, i.quantity, i.odoo_id, i.component_status, i.odoo_ref));
      closeRefs.forEach((ref) => close.run(ref, ref));
      if (markAllSeen) plan.all.forEach((i) => seenOld.run(i.odoo_id));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  let running = false;
  async function run({ dryRun, closeRefs = [], auto = false }) {
    if (!enabled) throw new Error("Odoo ist nicht verbunden (ODOO_URL und ODOO_API_KEY fehlen auf dem Server).");
    if (running) throw new Error("Ein Abgleich läuft gerade.");
    running = true;
    try {
      const items = await fetchOpen();
      let ext = null;
      let extX = null;
      try {
        ext = await fetchExternal();
        extX = computeExternal(ext);
        setState("ext_error", null);
      } catch (err) {
        setState("ext_error", err.message);
      }
      const extCreated = () => (extX ? extX.created.map((e) => ({ ref: e.odoo_ref, source: e.source, product: e.product, quantity: e.quantity, due: e.due, supplier: e.supplier })) : []);
      const baseline = getState("baseline_done") !== "1";
      const plan = computePlan(items);
      plan.all = items;
      if (baseline) {
        // Erster Abgleich: alle alten offenen Aufträge sind "bekannt". Was in den letzten Tagen neu angelegt wurde, kommt als neu in die Liste.
        const cutoff = Date.now() - FRESH_DAYS * 24 * 3600 * 1000;
        const inApp = new Set(db.prepare("SELECT odoo_ref FROM orders WHERE odoo_ref LIKE 'FA%'").all().map((r) => r.odoo_ref));
        const isFresh = (i) => !inApp.has(i.odoo_ref) && !i.delivered && !i.saleCancelled && i.created && Date.parse(i.created) >= cutoff;
        const fresh = items.filter(isFresh);
        const old = items.filter((i) => !isFresh(i));
        if (!dryRun) {
          applyPlan({ created: fresh, updated: [], closing: [], all: old }, { markAllSeen: true });
          if (extX) applyExternal(extX, ext, []);
          setState("baseline_done", "1");
          setState("last_sync", new Date().toISOString());
          setState("last_error", null);
          setState("pending_closing", "[]");
          if (fresh.length || (extX && extX.created.length)) setState("last_change", new Date().toISOString());
        }
        return {
          baseline: true,
          openCount: plan.openCount,
          knownInApp: plan.knownInApp,
          updated: 0,
          created: [...fresh.map((i) => ({ ref: i.odoo_ref, source: i.source, product: i.product, quantity: i.quantity, due: i.due })), ...extCreated()],
          closing: [],
        };
      }
      if (!dryRun) {
        // Nur Vorschläge, die die App gerade selbst berechnet hat, dürfen geschlossen werden
        const extClosing = extX ? extX.closing : [];
        const allowed = new Set(plan.closing.map((c) => c.ref));
        const allowedExt = new Set(extClosing.map((c) => c.ref));
        applyPlan(plan, { closeRefs: closeRefs.filter((r) => allowed.has(r)) });
        if (extX) applyExternal(extX, ext, closeRefs.filter((r) => allowedExt.has(r)));
        setState("last_sync", new Date().toISOString());
        setState("last_error", null);
        if (plan.created.length || closeRefs.length || (extX && extX.created.length)) setState("last_change", new Date().toISOString());
        const remaining = [...computePlan(items).closing, ...(extX ? computeExternal(ext).closing : [])];
        setState("pending_closing", JSON.stringify(remaining));
      } else if (auto) {
        setState("pending_closing", JSON.stringify([...plan.closing, ...(extX ? extX.closing : [])]));
      }
      return {
        baseline: false,
        openCount: plan.openCount,
        created: [...plan.created.map((i) => ({ ref: i.odoo_ref, source: i.source, product: i.product, quantity: i.quantity, due: i.due })), ...extCreated()],
        updated: plan.updated.length,
        closing: [...plan.closing, ...(extX ? extX.closing : [])],
      };
    } catch (err) {
      setState("last_error", err.message);
      throw err;
    } finally {
      running = false;
    }
  }

  app.get("/api/odoo/status", (req, res) => {
    let pending = [];
    try {
      pending = JSON.parse(getState("pending_closing") || "[]");
    } catch {
      pending = [];
    }
    res.json({
      enabled,
      baselineDone: getState("baseline_done") === "1",
      lastSync: getState("last_sync"),
      lastChange: getState("last_change"),
      lastError: getState("last_error") || (getState("ext_error") ? "Einkauf (Fremdfertigung): " + getState("ext_error") : null),
      pendingClosing: pending,
    });
  });

  app.post("/api/odoo/sync", async (req, res) => {
    const { dryRun, close } = req.body || {};
    if (close !== undefined && !(Array.isArray(close) && close.length <= 500 && close.every((r) => typeof r === "string" && r.length <= 40))) {
      return res.status(400).json({ error: "invalid payload" });
    }
    try {
      res.json(await run({ dryRun: dryRun !== false, closeRefs: close || [] }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Abgleich im Hintergrund (alle 10 Minuten): übernimmt neue Aufträge und aktualisiert bekannte, schließt nie von selbst
  async function auto() {
    if (!enabled || getState("baseline_done") !== "1") return;
    try {
      const r = await run({ dryRun: false, closeRefs: [], auto: true });
      if (r.created.length) console.log(`Odoo-Abgleich: ${r.created.length} neue Fertigungsaufträge übernommen`);
    } catch (err) {
      console.error("Odoo-Abgleich fehlgeschlagen:", err.message);
    }
  }
  if (enabled) {
    setTimeout(auto, 45 * 1000);
    setInterval(auto, EVERY);
  }
}
