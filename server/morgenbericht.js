// Morgenbericht als Nachricht: werktags um 6:15 Uhr (deutsche Zeit) eine kurze Zusammenfassung an die Planung (Frank), damit niemand erst
// die App öffnen muss. Inhalt: "Heute zu tun", der Planvorschlag des Tages (Text von Talos, wenn vorhanden), Extern & Wareneingang,
// offene Freigaben, Link zur App.
//
// Zugestellt wird über eine Weiterleitung (z. B. n8n-Webhook, der die Mail verschickt): MORGENBERICHT_WEBHOOK (URL),
// MORGENBERICHT_AN (Empfänger, durch Komma getrennt), optional MORGENBERICHT_KEY (wird als Bearer mitgeschickt), APP_URL (Link).
// Ohne MORGENBERICHT_WEBHOOK wird nichts verschickt; der Bericht ist trotzdem unter GET /api/morgenbericht lesbar.

import { todayStr } from "../src/lib.js";

const SEND_HOUR = 6;
const SEND_MIN = 15;

export function berichtText({ heute, plan, extern, freigaben, appUrl, datum }) {
  const d = new Date(datum + "T12:00:00Z").toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  const lines = [`Morgenbericht Produktion, ${d}`, ""];
  const items = (heute && heute.items) || [];
  if (items.length) {
    lines.push("Heute zu tun:");
    items.filter((i) => i.tone !== "mute").forEach((i) => lines.push(`- ${i.text}${i.hint ? ` (${i.hint})` : ""}`));
  } else lines.push("Heute zu tun: nichts Dringendes.");
  if (plan) {
    lines.push("", `Planvorschlag: ${plan.titel}`);
    String(plan.text || "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 12)
      .forEach((l) => lines.push(l.startsWith("-") || l.startsWith("•") ? l : `  ${l}`));
  }
  if (extern) {
    const parts = [extern.ueberfaellig ? `${extern.ueberfaellig} Lieferungen überfällig` : null, extern.fehltDringend ? `${extern.fehltDringend} externe Arbeitsgänge ohne Bestellung` : null, extern.vorab ? `${extern.vorab} Lieferungen in 2 Werktagen fällig` : null].filter(Boolean);
    if (parts.length) lines.push("", `Extern & Wareneingang: ${parts.join(", ")}.`);
  }
  if (freigaben) {
    const av = freigaben.filter((f) => f.art === "av").length;
    const hin = freigaben.filter((f) => f.art === "hinweis").length;
    if (av || hin) lines.push("", `Zur Freigabe: ${[av ? `${av} AV-Pakete` : null, hin ? `${hin} Hinweise` : null].filter(Boolean).join(", ")}.`);
  }
  if (appUrl) lines.push("", `Zur Planung: ${appUrl}`);
  return lines.join("\n");
}

export default function registerMorgenbericht(app, db) {
  db.exec("CREATE TABLE IF NOT EXISTS morgenbericht_log (tag TEXT PRIMARY KEY, at TEXT NOT NULL, status TEXT NOT NULL, info TEXT)");
  const URL = process.env.MORGENBERICHT_WEBHOOK || "";
  const AN = (process.env.MORGENBERICHT_AN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const KEY = process.env.MORGENBERICHT_KEY || "";
  const appUrl = process.env.APP_URL || "https://dashboard.kratos-precision.de";

  async function build() {
    const datum = todayStr();
    let heute = null;
    let extern = null;
    let freigaben = [];
    try {
      heute = app.locals.heuteListe ? app.locals.heuteListe() : null;
    } catch {
      heute = null;
    }
    try {
      if (app.locals.extern) extern = (await app.locals.extern.get(false)).zahlen;
    } catch {
      extern = null;
    }
    try {
      freigaben = app.locals.freigaben ? app.locals.freigaben.offen() : [];
    } catch {
      freigaben = [];
    }
    const plan = freigaben.find((f) => f.art === "plan") || null;
    return { datum, betreff: `Morgenbericht Produktion ${datum.slice(8, 10)}.${datum.slice(5, 7)}.`, text: berichtText({ heute, plan, extern, freigaben, appUrl, datum }) };
  }

  async function send({ force = false } = {}) {
    const b = await build();
    if (!URL) return { gesendet: false, grund: "MORGENBERICHT_WEBHOOK ist nicht eingerichtet", ...b };
    const done = db.prepare("SELECT status FROM morgenbericht_log WHERE tag = ?").get(b.datum);
    if (done && done.status === "ok" && !force) return { gesendet: false, grund: "heute schon verschickt", ...b };
    try {
      const r = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
        body: JSON.stringify({ an: AN, betreff: b.betreff, text: b.text, link: appUrl }),
        signal: AbortSignal.timeout(20000),
      });
      const status = r.ok ? "ok" : `HTTP ${r.status}`;
      db.prepare("INSERT INTO morgenbericht_log (tag, at, status, info) VALUES (?, ?, ?, ?) ON CONFLICT (tag) DO UPDATE SET at = excluded.at, status = excluded.status, info = excluded.info").run(b.datum, new Date().toISOString(), status, AN.join(", "));
      return { gesendet: r.ok, grund: r.ok ? null : status, ...b };
    } catch (err) {
      db.prepare("INSERT INTO morgenbericht_log (tag, at, status, info) VALUES (?, ?, ?, ?) ON CONFLICT (tag) DO UPDATE SET at = excluded.at, status = excluded.status, info = excluded.info").run(b.datum, new Date().toISOString(), "Fehler", err.message);
      return { gesendet: false, grund: err.message, ...b };
    }
  }

  app.get("/api/morgenbericht", async (req, res) => res.json({ eingerichtet: !!URL, an: AN, ...(await build()), letzte: db.prepare("SELECT * FROM morgenbericht_log ORDER BY tag DESC LIMIT 5").all() }));
  // Von Hand nachsenden: nur Leitung (PIN)
  app.post("/api/morgenbericht/senden", async (req, res) => {
    const s = app.locals.bdeSession ? app.locals.bdeSession(req) : null;
    if (!s || !s.leitung) return res.status(403).json({ error: "Nur die Leitung kann den Bericht von Hand senden." });
    res.json(await send({ force: true }));
  });

  // Werktags 6:15 Uhr, einmal je Tag (der Planvorschlag entsteht ab 6:00, Talos braucht ein paar Minuten für den Text)
  if (URL && process.env.MORGENBERICHT_AUTO !== "0") {
    setInterval(() => {
      const p = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
      const h = Number(p.find((x) => x.type === "hour").value);
      const m = Number(p.find((x) => x.type === "minute").value);
      const wd = p.find((x) => x.type === "weekday").value;
      if (/^(Sa|So)/.test(wd) || h < SEND_HOUR || (h === SEND_HOUR && m < SEND_MIN) || h >= 11) return;
      send().catch((err) => console.error("Morgenbericht:", err.message));
    }, 5 * 60 * 1000).unref();
  }
  app.locals.morgenbericht = { build, send };
}
