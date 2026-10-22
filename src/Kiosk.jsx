import React, { useCallback, useEffect, useRef, useState } from "react";
import { Ico } from "./ui.jsx";
import { useBdeTeam, TeamGrid } from "./Team.jsx";
import { useNow, fmtTime, hm } from "./bdeLib.js";
import { greetText, GreetTitle } from "./Greeting.jsx";
import Avatar from "./Avatar.jsx";

// Kiosk für Kommen und Gehen am Terminal (ersetzt den Odoo-Kiosk).
// Zeigt die Team-Tafel. Der Chipleser tippt die Nummer wie eine Tastatur (Ziffern + Enter).
// Gehen: laufende Personentätigkeiten enden automatisch, für jeden laufenden Maschinenlauf fragt der Kiosk, ob die Maschine weiterläuft.
// Danach 5 Sekunden die persönliche Stundenkarte, dann wieder die Tafel. Ohne Chip sind keine persönlichen Stunden sichtbar.
// Das Gerät wird einmal mit dem Kiosk-Schlüssel freigeschaltet (bleibt im Browser gespeichert).

const KEY_STORE = "kratos-bde-kiosk";
const CARD_MS = 5000;
const QUESTION_MS = 60 * 1000;

function storedKey() {
  try {
    return window.localStorage.getItem(KEY_STORE) || "";
  } catch {
    return "";
  }
}

