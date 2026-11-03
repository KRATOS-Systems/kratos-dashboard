import React, { useEffect, useState } from "react";

// Hinweis oben auf Planung und Arbeitsvorbereitung: was bei den Stücklisten in Odoo auffällt.
// Ohne Stückliste hat ein Fertigungsauftrag keine Arbeitsgänge, im Entwurf holt die App ihn gar nicht, und Musterwerte sind nur Platzhalter.

const plural = (n, one, many) => (n === 1 ? one : many);
const names = (list, max = 6) => list.slice(0, max).join(", ") + (list.length > max ? " u. a." : "");

export default function BomHinweis() {
  const [b, setB] = useState(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/odoo/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => !stop && setB(s && s.enabled ? s.bomCheck || null : null))
        .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (!b) return null;
  const noBom = [...new Set([...(b.none || []), ...(b.draftsNoBom || [])])];
  const leer = b.leer || [];
  const muster = b.muster || [];
  if (!noBom.length && !leer.length && !muster.length && !b.drafts) return null;

  const line = (key, color, head, rest) => (
    <div className="bom-l" key={key}>
      <i className="dot" style={{ "--c": color }} />
      <span>
        <b>{head}</b> {rest}
      </span>
    </div>
  );
  const lines = [];
  if (noBom.length)
    lines.push(line("n", "var(--bad)", `${noBom.length} ${plural(noBom.length, "Fertigungsauftrag hat", "Fertigungsaufträge haben")} keine Stückliste:`, `${names(noBom)}. Ohne Stückliste gibt es keine Arbeitsgänge, der Auftrag fehlt in der Planung.`));
  if (leer.length) lines.push(line("l", "var(--bad)", `${leer.length} ${plural(leer.length, "Auftrag hat", "Aufträge haben")} eine Stückliste ohne Arbeitsgänge:`, `${names(leer)}. In Odoo Arbeitsgänge ergänzen.`));
  if (muster.length) lines.push(line("m", "var(--warn)", `${muster.length} ${plural(muster.length, "Auftrag läuft", "Aufträge laufen")} auf Musterwerten:`, `${names(muster)}. Maschine und Zeit sind noch nicht geprüft.`));
  if (b.drafts > 0) lines.push(line("d", "var(--faint)", `${b.drafts} ${plural(b.drafts, "Fertigungsauftrag ist", "Fertigungsaufträge sind")} in Odoo noch im Entwurf`, "und deshalb nicht in der Planung."));

  return (
    <div className={`bom-hinweis note${noBom.length || leer.length ? " warn" : ""} rise`} style={{ "--i": 1 }}>
      {lines}
    </div>
  );
}
