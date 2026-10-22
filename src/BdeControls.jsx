import React from "react";
import { Ico } from "./ui.jsx";

// Die Bedienknöpfe der Zeiterfassung als bekannte Symbole mit Farbakzent:
// ⇄ Wechseln (neutral), ▶ Weiter (grün), ⏸ Unterbrechen (gelb), ■ Stopp (rot). Der Text steht klein darunter.
export function ActButtons({ running, busy, onSwitch, onPause, onResume, onStop, resumeLabel, compact }) {
  return (
    <div className={`actbtns${compact ? " compact" : ""}`}>
      <button type="button" className="actbtn swap" disabled={busy} onClick={onSwitch} title="Auf eine andere Tätigkeit wechseln">
        <Ico n="swap" s={compact ? 20 : 26} />
        <span>Wechseln</span>
      </button>
      {running ? (
        <button type="button" className="actbtn pause" disabled={busy} onClick={onPause} title="Unterbrechen (Weiter setzt sie fort)">
          <Ico n="pause" s={compact ? 20 : 26} />
          <span>Pause</span>
        </button>
      ) : (
        <button type="button" className="actbtn play" disabled={busy} onClick={onResume} title={resumeLabel ? `Weiter: ${resumeLabel}` : "Die letzte Tätigkeit fortsetzen"}>
          <Ico n="play" s={compact ? 20 : 26} />
          <span>Weiter</span>
        </button>
      )}
      <button type="button" className="actbtn stop" disabled={busy || !running} onClick={onStop} title="Tätigkeit beenden">
        <Ico n="stop" s={compact ? 20 : 26} />
        <span>Stopp</span>
      </button>
    </div>
  );
}

// Auftrag zur Tätigkeit: FA-Nummer und, falls bekannt, die Auftragsnummer aus dem Verkauf (A-Nummer)
export function JobRef({ fa, order }) {
  return (
    <span className="jobref">
      <b className="mono">{fa}</b>
      {order && <span className="mono ord">{order}</span>}
    </span>
  );
}
