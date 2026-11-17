// Verbindung zu QS (app.dynamis-systems.de/qs): Prüfplan und EMPB der Arbeitsvorbereitung.
//
// Schlüssel: Das Dashboard erzeugt ihn beim ersten Start selbst und speichert ihn in seiner Datenbank (Tabelle kv). Angemeldete sehen ihn
// unter GET /api/qs-verbindung; auf dem QS-Server steht derselbe Wert in DASHBOARD_SCHLUESSEL. Kein Eintrag bei Hostinger nötig.
//
// Für QS (vor dem Passwortschutz, eigener Schutz über den Schlüssel im Kopf X-QS-Schluessel):
//   GET  /api/extern/av-offen    Positionen, bei denen Prüfplan oder EMPB offen oder in Arbeit sind (mit geplantem Start und Zuständigem)
//   POST /api/extern/av-bereit   { artikel, item } → Prüfplan bzw. EMPB dieses Artikels auf „bereit“ (nur was offen oder in Arbeit ist)
//
// Automatischer Status (statt „nicht nötig“) für Positionen, die nach dem Einschalten neu aus Odoo kommen:
//   - Prüfplan: „bereit“, wenn es in QS einen freigegebenen Prüfplan zum Artikel gibt, sonst „offen“
//   - EMPB: „offen“, wenn im Verkaufsauftrag unter dem Teil die Position „[EMPB] Erstmusterprüfbericht“ steht, sonst „nicht nötig“
// Automatisch gesetzte Punkte sind markiert (av_checks.auto = 1) und werden bei jedem Lauf neu bewertet, solange sie „offen“ oder
// „nicht nötig“ sind. Sobald jemand den Punkt von Hand ändert, ist er nicht mehr automatisch und wird nie überschrieben.
import express from "express";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { STAFF_DEFAULTS, STAFF_KEYS, avResponsible } from "../src/staffLib.js";
import { loadPlanInputs, makeContext } from "./talosPlan.js";

const QS_URL = String(process.env.QS_URL || "https://app.dynamis-systems.de/qs").replace(/\/+$/, "");
const EVERY = 10 * 60 * 1000;
const sha = (s) => createHash("sha256").update(String(s)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));

// „[SK966-052200.005.0] Knotenpunkt“ → „SK966-052200.005.0“
export const artikelAus = (product) => {
  const m = String(product || "").match(/^\[([^\]]+)\]/);
  return m ? m[1].trim() : "";
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Gleicher Artikel? Gleich ohne Satzzeichen, oder einer hängt nur den Index an (…_0_a)
export function gleicherArtikel(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [lang, kurz] = x.length > y.length ? [x, y] : [y, x];
  return lang.startsWith(kurz) && /^[a-z]{1,2}$/.test(lang.slice(kurz.length));
}
export const hatEmpb = (namen) => namen.some((n) => /\bempb\b/i.test(String(n)));
const istEmpbZeile = (l) => Array.isArray(l.product_id) && /^\[EMPB\]/i.test(String(l.product_id[1]));
// Auftragszeilen (sortiert nach Auftrag und Reihenfolge) → Menge „Auftrag|Artikel“ der Teile mit EMPB
export function empbTeile(lines) {
  const out = new Set();
  let teil = null; // letzte Teileposition (mit Artikelnummer) im selben Auftrag
  for (const l of lines) {
    const auftrag = Array.isArray(l.order_id) ? l.order_id[1] : String(l.order_id || "");
    if (teil && teil.auftrag !== auftrag) teil = null;
    if (l.display_type) continue; // Abschnitt oder Notiz
    if (istEmpbZeile(l)) {
      if (teil) out.add(teil.auftrag + "|" + norm(teil.artikel));
      continue;
    }
    const artikel = Array.isArray(l.product_id) ? artikelAus(l.product_id[1]) : "";
    if (!artikel) continue; // z. B. AV, Rüstkosten, Versand ohne Artikelnummer
    teil = { auftrag, artikel };
    if (hatEmpb([l.name])) out.add(auftrag + "|" + norm(artikel));
  }
  return out;
}

