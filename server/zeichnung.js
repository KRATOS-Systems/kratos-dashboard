// Zeichnung lesen fürs AV-Paket: fragt Talos (odoo-mcp, POST /talos/zeichnung), der die Zeichnung (PDF) des Fertigungsauftrags aus Odoo
// holt und von Claude auslesen lässt. Ergebnis wird je FA gespeichert (Tabelle zeichnungen) und nur neu gelesen, wenn eine andere
// Zeichnung am Artikel hängt oder jemand "Zeichnung neu lesen" drückt.
// Zugang: TALOS_URL (…/talos/ask, die Adresse wird daraus abgeleitet) und TALOS_KEY_DASHBOARD. Ohne Schlüssel aus.

const KINDS = [
  ["Eloxieren", /elox/i],
  ["Härten", /härt|haert|vergüt|hrc/i],
  ["Strahlen", /strahl/i],
  ["Brünieren", /brünier|bruenier|schwärz/i],
  ["Beschichten", /beschicht|pulver|lack/i],
  ["Galvanik", /vernick|verzink|verchrom|galvan/i],
];

// Abgleich Zeichnung <-> Arbeitsplan (Odoo) <-> Kalkulation: Warnungen und Hinweise fürs AV-Paket
export function zeichnungAbgleich(z, { oberflaechenArbeitsplan = [], kalkWerkstoff = "", werkstoffArtOf = () => null } = {}) {
  const warnungen = [];
  const hinweise = [];
  if (!z) return { warnungen, hinweise };
  const plan = oberflaechenArbeitsplan.join(" ");
  const verlangt = [...(z.oberflaeche || []), z.waermebehandlung || ""].join(" ");
  // "Oberflächenbehandlung (extern)" ohne Art: die Oberfläche ist eingeplant, nur nicht genau benannt
  const allgemein = /oberfläche/i.test(plan);
  for (const [name, re] of KINDS) {
    if (re.test(verlangt) && !re.test(plan) && allgemein && name !== "Härten") hinweise.push(`Zeichnung verlangt ${name}, im Arbeitsplan steht nur „Oberflächenbehandlung“: beim Bestellen der Lohnarbeit angeben.`);
    else if (re.test(verlangt) && !re.test(plan)) warnungen.push(`Zeichnung verlangt ${name} (${[...(z.oberflaeche || []), z.waermebehandlung].filter((x) => x && re.test(x)).join(", ")}), im Arbeitsplan fehlt der Schritt.`);
    else if (re.test(plan) && !re.test(verlangt) && z.sicherheit === "hoch") hinweise.push(`Arbeitsplan hat ${name}, die Zeichnung nennt das nicht: prüfen.`);
  }
  if (z.werkstoff && kalkWerkstoff) {
    const a = werkstoffArtOf(z.werkstoff);
    const b = werkstoffArtOf(kalkWerkstoff);
    if (a && b && a !== b) warnungen.push(`Werkstoff: Zeichnung ${z.werkstoff}, Kalkulation ${kalkWerkstoff}.`);
  }
  const genau = [z.engste_toleranz, ...(z.passungen || []), z.rauheit].filter(Boolean);
  if (genau.length) hinweise.push(`Zeichnung: ${genau.join(", ")}`);
  if ((z.besonderheiten || []).length) hinweise.push(`Zeichnung: ${z.besonderheiten.join(", ")}`);
  return { warnungen, hinweise };
}

export default function registerZeichnung(app, db) {
  db.exec(`CREATE TABLE IF NOT EXISTS zeichnungen (
    fa TEXT PRIMARY KEY,
    anhang_id INTEGER,
    anhang TEXT,
    daten TEXT,
    grund TEXT,
    at TEXT NOT NULL
  )`);
  const base = (process.env.TALOS_URL || "https://odoo-mcp.kratos-precision.de/talos/ask").replace(/\/talos\/ask(-stream)?\/?$/, "");
  const KEY = process.env.TALOS_KEY_DASHBOARD || "";
  const enabled = KEY.length >= 24 && process.env.ZEICHNUNG_AUS !== "1";
  const get = db.prepare("SELECT * FROM zeichnungen WHERE fa = ?");
  const out = (r) => (r ? { fa: r.fa, anhang: r.anhang, daten: r.daten ? JSON.parse(r.daten) : null, grund: r.grund, at: r.at } : null);

  async function lesen(fa, { neu = false } = {}) {
    if (!enabled) return null;
    const cur = get.get(fa);
    if (cur && !neu) return out(cur);
    const r = await fetch(base + "/talos/zeichnung", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ fa }),
      signal: AbortSignal.timeout(200000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Talos antwortete mit HTTP ${r.status}`);
    db.prepare(
      `INSERT INTO zeichnungen (fa, anhang_id, anhang, daten, grund, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (fa) DO UPDATE SET anhang_id = excluded.anhang_id, anhang = excluded.anhang, daten = excluded.daten, grund = excluded.grund, at = excluded.at`
    ).run(fa, j.anhang ? j.anhang.id : null, j.anhang ? j.anhang.name : null, j.daten ? JSON.stringify(j.daten) : null, j.daten ? null : j.grund || "nicht gelesen", new Date().toISOString());
    return out(get.get(fa));
  }

  app.get("/api/zeichnung/:fa", (req, res) => res.json(out(get.get(req.params.fa))));
  app.locals.zeichnung = { enabled, lesen, gespeichert: (fa) => out(get.get(fa)) };
}