export default function Kiosk() {
  const [key, setKey] = useState(storedKey);
  const [device, setDevice] = useState("check"); // check | ok | setup
  const [deviceErr, setDeviceErr] = useState(null);
  const [step, setStep] = useState({ s: "idle" }); // idle | busy | ask | card | error
  const { data, error, reload } = useBdeTeam();
  const now = useNow();
  const buf = useRef({ text: "", at: 0 });

  const headers = useCallback((k = key) => ({ "Content-Type": "application/json", "x-bde-kiosk": k }), [key]);

  useEffect(() => {
    if (!key) return setDevice("setup");
    fetch("/api/bde/kiosk/check", { headers: headers() })
      .then(async (r) => {
        const d = await r.json();
        if (r.ok) setDevice("ok");
        else {
          setDevice("setup");
          setDeviceErr(d.error);
        }
      })
      .catch(() => setDevice("ok"));
  }, [key, headers]);

  const finish = useCallback(
    async (ticket, keep) => {
      setStep({ s: "busy" });
      try {
        const r = await fetch("/api/bde/kiosk/confirm", { method: "POST", headers: headers(), body: JSON.stringify({ ticket, keep }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
        setStep({ s: "card", d });
        reload();
      } catch (err) {
        setStep({ s: "error", msg: err.message });
      }
    },
    [headers, reload]
  );

  const scan = useCallback(
    async (barcode) => {
      setStep({ s: "busy" });
      try {
        const r = await fetch("/api/bde/kiosk/scan", { method: "POST", headers: headers(), body: JSON.stringify({ barcode }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
        if (d.action === "out" && d.machine.length) setStep({ s: "ask", d, i: 0, keep: {} });
        else finish(d.ticket, {});
      } catch (err) {
        setStep({ s: "error", msg: err.message });
      }
    },
    [headers, finish]
  );

  // Chipleser: schnelle Tastenfolge mit Enter am Ende
  useEffect(() => {
    if (device !== "ok") return undefined;
    const onKey = (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const t = Date.now();
      if (t - buf.current.at > 600) buf.current.text = "";
      buf.current.at = t;
      if (e.key === "Enter") {
        const code = buf.current.text;
        buf.current.text = "";
        if (code.length >= 3 && (step.s === "idle" || step.s === "card" || step.s === "error")) scan(code);
      } else if (/^[0-9A-Za-z]$/.test(e.key)) buf.current.text += e.key;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [device, step.s, scan]);

  // Karte nach 5 Sekunden weg, Fehler nach 5 Sekunden weg, Rückfrage nach 60 Sekunden ohne Antwort abbrechen
  useEffect(() => {
    if (step.s === "card" || step.s === "error") {
      const t = setTimeout(() => setStep({ s: "idle" }), CARD_MS);
      return () => clearTimeout(t);
    }
    if (step.s === "ask") {
      const t = setTimeout(() => setStep({ s: "error", msg: "Keine Antwort, es wurde nichts gebucht" }), QUESTION_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [step]);

  function answer(keepRunning) {
    const m = step.d.machine[step.i];
    const keep = { ...step.keep, [m.workorderId]: keepRunning };
    if (step.i + 1 < step.d.machine.length) setStep({ ...step, i: step.i + 1, keep });
    else finish(step.d.ticket, keep);
  }

  if (device === "setup")
    return (
      <div className="bde kiosk kiosk-setup">
        <div className="card bpin">
          <Ico n="chip" s={34} />
          <h2>Kiosk freischalten</h2>
          <p className="bsubtext">Einmal den Kiosk-Schlüssel eingeben. Er bleibt auf diesem Gerät gespeichert.</p>
          {deviceErr && <div className="bnote">{deviceErr}</div>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get("k");
              try {
                window.localStorage.setItem(KEY_STORE, String(v || ""));
              } catch {
                /* ohne Speicher gilt der Schlüssel nur bis zum Neuladen */
              }
              setDeviceErr(null);
              setDevice("check");
              setKey(String(v || ""));
            }}
          >
            <input type="password" name="k" autoComplete="off" className="bsearch" placeholder="Kiosk-Schlüssel" />
            <button type="submit" className="bbtn primary">
              Freischalten
            </button>
          </form>
        </div>
      </div>
    );

  return (
    <div className="bde kiosk">
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p>
            <Ico n="chip" s={14} /> Zum Kommen und Gehen den Chip an den Leser halten
          </p>
        </div>
        <span className="kclock mono">{fmtTime(now)}</span>
      </div>
      {(error || (data && data.notice)) && <div className="bnote">{error || data.notice}</div>}
      {data && <TeamGrid data={data} now={now} session={null} />}

      {step.s !== "idle" && (
        <div className="kov" onClick={() => (step.s === "card" || step.s === "error") && setStep({ s: "idle" })}>
          {step.s === "busy" && <div className="kbox card">Einen Moment …</div>}
          {step.s === "error" && <div className="kbox card kerr">{step.msg}</div>}
          {step.s === "ask" && (
            <div className="kbox card" onClick={(e) => e.stopPropagation()}>
              <div className="kname">{step.d.name}</div>
              <p className="kq">
                {step.d.machine[step.i].label} {step.d.machine[step.i].fa} läuft noch. Läuft die Maschine weiter (Spätschicht oder mannlos über Nacht)?
              </p>
              <div className="kbtns">
                <button type="button" className="bbtn primary" onClick={() => answer(true)}>
                  Läuft weiter
                </button>
                <button type="button" className="bbtn" onClick={() => answer(false)}>
                  Beenden
                </button>
              </div>
            </div>
          )}
          {step.s === "card" && <HoursCard d={step.d} />}
        </div>
      )}
    </div>
  );
}

// Persönliche Stundenkarte nach Kommen oder Gehen: groß, schlicht
function HoursCard({ d }) {
  const c = d.card || {};
  const share = c.weekTargetH ? Math.min(1, (c.weekH || 0) / c.weekTargetH) : null;
  const g = greetText(d.action === "in" ? "in" : "out", d.name);
  return (
    <div className={`kbox card kcard ${d.action === "in" ? "in" : "out"}`}>
      <div className="khead">
        <Avatar id={d.employeeId} name={d.name} size={84} />
        <GreetTitle text={g.title} className="kname" />
      </div>
      <div className="kstate">{g.sub}</div>
      <div className="kgrid">
        <div>
          <small>Heute</small>
          <b className="mono">{hm(c.todayH)} h</b>
        </div>
        <div>
          <small>Diese Woche{c.weekTargetH ? ` von ${hm(c.weekTargetH)}` : ""}</small>
          <b className="mono">{hm(c.weekH)} h</b>
          {share != null && (
            <span className="kbar">
              <i style={{ width: `${share * 100}%` }} />
            </span>
          )}
        </div>
        <div>
          <small>Überstunden</small>
          <b className="mono">{c.overtimeH == null ? "–" : `${c.overtimeH > 0 ? "+" : ""}${hm(c.overtimeH)} h`}</b>
        </div>
        <div>
          <small>Resturlaub</small>
          <b className="mono">{c.vacation == null ? "–" : `${String(c.vacation).replace(".", ",")} Tage`}</b>
        </div>
      </div>
    </div>
  );
}
