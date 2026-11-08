// Eigene To-dos und Notizen jedes Mitarbeiters ("Mein Arbeitsplatz").
//
// - Privat: jeder sieht und ändert nur seine eigenen Einträge. Wer angemeldet ist (BDE-Anmeldung), steht im Cookie; andere Personen
//   (auch die Leitung) haben keinen Zugriff, auch nicht über eine fremde Nummer (404).
// - Liegt in der Datenbank des Dashboards, nicht in Odoo. Die tägliche Datensicherung der Datenbankdatei enthält sie; die JSON-Datei
//   unter /api/backup enthält sie bewusst NICHT, weil sie von jedem mit dem App-Passwort geladen werden kann.
// - Erledigte To-dos bleiben 30 Tage sichtbar (zuletzt erledigte zuerst), dann werden sie gelöscht.
//   GET    /api/ich/todos          { today, open, done }
//   POST   /api/ich/todos          { text, due? }
//   PATCH  /api/ich/todos/:id      { text?, due?, done? }
//   DELETE /api/ich/todos/:id
//   GET    /api/ich/notizen        { items }
//   POST   /api/ich/notizen        { title?, text }
//   PATCH  /api/ich/notizen/:id    { title?, text?, pinned? }
//   DELETE /api/ich/notizen/:id

import { berlinDate } from "./bde.js";

const MAX_TODO = 200;
const MAX_TITLE = 80;
const MAX_NOTE = 4000;
const MAX_OPEN_TODOS = 300;
const MAX_NOTES = 200;
const DONE_KEEP_DAYS = 30;
const DONE_SHOWN = 15;

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const userErr = (msg) => Object.assign(new Error(msg), { user: true });

