import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Reiter „Erledigt“: versendete bzw. abgeschlossene Aufträge (Standard: letzte 30 Tage), mit Suche nach Auftrag, Kunde oder Artikel.
// Je Auftrag: versendet am, pünktlich gegenüber dem Liefertermin, Lieferungen, Rechnung (aus Odoo). Klick öffnet die Details.

const day = (s) => (s ? fmtShort(s) : "–");
const eur = (n) => (n || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

export default function Erledigt({ reloadKey, onOpen }) {
  const [tage, setTage] = useState(30);
  const [q, setQ] = useState("");
  const [qLive, setQLive] = useState("");
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(qLive.trim()), 300);
    return () => clearTimeout(t);
  }, [qLive]);
  useEffect(() => {
    let off = false;
    setErr("");
    fetch(`/api/erledigt?tage=${tage}${q ? "&q=" + encodeURIComponent(q) : ""}`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || "nicht erreichbar")))))
      .then((j) => !off && setD(j))
      .catch((e) => !off && setErr(e.message));
    return () => {
      off = true;
    };
  }, [tage, q, reloadKey]);

  const list = (d && d.list) || [];
  const spaet = list.filter((g) => g.puenktlich === false).length;
  const mitTermin = list.filter((g) => g.puenktlich !== null).length;
  return (
    <div className="card vs-card">
      <div className="sec-head">
        <div>
          <h2>Erledigt</h2>
          <p>Versendete und abgeschlossene Aufträge. Suche durchsucht alle, nicht nur den Zeitraum.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="search" placeholder="Auftrag, Kunde oder Artikel" value={qLive} onChange={(e) => setQLive(e.target.value)} style={{ width: 230 }} aria-label="Erledigte Aufträge durchsuchen" />
          <select value={tage} onChange={(e) => setTage(Number(e.target.value))} aria-label="Zeitraum" disabled={!!q}>
            <option value={30}>letzte 30 Tage</option>
            <option value={90}>letzte 90 Tage</option>
            <option value={365}>letztes Jahr</option>
          </select>
          {mitTermin > 0 && (
            <span className={`pill ${spaet ? "warn" : "ok"}`} title="Versanddatum gegenüber dem Liefertermin">
              {Math.round(((mitTermin - spaet) / mitTermin) * 100)} % pünktlich
            </span>
          )}
        </div>
      </div>
      {err && <div className="note" style={{ margin: 12 }}>Erledigt: {err}</div>}
      {!d ? (
        <div className="fg-faint" style={{ padding: 18 }}>{err ? "" : "Wird geladen …"}</div>
      ) : list.length === 0 ? (
        <div className="fg-faint" style={{ padding: 18 }}>{q ? "Nichts gefunden." : "Im Zeitraum ist nichts erledigt."}</div>
      ) : (
        <div className="tablewrap">
          <table className="vs-table">
            <thead>
              <tr>
                <th>Auftrag</th>
                <th>Kunde</th>
                <th>Artikel</th>
                <th>Versendet</th>
                <th>Liefertermin</th>
                <th>Termin</th>
                <th>Lieferungen</th>
                <th>Rechnung</th>
              </tr>
            </thead>
            <tbody>
              {list.map((g) => (
                <tr key={g.auftrag} onClick={() => onOpen(g.ids[0])} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(g.ids[0])} title="Details öffnen">
                  <td className="mono">
                    <b>{g.auftrag}</b>
                    {g.teilweiseOffen && <div className="fg-faint" style={{ fontSize: 13 }}>Rest noch offen</div>}
                  </td>
                  <td>{g.kunde || "–"}</td>
                  <td className="vs-art">{g.artikel.join(", ") || "–"}</td>
                  <td>{day(g.versendetAm)}</td>
                  <td>{day(g.liefertermin)}</td>
                  <td>{g.puenktlich === null ? <span className="fg-faint">–</span> : g.puenktlich ? <span className="pill ok">pünktlich</span> : <span className="pill warn">{g.tageZuSpaet} {g.tageZuSpaet === 1 ? "Tag" : "Tage"} später</span>}</td>
                  <td title={(g.lieferscheine || []).join(", ")}>{g.lieferungen != null ? g.lieferungen : "–"}{g.lieferungen > 1 ? " (Teillieferungen)" : ""}</td>
                  <td>{!g.rechnung ? <span className="fg-faint">–</span> : g.rechnung === "berechnet" ? <span className="pill ok">berechnet</span> : <span className="pill warn">offen{g.offenWert ? " · " + eur(g.offenWert) : ""}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
