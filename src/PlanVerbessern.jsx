import React from "react";
import Planvorschlag from "./Planvorschlag.jsx";
import Neuordnen from "./Neuordnen.jsx";

// "Plan verbessern": ein Knopf statt zwei. Darin
//   1. Neu einplanen: Vorschlag für die Positionen, die noch auf keiner Maschine stehen (mit Stunden)
//   2. Reihenfolge verbessern: bessere Reihenfolge der eingeplanten Positionen, laufende und fixierte bleiben stehen
// Gespeichert wird jeweils erst beim Übernehmen.

export default function PlanVerbessern({ open, onToggle, reloadKey, poolCount, onApply, onApplied, onOdoo }) {
  return (
    <div id="planverbessern" className="planverb">
      <div className="pvb-bar">
        <button type="button" className={`btn sm${open ? "" : " primary"}`} onClick={onToggle} aria-expanded={open}>
          {open ? "Plan verbessern schließen" : "Plan verbessern"}
        </button>
        {!open && <span className="pvb-faint">Plant neue Positionen ein und schlägt eine bessere Reihenfolge vor. Laufende und fixierte Positionen bleiben, wo sie sind. Gespeichert wird erst beim Übernehmen.</span>}
      </div>
      {open && (
        <div className="pvb-body">
          {poolCount > 0 ? <Planvorschlag embedded reloadKey={reloadKey} onApply={onApply} poolCount={poolCount} /> : <div className="pvb-faint">Neu einplanen: Alle Positionen stehen auf einer Maschine.</div>}
          <Neuordnen embedded reloadKey={reloadKey} onApplied={onApplied} onOdoo={onOdoo} />
        </div>
      )}
    </div>
  );
}
