// Prio-Aufträge: extrem wichtige Kundenaufträge, die alle in der Planung und bei „Mein Arbeitsplatz“ oben sehen.
//   - Prio gilt für den ganzen Auftrag (Kundenauftrag bzw. Auftragsnummer, wie die Planung Positionen zusammenfasst).
//   - Setzen und wegnehmen nur die Leitung (angemeldet mit PIN); sehen dürfen alle.
//   - Der Schalter schiebt den Plan NICHT von selbst um, er macht den Auftrag nur sichtbar.
//   - Prio endet von selbst, wenn alle Positionen erledigt sind. Nach 7 Tagen fragt die Leiste „Noch Prio?“.
//   - Zu jeder Position steht, was in der Arbeitsvorbereitung noch offen ist (Material, Programm, Stunden) – ohne Rechnen.

import { LANE_IDS, groupKeyOf, groupLabelOf } from "../src/planLogic.js";
import { MACHINES } from "../src/lib.js";

const NACHFRAGEN_TAGE = 7;
const VIELE = 5;
const AV_PUNKTE = { material: "Material", programm: "Programm" };

export default function registerPrio(app, db, { staffName } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS prio (auftrag TEXT PRIMARY KEY, grund TEXT NOT NULL DEFAULT '', von TEXT, seit TEXT NOT NULL, bestaetigt TEXT)");
  const sessionOf = (req) => (app.locals.bdeSession ? app.locals.bdeSession(req) : null);
  const nameOf = (e) => {
    try {
      return staffName ? staffName(e) : null;
    } catch {
      return null;
    }
  };
  const ortOf = (m) => {
    if (!m) return "nicht eingeplant";
    const ma = MACHINES.find((x) => x.id === m);
    if (ma) return ma.short;
    if (m === "qs") return "QS";
    if (LANE_IDS.includes(m)) return "Extern";
    return m;
  };

  function liste() {
    const rows = db.prepare("SELECT * FROM prio ORDER BY seit").all();
    if (!rows.length) return { items: [], viele: false };
    const keys = new Set(rows.map((r) => r.auftrag));
    const orders = db.prepare("SELECT id, machine, order_no, odoo_ref, source, product, customer, hours, done_hours, due_date, done, pinned FROM orders").all();
    const byKey = new Map();
    for (const o of orders) {
      const k = groupKeyOf(o);
      if (!keys.has(k)) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(o);
    }
    const checks = db.prepare("SELECT order_id, item, status FROM av_checks WHERE item IN ('material', 'programm')").all();
    const avOf = new Map(checks.map((c) => [`${c.order_id}:${c.item}`, c.status]));
    const del = db.prepare("DELETE FROM prio WHERE auftrag = ?");
    const now = Date.now();
    const items = [];
    for (const r of rows) {
      const all = byKey.get(r.auftrag) || [];
      const open = all.filter((o) => !o.done);
      // Alle Positionen erledigt: Prio endet von selbst
      if (all.length && !open.length) {
        del.run(r.auftrag);
        continue;
      }
      const positionen = open.map((o) => {
        const offen = [];
        if (!LANE_IDS.includes(o.machine)) {
          for (const [item, label] of Object.entries(AV_PUNKTE)) {
            const st = avOf.get(`${o.id}:${item}`) || "offen";
            if (st === "offen" || st === "in_arbeit") offen.push(label);
          }
          if (!(o.hours > 0)) offen.push("Stunden");
        }
        return {
          id: o.id,
          ref: o.odoo_ref || o.order_no || `#${o.id}`,
          product: o.product || null,
          machine: o.machine || "",
          ort: ortOf(o.machine),
          hours: o.hours || 0,
          done_hours: o.done_hours || 0,
          due_date: o.due_date || null,
          pinned: !!o.pinned,
          avOffen: offen,
        };
      });
      const dues = open.map((o) => o.due_date).filter(Boolean).sort();
      const stand = Date.parse(r.bestaetigt || r.seit);
      items.push({
        auftrag: r.auftrag,
        label: all.length ? groupLabelOf(all[0]) : r.auftrag,
        kunde: (open[0] && open[0].customer) || null,
        grund: r.grund || "",
        von: r.von || null,
        seit: r.seit,
        termin: dues[0] || null,
        positionen,
        avOffen: positionen.some((p) => p.avOffen.length),
        nachfragen: Number.isFinite(stand) && now - stand > NACHFRAGEN_TAGE * 86400000,
        ohnePositionen: !all.length,
      });
    }
    items.sort((a, b) => (a.termin || "9999").localeCompare(b.termin || "9999"));
    return { items, viele: items.length > VIELE, grenze: VIELE };
  }

  const nurLeitung = (req, res) => {
    const s = sessionOf(req);
    if (!s || !s.leitung) {
      res.status(403).json({ error: "Prio setzen kann nur die Leitung (mit PIN angemeldet)." });
      return null;
    }
    return s;
  };

  app.get("/api/prio", (req, res) => {
    const s = sessionOf(req);
    res.json({ ...liste(), darf: !!(s && s.leitung) });
  });

  app.post("/api/prio", (req, res) => {
    const s = nurLeitung(req, res);
    if (!s) return;
    const auftrag = String((req.body && req.body.auftrag) || "").trim().slice(0, 80);
    const grund = String((req.body && req.body.grund) || "").trim().slice(0, 140);
    if (!auftrag) return res.status(400).json({ error: "Auftrag fehlt" });
    const known = db
      .prepare("SELECT id, order_no, source FROM orders WHERE done = 0")
      .all()
      .some((o) => groupKeyOf(o) === auftrag);
    if (!known) return res.status(404).json({ error: "Kein offener Auftrag " + auftrag });
    const von = nameOf(s.e) || String(s.e);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO prio (auftrag, grund, von, seit, bestaetigt) VALUES (?, ?, ?, ?, NULL) ON CONFLICT (auftrag) DO UPDATE SET grund = excluded.grund"
    ).run(auftrag, grund, von, now);
    res.json({ ok: true, ...liste() });
  });

  // „Noch Prio?“ – ja: die 7 Tage beginnen neu
  app.post("/api/prio/bestaetigen", (req, res) => {
    if (!nurLeitung(req, res)) return;
    const auftrag = String((req.body && req.body.auftrag) || "").trim();
    const r = db.prepare("UPDATE prio SET bestaetigt = ? WHERE auftrag = ?").run(new Date().toISOString(), auftrag);
    if (!r.changes) return res.status(404).json({ error: "Nicht in Prio: " + auftrag });
    res.json({ ok: true, ...liste() });
  });

  app.post("/api/prio/aus", (req, res) => {
    if (!nurLeitung(req, res)) return;
    const auftrag = String((req.body && req.body.auftrag) || "").trim();
    db.prepare("DELETE FROM prio WHERE auftrag = ?").run(auftrag);
    res.json({ ok: true, ...liste() });
  });

  app.locals.prio = liste;
}
