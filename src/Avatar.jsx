import React, { useState } from "react";
import { staffId } from "./staffLib.js";

// Foto eines Mitarbeiters aus Odoo, ohne Foto die Initialen. Über Odoo-ID oder über den Namen aus der Planung ("Nino").
// Die Initialen liegen immer darunter; das Foto deckt sie zu, sobald es da ist, und verschwindet, wenn es keins gibt.
const failed = new Set();

const initialsOf = (name) =>
  String(name || "?")
    .replace(/\./g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

export default function Avatar({ id, name, size = 28, title, className = "" }) {
  const eid = id ?? (name ? staffId(name) : null);
  const src = eid != null ? `/api/bde/photo/${eid}` : null;
  const [bad, setBad] = useState(() => !src || failed.has(src));
  return (
    <span className={`avt ${className}`} style={{ "--s": `${size}px` }} title={title || name || undefined}>
      <i>{initialsOf(name)}</i>
      {!bad && (
        <img
          src={src}
          alt=""
          onError={() => {
            failed.add(src);
            setBad(true);
          }}
        />
      )}
    </span>
  );
}
