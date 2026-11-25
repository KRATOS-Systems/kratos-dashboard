import React, { Suspense, lazy, useEffect, useState } from "react";
import { Ico, docsKey } from "./ui.jsx";
import { avState, qsArtikelUrl } from "./avLib.js";

// QS-Prüfung im Fenster einer Position in der Spur QS (server/qsPruefung.js).
// Prüfart aus der AV: Punkt „Prüfplan“ = nicht nötig -> Sichtprüfung hier in der App, sonst Messprüfung im QS CHECK.
// Oben Zeichnung und 3D (vom Artikel, auch bei Fremdfertigung), daneben die Vorgaben aus dem Kundenauftrag.
// Ergebnis: alles i.O. / teilweise i.O. (gute Menge geht weiter) / nicht i.O. (bleibt in der QS, Nacharbeit möglich).

const FileThumbs = lazy(() => import("./PartDocs.jsx").then((m) => ({ default: m.FileThumbs })));
const CHECKS = [
  ["menge", "Menge gezählt"],
  ["oberflaeche", "Oberfläche und Grat"],
  ["gewinde", "Gewinde und Bohrungen"],
  ["beschriftung", "Beschriftung und Verpackung"],
];
const ERG = { io: "i.O.", teil: "teilweise i.O.", nio: "nicht i.O." };
const fmtN = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("de-DE");

