import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Plan neu ordnen: Die App rechnet für die eingeplanten Positionen eine bessere Reihenfolge aus (laufende und fixierte bleiben stehen)
// und zeigt vorher und nachher. Gespeichert wird erst mit "Übernehmen". reloadKey: ändert sich mit jeder Planänderung.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const full = (d) => (d ? `${fmtShort(d)}${d.slice(0, 4)}` : "–");

export default function Neuordnen({ reloadKey, onApplied, onOdoo, embedded = false }) {
  const [openState, setOpen] = useState(false);
  const open = embedded || openState; // eingebettet in "Plan verbessern": immer offen, ohne eigenen Knopf
  const [wechseln, setWechseln] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    let stop = false;
    setErr("");
    const t = setTimeout(
      () =>
        fetch(`/api/neuordnen?wechseln=${wechseln ? 1 : 0}`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Der Vorschlag konnte nicht berechnet werden"))))
          .then((j) => !stop && setData(j))
          .catch((e) => !stop && setErr(e.message)),
      data ? 900 : 0
    );
    return () => {
      stop = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wechseln, reloadKey]);

  const apply = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/neuordnen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stamp: data.stamp, wechseln }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Übernehmen hat nicht geklappt");
      setDone(`Übernommen: ${plural(j.geaendert, "Position", "Positionen")} neu geordnet${j.wechsel ? `, davon ${j.wechsel} auf eine andere Maschine` : ""}.`);
      setOpen(false);
      setData(null);
      if (onApplied) onApplied();
      if (onOdoo && j.odoo && j.odoo.length) onOdoo({ odoo: j.odoo });
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  const changed = data ? data.maschinen.filter((m) => m.geaendert) : [];
  return (
    <div className="neuord">
      <div className="no-bar">
        {embedded ? (
          <b className="pvb-h">Reihenfolge verbessern</b>
        ) : (
          <button type="button" className={`btn sm${open ? "" : " primary"}`} onClick={() => (setOpen((v) => !v), setDone(""))} aria-expanded={open}>
            {open ? "Neu ordnen schließen" : "Plan neu ordnen"}
          </button>
        )}
        {embedded && done && <span className="no-ok">{done}</span>}
        {!open && <span className="no-faint">{done || "Rechnet eine bessere Reihenfolge aus. Laufende und fixierte Positionen bleiben, wo sie sind. Gespeichert wird erst beim Übernehmen."}</span>}
        {open && (
          <label className="no-check" title="Positionen verspäteter Aufträge dürfen auf eine andere Maschine. In Odoo wird der noch nicht begonnene Arbeitsplan dann mit umgestellt, wie beim Ziehen einer Karte.">
            <input type="checkbox" checked={wechseln} onChange={(ev) => setWechseln(ev.target.checked)} />
            auch Maschine wechseln
          </label>
        )}
      </div>
      {open && err && <div className="no-err">{err}</div>}
      {open && !data && !err && <div className="no-faint">Rechne …</div>}
      {open && data && !data.verbessert && (
        <div className="no-faint">
          Die jetzige Reihenfolge ist schon die beste, die die App findet ({plural(data.vorher.zuSpaet, "Auftrag", "Aufträge")} zu spät). Nichts zu übernehmen.
        </div>
      )}
      {open && data && data.verbessert && (
        <>
          <div className="no-sum">
            <b>
              Verspätete Aufträge: {data.vorher.zuSpaet} → {data.nachher.zuSpaet}
            </b>
            <span>
              Verspätungstage zusammen: {data.vorher.tage} → {data.nachher.tage}
            </span>
            {data.wechsel.length > 0 && <span>{plural(data.wechsel.length, "Position wechselt", "Positionen wechseln")} die Maschine</span>}
            <button type="button" className="btn sm primary" disabled={busy} onClick={apply}>
              {busy ? "Übernehme …" : "Übernehmen"}
            </button>
          </div>
          {data.auftraege.length > 0 && (
            <div className="no-list">
              <div className="no-h">Was sich für die Aufträge ändert</div>
              {data.auftraege.slice(0, 14).map((a) => (
                <div className="no-row" key={a.auftrag}>
                  <b>{a.auftrag}</b>
                  <span className="no-faint">LT {a.liefertermin ? fmtShort(a.liefertermin) : "–"}</span>
                  <span>
                    fertig {fmtShort(a.vorher)} → <b>{fmtShort(a.nachher)}</b>
                  </span>
                  <span className={a.statusNachher === "late" ? "no-late" : a.statusVorher === "late" ? "no-ok" : "no-faint"}>
                    {a.statusVorher === "late" && a.statusNachher !== "late" ? "jetzt pünktlich" : a.statusVorher !== "late" && a.statusNachher === "late" ? "wird zu spät" : a.tage < 0 ? `${-a.tage} T früher` : `${a.tage} T später`}
                  </span>
                </div>
              ))}
              {data.auftraege.length > 14 && <div className="no-faint">und {data.auftraege.length - 14} weitere</div>}
            </div>
          )}
          <div className="no-mach">
            {changed.map((m) => (
              <div className="no-m" key={m.id}>
                <div className="no-h">{m.name}</div>
                {m.items.map((x) => (
                  <div className={`no-item${x.vonMaschine ? " moved" : x.vonPlatz !== x.platz ? " shifted" : ""}`} key={x.id} title={[x.customer, x.due ? "Liefertermin " + full(x.due) : null].filter(Boolean).join(" · ")}>
                    <span className="no-p">{x.platz}.</span>
                    <span className="no-src">{x.source}</span>
                    <span className="no-faint">{x.ref !== x.source ? x.ref : ""}</span>
                    <span className="no-was">
                      {x.fixed ? (x.pinned ? "fixiert" : "läuft") : x.vonMaschine ? `von ${x.vonMaschine}` : x.vonPlatz !== x.platz ? `vorher ${x.vonPlatz}.` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
