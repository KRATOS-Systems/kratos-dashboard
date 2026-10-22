// Odoo-Nachrichten im kleinen Fenster: ungelesene Chats (Direktnachrichten, Gruppen) und der Odoo-Posteingang
// (Erwähnungen, Nachrichten an gefolgte Aufträge) des angemeldeten Mitarbeiters.
//
// Datenschutz: Der zentrale Odoo-Zugang des Dashboards sieht technisch alle Chats. Deshalb gilt hier streng:
// - nur die eigenen Nachrichten des Angemeldeten, kein Parameter für andere Personen, keine Leitungsansicht
// - nur Ungelesenes, nur Absender und die ersten Worte; nichts wird im Dashboard gespeichert oder protokolliert
// - nur lesen: gelesen wird in Odoo (ein Klick öffnet den Chat bzw. den Posteingang dort)

import { m2o } from "./bde.js";

const CACHE_MS = 45 * 1000;
const PREVIEW = 90;
const CHAT_TYPES = ["chat", "group"];

const plain = (html) =>
  String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const short = (t) => (t.length > PREVIEW ? `${t.slice(0, PREVIEW - 1)}…` : t);

export default function registerBdeMessages(app, ctx) {
  const { odoo } = ctx;
  const partnerOf = new Map(); // Benutzer -> Kontakt (res.partner), ändert sich nicht
  const cache = new Map(); // Mitarbeiter -> { at, data }, nur im Speicher

  async function partner(userId) {
    if (partnerOf.has(userId)) return partnerOf.get(userId);
    const [u] = await odoo.read("res.users", "read", { ids: [userId], fields: ["partner_id"] });
    const pid = u ? m2o(u.partner_id)?.id || null : null;
    partnerOf.set(userId, pid);
    return pid;
  }

  async function load(pid) {
    // Chats: Mitgliedschaften mit ungelesenen Nachrichten (der Zähler ist berechnet, daher nicht suchbar)
    const members = await odoo.read("discuss.channel.member", "search_read", {
      domain: [["partner_id", "=", pid]],
      fields: ["channel_id", "message_unread_counter"],
      limit: 200,
    });
    const unread = members.filter((m) => m.message_unread_counter > 0);
    const chIds = unread.map((m) => m2o(m.channel_id)?.id).filter(Boolean);
    const channels = chIds.length ? await odoo.read("discuss.channel", "read", { ids: chIds, fields: ["name", "channel_type"] }) : [];
    const chById = new Map(channels.filter((c) => CHAT_TYPES.includes(c.channel_type)).map((c) => [c.id, c]));
    const chats = [];
    for (const m of unread) {
      const ch = chById.get(m2o(m.channel_id)?.id);
      if (!ch) continue;
      // letzte Nachricht eines anderen als Vorschau
      const [last] = await odoo.read("mail.message", "search_read", {
        domain: [["model", "=", "discuss.channel"], ["res_id", "=", ch.id], ["message_type", "=", "comment"], ["author_id", "!=", pid]],
        fields: ["author_id", "body", "date"],
        order: "id desc",
        limit: 1,
      });
      chats.push({
        key: `c${ch.id}`,
        kind: ch.channel_type === "group" ? "gruppe" : "chat",
        channelId: ch.id,
        from: last ? m2o(last.author_id)?.name || "?" : ch.name,
        group: ch.channel_type === "group" ? ch.name : null,
        count: m.message_unread_counter,
        text: last ? short(plain(last.body)) : "",
        at: last ? last.date : null,
      });
    }

    // Posteingang: ungelesene Benachrichtigungen (Erwähnungen, Nachrichten an gefolgte Datensätze)
    const notes = await odoo.read("mail.notification", "search_read", {
      domain: [["res_partner_id", "=", pid], ["notification_type", "=", "inbox"], ["is_read", "=", false]],
      fields: ["mail_message_id"],
      order: "id desc",
      limit: 20,
    });
    const msgIds = notes.map((n) => m2o(n.mail_message_id)?.id).filter(Boolean);
    const msgs = msgIds.length ? await odoo.read("mail.message", "read", { ids: msgIds, fields: ["author_id", "body", "model", "res_id", "record_name", "date", "subject"] }) : [];
    const inbox = msgs
      .filter((x) => x.model !== "discuss.channel")
      .map((x) => ({
        key: `m${x.id}`,
        kind: "posteingang",
        from: m2o(x.author_id)?.name || "Odoo",
        about: x.record_name || x.subject || null,
        model: x.model || null,
        resId: Number.isInteger(x.res_id) ? x.res_id : null,
        text: short(plain(x.body) || x.subject || ""),
        at: x.date,
      }));

    return [...chats, ...inbox].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  }

  app.get("/api/bde/nachrichten", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    try {
      await ctx.ensureEmployees();
      const emp = ctx.employees().get(s.e);
      if (!emp || !emp.userId) return res.json({ items: [], noUser: true });
      let c = cache.get(s.e);
      if (!c || Date.now() - c.at > CACHE_MS) {
        const pid = await partner(emp.userId);
        c = { at: Date.now(), data: pid ? await load(pid) : [] };
        cache.set(s.e, c);
      }
      const base = odoo.url || "";
      res.json({
        items: c.data.map((x) => ({
          ...x,
          link: !base
            ? null
            : x.channelId
              ? `${base}/odoo/discuss?active_id=discuss.channel_${x.channelId}`
              : x.model && x.resId
                ? `${base}/odoo/${x.model}/${x.resId}`
                : `${base}/odoo/discuss?active_id=mail.box_inbox`,
        })),
      });
    } catch (err) {
      ctx.fail(res, err);
    }
  });
}