export default function QsPruefung({ o, checks, pruefer: pruefer0, people = [], onFertig }) {
  const planNoetig = avState(checks, o.id, "pruefplan").status !== "entfaellt";
  const [art, setArt] = useState(planNoetig ? "mess" : "sicht");
  const [d, setD] = useState(null);
  const [haken, setHaken] = useState([]);
  const [modus, setModus] = useState(null); // null | "teil" | "nio"
  const [gut, setGut] = useState("");
  const [grund, setGrund] = useState("");
  const [pruefer, setPruefer] = useState(pruefer0 || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    setArt(planNoetig ? "mess" : "sicht");
    setHaken([]);
    setModus(null);
    setGut("");
    setGrund("");
    setErr("");
    let stop = false;
    fetch(`/api/qs/${o.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => !stop && setD(j))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [o.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function speichern(ergebnis) {
    setErr("");
    if (ergebnis !== "io" && !grund.trim()) return setErr("Bitte kurz den Grund angeben.");
    if (ergebnis === "teil" && !(Number(gut) > 0 && Number(gut) < (o.quantity || 0))) return setErr(`Gute Menge zwischen 1 und ${fmtN((o.quantity || 0) - 1)} angeben.`);
    setBusy(true);
    try {
      const r = await fetch(`/api/qs/${o.id}/ergebnis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ art, ergebnis, gut: ergebnis === "teil" ? Number(gut) : undefined, grund, checks: haken, pruefer }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Speichern hat nicht geklappt");
      onFertig && onFertig({ ergebnis, neueId: j.neueId, notiz: j.notiz });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const v = d && d.vorgaben;
  const qsUrl = qsArtikelUrl(o);
  const alleHaken = haken.length === CHECKS.length;
  return (
    <div className="qsp">
      <div className="qsp-art">
        <span className={`pill ${art === "sicht" ? "ok" : "warn"}`}>{art === "sicht" ? "Sichtprüfung" : "Messprüfung im QS CHECK"}</span>
        <span className="fg-faint">{planNoetig ? "laut AV: Prüfplan nötig" : "laut AV: kein Prüfplan nötig"}</span>
        <button type="button" className="btn quiet sm" onClick={() => setArt(art === "sicht" ? "mess" : "sicht")}>
          {art === "sicht" ? "Doch genau messen" : "Nur Sichtprüfung"}
        </button>
      </div>

      {docsKey(o) ? (
        <Suspense fallback={<div className="fg-faint">Zeichnung wird geladen …</div>}>
          <FileThumbs o={o} />
        </Suspense>
      ) : (
        <div className="fg-faint">Keine Zeichnung verknüpft: Die Position hat keinen Fertigungsauftrag und keine Bestellung in Odoo.</div>
      )}

      {v && (v.zeile || v.notiz || v.bestellung) && (
        <div className="qsp-vorgaben">
          <b>Vorgaben aus dem Kundenauftrag{v.kunde ? ` · ${v.kunde}` : ""}</b>
          {v.bestellung && <div>Bestellnummer des Kunden: {v.bestellung}</div>}
          {v.zeile && <div className="qsp-zeile">{v.zeile}</div>}
          {v.menge != null && (
            <div>
              Bestellt: {fmtN(v.menge)} Stück{o.quantity != null && Number(o.quantity) !== Number(v.menge) ? ` · diese Position: ${fmtN(o.quantity)} Stück` : ""}
            </div>
          )}
          {v.notiz && <div className="fg-faint">{v.notiz}</div>}
        </div>
      )}

      {art === "mess" ? (
        <div className="qsp-mess">
          <a className="btn" href={qsUrl} target="_blank" rel="noopener noreferrer">
            Im QS CHECK prüfen <Ico n="ext" s={14} />
          </a>
          <span className="fg-faint">Dort mit Prüfplan und Messwerten prüfen, danach hier das Ergebnis eintragen.</span>
        </div>
      ) : (
        <div className="qsp-checks">
          {CHECKS.map(([id, label]) => (
            <label key={id} className="chkline">
              <input type="checkbox" checked={haken.includes(id)} onChange={(e) => setHaken(e.target.checked ? [...haken, id] : haken.filter((x) => x !== id))} />
              {label}
            </label>
          ))}
        </div>
      )}

      <div className="qsp-pruefer">
        <label className="f" style={{ maxWidth: 260 }}>
          Geprüft von
          <select value={pruefer} onChange={(e) => setPruefer(e.target.value)}>
            <option value="">– bitte wählen –</option>
            {[...new Set([pruefer0, ...people].filter(Boolean))].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {modus && (
        <div className="qsp-detail">
          {modus === "teil" && (
            <label className="f" style={{ maxWidth: 200 }}>
              Gute Menge (von {fmtN(o.quantity)})
              <input type="number" min={1} max={(o.quantity || 1) - 1} step="1" value={gut} onChange={(e) => setGut(e.target.value)} autoFocus />
            </label>
          )}
          <label className="f">
            Grund
            <input type="text" maxLength={500} placeholder={modus === "teil" ? "z. B. 2 Stück Gewinde nicht i.O." : "z. B. Maß 12,5 außerhalb der Toleranz"} value={grund} onChange={(e) => setGrund(e.target.value)} autoFocus={modus === "nio"} />
          </label>
        </div>
      )}

      {err && <div className="qsp-err">{err}</div>}

      <div className="qsp-knoepfe">
        {!modus ? (
          <>
            <button type="button" className="btn primary" disabled={busy || !pruefer} onClick={() => speichern("io")} title={!pruefer ? "Erst „Geprüft von“ wählen" : art === "sicht" && !alleHaken ? "Nicht alle Punkte abgehakt – trotzdem i.O. melden" : "Alles in Ordnung: geht weiter"}>
              <Ico n="check" s={15} />
              Alles i.O.
            </button>
            <button type="button" className="btn" disabled={busy || !(o.quantity > 1)} onClick={() => setModus("teil")} title={o.quantity > 1 ? "Ein Teil ist gut und geht weiter, der Rest bleibt in der QS" : "Nur bei mehr als 1 Stück"}>
              Teilweise i.O.
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => setModus("nio")}>
              Nicht i.O.
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary" disabled={busy || !pruefer} onClick={() => speichern(modus)}>
              {modus === "teil" ? "Speichern: gute Menge geht weiter" : "Speichern: bleibt in der QS"}
            </button>
            <button type="button" className="btn quiet" onClick={() => (setModus(null), setErr(""))}>
              Abbrechen
            </button>
          </>
        )}
      </div>
      {!pruefer && <div className="fg-faint" style={{ fontSize: 13 }}>Erst „Geprüft von“ wählen, dann das Ergebnis.</div>}

      {d && d.verlauf && d.verlauf.length > 0 && (
        <ul className="qsp-verlauf">
          {d.verlauf.map((x, i) => (
            <li key={i}>
              {new Date(x.am).toLocaleDateString("de-DE")} · {x.art === "sicht" ? "Sichtprüfung" : "Messprüfung"}: <b>{ERG[x.ergebnis]}</b>
              {x.ergebnis === "teil" ? ` (${fmtN(x.gut)} gut)` : ""}
              {x.grund ? ` · ${x.grund}` : ""}
              {x.pruefer ? ` · ${x.pruefer}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
