import React, { useState } from "react";
import { MACHINES, fmtShort } from "./lib.js";

// Liefertermin für eine Anfrage: Stunden (oder Zeichnungsnummer + Menge aus der Kalkulation) eingeben, die App rechnet mit der echten
// Planung, wann wir liefern könnten (hinten anstellen oder vorziehen, ohne andere zu verspäten). Speichert nichts (server/liefertermin.js).

const day = (s) => (s ? `${fmtShort(s)}${s.slice(2, 4)}` : "–");

export default function LieferterminAnfrage() {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ stunden: "", code: "", menge: "", extern_tage: "0", material_tage: "0", qs: true, maschine: "" });
  const [r, setR] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const go = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/liefertermin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, stunden: Number(String(f.stunden).replace(",", ".")) || undefined, menge: Number(f.menge) || undefined, maschine: f.maschine || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Nicht berechenbar");
      setR(j);
    } catch (e2) {
      setErr(e2.message);
      setR(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card lt">
      <button type="button" className="fg-title" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <b>Liefertermin für eine Anfrage</b>
        <span className="fg-faint">Wann könnten wir liefern, wenn der Auftrag heute käme? Gerechnet mit der echten Planung.</span>
        <span className="ht-go">{open ? "▾" : "›"}</span>
      </button>
      {open && (
        <>
          <form className="lt-form" onSubmit={go}>
            <label>
              Stunden
              <input value={f.stunden} onChange={set("stunden")} inputMode="decimal" placeholder="z. B. 12" />
            </label>
            <span className="fg-faint">oder</span>
            <label>
              Zeichnungsnr.
              <input value={f.code} onChange={set("code")} placeholder="aus der Kalkulation" />
            </label>
            <label>
              Menge
              <input value={f.menge} onChange={set("menge")} inputMode="numeric" style={{ width: 70 }} />
            </label>
            <label>
              Extern (Tage)
              <input value={f.extern_tage} onChange={set("extern_tage")} inputMode="numeric" style={{ width: 60 }} />
            </label>
            <label>
              Material (Werktage)
              <input value={f.material_tage} onChange={set("material_tage")} inputMode="numeric" style={{ width: 60 }} />
            </label>
            <label>
              Maschine
              <select value={f.maschine} onChange={set("maschine")}>
                <option value="">alle</option>
                {MACHINES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.short}
                  </option>
                ))}
              </select>
            </label>
            <label className="lt-check">
              <input type="checkbox" checked={f.qs} onChange={set("qs")} /> QS
            </label>
            <button type="submit" className="btn sm primary" disabled={busy}>
              {busy ? "Rechne …" : "Termin rechnen"}
            </button>
          </form>
          {err && <div className="fg-err">{err}</div>}
          {r && (
            <div className="lt-out">
              {r.empfehlung ? (
                <div className="lt-best">
                  Liefertermin <b>{day(r.empfehlung.liefertermin)}</b> auf der {r.empfehlung.maschine}
                  {r.empfehlung.frühestens_bei_vorziehen && <span> · vorgezogen ohne andere zu verspäten: <b>{day(r.empfehlung.frühestens_bei_vorziehen)}</b></span>}
                  <div className="fg-faint">
                    {String(r.stunden).replace(".", ",")} h ({r.stunden_quelle}) · extern {r.annahmen.extern_tage} Tage · {r.annahmen.qs ? "mit QS" : "ohne QS"} · {r.annahmen.puffer_werktage} Werktage Puffer
                  </div>
                </div>
              ) : (
                <div className="fg-faint">Keine Maschine kann das gerade einplanen.</div>
              )}
              <div className="fg-detail">
                <table>
                  <thead>
                    <tr>
                      <th>Maschine</th>
                      <th>hinten anstellen</th>
                      <th>vorziehen (Platz)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.maschinen.map((m) => (
                      <tr key={m.id}>
                        <td>{m.maschine}</td>
                        <td>
                          {day(m.hinten.liefertermin)} <span className="fg-faint">Maschine fertig {day(m.hinten.maschineFertig)}</span>
                        </td>
                        <td>{m.vorziehen ? `${day(m.vorziehen.liefertermin)} (Platz ${m.vorziehen.platz})` : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
