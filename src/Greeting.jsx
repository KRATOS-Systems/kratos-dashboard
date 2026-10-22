import React, { useEffect } from "react";
import { BrandMark } from "./ui.jsx";

// Begrüßung beim Anmelden / Kommen und Verabschiedung beim Abmelden / Gehen, kurz und ganzseitig:
// "Guten Morgen, Aurel!", "Hallo, Aurel!", "Guten Abend, Aurel!" bzw. "Schönen Feierabend, Aurel!" (freitags/samstags "Schönes Wochenende"),
// beim Abmelden mitten am Tag "Bis später, Aurel!".
// Die Uhrzeit zählt in Berliner Zeit. Ohne Animation, wenn das Gerät reduzierte Bewegung wünscht.

const TZ = "Europe/Berlin";

export const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

export const berlinHour = (at = Date.now()) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at)).find((p) => p.type === "hour").value);

export function greetText(kind, name, at = Date.now()) {
  const hour = berlinHour(at);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date(at));
  const n = firstName(name);
  // "out" = Gehen (Feierabend), "bye" = nur abmelden mitten am Tag
  if (kind === "bye") return { title: `Bis später, ${n}!`, sub: "Du bist abgemeldet." };
  if (kind === "out") {
    const weekend = day === "Fri" || day === "Sat";
    return { title: `${weekend ? "Schönes Wochenende" : "Schönen Feierabend"}, ${n}!`, sub: "Danke für deine Arbeit heute." };
  }
  const hello = hour < 11 ? "Guten Morgen" : hour < 18 ? "Hallo" : "Guten Abend";
  return { title: `${hello}, ${n}!`, sub: "Schön, dass du da bist." };
}

// Wörter steigen nacheinander auf
export function GreetTitle({ text, className = "" }) {
  return (
    <span className={`gt ${className}`} aria-label={text}>
      {text.split(" ").map((w, i) => (
        <span key={i} className="gt-w" style={{ "--i": i }} aria-hidden="true">
          {w}
        </span>
      ))}
    </span>
  );
}

// Ganzseitige Begrüßung, verschwindet von selbst (Klick oder Taste schließt sofort)
export default function Greeting({ name, kind = "in", ms = 2600, onDone }) {
  const g = greetText(kind, name);
  useEffect(() => {
    const t = setTimeout(onDone, ms);
    const skip = () => onDone();
    window.addEventListener("keydown", skip);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", skip);
    };
  }, [ms, onDone]);
  return (
    <div className={`greet ${kind}`} role="status" onClick={onDone} style={{ "--ms": `${ms}ms` }}>
      <div className="greet-in">
        <span className="greet-mark">
          <BrandMark size={56} />
        </span>
        <GreetTitle text={g.title} className="greet-title" />
        <span className="greet-sub">{g.sub}</span>
        <i className="greet-line" />
      </div>
    </div>
  );
}
