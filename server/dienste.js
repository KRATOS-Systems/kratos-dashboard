// Statuszeile „Dienste“: Läuft alles, wovon die Planung abhängt? Damit ein Ausfall (z. B. abgelaufener API-Schlüssel) nicht tagelang
// unbemerkt bleibt. Nur lesen, nichts wird geändert.
//   odoo       letzter Abgleich und Fehler (server/odooSync.js)
//   talos      Claude-Zugang des Talos-Servers (odoo-mcp /talos/health, kostet keine Token), davon hängen Talos und „Zeichnung lesen“ ab
//   maschinen  Maschinen-Dienst meldet sich (nur wenn MASCHINEN_KEY gesetzt ist)
// Je Dienst: ok = true | false | null (unbekannt), stufe = ok | warn | bad, grund = was zu tun ist.

import { liveEmpfangen } from "./maschinenLive.js";

const TALOS_TTL = 5 * 60 * 1000;
const ODOO_STALE_MIN = 120; // so lange ohne erfolgreichen Abgleich ist auffällig
const MASCHINEN_STALE_MIN = 15;

export default function registerDienste(app) {
  const base = (process.env.TALOS_URL || "https://odoo-mcp.kratos-precision.de/talos/ask").replace(/\/talos\/ask(-stream)?\/?$/, "");
  const KEY = process.env.TALOS_KEY_DASHBOARD || "";
  let talos = null;

  async function talosStand() {
    if (KEY.length < 24) return { ok: null, stufe: "warn", grund: "Talos ist nicht eingerichtet (TALOS_KEY_DASHBOARD fehlt)" };
    if (talos && Date.now() - talos.at < TALOS_TTL) return talos.v;
    let v;
    try {
      const r = await fetch(base + "/talos/health", { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(15000) });
      if (r.status === 404) v = { ok: null, stufe: "warn", grund: "Talos-Server kennt die Prüfung noch nicht (odoo-mcp aktualisieren)" };
      else if (!r.ok) v = { ok: false, stufe: "bad", grund: `Talos-Server antwortet mit HTTP ${r.status}` };
      else {
        const j = await r.json();
        v = j.ok ? { ok: true, stufe: "ok", grund: null } : { ok: false, stufe: "bad", grund: j.grund || "Claude-Zugang gestört" };
      }
    } catch {
      v = { ok: false, stufe: "bad", grund: "Talos-Server nicht erreichbar" };
    }
    talos = { at: Date.now(), v };
    return v;
  }

  function odooStand() {
    const s = app.locals.odooZustand ? app.locals.odooZustand() : null;
    if (!s || !s.enabled) return { ok: null, stufe: "warn", grund: "Odoo ist nicht verbunden" };
    if (s.lastError) return { ok: false, stufe: "bad", grund: s.lastError };
    const min = s.lastSync ? (Date.now() - Date.parse(s.lastSync)) / 60000 : Infinity;
    if (min > ODOO_STALE_MIN) return { ok: false, stufe: "warn", grund: s.lastSync ? `Letzter Abgleich vor ${Math.round(min / 60)} Std.` : "Noch kein Abgleich" };
    return { ok: true, stufe: "ok", grund: null };
  }

  function maschinenStand() {
    if (!process.env.MASCHINEN_KEY) return null; // ohne Maschinen-Dienst keine Zeile
    const t = liveEmpfangen();
    const min = t ? (Date.now() - t) / 60000 : Infinity;
    if (min <= MASCHINEN_STALE_MIN) return { ok: true, stufe: "ok", grund: null };
    const seit = t ? new Date(t).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;
    // Gelb statt rot: nachts oder am Wochenende ist der Dienst-PC oft aus
    return { ok: false, stufe: "warn", grund: seit ? `Keine Daten seit ${seit} Uhr (Dienst-PC an? Maschinen-Dienst läuft?)` : "Noch keine Daten vom Maschinen-Dienst" };
  }

  app.get("/api/dienste", async (req, res) => {
    const list = [
      { id: "odoo", label: "Odoo", ...odooStand() },
      { id: "talos", label: "Talos und Zeichnung lesen", ...(await talosStand()) },
    ];
    const m = maschinenStand();
    if (m) list.push({ id: "maschinen", label: "Maschinen-Dienst", ...m });
    res.json({ stand: new Date().toISOString(), dienste: list, alleOk: list.every((d) => d.stufe === "ok") });
  });
}
