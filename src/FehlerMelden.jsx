import React, { useEffect, useState } from "react";

// "Fehler melden" an einem Auftrag (Wunsch von Aurel): Wer etwas Falsches findet (z. B. "Eloxieren" bei einem Edelstahlteil), legt mit
// zwei Klicks eine Aufgabe in Odoo an, am Fertigungsauftrag, für die zuständige Person (Standard: Frank). Kein eigenes System: es ist das
// vorhandene Aufgaben-Vergeben (server/bdeTasks.js), mit "Fehler:" vorne im Text. Braucht die Anmeldung mit PIN.

const LEITUNG_DEFAULT = 3; // Frank
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + (d.getDay() === 5 ? 3 : d.getDay() === 6 ? 2 : 1));
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
};

export default function FehlerMelden({ o, small = true }) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState(null);
  const [can, setCan] = useState(true);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const ref = o.odoo_ref || o.parent_ref || o.source || "";

  useEffect(() => {
    if (!open || people) return;
    fetch("/api/bde/aufgaben/empfaenger")
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) throw new Error("Bitte zuerst unter „Mein Arbeitsplatz“ mit PIN anmelden.");
        if (!r.ok) throw new Error(j.error || "Empfänger nicht lesbar");
        return j;
      })
      .then((j) => {
        setPeople(j.people || []);
        setCan(!!j.canAssign);
        const def = (j.people || []).find((p) => p.id === LEITUNG_DEFAULT) || (j.people || [])[0];
        if (def) setTo(String(def.id));
      })
      .catch((e) => setErr(e.message));
  }, [open, people]);

  const send = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/bde/aufgaben/neu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: Number(to), summary: ("Fehler: " + text.trim()).slice(0, 140), deadline: tomorrow(), ref: /^(FA|A)\d{3,}$/i.test(ref) ? ref : "", urgent: false }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Melden hat nicht geklappt");
      const who = (people || []).find((p) => String(p.id) === to);
      setMsg(`Gemeldet: Aufgabe für ${who ? who.name : "die Zuständigen"}${ref ? " am " + ref : ""} in Odoo.`);
      setText("");
      setOpen(false);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  if (!open)
    return (
      <span className="fm">
        <button type="button" className={`btn${small ? " sm" : ""} quiet`} onClick={(e) => (e.stopPropagation(), setOpen(true), setMsg(""))} title="Etwas stimmt an diesem Auftrag nicht? Als Aufgabe in Odoo an die Zuständigen melden.">
          Fehler melden
        </button>
        {msg && <span className="fm-ok">{msg}</span>}
      </span>
    );
  return (
    <div className="fm-form" onClick={(e) => e.stopPropagation()}>
      <b>Fehler melden{ref ? ` zu ${ref}` : ""}</b>
      {err && <div className="fm-err">{err}</div>}
      {people && !can && <div className="fm-err">Aufgaben vergeben geht hier nicht (am Handy oder ohne Odoo-Benutzer).</div>}
      {people && can && (
        <>
          <textarea rows={2} maxLength={130} value={text} onChange={(e) => setText(e.target.value)} placeholder="Was stimmt nicht? z. B. Arbeitsplan sagt Eloxieren, Teil ist aber Edelstahl" autoFocus />
          <div className="fm-row">
            <label>
              an
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn sm primary" disabled={busy || text.trim().length < 3 || !to} onClick={send}>
              {busy ? "Melde …" : "Melden"}
            </button>
            <button type="button" className="btn sm quiet" onClick={() => setOpen(false)}>
              Abbrechen
            </button>
          </div>
          <small>Wird als Aufgabe in Odoo am Auftrag angelegt, Frist morgen.</small>
        </>
      )}
      {!people && !err && <span className="fm-faint">Lade …</span>}
      {(!people || !can) && (
        <button type="button" className="btn sm quiet" onClick={() => setOpen(false)}>
          Schließen
        </button>
      )}
    </div>
  );
}
