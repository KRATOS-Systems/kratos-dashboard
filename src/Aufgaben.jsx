import React, { useCallback, useEffect, useState } from "react";
import { Ico, useToast } from "./ui.jsx";
import { daysBetween, addDays } from "./lib.js";
import Avatar from "./Avatar.jsx";

// Meine Aufgaben: offene Odoo-Aktivitäten des Mitarbeiters, nach Frist sortiert.
// Farbe statt Text: rot = überfällig, gelb = heute, ohne Farbe = später.
// "Erledigt" (nur mit BDE_WRITE, nur eigene) schließt die Aktivität in Odoo; "Stempeln" springt bei Fertigungsaufträgen in die Auswahl.
// "Aufgabe vergeben" legt eine Odoo-Aktivität (To-do) beim Empfänger an, "Von mir vergeben" zeigt deren Stand.
// "Rückfrage" öffnet unter der Aufgabe einen kleinen Verlauf zwischen Empfänger und dem, der sie vergeben hat (roter Punkt = ungelesen).

const SHOW = 5;
// Belegnummern (FA01307, A01365, P00077, WH/OUT/00012) in Schreibmaschinenschrift, Namen normal
const NUMBERED = new Set(["mrp.production", "sale.order", "purchase.order", "stock.picking", "account.move"]);
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// Uhrzeit jetzt in deutscher Zeit, "HH:MM"
const nowHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

function due(deadline, today, time) {
  if (!deadline) return { cls: "later", text: "ohne Frist" };
  const d = daysBetween(today, deadline);
  const at = time ? ` bis ${time}` : "";
  if (d < 0) return { cls: "over", text: d === -1 ? "seit gestern fällig" : `seit ${-d} Tagen fällig` };
  if (d === 0) return time && nowHM() > time ? { cls: "over", text: `heute${at}, überfällig` } : { cls: "today", text: `heute${at}` };
  if (d === 1) return { cls: "later", text: `morgen${at}` };
  const dt = new Date(`${deadline}T12:00:00Z`);
  return { cls: "later", text: `${WD[dt.getUTCDay()]} ${deadline.slice(8, 10)}.${deadline.slice(5, 7)}.${at}` };
}

