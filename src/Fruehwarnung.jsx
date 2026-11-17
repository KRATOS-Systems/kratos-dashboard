import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Frühwarnung: Aufträge, die laut Plan nach dem Liefertermin fertig werden (oder schon überfällig sind), mit Grund,
// Vorschlag für den neuen Termin und einem Entwurf für die Nachricht an den Kunden. Gesendet wird nichts von selbst:
// Der Entwurf öffnet sich im Mailprogramm, ein Mensch prüft und schickt ihn ab. Danach wird "Kunde informiert" vermerkt.
// reloadKey: ändert sich, wenn sich die Planung ändert (dann neu rechnen lassen).

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const full = (d) => (d ? `${fmtShort(d)}${d.slice(0, 4)}` : "");
const call = (url, method, body) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Das hat nicht geklappt");
    return j;
  });

function Entwurf({ item, onDone, onClose }) {
  const [date, setDate] = useState(item.proposal || "");
  const [m, setM] = useState(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    setErr("");
    call(`/api/fruehwarnung/mail?source=${encodeURIComponent(item.source)}${date ? "&date=" + date : ""}`, "GET")
      .then((j) => !stop && setM(j))
      .catch((e) => !stop && setErr(e.message));
    return () => {
      stop = true;
    };
  }, [item.source, date]);

  const set = (k) => (ev) => setM((p) => ({ ...p, [k]: ev.target.value }));
  const mailto = m ? `mailto:${encodeURIComponent(m.to || "")}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}` : "#";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${m.subject}\n\n${m.body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Kopieren ist hier nicht möglich. Bitte den Text markieren und kopieren.");
    }
  };
  const informed = async () => {
    setBusy(true);
    try {
      onDone(await call("/api/fruehwarnung/informiert", "POST", { source: item.source, date: date || null }));
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  return (
    <div className="fw-mail">
      <div className="fw-mail-top">
        <label>
          Neuer Liefertermin
          <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} />
        </label>
        <span className="fw-faint">
          {item.proposal
            ? `Vorschlag ${full(item.proposal)}: Ende laut Plan plus Puffer, nächster Werktag. Der Text passt sich an.`
            : "Kein Vorschlag möglich, solange nicht alle Positionen eingeplant sind. Bitte erst einplanen oder den Termin selbst eintragen."}
        </span>
      </div>
      {err && <div className="fw-err">{err}</div>}
      {!m && !err && <div className="fw-faint">Entwurf wird erstellt …</div>}
      {m && (
        <>
          {m.hint && <div className="fw-hint">{m.hint}</div>}
          <label>
            An
            <input value={m.to} onChange={set("to")} placeholder="E-Mail-Adresse des Kunden" />
          </label>
          <label>
            Betreff
            <input value={m.subject} onChange={set("subject")} />
          </label>
          <label>
            Nachricht
            <textarea rows={14} value={m.body} onChange={set("body")} />
          </label>
          <div className="fw-actions">
            <a className="btn primary" href={mailto} title="Öffnet den Entwurf im Mailprogramm. Dort prüfen und selbst senden.">
              Im Mailprogramm öffnen
            </a>
            <button type="button" className="btn" onClick={copy}>
              {copied ? "Kopiert" : "Text kopieren"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={informed} title="Vermerkt: Der Kunde kennt den neuen Termin. Der Auftrag verschwindet aus der roten Liste.">
              Kunde ist informiert
            </button>
            <button type="button" className="btn quiet" onClick={onClose}>
              Schließen
            </button>
          </div>
          <div className="fw-faint">Die App sendet nichts. Erst wenn du die Nachricht im Mailprogramm abschickst, geht sie an den Kunden.</div>
        </>
      )}
    </div>
  );
}

export default function Fruehwarnung({ reloadKey }) {
  const [data, setData] = useState(null);
  const [openFor, setOpenFor] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/fruehwarnung")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => !stop && j && setData(j))
        .catch(() => {});
    // kurz warten, damit eine gerade gespeicherte Änderung der Planung schon mitgerechnet wird
    const first = setTimeout(load, 1200);
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [reloadKey]);

  if (!data || !data.items.length) return null;
  const c = data.counts;
  const undo = (source) =>
    call("/api/fruehwarnung/informiert", "POST", { source, undo: true })
      .then(setData)
      .catch((e) => setErr(e.message));
  const urgent = data.items.filter((i) => i.state === "offen" || i.state === "erneut");
  const rest = data.items.filter((i) => i.state !== "offen" && i.state !== "erneut");
  const shown = showAll ? data.items : urgent;

  const row = (i) => {
    const overdue = i.due < data.today;
    return (
      <React.Fragment key={i.source}>
        <div className={`fw-row ${i.state}`}>
          <div className="fw-who">
            <b>{i.label}</b>
            <span title={i.customer || ""}>{i.customer || "–"}</span>
          </div>
          <div className="fw-dates">
            <span className={overdue ? "fw-late" : ""}>Liefertermin {full(i.due)}</span>
            {i.kind === "risiko" ? (
              <span>in {plural(i.daysLeft, "Tag", "Tagen")}</span>
            ) : i.proposal ? (
              <span>
                neu möglich <b>{full(i.proposal)}</b> · {plural(i.lateDays, "Tag", "Tage")} später
              </span>
            ) : (
              <span className="fw-late">{overdue ? `${plural(i.lateDays, "Tag", "Tage")} überfällig` : `${plural(i.lateDays, "Tag", "Tage")} zu spät`} · neuer Termin offen</span>
            )}
          </div>
          <div className="fw-why" title={i.reasons.join("\n")}>
            {i.reasons.join(" · ") || "–"}
          </div>
          <div className="fw-state">
            {i.state === "offen" && <span className="pill bad">Kunde nicht informiert{i.since && i.since < data.today ? ` · seit ${fmtShort(i.since)}` : ""}</span>}
            {i.state === "erneut" && (
              <span className="pill bad" title={`Dem Kunden wurde ${full(i.informedDate)} genannt, laut Plan wird es später`}>
                Termin erneut verschoben
              </span>
            )}
            {i.state === "risiko" && <span className="pill warn">noch nicht eingeplant</span>}
            {i.state === "informiert" && (
              <span className="pill ok" title={`Informiert am ${full(i.informedAt.slice(0, 10))}${i.informedBy ? " von " + i.informedBy : ""}`}>
                informiert{i.informedDate ? `: ${full(i.informedDate)}` : ""}
              </span>
            )}
            {i.kind === "verzug" && i.state !== "informiert" && (
              <button type="button" className="btn sm" onClick={() => setOpenFor(openFor === i.source ? null : i.source)}>
                {openFor === i.source ? "Entwurf schließen" : "Mail-Entwurf"}
              </button>
            )}
            {i.state === "informiert" && (
              <button type="button" className="btn sm quiet" onClick={() => undo(i.source)} title="Vermerk lösen">
                zurück
              </button>
            )}
          </div>
        </div>
        {openFor === i.source && (
          <Entwurf
            item={i}
            onClose={() => setOpenFor(null)}
            onDone={(j) => {
              setData(j);
              setOpenFor(null);
            }}
          />
        )}
      </React.Fragment>
    );
  };

  return (
    <div className={`fruehwarn note${c.nichtInformiert ? " bad" : ""} rise`} style={{ "--i": 1 }}>
      <div className="fw-head">
        <i className="dot" style={{ "--c": c.nichtInformiert ? "var(--bad)" : c.risiko ? "var(--warn)" : "var(--ok)" }} />
        <span>
          <b>
            {c.nichtInformiert
              ? `Liefertermine in Gefahr: Bei ${plural(c.nichtInformiert, "Auftrag", "Aufträgen")} weiß der Kunde noch nichts.`
              : c.verzug
              ? "Liefertermine: Alle betroffenen Kunden sind informiert."
              : "Liefertermine: kein Verzug."}
          </b>{" "}
          {plural(c.verzug, "Auftrag", "Aufträge")} im Verzug{c.risiko ? `, ${c.risiko} mit Liefertermin in ${data.riskDays} Tagen noch nicht eingeplant` : ""}.
        </span>
        {rest.length > 0 && (
          <button type="button" className="btn sm quiet" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Nur Offene zeigen" : `Alle ${data.items.length} zeigen`}
          </button>
        )}
      </div>
      {err && <div className="fw-err">{err}</div>}
      {shown.length > 0 && <div className="fw-list">{shown.map(row)}</div>}
    </div>
  );
}
