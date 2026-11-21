// Automatik: Was Odoo eindeutig weiß, übernimmt die App selbst, statt es nur vorzuschlagen.
//
// 1. Fertigung extern (Fremdfertigung, Position mit Einkaufsbestellung): Ist der Wareneingang der Bestellung in Odoo gebucht
//    (Bestellung „komplett eingegangen“ oder die Zeile mit demselben Artikel vollständig), geht die Position weiter – Standard: in die QS
//    (Wareneingangsprüfung). Teil-Wareneingang: „12 von 20 eingegangen“ steht an der Position, sie bleibt.
// 2. Oberfläche extern (Lohnarbeit zu einem Fertigungsauftrag): Bestellung, deren Herkunft die FA-Nummer nennt, ist eingegangen →
//    weiter, Standard: in den Versand (geprüft wurde vor der Beschichtung).
//    Ziel umstellbar (plan_settings auto_nach_fremd / auto_nach_oberflaeche: qs | versand). Ohne Kundenauftrag statt Versand: erledigt.
// 3. Abschließen: Positionen (nicht im Versand), deren Kundenauftrag laut Odoo vollständig ausgeliefert ist (Schließvorschlag des
//    Odoo-Abgleichs mit diesem Grund), schließt die App selbst. Andere Schließvorschläge (storniert, nicht mehr offen) bleiben Vorschläge.
//
// Läuft alle 10 Minuten (AUTOMATIK_AUTO=0 schaltet ab) und auf POST /api/automatik/lauf. Odoo wird nur gelesen.

import { needsShipping } from "../src/planLogic.js";

const dayPart = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const m2oId = (v) => (Array.isArray(v) ? v[0] : typeof v === "number" ? v : null);
const m2oName = (v) => (Array.isArray(v) && v[1] ? String(v[1]) : null);
const codeOf = (s) => {
  const m = /^\s*\[([^\]]+)\]/.exec(String(s || ""));
  return m ? m[1].trim() : null;
};
const fmtN = (n) => (Math.round(n * 100) / 100).toLocaleString("de-DE");
const todayBerlin = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
const ORT = { qs: "QS", versand: "Versand", done: "erledigt" };

export const AUTOMATIK_DDL = `
  CREATE TABLE IF NOT EXISTS automatik_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    am TEXT NOT NULL,
    order_id INTEGER,
    text TEXT NOT NULL
  );`;

// Eingangsstand einer Position aus ihren Bestellzeilen (gleicher Artikel: Name oder Artikelnummer; sonst die ganze Bestellung)
export function eingangStand(o, po, lines) {
  if (po && po.receipt_status === "full") return { da: true, info: "Ware eingegangen" };
  const code = codeOf(o.product);
  const passend = lines.filter((l) => !l.display_type && (m2oName(l.product_id) === o.product || (code && (codeOf(m2oName(l.product_id)) === code || codeOf(l.name) === code))));
  const use = passend.length ? passend : [];
  const soll = use.reduce((s, l) => s + (Number(l.product_qty) || 0), 0);
  const ist = use.reduce((s, l) => s + (Number(l.qty_received) || 0), 0);
  if (soll > 0 && ist + 1e-6 >= soll) return { da: true, info: `${fmtN(soll)} von ${fmtN(soll)} eingegangen` };
  if (ist > 0) return { da: false, info: `${fmtN(ist)} von ${fmtN(soll)} eingegangen (Teil-Wareneingang)` };
  return { da: false, info: null };
}

