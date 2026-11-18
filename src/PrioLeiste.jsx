import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Leiste „Prioritäten diese Woche“: ganz oben auf der Planung und bei „Mein Arbeitsplatz“.
// Zeigt die Prio-Aufträge mit Kunde, Termin, Positionen (wo sie gerade stehen) und was in der AV noch offen ist (rote Zeile).
// Setzen und wegnehmen nur die Leitung; der Schalter schiebt den Plan nicht um. Daten: GET /api/prio (server/prio.js).

export async function prioSetzen(auftrag, an, grund = "") {
  const r = await fetch(an ? "/api/prio" : "/api/prio/aus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auftrag, grund }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Prio nicht gespeichert");
  return j;
}

// Eigene Daten laden (für „Mein Arbeitsplatz“) oder von außen bekommen (Planung, damit Karten und Knopf dieselben Daten nutzen)
export function usePrio(reloadKey) {
  const [d, setD] = useState(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let stop = false;
    fetch("/api/prio")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => !stop && j && setD(j))
      .catch(() => {});
    const iv = setInterval(() => setN((x) => x + 1), 5 * 60 * 1000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [reloadKey, n]);
  return [d, setD];
}

const tage = (n) => `${n} ${n === 1 ? "Tag" : "Tage"}`;

export default function PrioLeiste({ data, setData, spaet, onOpen, meineMaschinen, toast }) {
  const [busy, setBusy] = useState(null);
  if (!data || !data.items || !data.items.length) return null;
  const darf = !!data.darf;
  const act = async (auftrag, fn) => {
    setBusy(auftrag);
    try {
      const j = await fn();
      setData && setData((prev) => ({ ...prev, ...j }));
    } catch (e) {
      toast ? toast(e.message) : console.error(e);
    } finally {
      setBusy(null);
    }
  };
  const bestaetigen = (auftrag) =>
    act(auftrag, () =>
      fetch("/api/prio/bestaetigen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auftrag }) }).then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Nicht gespeichert");
        return j;
      })
    );

  return (
    <div id="prio" className="prio-leiste card rise" style={{ "--i": 0 }}>
      <div className="pr-top">
        <b>Prioritäten diese Woche</b>
        <span className="pr-n">{data.items.length}</span>
        <small>Diese Aufträge zuerst. Die Reihenfolge im Plan ändert Prio nicht von selbst.</small>
      </div>
      {data.viele && (
        <div className="pr-viele">Mehr als {data.grenze || 5} Prio-Aufträge – wenn alles Prio ist, ist nichts Prio. Lieber ein paar wieder rausnehmen.</div>
      )}
      <div className="pr-list">
        {data.items.map((p) => {
          const late = spaet ? spaet[p.auftrag] : null;
          const avOffen = p.positionen.filter((x) => x.avOffen.length);
          return (
            <div key={p.auftrag} className={`pr-row${late > 0 ? " late" : ""}`}>
              <div className="pr-head">
                <span className="prio-badge">Prio</span>
                <b className="pr-auf">{p.label}</b>
                {p.kunde && <span className="pr-kunde">{p.kunde}</span>}
                {p.termin && <span className="pr-termin">Termin {fmtShort(p.termin)}</span>}
                {late > 0 && <em className="tag bad">{tage(late)} zu spät</em>}
                {late === 0 && <em className="tag ok">im Plan</em>}
                {p.grund && <span className="pr-grund">„{p.grund}“</span>}
                {darf && (
                  <button type="button" className="pr-aus" disabled={busy === p.auftrag} onClick={() => act(p.auftrag, () => prioSetzen(p.auftrag, false))} title="Prio für diesen Auftrag wegnehmen">
                    Prio aus
                  </button>
                )}
              </div>
              <div className="pr-pos">
                {p.positionen.map((x) => (
                  <button
                    type="button"
                    key={x.id}
                    className={`pr-chip${meineMaschinen && meineMaschinen.includes(x.machine) ? " mine" : ""}${x.machine ? "" : " pool"}`}
                    onClick={() => onOpen && onOpen(x.id)}
                    disabled={!onOpen}
                    title={[x.product, x.hours ? `${x.hours} h` : "ohne Stunden", x.due_date ? `Termin ${fmtShort(x.due_date)}` : ""].filter(Boolean).join(" · ")}
                  >
                    {x.ref} · {x.ort}
                  </button>
                ))}
                {p.ohnePositionen && <span className="pr-hint">Keine Positionen in der Planung gefunden.</span>}
              </div>
              {avOffen.length > 0 && (
                <div className="pr-av">
                  AV noch offen: {avOffen.map((x) => `${x.ref} ${x.avOffen.join(", ")}`).join(" · ")}
                </div>
              )}
              {p.nachfragen && darf && (
                <div className="pr-frage">
                  Seit über 7 Tagen Prio. Noch Prio?
                  <button type="button" className="btn sm" disabled={busy === p.auftrag} onClick={() => bestaetigen(p.auftrag)}>
                    Ja, bleibt
                  </button>
                  <button type="button" className="btn sm" disabled={busy === p.auftrag} onClick={() => act(p.auftrag, () => prioSetzen(p.auftrag, false))}>
                    Nein, raus
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
