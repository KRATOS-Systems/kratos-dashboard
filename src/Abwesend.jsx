import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Wer ist in den nächsten 4 Wochen abwesend (aus Odoo, ohne Grund)? Feiertage und Betriebsruhe aus Odoo stehen schon in den freien Tagen.
export default function Abwesend({ reloadKey }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    fetch("/api/abwesenheit")
      .then((r) => (r.ok ? r.json() : null))
      .then(setD)
      .catch(() => setD(null));
  }, [reloadKey]);
  if (!d || !d.abwesend || !d.abwesend.length) return null;
  return (
    <div className="card abw">
      <b>Abwesend in den nächsten 4 Wochen</b>
      <span className="fg-faint"> laut Odoo · die Maschinenleistung bitte selbst anpassen, wenn eine Maschine dadurch steht</span>
      <ul>
        {d.abwesend.map((a, i) => (
          <li key={i}>
            <b>{a.name}</b> {a.von === a.bis ? fmtShort(a.von) : `${fmtShort(a.von)}–${fmtShort(a.bis)}`}
            {a.beantragt ? <span className="fg-faint"> (beantragt)</span> : null}
          </li>
        ))}
      </ul>
      {d.neueFreieTage && d.neueFreieTage.length > 0 && <div className="fg-faint">Aus Odoo übernommen: {d.neueFreieTage.map((x) => `${fmtShort(x.date)} ${x.name}`).join(", ")}</div>}
    </div>
  );
}
