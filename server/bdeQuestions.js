// Rückfragen zu Aufgaben: ein kleiner Verlauf je Odoo-Aktivität zwischen Empfänger und dem, der die Aufgabe vergeben hat.
//
// - Beteiligt sind der Empfänger (Benutzer der Aktivität) und der Vergebende: bei Aufgaben aus der BDE steht er im Vermerk
//   "Vergeben von … über Kratos BDE", bei Aufgaben aus Odoo ist es der Ersteller (create_uid). Nur diese beiden lesen und schreiben.
// - Der Verlauf liegt in der Datenbank des Dashboards (task_messages), "gelesen bis" je Person in task_reads.
// - Mit BDE_WRITE=1 wird jede Nachricht zusätzlich als interne Notiz in Odoo am Auftrag bzw. Mitarbeiter abgelegt (message_post,
//   Untertyp Notiz: keine E-Mail, Kunden sehen nichts).

import { m2o, isPhone } from "./bde.js";

const MARK = "über Kratos BDE";
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const userErr = (msg) => Object.assign(new Error(msg), { user: true });

// Vergebender aus dem Vermerk in der Notiz ("Vergeben von Frank Häckl über Kratos BDE")
export function assignerName(note) {
  const m = /Vergeben von (.+?) über Kratos BDE/.exec(String(note || "").replace(/<[^>]+>/g, " "));
  return m ? m[1].trim() : null;
}

export default function registerBdeQuestions(app, db, ctx) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL,
      from_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_messages_activity ON task_messages (activity_id);
    CREATE TABLE IF NOT EXISTS task_reads (
      activity_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY (activity_id, employee_id)
    );
  `);
  const { odoo } = ctx;
  const byName = () => new Map([...ctx.employees().values()].map((e) => [e.name, e]));
  const byUser = () => new Map([...ctx.employees().values()].filter((e) => e.userId).map((e) => [e.userId, e]));

  // Beteiligte einer Aktivität: { assignee, assigner } als Mitarbeiter (oder null)
  function participants(a) {
    const assignee = byUser().get(m2o(a.user_id)?.id) || null;
    const name = assignerName(a.note);
    const assigner = name ? byName().get(name) || null : byUser().get(m2o(a.create_uid)?.id) || null;
    return { assignee, assigner: assigner && assignee && assigner.id === assignee.id ? null : assigner };
  }
  async function activity(id) {
    const [a] = await odoo.read("mail.activity", "read", { ids: [id], fields: ["user_id", "create_uid", "note", "summary", "res_model", "res_id", "res_name"] });
    if (!a) throw userErr("Diese Aufgabe gibt es nicht mehr");
    return a;
  }

  // Zähler für die Listen: Anzahl Nachrichten und ungelesene je Aktivität für einen Mitarbeiter
  function counts(activityIds, employeeId) {
    const out = new Map();
    if (!activityIds.length) return out;
    const ph = activityIds.map(() => "?").join(",");
    const all = db.prepare(`SELECT activity_id, from_id, at FROM task_messages WHERE activity_id IN (${ph})`).all(...activityIds);
    const reads = new Map(db.prepare(`SELECT activity_id, read_at FROM task_reads WHERE employee_id = ? AND activity_id IN (${ph})`).all(employeeId, ...activityIds).map((r) => [r.activity_id, r.read_at]));
    all.forEach((m) => {
      const c = out.get(m.activity_id) || { total: 0, unread: 0 };
      c.total += 1;
      if (m.from_id !== employeeId && (!reads.has(m.activity_id) || m.at > reads.get(m.activity_id))) c.unread += 1;
      out.set(m.activity_id, c);
    });
    return out;
  }

  app.get("/api/bde/aufgaben/:id/fragen", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    const id = Number(req.params.id);
    try {
      await ctx.ensureEmployees();
      const a = await activity(id);
      const { assignee, assigner } = participants(a);
      const leitungView = s.leitung && req.query.ansicht === "1";
      if (!leitungView && ![assignee?.id, assigner?.id].includes(s.e)) throw Object.assign(new Error("Nur die Beteiligten sehen die Rückfragen"), { forbidden: true });
      const msgs = db.prepare("SELECT id, from_id, text, at FROM task_messages WHERE activity_id = ? ORDER BY at, id").all(id);
      if (!leitungView) db.prepare("INSERT INTO task_reads (activity_id, employee_id, read_at) VALUES (?, ?, ?) ON CONFLICT (activity_id, employee_id) DO UPDATE SET read_at = excluded.read_at").run(id, s.e, new Date().toISOString());
      const names = new Map([...ctx.employees().values()].map((e) => [e.id, e.name]));
      res.json({
        assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
        assigner: assigner ? { id: assigner.id, name: assigner.name } : null,
        canWrite: [assignee?.id, assigner?.id].includes(s.e) && !!assigner && !isPhone(req),
        // Gegenüber des Betrachters (an wen die nächste Nachricht geht)
        other: s.e === assignee?.id ? (assigner ? { id: assigner.id, name: assigner.name } : null) : assignee ? { id: assignee.id, name: assignee.name } : null,
        messages: msgs.map((m) => ({ id: m.id, fromId: m.from_id, fromName: names.get(m.from_id) || "?", text: m.text, at: m.at, mine: m.from_id === s.e })),
      });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  app.post("/api/bde/aufgaben/:id/fragen", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    if (isPhone(req)) return res.status(403).json({ error: "Am Handy gibt es nur die Anzeige." });
    const id = Number(req.params.id);
    const text = String((req.body && req.body.text) || "").trim();
    try {
      if (text.length < 1 || text.length > 1000) throw userErr("Bitte eine kurze Nachricht schreiben");
      await ctx.ensureEmployees();
      const a = await activity(id);
      const { assignee, assigner } = participants(a);
      if (!assigner) throw userErr("Bei dieser Aufgabe ist nicht bekannt, wer sie vergeben hat");
      if (![assignee?.id, assigner?.id].includes(s.e)) throw Object.assign(new Error("Nur die Beteiligten können Rückfragen stellen"), { forbidden: true });
      const now = new Date().toISOString();
      db.prepare("INSERT INTO task_messages (activity_id, from_id, text, at) VALUES (?, ?, ?, ?)").run(id, s.e, text, now);
      db.prepare("INSERT INTO task_reads (activity_id, employee_id, read_at) VALUES (?, ?, ?) ON CONFLICT (activity_id, employee_id) DO UPDATE SET read_at = excluded.read_at").run(id, s.e, now);
      // Zusätzlich als interne Notiz in Odoo (nur mit BDE_WRITE; ein Fehler dort hält die Rückfrage nicht auf)
      let odooNote = false;
      if (odoo.writeEnabled && ["mrp.production", "sale.order", "hr.employee"].includes(a.res_model) && Number.isInteger(a.res_id)) {
        const me = ctx.employees().get(s.e);
        const other = s.e === assignee?.id ? assigner : assignee;
        try {
          await odoo.write(a.res_model, "message_post", {
            ids: [a.res_id],
            body: `<p><b>${s.e === assignee?.id ? "Rückfrage" : "Antwort"} zur Aufgabe „${escHtml(a.summary || "")}“</b> (${escHtml(me ? me.name : "?")} an ${escHtml(other ? other.name : "?")}, ${MARK}):</p><p>${escHtml(text)}</p>`,
            message_type: "comment",
            subtype_xmlid: "mail.mt_note",
          });
          odooNote = true;
        } catch (err) {
          console.error("BDE: Notiz in Odoo fehlgeschlagen", err.message);
        }
      }
      res.json({ ok: true, odooNote });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  return { counts, participants, assignerName };
}
