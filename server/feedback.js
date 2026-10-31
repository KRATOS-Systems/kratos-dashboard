// Rückmeldungen der Mitarbeiter (Fehler, Idee, Lob) mit optionalem Bild.
//
// - Schreiben darf jeder, der die App öffnen kann; ist ein Mitarbeiter angemeldet (BDE), steht sein Name dabei.
// - Die Liste aller Rückmeldungen und das Bearbeiten (Status, Antwort) sind nur für die Leitung.
// - Jeder angemeldete Mitarbeiter sieht seine eigenen Rückmeldungen samt Antwort.
// - Bilder werden im Browser verkleinert, hier nur geprüft und nach 90 Tagen wieder gelöscht, der Text bleibt.
//   GET  /api/feedback/anzahl      Anzahl neuer Rückmeldungen (Leitung)
//   GET  /api/feedback/liste       alle Rückmeldungen (Leitung)
//   GET  /api/feedback/meine       eigene Rückmeldungen
//   POST /api/feedback             neue Rückmeldung
//   GET  /api/feedback/:id/bild    Bild (Leitung oder Absender)
//   POST /api/feedback/:id/status  Status und Antwort setzen (Leitung)

import { staffName } from "../src/staffLib.js";

const ARTEN = ["fehler", "idee", "lob"];
const STATUS = ["neu", "arbeit", "erledigt", "verworfen"];
const MAX_TEXT = 3000;
const MAX_ANSWER = 1000;
const MAX_IMAGE = 1_500_000; // Bytes nach dem Verkleinern im Browser
const IMAGE_DAYS = 90;
const RATE_MAX = 10;
const RATE_MS = 10 * 60 * 1000;

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

