import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Auslastung nach vorn: je Maschine und Woche, wie voll sie laut Plan ist (Ampel), bis wann sie ausgebucht ist,
// und welche Stunden noch auf keiner Maschine stehen. reloadKey ändert sich mit jeder Planänderung.

const h = (x) => String(Math.round(x * 10) / 10).replace(".", ",");
const AMPEL = { rot: "var(--bad)", gelb: "var(--warn)", gruen: "var(--ok)" };

export default function Auslastung({ reloadKey }) {
  const [d, setD] = useState(null);

  useEffect(() => {
    let stop = false;
    const t = setTimeout(
      () =>
        fetch("/api/auslastung")
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => !stop && j && setD(j))
          .catch(() => {}),
      d ? 900 : 0
    );
    return () => {
      stop = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  if (!d) return <div className="card" style={{ padding: 18, color: "var(--muted)" }}>Auslastung wird berechnet …</div>;
  const pool = d.nichtEingeplant;
  const poolTotal = pool.wochen.reduce((s, w) => s + w.stunden, 0) + pool.spaeter + pool.ohneTermin;

  return (
    <div className="card ausl">
      <div className="sec-head">
        <div>
          <h2>Auslastung der nächsten {d.wochen.length} Wochen</h2>
          <p>Stunden laut Plan gegen die Leistung der Maschine. Rot: In dieser Woche wird etwas nach dem Liefertermin fertig. Gelb: voll (ab {d.vollAb} %). Grün: Es ist Luft.</p>
        </div>
      </div>
      <div className="scroll">
        <table className="ausl-t">
          <thead>
            <tr>
              <th>Maschine</th>
              {d.wochen.map((w, ix) => (
                <th key={w.monday}>
                  KW {w.kw}
                  <small>{ix === 0 ? "ab heute" : "ab " + fmtShort(w.monday)}</small>
                </th>
              ))}
              <th>Ausgebucht bis</th>
            </tr>
          </thead>
          <tbody>
            {d.maschinen.map((m) => (
              <tr key={m.id}>
                <th>
                  {m.name}
                  <small>{h(m.wochenleistung)} h je Woche</small>
                </th>
                {m.wochen.map((w) => (
                  <td
                    key={w.monday}
                    title={
                      w.kapazitaet > 0
                        ? `${h(w.belegt)} von ${h(w.kapazitaet)} h belegt, ${h(w.frei)} h frei` + (w.zuSpaet.length ? "\nZu spät fertig: " + w.zuSpaet.map((z) => `${z.auftrag}${z.fa && z.fa !== z.auftrag ? " (" + z.fa + ")" : ""} +${z.tage} T`).join(", ") : "")
                        : "Keine Arbeitstage"
                    }
                  >
                    {w.kapazitaet > 0 ? (
                      <div className="ausl-c">
                        <div className="ausl-bar">
                          <i style={{ width: w.prozent + "%", background: AMPEL[w.ampel] }} />
                        </div>
                        <b style={{ color: w.ampel === "gruen" ? "var(--ink)" : AMPEL[w.ampel] }}>{w.prozent} %</b>
                        <small>{w.zuSpaet.length ? `${w.zuSpaet.length} zu spät` : w.frei >= 1 ? `${h(w.frei)} h frei` : "voll"}</small>
                      </div>
                    ) : (
                      <span className="ausl-none">frei</span>
                    )}
                  </td>
                ))}
                <td className="ausl-end">{m.ausgebuchtBis ? fmtShort(m.ausgebuchtBis) : <span style={{ color: "var(--ok)", fontWeight: 600 }}>jetzt frei</span>}</td>
              </tr>
            ))}
            <tr className="ausl-pool">
              <th>
                Noch nicht eingeplant
                <small>Stunden nach Liefertermin</small>
              </th>
              {pool.wochen.map((w) => (
                <td key={w.monday} title={w.positionen ? `${w.positionen} ${w.positionen === 1 ? "Position" : "Positionen"} mit Liefertermin in dieser Woche oder früher, noch auf keiner Maschine` : ""}>
                  {w.stunden > 0 ? <b>{h(w.stunden)} h</b> : <span className="ausl-none">–</span>}
                </td>
              ))}
              <td className="ausl-end">{poolTotal > 0 ? `${h(poolTotal)} h gesamt` : "–"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {(pool.spaeter > 0 || pool.ohneTermin > 0 || pool.ohneStunden > 0) && (
        <div className="ausl-foot">
          {[
            pool.spaeter > 0 ? `${h(pool.spaeter)} h mit Liefertermin nach diesen ${d.wochen.length} Wochen` : null,
            pool.ohneTermin > 0 ? `${h(pool.ohneTermin)} h ohne Liefertermin` : null,
            pool.ohneStunden > 0 ? `${pool.ohneStunden} ${pool.ohneStunden === 1 ? "Position" : "Positionen"} ohne Stunden (nicht mitgerechnet)` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}
