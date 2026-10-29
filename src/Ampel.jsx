import React, { useCallback, useEffect, useState } from "react";
import { MACHINES } from "./lib.js";
import { useToast } from "./ui.jsx";
import { useBdeSession, canOperate, act, since, useNow, toLocalInput, fromLocalInput } from "./bdeLib.js";
import { afterStop } from "./Laufzeit.jsx";

// Maschinenampel wie eine Signalleuchte an der Maschine (Daten: /api/maschinen/ampel, Server: server/bdeAmpel.js).
//   grün = Fräsen läuft, gelb = es wird gerüstet, rot = nichts läuft, obwohl Arbeitszeit ist und Arbeit wartet, keine Lampe = nichts zu tun.
// Ein Klick zeigt, was läuft und wer es gestartet hat, und lässt es beenden (Maschinenläufe darf jeder angemeldete Mitarbeiter beenden).

const notifyChanged = () => window.dispatchEvent(new Event("bde-changed"));

// gemeinsamer Stand für alle Ampeln auf der Seite, alle 60 Sekunden und nach jeder Buchung neu
let current = null;
const listeners = new Set();
let timer = null;
async function fetchAmpel(fresh) {
  try {
    const r = await fetch(`/api/maschinen/ampel${fresh ? "?fresh=1" : ""}`);
    if (!r.ok) return;
    current = await r.json();
    listeners.forEach((l) => l(current));
  } catch {
    /* ohne Verbindung bleibt der letzte Stand stehen */
  }
}
function useAmpel() {
  const [d, setD] = useState(current);
  useEffect(() => {
    listeners.add(setD);
    if (!current) fetchAmpel();
    else setD(current);
    if (!timer) timer = setInterval(() => fetchAmpel(), 60000);
    const on = () => fetchAmpel(true);
    window.addEventListener("bde-changed", on);
    return () => {
      listeners.delete(setD);
      window.removeEventListener("bde-changed", on);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return d;
}

const TEXT = { lauf: "Fräsen läuft", ruesten: "Wird gerüstet", steht: "Steht", frei: "Nichts zu tun" };
const LAMP = { steht: "r", ruesten: "y", lauf: "g" };

// Die Leuchte: rot oben, gelb in der Mitte, grün unten, nur die aktive Lampe leuchtet
export function Tower({ state, size = 1 }) {
  const lit = LAMP[state];
  return (
    <svg className={`amp-tower amp-${state || "frei"}`} viewBox="0 0 24 64" width={24 * size} height={64 * size} aria-hidden="true">
      <rect className="amp-pole" x="10" y="56" width="4" height="8" />
      <rect className="amp-body" x="2.5" y="1.5" width="19" height="57" rx="6" />
      {[["r", 14], ["y", 31], ["g", 48]].map(([k, cy]) => (
        <circle key={k} className={`amp-lamp amp-${k}${lit === k ? " on" : ""}`} cx="12" cy={cy} r="6" />
      ))}
    </svg>
  );
}

const stateLine = (m) => {
  if (!m) return "";
  const first = m.runs.find((r) => r.step === "Fräsen") || m.runs[0];
  if (!first || m.state === "steht" || m.state === "frei") return TEXT[m.state];
  return `${TEXT[m.state]} · ${first.fa || ""}${first.who ? ` · ${first.who}` : ""}`;
};

// Kleine Ampel im Maschinenkopf der Planung
export function Ampel({ machine }) {
  const d = useAmpel();
  const [open, setOpen] = useState(false);
  const m = d && d.machines && d.machines[machine];
  if (!m) return null;
  const name = (MACHINES.find((x) => x.id === machine) || {}).short || machine;
  return (
    <>
      <button type="button" className="amp-btn" title={`${name}: ${stateLine(m)}`} aria-label={`${name}: ${stateLine(m)}`} onClick={() => setOpen(true)}>
        <Tower state={m.state} size={0.7} />
      </button>
      {open && <AmpelDialog machine={machine} onClose={() => setOpen(false)} />}
    </>
  );
}

// Leiste mit allen vier Maschinen (Team und Mein Arbeitsplatz)
export function AmpelLeiste() {
  const d = useAmpel();
  const [open, setOpen] = useState(null);
  if (!d || !d.machines) return null;
  return (
    <section className="amp-leiste" aria-label="Maschinen">
      {MACHINES.map((mm) => {
        const m = d.machines[mm.id];
        if (!m) return null;
        return (
          <button type="button" key={mm.id} className={`amp-card card amp-s-${m.state}`} onClick={() => setOpen(mm.id)}>
            <Tower state={m.state} size={0.8} />
            <span className="amp-txt">
              <b>{mm.short}</b>
              <small>{stateLine(m)}</small>
            </span>
          </button>
        );
      })}
      {d.unknown && d.unknown.length > 0 && <span className="amp-unk">Läuft ohne bekannte Maschine: {d.unknown.map((r) => r.fa).join(", ")}</span>}
      {open && <AmpelDialog machine={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function AmpelDialog({ machine, onClose }) {
  const d = useAmpel();
  const toast = useToast();
  const session = useBdeSession(0);
  const now = useNow(30000);
  const [stop, setStop] = useState(null); // Lauf, der gerade beendet wird
  const [when, setWhen] = useState(() => toLocalInput(Date.now()));
  const [busy, setBusy] = useState(false);
  const m = d && d.machines && d.machines[machine];
  const mm = MACHINES.find((x) => x.id === machine) || { name: machine, short: machine };
  const operate = canOperate(session);

  const go = useCallback(
    async (run, endAt) => {
      setBusy(true);
      try {
        const own = session && session.id === run.employeeId;
        await act({ action: "stop", workorderId: run.workorderId, employeeId: own ? undefined : run.employeeId, endAt });
        toast(`${run.step} ${run.fa || ""} beendet`);
        notifyChanged();
        setStop(null);
        // Eigenes Fräsen beendet: die Frage nach den Aufspannungen
        if (own) afterStop({ workorderId: run.workorderId, productionId: run.productionId, fa: run.fa, step: run.step });
      } catch (err) {
        toast(err.message);
      } finally {
        setBusy(false);
      }
    },
    [session, toast]
  );

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog amp-dlg" role="dialog" aria-modal="true" aria-label={`${mm.name}: Maschinenampel`}>
        <div className="amp-dlg-head">
          <Tower state={m ? m.state : "frei"} size={1.1} />
          <div>
            <h3>{mm.name}</h3>
            <p>{m ? TEXT[m.state] : "Lade …"}</p>
          </div>
        </div>
        {m && m.runs.length === 0 && (
          <p className="amp-hint">
            {m.state === "steht" ? "Es ist nichts gestempelt, obwohl Arbeitszeit ist und in der Planung noch Arbeit für diese Maschine wartet." : "Es läuft nichts, und es ist auch nichts zu tun oder keine Arbeitszeit."}
          </p>
        )}
        {m &&
          m.runs.map((r) => {
            const own = session && session.id === r.employeeId;
            const mayStop = operate && r.workorderId && (r.step === "Fräsen" || own || (session && session.leitung));
            return (
              <div className="amp-run" key={`${r.workorderId}-${r.employeeId}`}>
                <div>
                  <b>{r.step}</b> <span className="mono">{r.fa}</span>
                  <small>
                    {r.who || "unbekannt"}, {r.start ? since(r.start, now) : "Start unbekannt"}
                  </small>
                </div>
                {mayStop && stop !== r.workorderId && (
                  <button type="button" className="btn sm" disabled={busy} onClick={() => (setWhen(toLocalInput(Date.now())), setStop(r.workorderId))}>
                    Beenden
                  </button>
                )}
                {mayStop && stop === r.workorderId && (
                  <div className="mstop">
                    <button type="button" className="bbtn" disabled={busy} onClick={() => go(r, null)}>
                      Jetzt beenden
                    </button>
                    {r.step === "Fräsen" && r.start && (
                      <div className="mstop-at">
                        <label className="f">
                          Maschine war fertig um
                          <input type="datetime-local" value={when} min={toLocalInput(r.start)} max={toLocalInput(Date.now())} onChange={(e) => setWhen(e.target.value)} />
                        </label>
                        <button type="button" className="bbtn" disabled={busy || !when} onClick={() => go(r, fromLocalInput(when))}>
                          Mit dieser Zeit beenden
                        </button>
                      </div>
                    )}
                    <button type="button" className="btn quiet" onClick={() => setStop(null)}>
                      Abbrechen
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        {!operate && m && m.runs.length > 0 && <p className="amp-hint">Zum Beenden bitte mit PIN anmelden (Mein Arbeitsplatz).</p>}
        <div className="actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