export default function registerQsBridge(app, db, helpers, { fetchImpl = fetch, odooImpl = null } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  if (!db.prepare("PRAGMA table_info(av_checks)").all().some((c) => c.name === "auto")) db.exec("ALTER TABLE av_checks ADD COLUMN auto INTEGER NOT NULL DEFAULT 0");
  const getKv = (k) => db.prepare("SELECT value FROM kv WHERE key = ?").get(k)?.value ?? null;
  const setKv = (k, v) => db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v);
  if (!getKv("qs_schluessel")) setKv("qs_schluessel", randomBytes(32).toString("base64url"));
  // Automatischer Status gilt für Positionen, die ab jetzt neu aus Odoo kommen
  if (!getKv("qs_auto_ab")) setKv("qs_auto_ab", new Date().toISOString());
  const key = () => getKv("qs_schluessel");
  const keyOk = (req) => {
    const k = String(req.headers["x-qs-schluessel"] || "");
    return !!k && same(k, key());
  };

  const staffDefaults = () => {
    const out = { ...STAFF_DEFAULTS };
    try {
      db.prepare("SELECT key, name FROM staff_defaults").all().forEach((r) => STAFF_KEYS.includes(r.key) && (out[r.key] = r.name));
    } catch {
      /* Tabelle gibt es erst nach registerStaff */
    }
    return out;
  };
  const staffOverrides = () => {
    try {
      return new Map(db.prepare("SELECT order_id, activity, name FROM order_staff").all().map((r) => [`${r.order_id}|${r.activity}`, r.name]));
    } catch {
      return new Map();
    }
  };

  // Geplanter Start je Position (wie die Planung)
  function starts(inp) {
    const sched = new Map();
    try {
      const ctx = makeContext(inp);
      const { plan } = ctx.compute(inp.orders);
      plan.forEach((p) => p.items.forEach((i) => i.scheduled && sched.set(i.o.id, { maschine: p.m.short, start: ctx.dateOf(i.pastStart ?? i.start) })));
    } catch (err) {
      console.error("QS-Verbindung: Planung nicht berechenbar", err.message);
    }
    return sched;
  }

  app.get("/api/extern/av-offen", (req, res) => {
    if (!keyOk(req)) return res.status(401).json({ error: "Schlüssel fehlt oder ist falsch" });
    const inp = loadPlanInputs(db, helpers);
    const sched = starts(inp);
    const defaults = staffDefaults();
    const overrides = staffOverrides();
    const punkt = (o, item) => {
      const c = inp.checks.get(`${o.id}|${item}`);
      const status = c ? c.status : "entfaellt";
      return { status, zustaendig: avResponsible(o, item, c?.assignee || null, defaults, overrides), due: c?.due || null };
    };
    const zeilen = inp.orders
      .filter((o) => !o.done)
      .map((o) => ({ o, pruefplan: punkt(o, "pruefplan"), empb: punkt(o, "empb") }))
      .filter((r) => ["offen", "in_arbeit"].includes(r.pruefplan.status) || ["offen", "in_arbeit"].includes(r.empb.status))
      .map(({ o, pruefplan, empb }) => ({
        id: o.id,
        fa: o.odoo_ref && !/^P\d/.test(o.odoo_ref) ? o.odoo_ref : null,
        auftrag: o.source || null,
        artikel: artikelAus(o.product),
        produkt: String(o.product || "").replace(/^\[[^\]]*\]\s*/, ""),
        menge: o.quantity,
        liefertermin: o.due || null,
        start: sched.get(o.id)?.start || null,
        maschine: sched.get(o.id)?.maschine || null,
        pruefplan,
        empb,
      }))
      .sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999") || (a.liefertermin || "9999").localeCompare(b.liefertermin || "9999"));
    res.json({ zeilen });
  });

  app.post("/api/extern/av-bereit", express.json({ limit: "20kb" }), (req, res) => {
    if (!keyOk(req)) return res.status(401).json({ error: "Schlüssel fehlt oder ist falsch" });
    const { artikel, item } = req.body || {};
    if (typeof artikel !== "string" || !artikel.trim() || !["pruefplan", "empb"].includes(item)) return res.status(400).json({ error: "artikel und item (pruefplan|empb) nötig" });
    const orders = db.prepare("SELECT id, product FROM orders WHERE done = 0").all().filter((o) => gleicherArtikel(artikelAus(o.product), artikel));
    const upd = db.prepare("UPDATE av_checks SET status = 'bereit', updated_at = datetime('now') WHERE order_id = ? AND item = ? AND status IN ('offen', 'in_arbeit')");
    let gesetzt = 0;
    for (const o of orders) gesetzt += Number(upd.run(o.id, item).changes);
    if (gesetzt) console.log(`QS: ${item} für ${artikel} bei ${gesetzt} Position(en) auf bereit gesetzt`);
    res.json({ gesetzt });
  });

  // Nach dem Passwortschutz: Schlüssel für die Einrichtung in QS anzeigen
  const afterLogin = () => {
    app.get("/api/qs-verbindung", (req, res) => res.json({ qs_url: QS_URL, schluessel: key(), automatisch_ab: getKv("qs_auto_ab") }));
  };

  // ---- Automatischer Status ----
  const odooUrl = String(process.env.ODOO_URL || "").replace(/\/+$/, "");
  const odooKey = process.env.ODOO_API_KEY || "";
  const odooDb = process.env.ODOO_DB || "";
  const odoo =
    odooImpl ||
    (odooUrl && odooKey
      ? async (model, method, params) => {
          const headers = { "Content-Type": "application/json; charset=utf-8", Authorization: `bearer ${odooKey}`, "User-Agent": "kratos-dashboard/1.0" };
          if (odooDb) headers["X-Odoo-Database"] = odooDb;
          const r = await fetchImpl(`${odooUrl}/json/2/${model}/${method}`, { method: "POST", headers, body: JSON.stringify(params), signal: AbortSignal.timeout(60000) });
          if (!r.ok) throw new Error(`Odoo HTTP ${r.status}`);
          return r.json();
        }
      : null);

  // Welche Teile verlangen einen EMPB? Im Verkaufsauftrag steht die Position „[EMPB] Erstmusterprüfbericht“ direkt unter dem Teil,
  // für das sie gilt; ausnahmsweise steht „EMPB“ im Text der Teileposition selbst. Nur lesen.
  async function empbTeileAusOdoo(sources) {
    if (!odoo || !sources.length) return new Set();
    const lines = await odoo("sale.order.line", "search_read", {
      domain: [["order_id.name", "in", sources]],
      fields: ["order_id", "sequence", "product_id", "name", "display_type"],
      order: "order_id, sequence, id",
      limit: 2000,
    });
    return empbTeile(lines);
  }

  // Prüfplanstand in QS (nur Artikel, nur lesen)
  async function qsPlaene(artikel) {
    const p = new URLSearchParams();
    artikel.forEach((a) => p.append("artikel", a));
    const r = await fetchImpl(`${QS_URL}/api/extern/plaene?${p}`, { headers: { "X-QS-Schluessel": key() }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`QS HTTP ${r.status}`);
    return (await r.json()).artikel || {};
  }

  async function automatisch() {
    const ab = getKv("qs_auto_ab");
    // Neue offene Positionen (seit dem Einschalten aus Odoo), bei denen Prüfplan oder EMPB noch automatisch bewertet werden dürfen
    const kandidaten = db
      .prepare(
        `SELECT o.id, o.product, o.source FROM orders o JOIN odoo_seen s ON s.odoo_id = o.odoo_id
          WHERE o.done = 0 AND s.first_seen >= ? AND s.first_seen <> 'baseline'`
      )
      .all(ab);
    if (!kandidaten.length) return { geprueft: 0, gesetzt: 0 };
    const row = db.prepare("SELECT status, auto FROM av_checks WHERE order_id = ? AND item = ?");
    const frei = (id, item) => {
      const r = row.get(id, item);
      return !r || (r.auto === 1 && ["offen", "entfaellt"].includes(r.status)); // von Hand gesetzt oder schon weiter → nie anfassen
    };
    const set = db.prepare(
      `INSERT INTO av_checks (order_id, item, status, due, note, assignee, updated_at, auto) VALUES (?, ?, ?, NULL, '', NULL, datetime('now'), 1)
       ON CONFLICT (order_id, item) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at WHERE av_checks.auto = 1 AND av_checks.status <> excluded.status`
    );
    let gesetzt = 0;
    const pp = kandidaten.filter((o) => frei(o.id, "pruefplan") && artikelAus(o.product));
    if (pp.length) {
      try {
        const stand = await qsPlaene([...new Set(pp.map((o) => artikelAus(o.product)))]);
        for (const o of pp) {
          const s = stand[artikelAus(o.product)];
          if (!s) continue;
          gesetzt += Number(set.run(o.id, "pruefplan", s.freigegeben.length ? "bereit" : "offen").changes);
        }
      } catch (err) {
        console.error("QS-Verbindung: Prüfplanstand nicht lesbar", err.message);
      }
    }
    const em = kandidaten.filter((o) => frei(o.id, "empb") && o.source);
    if (em.length && odoo) {
      try {
        const mit = await empbTeileAusOdoo([...new Set(em.map((o) => o.source))]);
        for (const o of em) gesetzt += Number(set.run(o.id, "empb", mit.has(o.source + "|" + norm(artikelAus(o.product))) ? "offen" : "entfaellt").changes);
      } catch (err) {
        console.error("QS-Verbindung: EMPB im Verkaufsauftrag nicht lesbar", err.message);
      }
    }
    if (gesetzt) console.log(`QS-Verbindung: ${gesetzt} AV-Punkte automatisch gesetzt`);
    return { geprueft: kandidaten.length, gesetzt };
  }

  const start = () => {
    if (process.env.QS_AUTO === "0") return;
    setTimeout(() => automatisch().catch(() => {}), 90 * 1000);
    setInterval(() => automatisch().catch(() => {}), EVERY);
  };

  return { afterLogin, start, automatisch, key };
}
