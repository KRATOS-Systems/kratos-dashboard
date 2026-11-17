import React, { useEffect, useState } from "react";

// "Heute zu tun": eine kurze Liste mit Zahlen statt vieler Hinweise. Jede Zeile springt an die Stelle, wo man es erledigt (onJump(ziel)).
// reloadKey: ändert sich mit jeder Planänderung, dann wird neu gezählt.

const TONE = { bad: "var(--bad)", warn: "var(--warn)", mute: "var(--faint)" };

export default function Heute({ reloadKey, onJump }) {
  const [d, setD] = useState(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/heute")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => !stop && j && setD(j))
        .catch(() => {});
    const t = setTimeout(load, d ? 1200 : 0);
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => {
      stop = true;
      clearTimeout(t);
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  if (!d) return null;
  return (
    <div className={`heute note rise${d.items.some((i) => i.tone === "bad") ? " bad" : ""}`} style={{ "--i": 1 }}>
      <div className="ht-head">
        <b>Heute zu tun</b>
        {d.alles && <span className="ht-ok">Nichts Dringendes. Planung und Arbeitsvorbereitung sind auf Stand.</span>}
      </div>
      {d.items.length > 0 && (
        <div className="ht-list">
          {d.items.map((i) => (
            <button type="button" key={i.id} className={`ht-row ${i.tone}`} onClick={() => onJump && onJump(i.ziel, i.id)} title="Dorthin springen">
              <i className="dot" style={{ "--c": TONE[i.tone] }} />
              <b className="ht-n">{i.n}</b>
              <span className="ht-t">
                {i.text.replace(/^\d+\s/, "")}
                {i.hint && <small>{i.hint}</small>}
              </span>
              <span className="ht-go">›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