export default function registerMeineNotizen(app, db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS my_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      due TEXT,
      created_at TEXT NOT NULL,
      done_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_my_todos_emp ON my_todos (employee_id, done_at);
    CREATE TABLE IF NOT EXISTS my_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_my_notes_emp ON my_notes (employee_id);
  `);

  const session = (req) => (app.locals.bdeSession ? app.locals.bdeSession(req) : null);
  // Angemeldeten Mitarbeiter holen oder mit 401 antworten
  function me(req, res) {
    const s = session(req);
    if (!s) {
      res.status(401).json({ error: "Bitte anmelden" });
      return null;
    }
    return s.e;
  }
  const idOf = (req) => {
    const n = Number(req.params.id);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const fail = (res, err) => {
    if (err && err.user) return res.status(400).json({ error: err.message });
    console.error("Notizen", err);
    res.status(500).json({ error: "Das hat nicht geklappt" });
  };
  const clean = (v, n) => String(v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, n);

  const todo = (r) => ({ id: r.id, text: r.text, due: r.due || null, createdAt: r.created_at, doneAt: r.done_at || null });
  const note = (r) => ({ id: r.id, title: r.title, text: r.text, pinned: !!r.pinned, createdAt: r.created_at, updatedAt: r.updated_at });

  // ---- To-dos
  app.get("/api/ich/todos", (req, res) => {
    const e = me(req, res);
    if (e == null) return;
    try {
      const cutoff = new Date(Date.now() - DONE_KEEP_DAYS * 86400000).toISOString();
      db.prepare("DELETE FROM my_todos WHERE employee_id = ? AND done_at IS NOT NULL AND done_at < ?").run(e, cutoff);
      const open = db.prepare("SELECT * FROM my_todos WHERE employee_id = ? AND done_at IS NULL ORDER BY (due IS NULL), due, id").all(e);
      const done = db.prepare("SELECT * FROM my_todos WHERE employee_id = ? AND done_at IS NOT NULL ORDER BY done_at DESC, id DESC LIMIT ?").all(e, DONE_SHOWN);
      res.json({ today: berlinDate(Date.now()), open: open.map(todo), done: done.map(todo) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/ich/todos", (req, res) => {
    const e = me(req, res);
    if (e == null) return;
    try {
      const { text, due } = req.body || {};
      const t = clean(text, MAX_TODO);
      if (!t) throw userErr("Bitte kurz beschreiben, was zu tun ist");
      if (due != null && due !== "" && !isDate(due)) throw userErr("Das Datum bitte als TT.MM.JJJJ wählen");
      if (db.prepare("SELECT COUNT(*) AS n FROM my_todos WHERE employee_id = ? AND done_at IS NULL").get(e).n >= MAX_OPEN_TODOS) throw userErr("Zu viele offene To-dos, bitte erst ein paar erledigen oder löschen");
      const r = db.prepare("INSERT INTO my_todos (employee_id, text, due, created_at) VALUES (?, ?, ?, ?)").run(e, t, due ? due : null, new Date().toISOString());
      res.json({ ok: true, id: Number(r.lastInsertRowid) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch("/api/ich/todos/:id", (req, res) => {
    const e = me(req, res);
    if (e == null) return;
    try {
      const id = idOf(req);
      const cur = id ? db.prepare("SELECT * FROM my_todos WHERE id = ? AND employee_id = ?").get(id, e) : null;
      if (!cur) return res.status(404).json({ error: "Dieses To-do gibt es nicht" });
      const b = req.body || {};
      let text = cur.text;
      let due = cur.due;
      let doneAt = cur.done_at;
      if (b.text !== undefined) {
        text = clean(b.text, MAX_TODO);
        if (!text) throw userErr("Bitte kurz beschreiben, was zu tun ist");
      }
      if (b.due !== undefined) {
        if (b.due !== null && b.due !== "" && !isDate(b.due)) throw userErr("Das Datum bitte als TT.MM.JJJJ wählen");
        due = b.due ? b.due : null;
      }
      if (b.done !== undefined) doneAt = b.done ? cur.done_at || new Date().toISOString() : null;
      db.prepare("UPDATE my_todos SET text = ?, due = ?, done_at = ? WHERE id = ? AND employee_id = ?").run(text, due, doneAt, id, e);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/ich/todos/:id", (req, res) => {
    const e = me(req, res);
    if (e == null) return;
    try {
      const id = idOf(req);
      const r = id ? db.prepare("DELETE FROM my_todos WHERE id = ? AND employee_id = ?").run(id, e) : { changes: 0 };
      if (!r.changes) return res.status(404).json({ error: "Dieses To-do gibt es nicht" });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Notizen
  app.get("/api/ich/notizen", (req, res) => {
    const e = me(req, res);
    if (e == null) return;
    try {
      const rows = db.prepare("SELECT * FROM my_notes WHERE employee_id = ? ORDER BY pinned DESC, updated_at DESC, id DESC").all(e);
      res.json({ items: rows.map(note) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/ich/notizen", (req, res) => {
    const e = me(req, res);
    if (e == null) return;
    try {
      const { title, text } = req.body || {};
      const t = clean(text, MAX_NOTE);
      if (!t) throw userErr("Die Notiz ist leer");
      if (db.prepare("SELECT COUNT(*) AS n FROM my_notes WHERE employee_id = ?").get(e).n >= MAX_NOTES) throw userErr("Zu viele Notizen, bitte erst ein paar löschen");
      const now = new Date().toISOString();
      const r = db.prepare("INSERT INTO my_notes (employee_id, title, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(e, clean(title, MAX_TITLE), t, now, now);
      res.json({ ok: true, id: Number(r.lastInsertRowid) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch("/api/ich/notizen/:id", (req, res) => {
    const e = me(req, res);
    if (e == null) return;
    try {
      const id = idOf(req);
      const cur = id ? db.prepare("SELECT * FROM my_notes WHERE id = ? AND employee_id = ?").get(id, e) : null;
      if (!cur) return res.status(404).json({ error: "Diese Notiz gibt es nicht" });
      const b = req.body || {};
      let title = cur.title;
      let text = cur.text;
      let pinned = cur.pinned;
      if (b.title !== undefined) title = clean(b.title, MAX_TITLE);
      if (b.text !== undefined) {
        text = clean(b.text, MAX_NOTE);
        if (!text) throw userErr("Die Notiz ist leer");
      }
      if (b.pinned !== undefined) pinned = b.pinned ? 1 : 0;
      // Anheften ändert die Reihenfolge, nicht den "zuletzt bearbeitet"-Zeitpunkt
      const changedContent = title !== cur.title || text !== cur.text;
      db.prepare("UPDATE my_notes SET title = ?, text = ?, pinned = ?, updated_at = ? WHERE id = ? AND employee_id = ?").run(title, text, pinned, changedContent ? new Date().toISOString() : cur.updated_at, id, e);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/ich/notizen/:id", (req, res) => {
    const e = me(req, res);
    if (e == null) return;
    try {
      const id = idOf(req);
      const r = id ? db.prepare("DELETE FROM my_notes WHERE id = ? AND employee_id = ?").run(id, e) : { changes: 0 };
      if (!r.changes) return res.status(404).json({ error: "Diese Notiz gibt es nicht" });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}
