// Programme: Welche offenen Fertigungsaufträge haben schon ein Mastercam-Programm?
// Gemeldet vom Skript auftragsordner/programme_melden.py (läuft im Haus, liest K: und Odoo): eigene Programme im Auftragsordner und
// Altprogramme desselben Artikels aus früheren Aufträgen. Das AV-Paket schlägt damit den Punkt "Programm" vor.
//
// POST /api/programme/meldung  (vor dem Passwortschutz, Schutz: Authorization: Bearer <PROGRAMME_KEY>, mind. 24 Zeichen)
// GET  /api/programme?fa=FA01341

import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";

const sha = (s) => createHash("sha256").update(String(s)).digest();
const fmt = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");

// Text für den AV-Punkt "Programm" und ob er auf "bereit" gehen kann
export function programmHinweis(p) {
  if (!p) return null;
  const eigene = JSON.parse(p.eigene || "[]");
  const alt = JSON.parse(p.alt || "[]");
  if (eigene.length) {
    const neu = eigene.slice().sort((a, b) => String(b.stand || "").localeCompare(String(a.stand || "")))[0];
    return { text: `Programm im Auftragsordner: ${eigene.map((e) => e.datei).slice(0, 3).join(", ")}${eigene.length > 3 ? " …" : ""}${neu && neu.stand ? ` (Stand ${fmt(neu.stand)})` : ""}`, status: "bereit" };
  }
  if (alt.length) {
    const g = alt[0];
    return { text: `Altprogramm aus ${g.auftrag}${g.stand ? ` (Stand ${fmt(g.stand)})` : ""}: ${g.dateien.slice(0, 3).join(", ")}${g.dateien.length > 3 ? " …" : ""}. Zeichnungsindex prüfen, Programm in den Auftrag übernehmen`, status: null, ordner: g.ordner };
  }
  return null;
}

export default function registerProgramme(app, db) {
  db.exec(`CREATE TABLE IF NOT EXISTS programme (
    fa TEXT PRIMARY KEY,
    code TEXT,
    auftrag TEXT,
    eigene TEXT NOT NULL DEFAULT '[]',
    alt TEXT NOT NULL DEFAULT '[]',
    at TEXT NOT NULL
  )`);
  const KEY = process.env.PROGRAMME_KEY || "";
  const get = db.prepare("SELECT * FROM programme WHERE fa = ?");

  app.post("/api/programme/meldung", express.json({ limit: "4mb" }), (req, res) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    if (KEY.length < 24 || !m || !timingSafeEqual(sha(m[1].trim()), sha(KEY))) return res.status(401).json({ error: "Schlüssel fehlt oder falsch" });
    const list = Array.isArray(req.body && req.body.meldungen) ? req.body.meldungen : null;
    if (!list) return res.status(400).json({ error: "meldungen fehlt" });
    const now = new Date().toISOString();
    const put = db.prepare(
      `INSERT INTO programme (fa, code, auftrag, eigene, alt, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (fa) DO UPDATE SET code = excluded.code, auftrag = excluded.auftrag, eigene = excluded.eigene, alt = excluded.alt, at = excluded.at`
    );
    let n = 0;
    db.exec("BEGIN");
    try {
      for (const x of list.slice(0, 2000)) {
        if (!x || !/^FA\d{3,}/.test(String(x.fa || ""))) continue;
        const eigene = (Array.isArray(x.eigene) ? x.eigene : []).slice(0, 50).map((e) => ({ datei: String(e.datei || "").slice(0, 200), pfad: String(e.pfad || "").slice(0, 400), stand: e.stand || null }));
        const alt = (Array.isArray(x.alt) ? x.alt : []).slice(0, 10).map((g) => ({ auftrag: String(g.auftrag || "").slice(0, 60), ordner: String(g.ordner || "").slice(0, 400), dateien: (Array.isArray(g.dateien) ? g.dateien : []).slice(0, 30).map((d) => String(d).slice(0, 200)), stand: g.stand || null }));
        put.run(String(x.fa), String(x.code || "").slice(0, 80) || null, String(x.auftrag || "").slice(0, 40) || null, JSON.stringify(eigene), JSON.stringify(alt), now);
        n++;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true, gespeichert: n, programmBereit: programmAv() });
  });

  app.get("/api/programme", (req, res) => {
    const fa = String(req.query.fa || "");
    if (fa) {
      const p = get.get(fa);
      return res.json(p ? { ...p, eigene: JSON.parse(p.eigene), alt: JSON.parse(p.alt), hinweis: programmHinweis(p) } : null);
    }
    const rows = db.prepare("SELECT fa, code, auftrag, at, json_array_length(eigene) AS eigene, json_array_length(alt) AS alt FROM programme ORDER BY fa").all();
    res.json({ items: rows, stand: rows.reduce((a, r) => (r.at > a ? r.at : a), "") || null });
  });

  app.locals.programmOf = (fa) => (fa ? get.get(fa) : null);

  // Eigenes Programm im Auftragsordner gefunden: AV-Punkt "Programm" auf bereit (automatisch markiert, wie Material aus dem Einkauf).
  // Von Hand gesetzte Punkte bleiben, wie sie sind.
  function programmAv() {
    if (!db.prepare("PRAGMA table_info(av_checks)").all().some((c) => c.name === "auto")) return 0;
    const rows = db.prepare("SELECT o.id, p.eigene FROM orders o JOIN programme p ON p.fa = COALESCE(o.parent_ref, o.odoo_ref) WHERE o.done = 0").all();
    const cur = db.prepare("SELECT status, note, auto FROM av_checks WHERE order_id = ? AND item = 'programm'");
    const put = db.prepare(
      `INSERT INTO av_checks (order_id, item, status, due, note, assignee, updated_at, auto) VALUES (?, 'programm', 'bereit', NULL, ?, NULL, datetime('now'), 1)
       ON CONFLICT (order_id, item) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at WHERE av_checks.auto = 1`
    );
    let n = 0;
    for (const r of rows) {
      let eigene = [];
      try {
        eigene = JSON.parse(r.eigene || "[]");
      } catch {
        eigene = [];
      }
      if (!eigene.length) continue;
      const c = cur.get(r.id);
      if (c && c.auto !== 1) continue;
      const note = "Auftragsordner: " + eigene.map((e) => e.datei).slice(0, 3).join(", ");
      if (c && c.status === "bereit" && c.note === note) continue;
      put.run(r.id, note);
      n++;
    }
    return n;
  }
  app.locals.programmAv = programmAv;
}
