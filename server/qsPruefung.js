// QS-Prüfung einer Position in der Spur QS.
// Sichtprüfung direkt in der App (Checkliste + Ergebnis), Messprüfung im QS CHECK (Link; Ergebnis hier nur bestätigt).
// Welche Prüfart gilt, legt die AV fest: Punkt „Prüfplan“ = nicht nötig -> Sichtprüfung, sonst Messprüfung (src/QsPruefung.jsx).
//
//   GET  /api/qs/:id            -> { vorgaben, verlauf }   Kundenvorgaben aus Odoo (nur lesen) und bisherige Prüfungen
//   POST /api/qs/:id/ergebnis   { art, ergebnis: io|teil|nio, gut, schlecht, grund, checks, pruefer }
//        -> { ok, neueId, notiz }   bei „teil“ wird die gute Menge abgeteilt (neue Position, geht weiter), der Rest bleibt in der QS
//
// Odoo: nur mit BDE_WRITE=1 eine interne Notiz am Fertigungsauftrag bzw. an der Bestellung (Fremdfertigung). Sonst nichts.

import { postNotiz } from "./odooNotiz.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ERG = { io: "in Ordnung", teil: "teilweise in Ordnung", nio: "nicht in Ordnung" };
const ART = { sicht: "Sichtprüfung", mess: "Messprüfung (QS CHECK)" };
const CHECKS = { menge: "Menge gezählt", oberflaeche: "Oberfläche und Grat", gewinde: "Gewinde und Bohrungen", beschriftung: "Beschriftung und Verpackung" };
const m2oName = (v) => (Array.isArray(v) ? v[1] : "");
const codeOf = (s) => {
  const m = String(s || "").match(/^\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
};

export default function registerQsPruefung(app, db, { splitOrder }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qs_pruefung (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      art TEXT NOT NULL,
      ergebnis TEXT NOT NULL,
      gut REAL,
      schlecht REAL,
      grund TEXT,
      checks TEXT,
      pruefer TEXT,
      am TEXT NOT NULL
    );
  `);

  app.get("/api/qs/:id", async (req, res) => {
    const id = Number(req.params.id);
    const o = Number.isInteger(id) ? db.prepare("SELECT id, source, product, quantity FROM orders WHERE id = ?").get(id) : null;
    if (!o) return res.status(404).json({ error: "Position nicht gefunden" });
    const verlauf = db.prepare("SELECT art, ergebnis, gut, schlecht, grund, pruefer, am FROM qs_pruefung WHERE order_id = ? ORDER BY id DESC LIMIT 10").all(id);
    let vorgaben = null;
    const read = app.locals.odooRead;
    if (read && /^A\d+/.test(o.source || "")) {
      try {
        const [so] = await read("sale.order", { domain: [["name", "=", o.source.trim()]], fields: ["partner_id", "client_order_ref", "note"], limit: 1 });
        if (so) {
          const code = codeOf(o.product);
          const lines = await read("sale.order.line", { domain: [["order_id", "=", so.id], ["display_type", "=", false]], fields: ["name", "product_id", "product_uom_qty"], limit: 100 });
          const zeile = lines.find((l) => code && (codeOf(m2oName(l.product_id)) === code || codeOf(l.name) === code)) || null;
          const notiz = String(so.note || "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          vorgaben = {
            kunde: m2oName(so.partner_id) || null,
            bestellung: so.client_order_ref || null,
            zeile: zeile ? String(zeile.name || "").trim() : null,
            menge: zeile ? Number(zeile.product_uom_qty) || null : null,
            notiz: notiz ? notiz.slice(0, 600) : null,
          };
        }
      } catch {
        vorgaben = null;
      }
    }
    res.json({ vorgaben, verlauf });
  });

  app.post("/api/qs/:id/ergebnis", async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const row = Number.isInteger(id) ? db.prepare("SELECT * FROM orders WHERE id = ? AND done = 0").get(id) : null;
    if (!row) return res.status(404).json({ error: "Position nicht gefunden oder schon erledigt" });
    if (!ART[b.art] || !ERG[b.ergebnis]) return res.status(400).json({ error: "Prüfart oder Ergebnis fehlt" });
    const menge = Number(row.quantity) || 0;
    const gut = b.ergebnis === "io" ? menge : b.ergebnis === "nio" ? 0 : Number(b.gut);
    if (b.ergebnis === "teil" && !(gut > 0 && gut < menge)) return res.status(400).json({ error: `Gute Menge zwischen 1 und ${menge - 1} angeben` });
    const grund = typeof b.grund === "string" ? b.grund.trim().slice(0, 500) : "";
    if (b.ergebnis !== "io" && !grund) return res.status(400).json({ error: "Bitte einen Grund angeben" });
    const checks = Array.isArray(b.checks) ? b.checks.filter((c) => CHECKS[c]) : [];
    const pruefer = typeof b.pruefer === "string" ? b.pruefer.trim().slice(0, 60) : "";
    const am = new Date().toISOString();

    let neueId = null;
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO qs_pruefung (order_id, art, ergebnis, gut, schlecht, grund, checks, pruefer, am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        b.art,
        b.ergebnis,
        gut,
        Math.max(0, menge - gut),
        grund || null,
        JSON.stringify(checks),
        pruefer || null,
        am
      );
      if (b.ergebnis === "teil") {
        // Gute Menge abteilen: neue Position mit „gut“ Stück (geht weiter), der Rest bleibt hier in der QS
        splitOrder(row, gut, null);
        neueId = db.prepare("SELECT id FROM orders WHERE is_split = 1 AND source IS ? AND product IS ? AND machine = ? AND quantity = ? ORDER BY id DESC LIMIT 1").get(row.source, row.product, row.machine, gut)?.id || null;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      return res.status(500).json({ error: err.message });
    }

    // Interne Notiz in Odoo (am Fertigungsauftrag, bei Fremdfertigung an der Bestellung)
    let notiz = "aus";
    const odoo = app.locals.odooBde;
    if (odoo && odoo.writeEnabled && (row.odoo_id || row.po_id)) {
      const zeit = new Date(am).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
      const html =
        `<p><b>QS ${esc(ART[b.art])}: ${esc(ERG[b.ergebnis])}</b></p>` +
        `<p>${esc(row.product || "")}${menge ? ` · ${esc(gut)} von ${esc(menge)} Stück gut` : ""}</p>` +
        (checks.length ? `<p>Geprüft: ${checks.map((c) => esc(CHECKS[c])).join(", ")}</p>` : "") +
        (grund ? `<p>Grund: ${esc(grund)}</p>` : "") +
        `<p>${pruefer ? `Prüfer: ${esc(pruefer)} · ` : ""}${esc(zeit)} · Produktionsdashboard</p>`;
      try {
        await postNotiz(odoo, row.odoo_id ? "mrp.production" : "purchase.order", row.odoo_id || row.po_id, html);
        notiz = "ok";
      } catch (err) {
        notiz = "fehler: " + err.message;
      }
    }
    res.json({ ok: true, neueId, notiz });
  });
}
