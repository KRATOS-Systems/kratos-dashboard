import React, { useState } from "react";
import { ODOO_CENTER, STATE_LABEL, deviation, fixInOdoo } from "./arbeitsplan.js";
import { MACHINES } from "./lib.js";
import { useToast } from "./ui.jsx";

// Arbeitsplan eines Fertigungsauftrags aus Odoo, so wie er dort steht: Reihenfolge, Arbeitsplatz, Status, Soll- und Ist-Zeit.
// Weicht die Maschine der Karte in der Planung von der in Odoo ab, steht oben eine Warnung; ist noch nichts begonnen, kann man sie umstellen.

const machineName = (id) => (MACHINES.find((m) => m.id === id) || {}).short || ODOO_CENTER[id] || id;
const min = (m) => {
  if (!m) return "–";
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? `${h}:${String(r).padStart(2, "0")} h` : `${r} min`;
};

// Kurze Kette für die Zeile in der Liste: Programmierung → Rüsten → Fräsen M1 → QS, Farbe nach Stand
export function ArbeitsplanKette({ steps, cardMachineId }) {
  if (!steps || !steps.length) return null;
  const dev = deviation(steps, cardMachineId);
  const offIds = new Set(dev ? dev.steps.map((s) => s.id) : []);
  return (
    <span className="apk" aria-label="Arbeitsplan in Odoo">
      {steps.map((s) => {
        const wrong = offIds.has(s.id);
        const label = s.step === "Programmierung" ? "Prog" : s.step === "Fräsen" || s.step === "Rüsten" ? `${s.step === "Rüsten" ? "Rüst" : "Fräs"}${s.machine && !/^(fräsen|rüsten)$/i.test(s.machine) ? " " + s.machine.replace(/\s+rüsten$/i, "") : ""}` : s.step;
        return (
          <i key={s.id} className={`apk-i ${s.state}${wrong ? " wrong" : ""}`} title={`${s.step} · ${s.machine || "ohne Arbeitsplatz"} · ${STATE_LABEL[s.state] || s.state}${wrong ? " (Maschine weicht von der Karte ab)" : ""}`}>
            {label}
          </i>
        );
      })}
    </span>
  );
}

export function ArbeitsplanPanel({ order, steps, loaded, error, onFixed }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!order.odoo_id) return null;
  const dev = deviation(steps, order.machine);
  async function fix() {
    setBusy(true);
    try {
      const r = await fixInOdoo(order.id, dev.fromId);
      toast(r.text || (r.status === "passt" ? "Die Maschine stimmt schon überein" : "Fertig"));
      if (onFixed) onFixed();
    } catch (err) {
      toast(err.message);
    }
    setBusy(false);
  }
  return (
    <div className="apl">
      <div className="apl-head">Arbeitsplan in Odoo</div>
      {dev && (
        <div className="apl-warn" role="status">
          <span>
            Die Karte steht auf <b>{machineName(order.machine)}</b>, in Odoo hängt {dev.steps.map((s) => `${s.step} (${s.machine})`).join(" und ")} noch an <b>{machineName(dev.fromId)}</b>. Gestempelt wird auf den Arbeitsgang in Odoo.
            {!dev.canFix && " Er hat schon begonnen, deshalb lässt er sich nicht mehr umstellen."}
          </span>
          {dev.canFix && (
            <button type="button" className="btn sm" disabled={busy} onClick={fix}>
              {busy ? "Stelle um …" : `In Odoo auf ${machineName(order.machine)} umstellen`}
            </button>
          )}
        </div>
      )}
      {!loaded ? (
        <div className="apl-empty">Wird geladen …</div>
      ) : error && !steps ? (
        <div className="apl-empty">Der Arbeitsplan ist gerade nicht lesbar: {error}</div>
      ) : !steps || !steps.length ? (
        <div className="apl-empty">In Odoo gibt es zu diesem Fertigungsauftrag keine Arbeitsgänge.</div>
      ) : (
        <table className="apl-tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Arbeitsgang</th>
              <th>Arbeitsplatz</th>
              <th>Status</th>
              <th className="num">Soll</th>
              <th className="num">Ist</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => {
              const off = dev && dev.steps.some((x) => x.id === s.id);
              return (
                <tr key={s.id} className={s.state === "done" ? "done" : ""}>
                  <td>{i + 1}</td>
                  <td>{s.step}</td>
                  <td className={off ? "apl-off" : ""}>{s.machine || "–"}</td>
                  <td>
                    <span className={`apl-st ${s.state}`}>{STATE_LABEL[s.state] || s.state}</span>
                  </td>
                  <td className="num">{min(s.expectedMin)}</td>
                  <td className="num">{min(s.durationMin)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
