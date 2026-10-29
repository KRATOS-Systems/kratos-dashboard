import React, { useCallback, useEffect, useState } from "react";
import { useToast } from "./ui.jsx";
import { useBdeSession, canOperate, fmtTime } from "./bdeLib.js";

// wie notifyChanged in MiniWindow.jsx (nicht importiert, sonst entsteht ein Kreis über Team.jsx)
const notifyChanged = () => window.dispatchEvent(new Event("bde-changed"));

// Arbeitsgänge fertig melden, Fertigungsauftrag abschließen, weiterer Arbeitsschritt und Programmlaufzeit je Aufspannung beim Fräsen.
// Ein Dialog für alles: nach dem Stopp eines Arbeitsgangs die Frage "… fertig?", beim Fräsen die Laufzeit je Aufspannung, nach der QS der
// Abschluss des Fertigungsauftrags, dazu ein weiterer Arbeitsschritt auf einer anderen Maschine und von der Maschinenzeile aus der Stand
// (welche Aufspannung hat welche Zeit, wer, wann, was ist offen).
// Aufgerufen wird er mit askLaufzeit({ mode, workorderId | productionId, ... }); gebucht wird über /api/bde/* (Server: server/bdeLaufzeit.js).
//   mode "stop"   nach dem Beenden des Fräsens (Pflichtfrage Ja/Nein, am Ende "Fräsen fertig melden")
//   mode "prog"   nach dem Stopp der Programmierung ("Programmierung fertig?" -> fertig melden -> Anzahl der Aufspannungen)
//   mode "fertig" nach dem Stopp von Rüsten oder QS ("… fertig?"); bei der QS danach "Fertigungsauftrag abschließen?"
//   mode "status" Stand ansehen und bei Bedarf eintragen

const EVENT = "bde-laufzeit";
export const askLaufzeit = (detail) => window.dispatchEvent(new CustomEvent(EVENT, { detail }));

// Nach dem Stopp einer eigenen Buchung: je nach Arbeitsschritt die passende Frage (Schritt kommt vom Server, am Namen des Arbeitsgangs)
export function afterStop(b) {
  if (!b || !b.workorderId) return;
  const base = { workorderId: b.workorderId, productionId: b.productionId, fa: b.fa, product: b.product, step: b.step };
  if (b.step === "Programmierung") askLaufzeit({ ...base, mode: "prog" });
  else if (b.step === "Fräsen") askLaufzeit({ ...base, mode: "stop" });
  else if (b.step === "Rüsten" || b.step === "QS") askLaufzeit({ ...base, mode: "fertig" });
}

