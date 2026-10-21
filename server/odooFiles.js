// Zeichnung (PDF) und 3D-Modell (STEP) eines Artikels aus Odoo (nur lesen).
// GET /api/product-files/:id   Liste der Dateien am Artikel (id = Fertigungsauftrag in Odoo, in der App "odoo_id")
// GET /api/product-file/:att   die Datei selbst (Anhang in Odoo), wird beim ersten Abruf geholt und in der Datenbank gemerkt
// Nur Anhänge von Artikeln und nur PDF, STEP und IGES werden herausgegeben. Odoo wird nur mit ODOO_URL und ODOO_API_KEY gefragt.

const LIST_MINUTES = 15;
const MAX_BYTES = 60 * 1024 * 1024;
const KINDS = { pdf: "pdf", step: "step", stp: "step", igs: "step", iges: "step" };
const kindOf = (name) => KINDS[(String(name).split(".").pop() || "").toLowerCase()] || null;

export default function registerOdooFiles(app, db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS part_files (
      odoo_id INTEGER PRIMARY KEY,
      json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_cache (
      att_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      bytes BLOB NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
  const getList = db.prepare("SELECT json, fetched_at FROM part_files WHERE odoo_id = ?");
  const putList = db.prepare("INSERT OR REPLACE INTO part_files (odoo_id, json, fetched_at) VALUES (?, ?, ?)");
  const getFile = db.prepare("SELECT name, bytes FROM file_cache WHERE att_id = ?");
  const putFile = db.prepare("INSERT OR REPLACE INTO file_cache (att_id, name, bytes, fetched_at) VALUES (?, ?, ?, ?)");

  const url = (process.env.ODOO_URL || "").replace(/\/+$/, "");
  const key = process.env.ODOO_API_KEY || "";
  const database = process.env.ODOO_DB || "";
  const enabled = !!(url && key);

  async function odoo(model, method, params) {
    const headers = { "Content-Type": "application/json; charset=utf-8", Authorization: `bearer ${key}`, "User-Agent": "kratos-dashboard/1.0" };
    if (database) headers["X-Odoo-Database"] = database;
    const res = await fetch(`${url}/json/2/${model}/${method}`, { method: "POST", headers, body: JSON.stringify(params), signal: AbortSignal.timeout(60000) });
    if (res.status === 429) throw Object.assign(new Error("Odoo-Limit erreicht"), { busy: true });
    if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`);
    return res.json();
  }

  let chain = Promise.resolve();
  const queued = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => new Promise((r) => setTimeout(r, 120)),
      () => new Promise((r) => setTimeout(r, 400))
    );
    return run;
  };

  async function loadList(id) {
    const [prod] = await odoo("mrp.production", "read", { ids: [id], fields: ["product_id"] });
    const productId = prod && Array.isArray(prod.product_id) ? prod.product_id[0] : null;
    if (!productId) return { product: null, files: [] };
    const [p] = await odoo("product.product", "read", { ids: [productId], fields: ["display_name", "product_tmpl_id"] });
    const tmplId = p && Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : null;
    const domain = ["|", "&", ["res_model", "=", "product.product"], ["res_id", "=", productId], "&", ["res_model", "=", "product.template"], ["res_id", "=", tmplId || 0]];
    const atts = await odoo("ir.attachment", "search_read", { domain, fields: ["name", "mimetype", "file_size", "create_date"], order: "id desc", limit: 200 });
    const files = atts
      .map((a) => ({ id: a.id, name: String(a.name), kind: kindOf(a.name), size: a.file_size || 0, date: typeof a.create_date === "string" ? a.create_date.slice(0, 10) : null }))
      .filter((f) => f.kind);
    return { product: { id: productId, name: p ? p.display_name : null }, files };
  }

  app.get("/api/product-files/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
    const row = getList.get(id);
    const age = row ? Date.now() - Date.parse(row.fetched_at) : Infinity;
    if (row && age < LIST_MINUTES * 60000) return res.json({ ...JSON.parse(row.json), enabled });
    if (!enabled) return res.json(row ? { ...JSON.parse(row.json), enabled } : { product: null, files: [], enabled });
    try {
      const data = await queued(() => loadList(id));
      putList.run(id, JSON.stringify(data), new Date().toISOString());
      res.json({ ...data, enabled });
    } catch (err) {
      if (row) return res.json({ ...JSON.parse(row.json), enabled });
      console.error("Dateiliste laden fehlgeschlagen", id, err.message);
      res.status(err.busy ? 503 : 502).json({ error: err.message });
    }
  });

  app.get("/api/product-file/:att", async (req, res) => {
    const att = Number(req.params.att);
    if (!Number.isInteger(att) || att <= 0) return res.status(400).end();
    const send = (name, bytes) => {
      const kind = kindOf(name);
      res.set("Content-Type", kind === "pdf" ? "application/pdf" : "application/octet-stream");
      res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.set("Cache-Control", "private, max-age=86400");
      res.send(Buffer.from(bytes));
    };
    const hit = getFile.get(att);
    if (hit) return send(hit.name, hit.bytes);
    if (!enabled) return res.status(404).end();
    try {
      const [a] = await queued(() => odoo("ir.attachment", "read", { ids: [att], fields: ["name", "res_model", "datas", "file_size"] }));
      if (!a || !["product.template", "product.product"].includes(a.res_model) || !kindOf(a.name) || !a.datas) return res.status(404).end();
      if ((a.file_size || 0) > MAX_BYTES) return res.status(413).end();
      const bytes = Buffer.from(a.datas, "base64");
      putFile.run(att, String(a.name), bytes, new Date().toISOString());
      return send(String(a.name), bytes);
    } catch (err) {
      console.error("Datei laden fehlgeschlagen", att, err.message);
      return res.status(err.busy ? 503 : 502).end();
    }
  });
}