export default function registerFeedback(app, db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      employee_id INTEGER,
      name TEXT NOT NULL DEFAULT '',
      art TEXT NOT NULL,
      text TEXT NOT NULL,
      page TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      image BLOB,
      image_type TEXT,
      status TEXT NOT NULL DEFAULT 'neu',
      answer TEXT NOT NULL DEFAULT '',
      answered_at TEXT,
      answered_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, id);
  `);

  const session = (req) => (app.locals.bdeSession ? app.locals.bdeSession(req) : null);
  const row = (r) => ({
    id: r.id,
    createdAt: r.created_at,
    employeeId: r.employee_id,
    name: r.name,
    art: r.art,
    text: r.text,
    page: r.page,
    context: r.context,
    hasImage: !!r.has_image,
    status: r.status,
    answer: r.answer,
    answeredAt: r.answered_at,
    answeredBy: r.answered_by,
  });
  const COLS = "id, created_at, employee_id, name, art, text, page, context, (image IS NOT NULL) AS has_image, status, answer, answered_at, answered_by";

  // Bilder nach 90 Tagen entfernen, der Text bleibt
  function dropOldImages() {
    const cut = new Date(Date.now() - IMAGE_DAYS * 86400000).toISOString();
    try {
      db.prepare("UPDATE feedback SET image = NULL, image_type = NULL WHERE image IS NOT NULL AND created_at < ?").run(cut);
    } catch (err) {
      console.error("Alte Rückmelde-Bilder konnten nicht entfernt werden:", err.message);
    }
  }
  dropOldImages();
  if (process.env.BACKUP_AUTO !== "0") setInterval(dropOldImages, 12 * 3600 * 1000).unref();

  const hits = new Map(); // IP -> Zeitpunkte, nur im Speicher
  function tooMany(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < RATE_MS);
    if (list.length >= RATE_MAX) {
      hits.set(ip, list);
      return true;
    }
    list.push(now);
    hits.set(ip, list);
    return false;
  }

  function decodeImage(dataUrl) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
    if (!m) return null;
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length || buf.length > MAX_IMAGE) return { tooBig: buf.length > MAX_IMAGE };
    const head = buf.subarray(0, 12);
    const ok = m[1] === "image/jpeg" ? head[0] === 0xff && head[1] === 0xd8 : m[1] === "image/png" ? head.subarray(1, 4).toString() === "PNG" : head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP";
    return ok ? { type: m[1], buf } : null;
  }

  app.post("/api/feedback", (req, res) => {
    const b = req.body || {};
    const art = ARTEN.includes(b.art) ? b.art : null;
    const text = clip(b.text, MAX_TEXT + 1).trim();
    if (!art) return res.status(400).json({ error: "Bitte die Art der Rückmeldung wählen" });
    if (!text) return res.status(400).json({ error: "Bitte kurz beschreiben, worum es geht" });
    if (text.length > MAX_TEXT) return res.status(400).json({ error: "Der Text ist zu lang" });
    if (tooMany(req.ip || "?")) return res.status(429).json({ error: "Gerade sehr viele Rückmeldungen. Bitte in ein paar Minuten noch einmal." });
    let img = null;
    if (b.image) {
      img = decodeImage(b.image);
      if (!img) return res.status(400).json({ error: "Das Bild konnte nicht gelesen werden" });
      if (img.tooBig) return res.status(400).json({ error: "Das Bild ist zu groß" });
    }
    const s = session(req);
    const name = s ? staffName(s.e) || `Mitarbeiter ${s.e}` : "";
    const ctx = clip(typeof b.context === "string" ? b.context : JSON.stringify(b.context || ""), 600);
    const r = db
      .prepare("INSERT INTO feedback (created_at, employee_id, name, art, text, page, context, image, image_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), s ? s.e : null, name, art, text, clip(b.page, 200), ctx, img ? img.buf : null, img ? img.type : null);
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });

  app.get("/api/feedback/anzahl", (req, res) => {
    const s = session(req);
    if (!s || !s.leitung) return res.json({ neu: 0 });
    res.json({ neu: db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'neu'").get().n });
  });

  app.get("/api/feedback/liste", (req, res) => {
    const s = session(req);
    if (!s || !s.leitung) return res.status(403).json({ error: "Nur für die Leitung" });
    const rows = db.prepare(`SELECT ${COLS} FROM feedback ORDER BY (status IN ('erledigt','verworfen')), id DESC LIMIT 300`).all();
    res.json({ items: rows.map(row) });
  });

  app.get("/api/feedback/meine", (req, res) => {
    const s = session(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    const rows = db.prepare(`SELECT ${COLS} FROM feedback WHERE employee_id = ? ORDER BY id DESC LIMIT 50`).all(s.e);
    res.json({ items: rows.map(row) });
  });

  app.get("/api/feedback/:id/bild", (req, res) => {
    const s = session(req);
    const r = db.prepare("SELECT employee_id, image, image_type FROM feedback WHERE id = ?").get(Number(req.params.id));
    if (!r || !r.image) return res.status(404).json({ error: "Kein Bild" });
    if (!s || (!s.leitung && s.e !== r.employee_id)) return res.status(403).json({ error: "Kein Zugriff" });
    res.set({ "Content-Type": r.image_type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
    res.send(Buffer.from(r.image));
  });

  app.post("/api/feedback/:id/status", (req, res) => {
    const s = session(req);
    if (!s || !s.leitung) return res.status(403).json({ error: "Nur für die Leitung" });
    const id = Number(req.params.id);
    const cur = db.prepare("SELECT id, status, answer FROM feedback WHERE id = ?").get(id);
    if (!cur) return res.status(404).json({ error: "Rückmeldung nicht gefunden" });
    const b = req.body || {};
    const status = b.status == null ? cur.status : b.status;
    if (!STATUS.includes(status)) return res.status(400).json({ error: "Unbekannter Status" });
    const answer = b.answer == null ? cur.answer : clip(b.answer, MAX_ANSWER).trim();
    const changed = answer !== cur.answer;
    db.prepare("UPDATE feedback SET status = ?, answer = ?, answered_at = CASE WHEN ? THEN ? ELSE answered_at END, answered_by = CASE WHEN ? THEN ? ELSE answered_by END WHERE id = ?").run(
      status,
      answer,
      changed ? 1 : 0,
      new Date().toISOString(),
      changed ? 1 : 0,
      staffName(s.e) || `Mitarbeiter ${s.e}`,
      id,
    );
    res.json({ ok: true });
  });
}
