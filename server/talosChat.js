// Talos im Produktionsdashboard: leitet Fragen an den Talos-Kern weiter (odoo-mcp, /talos/ask).
// Der Schlüssel TALOS_KEY_DASHBOARD bleibt auf dem Server; der Browser sieht ihn nie.
// Absender = angemeldeter Mitarbeiter (BDE-Anmeldung), sonst „Dashboard“.
import { staffName } from "../src/staffLib.js";

export default function registerTalosChat(app) {
  const URL = process.env.TALOS_URL || "https://odoo-mcp.kratos-precision.de/talos/ask";
  const KEY = process.env.TALOS_KEY_DASHBOARD || "";

  app.get("/api/talos/status", (req, res) => res.json({ on: KEY.length >= 24 }));

  // Wie /api/talos, aber mit Fortschritt: der Zeilenstrom des Talos-Kerns wird unverändert an den Browser durchgereicht
  app.post("/api/talos/stream", async (req, res) => {
    if (KEY.length < 24) return res.status(503).json({ error: "Talos ist noch nicht eingerichtet." });
    const { frage, verlauf, kontext } = req.body || {};
    if (typeof frage !== "string" || !frage.trim() || frage.length > 4000) return res.status(400).json({ error: "Frage fehlt oder ist zu lang." });
    const session = app.locals.bdeSession?.(req);
    const absender = session ? { name: staffName(session.e) || `Mitarbeiter ${session.e}`, rolle: session.leitung ? "Leitung" : "Mitarbeiter" } : { name: "Dashboard (nicht angemeldet)" };
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      const r = await fetch(URL.replace(/\/ask$/, "/ask-stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ frage, verlauf: Array.isArray(verlauf) ? verlauf.slice(-10) : [], absender, kontext: String(kontext || "").slice(0, 500) }),
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300_000)]),
      });
      if (!r.ok || !r.body) {
        const data = await r.json().catch(() => ({}));
        return res.status(r.status === 429 ? 429 : 502).json({ error: data.error || "Talos ist gerade nicht erreichbar." });
      }
      res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      for await (const chunk of r.body) res.write(chunk);
      res.end();
    } catch {
      if (!res.headersSent) res.status(502).json({ error: "Talos ist gerade nicht erreichbar." });
      else res.end(JSON.stringify({ fehler: "Verbindung zu Talos unterbrochen." }) + "\n");
    }
  });

  app.post("/api/talos", async (req, res) => {
    if (KEY.length < 24) return res.status(503).json({ error: "Talos ist noch nicht eingerichtet." });
    const { frage, verlauf, kontext } = req.body || {};
    if (typeof frage !== "string" || !frage.trim() || frage.length > 4000) return res.status(400).json({ error: "Frage fehlt oder ist zu lang." });
    const session = app.locals.bdeSession?.(req);
    const absender = session ? { name: staffName(session.e) || `Mitarbeiter ${session.e}`, rolle: session.leitung ? "Leitung" : "Mitarbeiter" } : { name: "Dashboard (nicht angemeldet)" };
    try {
      const r = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ frage, verlauf: Array.isArray(verlauf) ? verlauf.slice(-10) : [], absender, kontext: String(kontext || "").slice(0, 500) }),
        signal: AbortSignal.timeout(240_000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: data.error || "Talos ist gerade nicht erreichbar." });
      res.json({ antwort: String(data.antwort || ""), quellen: Array.isArray(data.quellen) ? data.quellen : [] });
    } catch {
      res.status(502).json({ error: "Talos ist gerade nicht erreichbar." });
    }
  });
}
