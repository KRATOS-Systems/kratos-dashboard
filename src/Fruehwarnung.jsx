import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Frühwarnung: Aufträge, die laut Plan nach dem Liefertermin fertig werden (oder schon überfällig sind), mit Grund,
// Vorschlag für den neuen Termin und der Empfehlung, ob man anruft oder eine Mail reicht.
// Der Kunde wird telefonisch oder per Mail informiert, eins von beiden genügt. Für die Mail gibt es einen Entwurf (auch als Bestätigung
// nach einem Telefonat). Gesendet wird nichts von selbst: Der Entwurf öffnet sich im Mailprogramm, ein Mensch prüft und schickt ihn ab.
// Beim Abhaken wird der genannte Termin der neue Liefertermin, der ursprüngliche bleibt sichtbar.
// reloadKey: ändert sich, wenn sich die Planung ändert (dann neu rechnen lassen). onChanged: Liefertermine wurden geändert.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const full = (d) => (d ? `${fmtShort(d)}${d.slice(0, 4)}` : "");
const WAY = { telefon: "Telefon", mail: "Mail", beides: "Telefon und Mail" };
const call = (url, method, body) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Das hat nicht geklappt");
    return j;
  });

// Aufgeklapptes Feld eines Auftrags: neuer Termin, dann Telefon oder Mail
function Kontakt({ item, startTab, onDone, onClose }) {
  const called = item.channel === "telefon"; // schon telefonisch informiert: Mail nur noch als Bestätigung
  const [tab, setTab] = useState(startTab);
  const [date, setDate] = useState(item.proposal || item.informedDate || "");
  const [k, setK] = useState(null);
  const [person, setPerson] = useState(item.contact || "");
  const [note, setNote] = useState("");
  const [afterCall, setAfterCall] = useState(called);
  const [m, setM] = useState(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    call(`/api/fruehwarnung/kontakt?source=${encodeURIComponent(item.source)}`, "GET")
      .then((j) => {
        if (stop) return;
        setK(j);
        setPerson((p) => p || j.name || "");
      })
      .catch(() => !stop && setK({ hint: "Kontaktdaten nicht lesbar." }));
    return () => {
      stop = true;
    };
  }, [item.source]);

  useEffect(() => {
    if (tab !== "mail") return undefined;
    let stop = false;
    setErr("");
    call(`/api/fruehwarnung/mail?source=${encodeURIComponent(item.source)}${date ? "&date=" + date : ""}${afterCall ? "&nachTelefon=1" : ""}`, "GET")
      .then((j) => !stop && setM(j))
      .catch((e) => !stop && setErr(e.message));
    return () => {
      stop = true;
    };
  }, [tab, item.source, date, afterCall]);

  const set = (key) => (ev) => setM((p) => ({ ...p, [key]: ev.target.value }));
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
  const informed = async (channel) => {
    setBusy(true);
    try {
      onDone(await call("/api/fruehwarnung/informiert", "POST", { source: item.source, date: date || null, channel, contact: person, note }));
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
            ? `Vorschlag ${full(item.proposal)}: Ende laut Plan plus Puffer, nächster Werktag.`
            : item.kind === "informiert"
            ? "Dem Kunden wurde dieser Termin genannt."
            : "Kein Vorschlag möglich, solange nicht alle Positionen eingeplant sind. Bitte erst einplanen oder den Termin selbst eintragen."}{" "}
          Beim Abhaken wird er der neue Liefertermin, der bisherige bleibt als ursprünglicher Termin sichtbar.
        </span>
      </div>
      <div className="seg" role="tablist" aria-label="Weg">
        <button type="button" role="tab" aria-selected={tab === "telefon"} className={tab === "telefon" ? "on" : ""} onClick={() => setTab("telefon")}>
          Telefon
        </button>
        <button type="button" role="tab" aria-selected={tab === "mail"} className={tab === "mail" ? "on" : ""} onClick={() => setTab("mail")}>
          Mail
        </button>
      </div>
      {err && <div className="fw-err">{err}</div>}

      {tab === "telefon" && (
        <>
          <div className="fw-contact">
            {!k && <span className="fw-faint">Kontaktdaten werden geladen …</span>}
            {k && (
              <>
                <b>{k.name || k.company || item.customer || "Ansprechpartner unbekannt"}</b>
                {k.name && k.company && <span className="fw-faint">{k.company}</span>}
                {k.phone ? (
                  <a href={"tel:" + k.phone.replace(/[^+\d]/g, "")} title="Anrufen (wenn dieses Gerät telefonieren kann)">
                    {k.phone}
                  </a>
                ) : (
                  <span className="fw-hint">Keine Telefonnummer in Odoo hinterlegt</span>
                )}
                {k.ref && <span className="fw-faint">Bestellung {k.ref}</span>}
                {k.hint && <span className="fw-hint">{k.hint}</span>}
              </>
            )}
          </div>
          <label>
            Gesprochen mit
            <input value={person} maxLength={120} onChange={(ev) => setPerson(ev.target.value)} placeholder="Name des Gesprächspartners" />
          </label>
          <label>
            Notiz (freiwillig)
            <input value={note} maxLength={300} onChange={(ev) => setNote(ev.target.value)} placeholder="z. B. Teillieferung von 20 Stück gewünscht" />
          </label>
          <div className="fw-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => informed("telefon")} title="Vermerkt: Der Kunde kennt den neuen Termin aus dem Telefonat.">
              Telefonisch informiert
            </button>
            <button type="button" className="btn quiet" onClick={onClose}>
              Schließen
            </button>
          </div>
          <div className="fw-faint">Der Anruf reicht. Eine Mail als Bestätigung ist danach möglich, aber nicht nötig.</div>
        </>
      )}

      {tab === "mail" && (
        <>
          <label className="fw-check">
            <input type="checkbox" checked={afterCall} onChange={(ev) => setAfterCall(ev.target.checked)} />
            Als Bestätigung nach einem Telefonat formulieren
          </label>
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
                <textarea rows={13} value={m.body} onChange={set("body")} />
              </label>
              <div className="fw-actions">
                <a className="btn primary" href={mailto} title="Öffnet den Entwurf im Mailprogramm. Dort prüfen und selbst senden.">
                  Im Mailprogramm öffnen
                </a>
                <button type="button" className="btn" onClick={copy}>
                  {copied ? "Kopiert" : "Text kopieren"}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => informed(called || afterCall ? "beides" : "mail")} title="Vermerkt: Der Kunde kennt den neuen Termin aus der Mail.">
                  {called ? "Bestätigung ist verschickt" : "Per Mail informiert"}
                </button>
                <button type="button" className="btn quiet" onClick={onClose}>
                  Schließen
                </button>
              </div>
              <div className="fw-faint">Die App sendet nichts. Erst wenn du die Nachricht im Mailprogramm abschickst, geht sie an den Kunden.</div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function Fruehwarnung({ reloadKey, onChanged }) {
  const [data, setData] = useState(null);
  const [openFor, setOpenFor] = useState(null); // { source, tab }
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
  const toggle = (source, tab) => setOpenFor(openFor && openFor.source === source && openFor.tab === tab ? null : { source, tab });

  const row = (i) => {
    const overdue = i.due < data.today;
    const isOpen = openFor && openFor.source === i.source;
    return (
      <React.Fragment key={i.source}>
        <div className={`fw-row ${i.state}`}>
          <div className="fw-who">
            <b>{i.label}</b>
            <span title={i.customer || ""}>{i.customer || "–"}</span>
          </div>
          <div className="fw-dates">
            <span className={overdue ? "fw-late" : ""}>Liefertermin {full(i.due)}</span>
            {i.dueOriginal && (
              <span className="fw-orig" title="Der Liefertermin wurde schon verschoben">
                ursprünglich {full(i.dueOriginal)} · {i.dueShifts}× verschoben
              </span>
            )}
            {i.kind === "risiko" ? (
              <span>in {plural(i.daysLeft, "Tag", "Tagen")}</span>
            ) : i.kind === "informiert" ? null : i.proposal ? (
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
            {(i.state === "offen" || i.state === "erneut") && (
              <span className={`pill ${i.advice === "anrufen" ? "warn" : "mute"}`} title={"Empfehlung: " + i.adviceWhy}>
                {i.advice === "anrufen" ? "anrufen" : "Mail reicht"}
              </span>
            )}
            {i.state === "risiko" && <span className="pill warn">noch nicht eingeplant</span>}
            {i.state === "informiert" && (
              <span
                className="pill ok"
                title={[`Informiert am ${full(i.informedAt.slice(0, 10))}`, i.informedBy ? "von " + i.informedBy : "", i.contact ? "gesprochen mit " + i.contact : "", i.note || ""].filter(Boolean).join(" · ")}
              >
                informiert{i.channel ? " · " + WAY[i.channel] : ""}
                {i.informedDate ? ` · ${full(i.informedDate)}` : ""}
              </span>
            )}
            {(i.state === "offen" || i.state === "erneut") && (
              <button type="button" className="btn sm" onClick={() => toggle(i.source, i.advice === "anrufen" ? "telefon" : "mail")}>
                {isOpen ? "Schließen" : "Kunde informieren"}
              </button>
            )}
            {i.state === "informiert" && i.channel === "telefon" && (
              <button type="button" className="btn sm quiet" onClick={() => toggle(i.source, "mail")} title="Freiwillig: den telefonisch genannten Termin per Mail bestätigen">
                Bestätigung per Mail
              </button>
            )}
            {i.state === "informiert" && (
              <button type="button" className="btn sm quiet" onClick={() => undo(i.source)} title="Vermerk lösen (der Liefertermin bleibt, wie er ist)">
                zurück
              </button>
            )}
          </div>
        </div>
        {isOpen && (
          <Kontakt
            key={i.source + openFor.tab}
            item={i}
            startTab={openFor.tab}
            onClose={() => setOpenFor(null)}
            onDone={(j) => {
              setData(j);
              setOpenFor(null);
              if (onChanged) onChanged();
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
