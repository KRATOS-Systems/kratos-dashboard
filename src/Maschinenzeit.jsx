import React, { useEffect, useState } from "react";
import { Ico } from "./ui.jsx";
import { isoWeekOf, fmtShort, addDays } from "./lib.js";

// Prüfung der Maschinenzeit (Leitung): gebuchte Maschinenzeit aus Odoo gegen die Zählerstände vom Montag.
// Spindelstunden sind die Untergrenze, Maschine-an-Stunden die Obergrenze; Ampel und Hinweis kommen vom Server.

const h1 = (x) => (x == null ? "–" : `${Math.round(x * 10) / 10}`.replace(".", ","));
const pct = (x) => (x == null ? "" : `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(Math.round(x * 100))} %`);

function Line({ name, v, strong }) {
  return (
    <div className={`mz-line lvl-${v.level}${strong ? " strong" : ""}`}>
      <span className="mz-name">
        <i className="dot" />
        {name}
      </span>
      <span className="mz-n">
        <small>Spindel</small>
        {h1(v.spindle)}
      </span>
      <span className="mz-n">
        <small>Maschine an</small>
        {h1(v.on)}
      </span>
      <span className="mz-n">
        <small>Gebucht</small>
        {v.booked == null ? "–" : h1(v.booked)}
      </span>
      <span className="mz-d">{v.booked == null ? "keine Zuordnung" : pct(v.deviation)}</span>
      {v.text && <span className="mz-t">{v.text}</span>}
    </div>
  );
}

export default function Maschinenzeit() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [neu, setNeu] = useState(0);
  useEffect(() => {
    setErr(null);
    fetch(`/api/bde/maschinenzeit${neu ? "?neu=1" : ""}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Nicht verfügbar");
        setData(d);
      })
      .catch((e) => setErr(e.message));
  }, [neu]);
  return (
    <section className="bsec">
      <h2>
        Maschinenzeit prüfen
        <button type="button" className="btn quiet icon" onClick={() => setNeu((n) => n + 1)} aria-label="Neu berechnen" title="Neu berechnen">
          <Ico n="refresh" s={16} />
        </button>
      </h2>
      <p className="bsubtext">Gebuchte Maschinenzeit (Fräsen, Drehen) gegen die Zählerstände vom Montag. Grün: zwischen 95 % der Spindelstunden und den Maschine-an-Stunden.</p>
      {err && <div className="bnote">{err}</div>}
      {!data && !err && <div className="bnote quiet">Lade …</div>}
      {data && data.weeks.length === 0 && <div className="bnote quiet">Es gibt noch keine zwei Zählerablesungen.</div>}
      {data && data.weeks.length > 0 && data.mapped.length === 0 && (
        <div className="bnote quiet">In Odoo buchen alle Maschinen auf den einen Arbeitsplatz FRÄSEN. Deshalb gibt es nur die Summe; je Maschine geht es, sobald jede Maschine einen eigenen Arbeitsplatz hat (Einstellung BDE_MACHINES).</div>
      )}
      <div className="brecent">
        {data &&
          data.weeks.map((w) => (
            <div className="card mz-week" key={w.from}>
              <div className="mz-head">
                <b>KW {isoWeekOf(w.from).week}</b>
                <span>
                  {fmtShort(w.from)} – {fmtShort(addDays(w.to, -1))}
                </span>
              </div>
              <Line name="Alle Maschinen" v={w.total} strong />
              {w.machines.map((m) => (
                <Line key={m.id} name={m.name} v={m} />
              ))}
              {w.unassignedH > 0 && data.mapped.length > 0 && <div className="mz-foot">Ohne Maschinenzuordnung gebucht: {h1(w.unassignedH)} h</div>}
            </div>
          ))}
      </div>
    </section>
  );
}
