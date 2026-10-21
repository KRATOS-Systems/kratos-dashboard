// Vorschaubilder der Bauteile aus Odoo (nur lesen).
// GET /api/part-image/:id  (id = Fertigungsauftrag in Odoo, in der App "odoo_id")
// Das Bild des Artikels wird beim ersten Aufruf aus Odoo geholt, in der Datenbank zwischengespeichert und danach von dort geliefert.
// Odoo wird nur angefragt, wenn ODOO_URL und ODOO_API_KEY gesetzt sind (Umgebungsvariablen auf dem Server, nie im Code).
// Anfragen laufen nacheinander mit kleiner Pause, damit das Anfragelimit von Odoo (HTTP 429) nicht greift.

const OK_DAYS = 30; // Bilder werden einen Monat lang nicht neu geholt
const NONE_HOURS = 24; // "kein Bild" wird nach einem Tag erneut geprüft

export default function registerPartImages(app, db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS part_images (
      odoo_id INTEGER PRIMARY KEY,
      product_id INTEGER,
      png BLOB,
      status TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
  const get = db.prepare("SELECT product_id, png, status, fetched_at FROM part_images WHERE odoo_id = ?");
  const put = db.prepare("INSERT OR REPLACE INTO part_images (odoo_id, product_id, png, status, fetched_at) VALUES (?, ?, ?, ?, ?)");

  const url = (process.env.ODOO_URL || "").replace(/\/+$/, "");
  const key = process.env.ODOO_API_KEY || "";
  const database = process.env.ODOO_DB || "";
  const enabled = !!(url && key);

  async function odoo(model, method, params) {
    const headers = { "Content-Type": "application/json; charset=utf-8", Authorization: `bearer ${key}`, "User-Agent": "kratos-dashboard/1.0" };
    if (database) headers["X-Odoo-Database"] = database;
    const res = await fetch(`${url}/json/2/${model}/${method}`, { method: "POST", headers, body: JSON.stringify(params), signal: AbortSignal.timeout(20000) });
    if (res.status === 429) throw Object.assign(new Error("Odoo-Limit erreicht"), { busy: true });
    if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`);
    return res.json();
  }

  // Eine Anfrage nach der anderen
  let chain = Promise.resolve();
  const queued = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => new Promise((r) => setTimeout(r, 120)),
      () => new Promise((r) => setTimeout(r, 400))
    );
    return run;
  };

  const inflight = new Map();
  async function load(id) {
    const [prod] = await odoo("mrp.production", "read", { ids: [id], fields: ["product_id"] });
    const productId = prod && Array.isArray(prod.product_id) ? prod.product_id[0] : null;
    if (!productId) {
      put.run(id, null, null, "none", new Date().toISOString());
      return null;
    }
    const [p] = await odoo("product.product", "read", { ids: [productId], fields: ["image_256"] });
    const b64 = p && p.image_256;
    if (!b64) {
      put.run(id, productId, null, "none", new Date().toISOString());
      return null;
    }
    const png = Buffer.from(b64, "base64");
    put.run(id, productId, png, "ok", new Date().toISOString());
    return png;
  }

  app.get("/api/part-image/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
    const row = get.get(id);
    const age = row ? Date.now() - Date.parse(row.fetched_at) : Infinity;
    const send = (png) => {
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "private, max-age=86400");
      res.send(Buffer.from(png));
    };
    if (row && row.status === "ok" && age < OK_DAYS * 86400000) return send(row.png);
    if (row && row.status === "none" && age < NONE_HOURS * 3600000) return res.status(404).end();
    if (!enabled) return row && row.status === "ok" ? send(row.png) : res.status(404).end();
    try {
      if (!inflight.has(id)) inflight.set(id, queued(() => load(id)).finally(() => inflight.delete(id)));
      const png = await inflight.get(id);
      return png ? send(png) : res.status(404).end();
    } catch (err) {
      if (row && row.status === "ok") return send(row.png);
      console.error("Teilebild laden fehlgeschlagen", id, err.message);
      return res.status(err.busy ? 503 : 404).end();
    }
  });
}