export default function registerAutomatik(app, db) {
  db.exec(AUTOMATIK_DDL);
  const cols = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
  if (!cols.includes("ext_info")) db.exec("ALTER TABLE orders ADD COLUMN ext_info TEXT");
  const getSetting = (k, def) => {
    const r = db.prepare("SELECT value FROM plan_settings WHERE key = ?").get(k);
    return r && r.value != null ? String(r.value) : def;
  };
  const setSetting = (k, v) => db.prepare("INSERT INTO plan_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v);
  const einstellungen = () => ({ nachFremd: getSetting("auto_nach_fremd", "qs") === "versand" ? "versand" : "qs", nachOberflaeche: getSetting("auto_nach_oberflaeche", "versand") === "qs" ? "qs" : "versand" });
  const read = (model, domain, fields, limit = 500) => app.locals.odooRead(model, { domain, fields, limit });
  const nextPos = (machine) => db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM orders WHERE machine = ?").get(machine).p;
  const log = (orderId, text) => db.prepare("INSERT INTO automatik_log (am, order_id, text) VALUES (?, ?, ?)").run(new Date().toISOString(), orderId, text);

  // Position weiterschieben: in die QS, in den Versand oder (ohne Kundenauftrag) erledigt
  function weiter(o, ziel, datum, info) {
    const wohin = ziel === "qs" && o.qs_required !== 0 ? "qs" : needsShipping(o) ? "versand" : "done";
    if (wohin === "done") db.prepare("UPDATE orders SET done = 1, done_date = ?, ext_info = ? WHERE id = ? AND done = 0").run(datum, info, o.id);
    else db.prepare("UPDATE orders SET machine = ?, position = ?, extern_start = ?, ext_info = ?, checked_date = NULL WHERE id = ? AND done = 0").run(wohin, nextPos(wohin), datum, info, o.id);
    return wohin;
  }

  let running = null;
  let letzter = null;
  async function lauf() {
    if (!app.locals.odooRead) return { enabled: false, bewegt: [] };
    const today = todayBerlin();
    const cfg = einstellungen();
    const bewegt = [];

    // 1. Fertigung extern mit Bestellung
    const fremd = db.prepare("SELECT * FROM orders WHERE done = 0 AND machine = 'extern_fert' AND po_id IS NOT NULL").all();
    const poIds = [...new Set(fremd.map((o) => o.po_id))];
    if (poIds.length) {
      const pos = await read("purchase.order", [["id", "in", poIds]], ["name", "receipt_status", "state"], 500);
      const lines = await read("purchase.order.line", [["order_id", "in", poIds]], ["order_id", "product_id", "name", "product_qty", "qty_received", "display_type"], 3000);
      const picks = await read("stock.picking", [["picking_type_code", "=", "incoming"], ["state", "=", "done"], ["purchase_id", "in", poIds]], ["name", "date_done", "purchase_id"], 1000);
      for (const o of fremd) {
        const po = pos.find((p) => p.id === o.po_id);
        if (!po || po.state === "cancel") continue;
        const st = eingangStand(o, po, lines.filter((l) => m2oId(l.order_id) === po.id));
        const pk = picks.filter((p) => m2oId(p.purchase_id) === po.id && p.date_done).sort((a, b) => String(b.date_done).localeCompare(String(a.date_done)))[0];
        const datum = (pk && dayPart(pk.date_done)) || today;
        const info = st.info ? `${st.info} (${po.name}${pk ? ", " + pk.name : ""})` : null;
        if (st.da) {
          const wohin = weiter(o, cfg.nachFremd, datum, info);
          const text = `${o.source || o.order_no} (${po.name}): Ware eingegangen, weiter nach ${ORT[wohin]}`;
          log(o.id, text);
          bewegt.push({ id: o.id, text });
        } else if (info !== (o.ext_info || null)) db.prepare("UPDATE orders SET ext_info = ? WHERE id = ?").run(info, o.id);
      }
    }

    // 2. Oberfläche extern: Lohnarbeit-Bestellung, deren Herkunft die FA-Nummer nennt
    const ober = db.prepare("SELECT * FROM orders WHERE done = 0 AND machine = 'extern'").all();
    const refOf = (o) => [o.odoo_ref, o.parent_ref].find((r) => typeof r === "string" && /^FA\d{3,}/.test(r)) || null;
    const refs = [...new Set(ober.map(refOf).filter(Boolean))];
    for (let i = 0; i < refs.length; i += 30) {
      const chunk = refs.slice(i, i + 30);
      const dom = [["state", "=", "purchase"], ...Array(chunk.length - 1).fill("|"), ...chunk.map((r) => ["origin", "ilike", r])];
      const pos = await read("purchase.order", dom, ["name", "origin", "receipt_status", "date_approve"], 500);
      if (!pos.length) continue;
      const ids = pos.map((p) => p.id);
      const lines = await read("purchase.order.line", [["order_id", "in", ids]], ["order_id", "product_id", "name", "product_qty", "qty_received", "display_type"], 3000);
      const picks = await read("stock.picking", [["picking_type_code", "=", "incoming"], ["state", "=", "done"], ["purchase_id", "in", ids]], ["name", "date_done", "purchase_id"], 1000);
      for (const o of ober.filter((x) => chunk.includes(refOf(x)))) {
        // nur Bestellungen ab dem Gang nach extern (ältere Lohnarbeit desselben FA zählt nicht)
        const mine = pos.filter((p) => String(p.origin || "").includes(refOf(o)) && (!o.extern_start || !p.date_approve || dayPart(p.date_approve) >= addDaysStr(o.extern_start, -14)));
        if (!mine.length) continue;
        // Bei Lohnarbeit ist der Artikel die Dienstleistung, nicht das Teil: maßgeblich ist der Eingang der ganzen Bestellung
        const offen = mine.filter((p) => p.receipt_status !== "full");
        const last = picks.filter((p) => mine.some((m) => m.id === m2oId(p.purchase_id)) && p.date_done).sort((a, b) => String(b.date_done).localeCompare(String(a.date_done)))[0];
        const datum = (last && dayPart(last.date_done)) || today;
        if (!offen.length) {
          const info = `Ware zurück (${mine.map((p) => p.name).join(", ")}${last ? ", " + last.name : ""})`;
          const wohin = weiter(o, cfg.nachOberflaeche, datum, info);
          const text = `${o.source || o.order_no} (${mine.map((p) => p.name).join(", ")}): von der Oberfläche zurück, weiter nach ${ORT[wohin]}`;
          log(o.id, text);
          bewegt.push({ id: o.id, text });
        } else {
          const ls = lines.filter((l) => offen.some((p) => p.id === m2oId(l.order_id)) && !l.display_type);
          const soll = ls.reduce((s, l) => s + (Number(l.product_qty) || 0), 0);
          const ist = ls.reduce((s, l) => s + (Number(l.qty_received) || 0), 0);
          const info = ist > 0 && soll > 0 ? `${fmtN(ist)} von ${fmtN(soll)} zurück (Teil-Wareneingang, ${offen.map((p) => p.name).join(", ")})` : `bestellt: ${offen.map((p) => p.name).join(", ")}`;
          if (info !== (o.ext_info || null)) db.prepare("UPDATE orders SET ext_info = ? WHERE id = ?").run(info, o.id);
        }
      }
    }

    // 3. Vollständig ausgeliefert laut Odoo-Abgleich: selbst abschließen
    let pending = [];
    try {
      pending = JSON.parse((db.prepare("SELECT value FROM odoo_sync WHERE key = 'pending_closing'").get() || {}).value || "[]");
    } catch {
      pending = [];
    }
    const geliefert = pending.filter((c) => /vollständig (an den Kunden )?ausgeliefert/.test(c.reason || ""));
    if (geliefert.length) {
      const close = db.prepare("UPDATE orders SET done = 1, done_date = COALESCE(done_date, ?), shipped_date = COALESCE(shipped_date, ?), ship_info = COALESCE(ship_info, 'laut Odoo vollständig ausgeliefert') WHERE (odoo_ref = ? OR parent_ref = ?) AND done = 0 AND machine <> 'versand'");
      for (const c of geliefert) {
        const ids = db.prepare("SELECT id FROM orders WHERE (odoo_ref = ? OR parent_ref = ?) AND done = 0 AND machine <> 'versand'").all(c.ref, c.ref).map((r) => r.id);
        if (!ids.length) continue;
        close.run(today, today, c.ref, c.ref);
        const text = `${c.source || c.ref}: laut Odoo vollständig ausgeliefert, abgeschlossen`;
        ids.forEach((id) => log(id, text));
        bewegt.push({ id: ids[0], text });
      }
      const rest = pending.filter((c) => !geliefert.includes(c));
      db.prepare("UPDATE odoo_sync SET value = ? WHERE key = 'pending_closing'").run(JSON.stringify(rest));
    }
    letzter = { am: new Date().toISOString(), bewegt: bewegt.length };
    if (bewegt.length && app.locals.versand) app.locals.versand.get(true).catch(() => {});
    return { enabled: true, bewegt };
  }
  function addDaysStr(d, n) {
    return new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  }
  const run = () => {
    if (running) return running;
    running = lauf().finally(() => {
      running = null;
    });
    return running;
  };

  const protokoll = (stunden = 24 * 7) =>
    db
      .prepare("SELECT am, order_id AS id, text FROM automatik_log WHERE am >= ? ORDER BY id DESC LIMIT 100")
      .all(new Date(Date.now() - stunden * 3600000).toISOString());

  app.get("/api/automatik", (req, res) => res.json({ einstellungen: einstellungen(), letzter, protokoll: protokoll() }));
  app.put("/api/automatik/einstellungen", (req, res) => {
    const b = req.body || {};
    if (b.nachFremd !== undefined) {
      if (!["qs", "versand"].includes(b.nachFremd)) return res.status(400).json({ error: "nachFremd: qs oder versand" });
      setSetting("auto_nach_fremd", b.nachFremd);
    }
    if (b.nachOberflaeche !== undefined) {
      if (!["qs", "versand"].includes(b.nachOberflaeche)) return res.status(400).json({ error: "nachOberflaeche: qs oder versand" });
      setSetting("auto_nach_oberflaeche", b.nachOberflaeche);
    }
    res.json({ einstellungen: einstellungen() });
  });
  app.post("/api/automatik/lauf", async (req, res) => {
    try {
      res.json(await run());
    } catch (err) {
      res.status(502).json({ error: "Odoo nicht lesbar: " + err.message });
    }
  });

  // Für „Heute zu tun“: was in den letzten 24 Stunden automatisch weitergegangen ist
  app.locals.automatik = { run, letzte24: () => protokoll(24) };
  if (process.env.AUTOMATIK_AUTO !== "0") {
    setTimeout(() => run().catch((err) => console.error("Automatik:", err.message)), 2 * 60 * 1000).unref();
    setInterval(() => run().catch((err) => console.error("Automatik:", err.message)), 10 * 60 * 1000).unref();
  }
}