export default function Aufgaben({ viewId, canStamp, onStamp }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [assign, setAssign] = useState(null); // Empfänger-Liste und ob vergeben möglich ist
  const [dlg, setDlg] = useState(false);
  const [sent, setSent] = useState(null);
  const [showSent, setShowSent] = useState(false);
  const [thread, setThread] = useState(null); // offene Rückfrage (Aktivitäts-ID)
  const loadSent = useCallback(() => {
    fetch("/api/bde/aufgaben/vergeben")
      .then((r) => (r.ok ? r.json() : null))
      .then(setSent)
      .catch(() => setSent(null));
  }, []);
  useEffect(() => {
    if (viewId) return;
    fetch("/api/bde/aufgaben/empfaenger")
      .then((r) => (r.ok ? r.json() : null))
      .then(setAssign)
      .catch(() => setAssign(null));
    loadSent();
  }, [viewId, loadSent]);

  const load = useCallback(() => {
    fetch(`/api/bde/aufgaben${viewId ? `?id=${viewId}` : ""}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Aufgaben nicht verfügbar");
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [viewId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60 * 1000);
    return () => clearInterval(t);
  }, [load]);

  async function done(a) {
    setBusy(true);
    try {
      const r = await fetch("/api/bde/aufgaben/erledigt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
      toast(`Erledigt: ${a.summary || a.type}`);
      setConfirm(null);
      load();
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (err) return null;
  if (!data) return null;
  const items = data.items;
  const overdue = items.filter((a) => a.deadline && a.deadline < data.today).length;
  const shown = all ? items : items.slice(0, SHOW);

  return (
    <section className="bsec">
      <h2>
        {data.own === false ? "Aufgaben" : "Meine Aufgaben"}
        {items.length > 0 && <span className={`cntb${overdue ? "" : " quiet"}`}>{items.length}</span>}
        {data.own !== false && assign && assign.canAssign && (
          <button type="button" className="btn sm task-new" onClick={() => setDlg(true)}>
            <Ico n="plus" s={15} />
            Aufgabe vergeben
          </button>
        )}
      </h2>
      {data.noUser && <div className="bnote quiet">Ohne Odoo-Benutzer gibt es keine Aufgaben. Aktivitäten werden in Odoo Benutzern zugewiesen.</div>}
      {!data.noUser && items.length === 0 && <div className="bnote quiet">Keine offenen Aufgaben.</div>}
      <div className="brecent">
        {shown.map((a) => {
          const u = due(a.deadline, data.today, a.time);
          return (
            <div key={a.id} className={`card task due-${u.cls}${a.urgent ? " urgent" : ""}`}>
              <div className="task-main">
                <div className="task-top">
                  {a.urgent && <span className="task-urgent">Dringend</span>}
                  {a.summary && <span className="task-type">{a.type}</span>}
                  <b className="task-sum">{a.summary || a.type}</b>
                </div>
                <div className="task-meta">
                  {a.resName && (
                    <span className="task-res">
                      {a.modelLabel ? `${a.modelLabel} ` : ""}
                      <b className={NUMBERED.has(a.model) ? "mono" : undefined}>{a.resName}</b>
                    </span>
                  )}
                  <span className="task-due">{u.text}</span>
                </div>
                {a.note && <div className="task-note">{a.note}</div>}
              </div>
              <div className="task-act">
                {(data.own !== false ? a.assigner : a.questions.total > 0) && (
                  <AskButton q={a.questions} open={thread === a.id} onClick={() => setThread(thread === a.id ? null : a.id)} />
                )}
                {canStamp && a.model === "mrp.production" && a.resName && (
                  <button type="button" className="btn sm" onClick={() => onStamp(a.resName)}>
                    Stempeln
                  </button>
                )}
                {data.canDone &&
                  (confirm === a.id ? (
                    <>
                      <button type="button" className="btn sm ok" disabled={busy} onClick={() => done(a)}>
                        Ja, erledigt
                      </button>
                      <button type="button" className="btn sm" onClick={() => setConfirm(null)}>
                        Nein
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn sm" onClick={() => setConfirm(a.id)}>
                      <Ico n="check" s={15} />
                      Erledigt
                    </button>
                  ))}
                {a.link && (
                  <a className="olink" href={a.link} target="_blank" rel="noreferrer" title="In Odoo öffnen" aria-label="In Odoo öffnen">
                    <Ico n="ext" s={16} />
                  </a>
                )}
              </div>
              {thread === a.id && <Thread id={a.id} view={data.own === false} onRead={load} />}
            </div>
          );
        })}
      </div>
      {items.length > SHOW && (
        <button type="button" className="btn quiet task-more" onClick={() => setAll((v) => !v)}>
          {all ? "Weniger anzeigen" : `Alle ${items.length} anzeigen`}
        </button>
      )}
      {data.own !== false && sent && sent.items.length > 0 && (
        <div className="task-sent">
          <button type="button" className="btn quiet info-toggle" onClick={() => setShowSent((v) => !v)}>
            Von mir vergeben: {sent.items.length} offen
            {sent.items.some((x) => x.questions.unread > 0) && <span className="qdot" title="Neue Rückfrage" />}
            {sent.items.some((x) => x.deadline && x.deadline < sent.today) ? ` · ${sent.items.filter((x) => x.deadline && x.deadline < sent.today).length} überfällig` : ""} {showSent ? "▴" : "▾"}
          </button>
          {showSent && (
            <div className="brecent">
              {sent.items.map((x) => {
                const u = due(x.deadline, sent.today, x.time);
                return (
                  <div key={x.id} className={`card task due-${u.cls}${x.urgent ? " urgent" : ""}`}>
                    <Avatar id={x.toId} name={x.toName} size={30} />
                    <div className="task-main">
                      <div className="task-top">
                        {x.urgent && <span className="task-urgent">Dringend</span>}
                        <b className="task-sum">{x.summary}</b>
                      </div>
                      <div className="task-meta">
                        <span>an {x.toName}</span>
                        {x.resName && <b className="mono">{x.resName}</b>}
                        <span className="task-due">{u.text}</span>
                      </div>
                    </div>
                    <div className="task-act">
                      <AskButton q={x.questions} open={thread === x.id} onClick={() => setThread(thread === x.id ? null : x.id)} />
                    </div>
                    {thread === x.id && <Thread id={x.id} onRead={loadSent} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {dlg && assign && (
        <AssignDialog
          people={assign.people}
          today={data.today}
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            loadSent();
            load();
          }}
        />
      )}
    </section>
  );
}

// Knopf "Rückfrage" mit Anzahl und rotem Punkt für Ungelesenes
function AskButton({ q, open, onClick }) {
  return (
    <button type="button" className={`btn sm task-ask${open ? " on" : ""}`} onClick={onClick} aria-expanded={open}>
      <Ico n="chat" s={15} />
      Rückfrage{q.total > 0 ? ` (${q.total})` : ""}
      {q.unread > 0 && <span className="qdot" title={`${q.unread} neu`} />}
    </button>
  );
}

// Verlauf einer Rückfrage: Nachrichten beider Seiten, unten das Eingabefeld (bei Leitungs-Ansicht nur lesen)
function Thread({ id, view, onRead }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = React.useRef(null);
  const get = useCallback(
    (first) =>
      fetch(`/api/bde/aufgaben/${id}/fragen${view ? "?ansicht=1" : ""}`)
        .then(async (r) => {
          const x = await r.json();
          if (!r.ok) throw new Error(x.error || "Rückfragen nicht verfügbar");
          setD(x);
          if (first && onRead) onRead();
        })
        .catch((e) => setErr(e.message)),
    [id, view, onRead]
  );
  useEffect(() => {
    get(true);
    const t = setInterval(() => get(false), 30 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [d]);
  async function send() {
    setBusy(true);
    try {
      const r = await fetch(`/api/bde/aufgaben/${id}/fragen`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const x = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(x.error || "Das hat nicht geklappt");
      setText("");
      get(false);
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (err) return <div className="task-thread"><div className="bnote">{err}</div></div>;
  if (!d) return <div className="task-thread"><div className="bnote quiet">Lädt …</div></div>;
  return (
    <div className="task-thread">
      {d.messages.length === 0 && (
        <div className="bnote quiet">
          {d.canWrite && d.other ? `Noch keine Rückfrage. Die Nachricht geht an ${d.other.name}.` : "Noch keine Rückfragen."}
        </div>
      )}
      {d.messages.length > 0 && (
        <div className="tmsgs" ref={listRef}>
          {d.messages.map((m) => (
            <div key={m.id} className={`tmsg${m.mine ? " mine" : ""}`}>
              {!m.mine && <Avatar id={m.fromId} name={m.fromName} size={26} />}
              <div className="tbub">
                <div className="tmeta">
                  {m.mine ? "Ich" : m.fromName.split(" ")[0]} · {fmtAt(m.at)}
                </div>
                <div className="ttext">{m.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {d.canWrite && (
        <form
          className="tinput"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !busy) send();
          }}
        >
          <input type="text" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Frage oder Antwort schreiben …" aria-label="Nachricht" />
          <button type="submit" className="btn sm primary" disabled={busy || !text.trim()}>
            Senden
          </button>
        </form>
      )}
    </div>
  );
}

// Zeitpunkt kurz: heute nur Uhrzeit, sonst Tag und Uhrzeit (deutsche Zeit)
function fmtAt(iso) {
  const dt = new Date(iso);
  const tz = { timeZone: "Europe/Berlin" };
  const day = (x) => x.toLocaleDateString("de-DE", tz);
  const time = dt.toLocaleTimeString("de-DE", { ...tz, hour: "2-digit", minute: "2-digit" });
  return day(dt) === day(new Date()) ? time : `${dt.toLocaleDateString("de-DE", { ...tz, day: "2-digit", month: "2-digit" })} ${time}`;
}

// Aufgabe vergeben: für wen, was, bis wann, freiwillig ein Bezug (FA oder Auftrag)
function AssignDialog({ people, today, onClose, onDone }) {
  const toast = useToast();
  const [to, setTo] = useState(null);
  const [text, setText] = useState("");
  const [deadline, setDeadline] = useState(today);
  const [ref, setRef] = useState("");
  const [time, setTime] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const quick = [
    ["Heute", today],
    ["Morgen", addDays(today, 1)],
    ["Freitag", addDays(today, (5 - dow + 7) % 7)],
    ["In 1 Woche", addDays(today, 7)],
  ];
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/bde/aufgaben/neu", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: to.id, summary: text, deadline, ref: ref || null, time: time || null, urgent }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
      toast(`${urgent ? "Dringende " : ""}Aufgabe an ${to.name} vergeben`);
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog assign" role="dialog" aria-modal="true" aria-label="Aufgabe vergeben">
        <h3>Aufgabe vergeben</h3>
        <div className="assign-who">
          {people.map((p) => (
            <button key={p.id} type="button" className={`assign-p${to && to.id === p.id ? " on" : ""}`} onClick={() => setTo(p)}>
              <Avatar id={p.id} name={p.name} size={44} />
              <span>{p.name.split(" ")[0]}</span>
            </button>
          ))}
        </div>
        <label className="f">
          Was ist zu tun?
          <input type="text" maxLength={140} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="z. B. Spannbacken für FA01212 bestellen" />
        </label>
        <div className="f">
          Bis wann?
          <div className="assign-due">
            {quick.map(([l, d]) => (
              <button key={l} type="button" className={`chipf${deadline === d ? " on" : ""}`} onClick={() => setDeadline(d)}>
                {l}
              </button>
            ))}
            <input type="date" min={today} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Uhrzeit (freiwillig)" title="Uhrzeit (freiwillig)" />
          </div>
        </div>
        <button type="button" className={`chipf assign-urgent${urgent ? " on" : ""}`} aria-pressed={urgent} onClick={() => setUrgent((v) => !v)}>
          <Ico n="warn" s={15} />
          Dringend
        </button>
        <label className="f">
          Bezug (freiwillig)
          <input type="text" maxLength={20} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="FA01212 oder A01365" />
        </label>
        {err && <div className="bnote">{err}</div>}
        <div className="actions" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn primary" disabled={busy || !to || text.trim().length < 2 || !deadline} onClick={save}>
            Vergeben
          </button>
        </div>
      </div>
    </div>
  );
}