const mmss = (min) => {
  const s = Math.round((min || 0) * 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const secOf = (min) => Math.round((min || 0) * 60);
const n2 = (v) => String(v).replace(".", ",");

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
  return d;
}

export default function LaufzeitHost() {
  const [req, setReq] = useState(null);
  useEffect(() => {
    const on = (e) => setReq({ ...e.detail, key: Date.now() });
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return req ? <LaufzeitDialog key={req.key} req={req} onClose={() => setReq(null)} /> : null;
}

function LaufzeitDialog({ req, onClose }) {
  const toast = useToast();
  const session = useBdeSession(0);
  const edit = canOperate(session);
  const [st, setSt] = useState(null);
  const [view, setView] = useState("loading"); // loading | progfertig | anzahl | frage | wahl | eingabe | warnung | fertig | status
  const [nr, setNr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [pending, setPending] = useState(null); // Eingabe, die auf die Bestätigung der Warnung wartet

  const [machines, setMachines] = useState([]);
  const [machineId, setMachineId] = useState(null);
  const [rueH, setRueH] = useState("");
  const [fraH, setFraH] = useState("");
  const [back, setBack] = useState("status");
  // Bei "prog" ist die Nummer die der Programmierung, die Laufzeit gehört aber zum Fräsen desselben Auftrags
  const ref = req.workorderId && req.mode !== "prog" ? { workorderId: req.workorderId } : { productionId: req.productionId };
  const productionId = (st && st.productionId) || req.productionId || null;

  // Eingabe
  const [mi, setMi] = useState("");
  const [se, setSe] = useState("");
  const [teile, setTeile] = useState(1);
  const [edited, setEdited] = useState(false); // eigene Zeit statt "unverändert"
  const [changed, setChanged] = useState(false); // Programm geändert

  const load = useCallback(async () => {
    const q = ref.workorderId ? `workorderId=${ref.workorderId}` : `productionId=${ref.productionId}`;
    return call("GET", `/api/bde/laufzeit?${q}`);
  }, [req]);

  // Start: Stand laden und entscheiden, was als Erstes gefragt wird
  useEffect(() => {
    let alive = true;
    if (req.mode === "fertig") {
      setView("fertigfrage"); // Rüsten und QS haben keine Laufzeit-Daten, nur die Frage
      return undefined;
    }
    load()
      .then((d) => {
        if (!alive) return;
        setSt(d);
        if (req.mode === "prog") setView(d.anzahl ? "close" : "progfertig");
        else if (req.mode === "stop") setView(!d.anzahl ? "anzahl" : d.complete ? "fertig" : "frage");
        else setView("status");
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e.message);
        setView("status");
      });
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (view === "close") onClose();
  }, [view, onClose]);

  // Nach der Auswahl der Aufspannung: Felder vorbelegen (vorhandene Zeile > Vorschlag vom früheren Auftrag > letzter Wert)
  function openInput(d, n) {
    const row = d.rows.find((r) => r.nr === n);
    const sug = d.suggestion && d.suggestion.rows.find((r) => r.nr === n);
    const last = d.rows.length ? d.rows[d.rows.length - 1].teile : null;
    const src = row || sug;
    setNr(n);
    setMi(src ? String(Math.floor(secOf(src.minutes) / 60)) : "");
    setSe(src ? String(secOf(src.minutes) % 60) : "");
    setTeile(row ? row.teile : sug ? sug.teile : last || 1);
    setEdited(!!row || !sug); // nur bei einem Vorschlag erst "unverändert" anbieten
    setChanged(row ? row.geaendert : false);
    setErr(null);
    setView("eingabe");
  }
  function pickAufspannung(d) {
    if (d.open.length === 1) return openInput(d, d.open[0]);
    setView("wahl");
  }

  async function run(fn) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const saveAnzahl = (n) =>
    run(async () => {
      const d = await call("POST", "/api/bde/laufzeit/anzahl", { ...ref, anzahl: n });
      setSt(d);
      notifyChanged();
      if (req.mode === "prog") {
        toast(`Fräsen: ${n} ${n === 1 ? "Aufspannung" : "Aufspannungen"} festgehalten`);
        onClose();
      } else if (req.mode === "stop") setView("frage");
      else setView("status");
    });

  const save = (payload, confirm = false) =>
    run(async () => {
      const d = await call("POST", "/api/bde/laufzeit/save", { ...ref, ...payload, confirm });
      if (d.needsConfirm) {
        setPending(payload);
        setErr(d.warning);
        setView("warnung");
        return;
      }
      setSt(d);
      setPending(null);
      notifyChanged();
      if (d.complete) setView("fertig");
      else if (req.mode === "stop") {
        toast(`Aufspannung ${payload.aufspannung} gespeichert · offen: ${d.open.join(", ")}`);
        onClose();
      } else setView("status");
    });

  function submitInput(unchanged) {
    const sug = st.suggestion && st.suggestion.rows.find((r) => r.nr === nr);
    if (unchanged && sug) return save({ aufspannung: nr, sekunden: secOf(sug.minutes), teile: sug.teile, uebernommen: true, geaendert: false });
    const sec = (parseInt(mi || "0", 10) || 0) * 60 + (parseInt(se || "0", 10) || 0);
    if (sec < 1) return setErr("Bitte die Programmlaufzeit eintragen (Minuten und Sekunden).");
    if ((parseInt(se || "0", 10) || 0) > 59) return setErr("Sekunden bitte von 0 bis 59.");
    return save({ aufspannung: nr, sekunden: sec, teile: Math.max(1, teile), geaendert: changed, uebernommen: false });
  }

  // Fräsen fertig melden; danach kann ein weiterer Arbeitsschritt auf einer anderen Maschine angehängt werden
  const finish = () =>
    run(async () => {
      const d = await call("POST", "/api/bde/fertig", { workorderId: st.workorderId });
      toast(`Fräsen ${st.fa || ""} fertig gemeldet`);
      notifyChanged();
      setView("nach");
    });

  // Programmierung fertig: Arbeitsgang fertig melden, dann die Anzahl der Aufspannungen festhalten
  const finishProg = () =>
    run(async () => {
      try {
        await call("POST", "/api/bde/fertig", { workorderId: req.workorderId });
        toast(`Programmierung ${req.fa || (st && st.fa) || ""} fertig gemeldet`);
        notifyChanged();
      } catch (e) {
        toast(e.message);
      }
      setView("anzahl");
    });

  // Rüsten oder QS fertig melden; bei der QS mit allen Arbeitsgängen fertig folgt der Abschluss des Fertigungsauftrags
  const finishStep = () =>
    run(async () => {
      const d = await call("POST", "/api/bde/fertig", { workorderId: req.workorderId });
      notifyChanged();
      const label = d.step === "QS" ? "Qualitätssicherung" : d.step;
      if (d.step === "QS" && d.production && d.production.allDone) {
        toast(`${label} fertig gemeldet`);
        setView("abschluss");
        return;
      }
      const offen = d.production ? d.production.steps.filter((x) => x.state !== "done") : [];
      toast(`${label} fertig gemeldet${d.step === "QS" && offen.length ? ` · noch offen: ${offen.map((x) => x.step).join(", ")}` : ""}`);
      onClose();
    });

  const closeProduction = () =>
    run(async () => {
      await call("POST", "/api/bde/auftrag/abschliessen", { productionId });
      toast(`Fertigungsauftrag ${req.fa || (st && st.fa) || ""} abgeschlossen`);
      notifyChanged();
      onClose();
    });

  // Weiterer Arbeitsschritt: Maschine wählen, Rüsten und Fräsen werden vor die QS gehängt
  const openSchritt = (from) =>
    run(async () => {
      const d = await call("GET", `/api/bde/schritt?productionId=${productionId}`);
      setMachines(d.machines || []);
      setMachineId(null);
      setBack(from);
      setView("schritt");
    });
  const hoursToMin = (v) => {
    const n = parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 0;
  };
  const addSchritt = () =>
    run(async () => {
      const d = await call("POST", "/api/bde/schritt", { productionId, machineId, ruestenMin: hoursToMin(rueH), fraesenMin: hoursToMin(fraH) });
      toast(`Rüsten und Fräsen auf ${d.machine} angelegt`);
      notifyChanged();
      onClose();
    });

  const head = st ? (
    <div className="lzhead">
      <b className="mono">{st.fa}</b>
      <span>{st.product}</span>
      <span className="mono">{n2(st.qty)} Stück</span>
      {st.machine && <span>{st.machine}</span>}
    </div>
  ) : req.fa ? (
    <div className="lzhead">
      <b className="mono">{req.fa}</b>
      <span>{req.product}</span>
    </div>
  ) : null;
  const errBox = err && view !== "warnung" ? <div className="lzerr">{err}</div> : null;
  const stopMode = req.mode === "stop";

  return (
    <div className="modal lz" role="dialog" aria-modal="true" aria-label="Programmlaufzeit je Aufspannung">
      <div className="dialog lzdlg">
        {view === "loading" && <p>Lade …</p>}

        {view === "fertigfrage" && (
          <>
            <h3>{req.step === "QS" ? "Qualitätssicherung" : req.step} fertig?</h3>
            {head}
            {errBox}
            <div className="lzbtns two">
              <button type="button" className="bbtn primary" disabled={busy || !edit} onClick={finishStep}>
                Ja
              </button>
              <button type="button" className="bbtn" onClick={onClose}>
                Nein
              </button>
            </div>
          </>
        )}

        {view === "abschluss" && (
          <>
            <h3>Fertigungsauftrag abschließen?</h3>
            {head}
            <p className="lzhint">Alle Arbeitsgänge sind fertig. Beim Abschließen bucht Odoo das Material ab und das fertige Teil ins Lager.</p>
            {errBox}
            <div className="lzbtns">
              <button type="button" className="bbtn primary" disabled={busy} onClick={closeProduction}>
                Fertigungsauftrag abschließen
              </button>
              <button type="button" className="bbtn" disabled={busy} onClick={() => openSchritt("abschluss")}>
                Weiterer Arbeitsschritt
              </button>
            </div>
            <div className="lzfoot">
              <button type="button" className="btn quiet" onClick={onClose}>
                Später
              </button>
            </div>
          </>
        )}

        {view === "nach" && st && (
          <>
            <h3>Fräsen fertig gemeldet</h3>
            {head}
            <p className="lzhint">Kommt noch ein weiterer Arbeitsschritt auf einer anderen Maschine dazu?</p>
            {errBox}
            <div className="lzbtns">
              <button type="button" className="bbtn primary" disabled={busy} onClick={() => openSchritt("nach")}>
                Weiterer Arbeitsschritt
              </button>
              <button type="button" className="bbtn" onClick={onClose}>
                Nein, fertig
              </button>
            </div>
          </>
        )}

        {view === "schritt" && (
          <>
            <h3>Weiterer Arbeitsschritt</h3>
            {head}
            <p className="lzhint">Rüsten und Fräsen auf einer weiteren Maschine. Sie werden vor die QS gehängt, der Fertigungsauftrag bleibt offen.</p>
            <div className="lzgrid">
              {machines.map((m) => (
                <button type="button" key={m.id} className={`bbtn big${machineId === m.id ? " sug" : ""}`} onClick={() => setMachineId(m.id)}>
                  {m.name}
                </button>
              ))}
            </div>
            {!machines.length && <p className="lzhint">Es gibt keine Maschine, für die Rüsten und Fräsen angelegt werden können.</p>}
            <div className="lztime">
              <label>
                Rüsten geplant (Std)
                <input inputMode="decimal" value={rueH} onChange={(e) => setRueH(e.target.value.replace(/[^0-9,.]/g, "").slice(0, 5))} placeholder="optional" />
              </label>
              <label>
                Fräsen geplant (Std)
                <input inputMode="decimal" value={fraH} onChange={(e) => setFraH(e.target.value.replace(/[^0-9,.]/g, "").slice(0, 5))} placeholder="optional" />
              </label>
            </div>
            {errBox}
            <div className="lzbtns">
              <button type="button" className="bbtn primary" disabled={busy || !machineId || !edit} onClick={addSchritt}>
                Anlegen
              </button>
            </div>
            <div className="lzfoot">
              <button type="button" className="btn quiet" onClick={() => setView(back)}>
                Zurück
              </button>
            </div>
          </>
        )}

        {view === "progfertig" && st && (
          <>
            <h3>Programmierung fertig?</h3>
            {head}
            <div className="lzbtns two">
              <button type="button" className="bbtn primary" disabled={busy} onClick={finishProg}>
                Ja
              </button>
              <button type="button" className="bbtn" onClick={onClose}>
                Nein
              </button>
            </div>
          </>
        )}

        {view === "anzahl" && st && (
          <>
            <h3>Wie viele Aufspannungen?</h3>
            {head}
            {st.suggestion && (
              <p className="lzhint">
                Beim letzten Mal ({st.suggestion.from}): {st.suggestion.anzahl}
              </p>
            )}
            <div className="lzgrid">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <button type="button" key={n} className={`bbtn big${st.suggestion && st.suggestion.anzahl === n ? " sug" : ""}`} disabled={busy} onClick={() => saveAnzahl(n)}>
                  {n}
                </button>
              ))}
            </div>
            <MoreCount busy={busy} onSave={saveAnzahl} />
            {errBox}
            <div className="lzfoot">
              {!stopMode && (
                <button type="button" className="btn quiet" onClick={onClose}>
                  Später
                </button>
              )}
            </div>
          </>
        )}

        {view === "frage" && st && (
          <>
            <h3>Aufspannung fertig?</h3>
            {head}
            <p className="lzhint">
              {st.anzahl} {st.anzahl === 1 ? "Aufspannung" : "Aufspannungen"} · offen: {st.open.join(", ")}
            </p>
            <div className="lzbtns two">
              <button type="button" className="bbtn primary" onClick={() => pickAufspannung(st)}>
                Ja
              </button>
              <button type="button" className="bbtn" onClick={onClose}>
                Nein
              </button>
            </div>
            <div className="lzfoot">
              <button type="button" className="btn quiet" onClick={() => setView("anzahl")}>
                Anzahl der Aufspannungen ändern
              </button>
            </div>
          </>
        )}

        {view === "wahl" && st && (
          <>
            <h3>Welche Aufspannung?</h3>
            {head}
            <div className="lzgrid">
              {Array.from({ length: st.anzahl }, (_, i) => i + 1).map((n) => {
                const row = st.rows.find((r) => r.nr === n);
                return (
                  <button type="button" key={n} className={`bbtn big${row ? " done" : n === st.open[0] ? " sug" : ""}`} onClick={() => openInput(st, n)}>
                    {n}
                    <small>{row ? `✓ ${mmss(row.minutes)}` : "offen"}</small>
                  </button>
                );
              })}
            </div>
            <div className="lzfoot">
              <button type="button" className="btn quiet" onClick={() => setView(stopMode ? "frage" : "status")}>
                Zurück
              </button>
            </div>
          </>
        )}

        {view === "eingabe" && st && (() => {
          const sug = st.suggestion && st.suggestion.rows.find((r) => r.nr === nr);
          const existing = st.rows.find((r) => r.nr === nr);
          return (
            <>
              <h3>
                Aufspannung {nr} von {st.anzahl}
              </h3>
              {head}
              {sug && !existing && !edited ? (
                <>
                  <div className="lzsug">
                    <span>Wie beim letzten Mal ({st.suggestion.from})</span>
                    <b className="mono">
                      {mmss(sug.minutes)} <small>für {sug.teile} {sug.teile === 1 ? "Teil" : "Teile"}</small>
                    </b>
                  </div>
                  <div className="lzbtns">
                    <button type="button" className="bbtn primary" disabled={busy} onClick={() => submitInput(true)}>
                      Laufzeit unverändert
                    </button>
                    <button
                      type="button"
                      className="bbtn"
                      onClick={() => {
                        setEdited(true);
                        setChanged(true);
                      }}
                    >
                      Andere Zeit eingeben
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="lzhint">Programmlaufzeit eines vollen Durchlaufs, wie die Steuerung sie anzeigt.</p>
                  <div className="lztime">
                    <label>
                      Minuten
                      <input inputMode="numeric" pattern="[0-9]*" autoFocus value={mi} onChange={(e) => setMi(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="0" />
                    </label>
                    <span className="lzcolon">:</span>
                    <label>
                      Sekunden
                      <input inputMode="numeric" pattern="[0-9]*" value={se} onChange={(e) => setSe(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="00" />
                    </label>
                  </div>
                  <div className="lzteile">
                    <span>Teile in dieser Aufspannung</span>
                    <div className="lzstep">
                      <button type="button" className="bbtn" onClick={() => setTeile((t) => Math.max(1, t - 1))} aria-label="Weniger">
                        −
                      </button>
                      <b className="mono">{teile}</b>
                      <button type="button" className="bbtn" onClick={() => setTeile((t) => t + 1)} aria-label="Mehr">
                        +
                      </button>
                    </div>
                  </div>
                  {(mi || se) && teile > 0 && (
                    <p className="lzhint">
                      Je Stück: <b className="mono">{mmss(((parseInt(mi || "0", 10) || 0) * 60 + (parseInt(se || "0", 10) || 0)) / 60 / teile)}</b>
                    </p>
                  )}
                  {(sug || existing) && (
                    <label className="chk">
                      <input type="checkbox" checked={changed} onChange={(e) => setChanged(e.target.checked)} />
                      Programm wurde geändert
                    </label>
                  )}
                  <div className="lzbtns">
                    <button type="button" className="bbtn primary" disabled={busy} onClick={() => submitInput(false)}>
                      Speichern
                    </button>
                  </div>
                </>
              )}
              {errBox}
              <div className="lzfoot">
                <button type="button" className="btn quiet" onClick={() => (st.anzahl > 1 ? setView("wahl") : stopMode ? setView("frage") : setView("status"))}>
                  Zurück
                </button>
              </div>
            </>
          );
        })()}

        {view === "warnung" && (
          <>
            <h3>Stimmt die Zeit?</h3>
            <div className="lzwarn">{err}</div>
            <div className="lzbtns two">
              <button
                type="button"
                className="bbtn primary"
                onClick={() => {
                  setErr(null);
                  setView("eingabe");
                }}
              >
                Korrigieren
              </button>
              <button type="button" className="bbtn" disabled={busy} onClick={() => save(pending, true)}>
                Trotzdem speichern
              </button>
            </div>
          </>
        )}

        {view === "fertig" && st && (
          <>
            <h3>Alle Aufspannungen erfasst</h3>
            {head}
            <p className="lzhint">
              Laufzeit je Stück gesamt: <b className="mono">{mmss(st.sumPerPiece)}</b> Min:Sek
            </p>
            {edit && st.state !== "done" && (
              <div className="lzbtns">
                <button type="button" className="bbtn primary" disabled={busy} onClick={finish}>
                  Fräsen fertig melden
                </button>
              </div>
            )}
            {errBox}
            <div className="lzfoot">
              <button type="button" className="btn quiet" onClick={() => setView("status")}>
                Übersicht
              </button>
              <button type="button" className="btn quiet" onClick={onClose}>
                Später
              </button>
            </div>
          </>
        )}

        {view === "status" && (
          <>
            <h3>Programmlaufzeiten</h3>
            {head}
            {!st && errBox}
            {st && (
              <>
                {!st.anzahl ? (
                  <p className="lzhint">Die Anzahl der Aufspannungen ist noch nicht festgehalten.</p>
                ) : (
                  <table className="lztable">
                    <thead>
                      <tr>
                        <th>Aufsp.</th>
                        <th>Laufzeit</th>
                        <th>Teile</th>
                        <th>je Stück</th>
                        <th>Wer, wann</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: st.anzahl }, (_, i) => i + 1).map((n) => {
                        const r = st.rows.find((x) => x.nr === n);
                        return r ? (
                          <tr key={n}>
                            <td>{n}</td>
                            <td className="mono">{mmss(r.minutes)}</td>
                            <td className="mono">{r.teile}</td>
                            <td className="mono">{mmss(r.perPiece)}</td>
                            <td>
                              {r.who || "–"}
                              {r.at ? `, ${new Date(r.at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" })} ${fmtTime(r.at)}` : ""}
                              {r.uebernommen && <span className="lztag">unverändert</span>}
                              {r.geaendert && <span className="lztag chg">Programm geändert</span>}
                            </td>
                          </tr>
                        ) : (
                          <tr key={n} className="open">
                            <td>{n}</td>
                            <td colSpan={4}>offen</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {st.complete && (
                  <p className="lzhint">
                    Laufzeit je Stück gesamt: <b className="mono">{mmss(st.sumPerPiece)}</b>
                  </p>
                )}
                {errBox}
                {edit && st.state !== "done" && (
                  <div className="lzbtns">
                    {st.anzahl > 0 && (
                      <button type="button" className="bbtn primary" onClick={() => (st.open.length === 1 ? openInput(st, st.open[0]) : setView("wahl"))}>
                        Laufzeit eintragen
                      </button>
                    )}
                    <button type="button" className="bbtn" onClick={() => setView("anzahl")}>
                      {st.anzahl ? "Anzahl ändern" : "Anzahl festhalten"}
                    </button>
                    {st.complete && (
                      <button type="button" className="bbtn" disabled={busy} onClick={finish}>
                        Fräsen fertig melden
                      </button>
                    )}
                    <button type="button" className="bbtn" disabled={busy} onClick={() => openSchritt("status")}>
                      Weiterer Arbeitsschritt
                    </button>
                  </div>
                )}
              </>
            )}
            <div className="lzfoot">
              <button type="button" className="btn" onClick={onClose}>
                Schließen
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Liste auf Mein Arbeitsplatz: eigene Arbeitsgänge, die gestoppt, aber noch nicht fertig gemeldet sind. Fängt auf, was der Dialog nicht erreicht hat
// (Beenden am Kiosk, weggeklickte Frage). Beim Fräsen steht dabei, wie viele Laufzeiten fehlen. Ohne offene Arbeitsgänge erscheint nichts.
export function LaufzeitOffen({ refreshKey }) {
  const [items, setItems] = useState([]);
  const load = useCallback(() => {
    call("GET", "/api/bde/offen")
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("bde-changed", load);
    return () => window.removeEventListener("bde-changed", load);
  }, [load, refreshKey]);
  if (!items.length) return null;
  const open = (i) => {
    const base = { workorderId: i.workorderId, productionId: i.productionId, fa: i.fa, product: i.product, step: i.step };
    if (i.step === "Fräsen") askLaufzeit({ ...base, mode: "stop" });
    else if (i.step === "Programmierung") askLaufzeit({ ...base, mode: "prog" });
    else askLaufzeit({ ...base, mode: "fertig" });
  };
  return (
    <section className="bsec lzoffen">
      <h2>
        Noch nicht fertig gemeldet <span className="cntb">{items.length}</span>
      </h2>
      <div className="brecent">
        {items.map((i) => (
          <div className="card brow" key={i.workorderId}>
            <span className="bact">{i.step === "QS" ? "QS" : i.step}</span>
            <b className="mono">{i.fa}</b>
            <span className="t">{i.product}</span>
            <span className="when">
              {i.step === "Fräsen" ? (i.anzahl ? `${i.erfasst} von ${i.anzahl} Aufspannungen erfasst` : "Anzahl der Aufspannungen fehlt") : "gestoppt"}
              {i.step === "Fräsen" && i.machine ? ` · ${i.machine}` : ""}
            </span>
            <button type="button" className="btn sm" onClick={() => open(i)}>
              {i.step === "Fräsen" && !(i.anzahl && i.erfasst >= i.anzahl) ? "Eintragen" : "Fertig melden"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// Mehr als sechs Aufspannungen: Zahl eintippen
function MoreCount({ busy, onSave }) {
  const [v, setV] = useState("");
  return (
    <div className="lzmore">
      <label>
        Mehr
        <input inputMode="numeric" pattern="[0-9]*" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="7 …" />
      </label>
      <button type="button" className="bbtn" disabled={busy || !Number(v)} onClick={() => onSave(Number(v))}>
        Übernehmen
      </button>
    </div>
  );
}
