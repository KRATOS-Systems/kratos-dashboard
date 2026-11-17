import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Terminverlauf einer Position: ursprünglicher Liefertermin und jede Verschiebung (wann, von wem, Grund).
// Erscheint nur, wenn der Liefertermin schon einmal verschoben wurde.

const full = (d) => (d ? `${fmtShort(d)}${d.slice(0, 4)}` : "");

export default function Terminverlauf({ o }) {
  const [list, setList] = useState(null);

  useEffect(() => {
    if (!(o.due_shifts > 0)) {
      setList(null);
      return undefined;
    }
    let stop = false;
    fetch(`/api/orders/${o.id}/due-history`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => !stop && setList(j ? j.history : []))
      .catch(() => !stop && setList([]));
    return () => {
      stop = true;
    };
  }, [o.id, o.due, o.due_shifts]);

  if (!(o.due_shifts > 0) || !o.due_original) return null;
  return (
    <div className="terminverlauf">
      <b>
        Liefertermin {o.due_shifts}× verschoben, ursprünglich {full(o.due_original)}
      </b>
      {list &&
        list.map((h, ix) => (
          <div key={ix}>
            {full(h.at.slice(0, 10))}: {full(h.from)} → {full(h.to)}
            {h.by ? ` · ${h.by}` : ""}
            {h.reason ? ` · ${h.reason}` : ""}
          </div>
        ))}
    </div>
  );
}
