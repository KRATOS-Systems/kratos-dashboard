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
// Odoo wird nur gelesen, und nur wenn ODOO_URL und ODOO_API_KEY gesetzt sind.

const OPEN_STATES = ["confirmed", "progress", "to_close"];
const EVERY = 10 * 60 * 1000;
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

  // Was würde passieren? (ohne etwas zu schreiben)
  function computePlan(items) {
    const seen = new Set(db.prepare("SELECT odoo_id FROM odoo_seen").all().map((r) => r.odoo_id));
    const inApp = new Map(db.prepare("SELECT id, odoo_ref, odoo_id, done, source, product FROM orders WHERE odoo_ref IS NOT NULL").all().map((r) => [r.odoo_ref, r]));
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
      const baseline = getState("baseline_done") !== "1";
      const plan = computePlan(items);
      plan.all = items;
      if (baseline) {
        // Erster Abgleich: alle alten offenen Aufträge sind "bekannt". Was in den letzten Tagen neu angelegt wurde, kommt als neu in die Liste.
        const cutoff = Date.now() - FRESH_DAYS * 24 * 3600 * 1000;
        const inApp = new Set(db.prepare("SELECT odoo_ref FROM orders WHERE odoo_ref IS NOT NULL").all().map((r) => r.odoo_ref));
        const isFresh = (i) => !inApp.has(i.odoo_ref) && !i.delivered && !i.saleCancelled && i.created && Date.parse(i.created) >= cutoff;
        const fresh = items.filter(isFresh);
        const old = items.filter((i) => !isFresh(i));
        if (!dryRun) {
          applyPlan({ created: fresh, updated: [], closing: [], all: old }, { markAllSeen: true });
          setState("baseline_done", "1");
          setState("last_sync", new Date().toISOString());
          setState("last_error", null);
          setState("pending_closing", "[]");
          if (fresh.length) setState("last_change", new Date().toISOString());
        }
        return {
          baseline: true,
          openCount: plan.openCount,
          knownInApp: plan.knownInApp,
          updated: 0,
          created: fresh.map((i) => ({ ref: i.odoo_ref, source: i.source, product: i.product, quantity: i.quantity, due: i.due })),
          closing: [],
        };
      }
      if (!dryRun) {
        // Nur Vorschläge, die die App gerade selbst berechnet hat, dürfen geschlossen werden
        const allowed = new Set(plan.closing.map((c) => c.ref));
        applyPlan(plan, { closeRefs: closeRefs.filter((r) => allowed.has(r)) });
        setState("last_sync", new Date().toISOString());
        setState("last_error", null);
        if (plan.created.length || closeRefs.length) setState("last_change", new Date().toISOString());
        const remaining = computePlan(await Promise.resolve(items)).closing;
        setState("pending_closing", JSON.stringify(remaining));
      } else if (auto) {
        setState("pending_closing", JSON.stringify(plan.closing));
      }
      return {
        baseline: false,
        openCount: plan.openCount,
        created: plan.created.map((i) => ({ ref: i.odoo_ref, source: i.source, product: i.product, quantity: i.quantity, due: i.due })),
        updated: plan.updated.length,
        closing: plan.closing,
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
      lastError: getState("last_error"),
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
