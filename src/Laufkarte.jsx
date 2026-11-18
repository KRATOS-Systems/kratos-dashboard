import React from "react";

// Laufkarte eines Auftrags (Schritt 4): acht Schritte von „Auftrag da“ bis „QS · Extern · Lieferung“, berechnet in ablauf.js.
// Der aktuelle Schritt (gelb) hat einen Knopf, der dorthin springt, wo man ihn erledigt.

const ACTION = { zeiten: "Zur AV", material: "Zur AV", fa: "Zur AV", plan: "Einplanen", av: "Zur AV", fertigung: "Im Zeitstrahl", qs: "Ansehen" };
const ICON = { done: "✓", now: "!", open: "·" };

export function AblaufBar({ steps, title }) {
  return (
    <span className="ab-bar" title={title || steps.map((s) => `${s.state === "done" ? "✓" : s.state === "now" ? "→" : "·"} ${s.label}`).join("\n")} aria-label={`${steps.filter((s) => s.state === "done").length} von ${steps.length} Schritten erledigt`}>
      {steps.map((s) => (
        <i key={s.id} className={`ab-seg ${s.state}${s.id === "fertigung" && s.running ? " run" : ""}`} />
      ))}
    </span>
  );
}

export default function Laufkarte({ ablauf, onAction }) {
  if (!ablauf) return null;
  return (
    <ol className="laufkarte">
      {ablauf.steps.map((s) => (
        <li key={s.id} className={`lk-step ${s.state}${s.id === "fertigung" && s.running ? " run" : ""}`}>
          <span className="lk-ic" aria-hidden="true">{ICON[s.state]}</span>
          <div className="lk-t">
            <b>{s.label}</b>
            {s.detail && <small>{s.detail}</small>}
          </div>
          {s.state === "now" && ACTION[s.id] && onAction && (
            <button type="button" className="btn sm" onClick={() => onAction(s)}>
              {ACTION[s.id]}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
