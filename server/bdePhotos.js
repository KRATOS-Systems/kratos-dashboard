// Mitarbeiterfotos aus Odoo (hr.employee.image_128, nur lesen) für Tafel, Anmeldung, Kiosk und Planung.
// GET /api/bde/photo/:id  – nur für die Mitarbeiter der BDE (Team, Leitung, Zuständigkeiten). Ohne Foto: 404, die Oberfläche zeigt Initialen.
// Fotos werden einen Tag im Speicher gehalten, damit Odoo nicht bei jedem Seitenaufruf gefragt wird.

import { STAFF } from "../src/staffLib.js";

const TTL_MS = 24 * 60 * 60 * 1000;

function typeOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.slice(0, 5).toString() === "<?xml" || buf.slice(0, 4).toString() === "<svg") return "image/svg+xml";
  if (buf.slice(0, 4).toString() === "RIFF") return "image/webp";
  return null;
}

export default function registerBdePhotos(app, ctx) {
  const cache = new Map(); // id -> { at, buf, type } (buf null = kein Foto)
  const allowed = () => new Set([...ctx.PEOPLE, ...STAFF.map((s) => s.employeeId)]);

  app.get("/api/bde/photo/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !allowed().has(id)) return res.status(404).end();
    let c = cache.get(id);
    if (!c || Date.now() - c.at > TTL_MS) {
      try {
        const [e] = await ctx.odoo.read("hr.employee", "read", { ids: [id], fields: ["image_128"] });
        const buf = e && typeof e.image_128 === "string" && e.image_128 ? Buffer.from(e.image_128, "base64") : null;
        const type = buf ? typeOf(buf) : null;
        // Odoo liefert ohne Foto ein erzeugtes SVG-Platzhalterbild; das zählt als "kein Foto"
        c = { at: Date.now(), buf: type && type !== "image/svg+xml" ? buf : null, type };
        cache.set(id, c);
      } catch (err) {
        if (c && c.buf) return res.type(c.type).set("Cache-Control", "private, max-age=3600").send(c.buf);
        return res.status(503).end();
      }
    }
    if (!c.buf) return res.status(404).end();
    res.type(c.type).set("Cache-Control", "private, max-age=3600").send(c.buf);
  });
}
