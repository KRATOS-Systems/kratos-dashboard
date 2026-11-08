import React, { useCallback, useEffect, useState } from "react";
import { Ico, useToast } from "./ui.jsx";
import { addDays } from "./lib.js";
import { due } from "./Aufgaben.jsx";

// Meine To-dos und Meine Notizen: nur für sich selbst, nur auf der eigenen Seite (Leitung sieht die der anderen nicht).
// Liegt in der Datenbank des Dashboards (server/meineNotizen.js), nicht in Odoo; Odoo-Aufgaben stehen darüber unter "Meine Aufgaben".

const FOLD = 280; // längere Notizen werden zugeklappt

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
  return d;
}

export default function Notizen() {
  return (
    <>
      <Todos />
      <Notes />
    </>
  );
}

function Todos() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null); // { id, text, due }
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(() => {
    fetch("/api/ich/todos")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "To-dos nicht verfügbar");
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  async function run(fn, okMsg) {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      load();
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function add(e) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    const ok = await run(() => call("POST", "/api/ich/todos", { text, due: date || null }));
    if (ok) {
      setText("");
      setDate("");
    }
  }

  if (err) return null;
  if (!data) return null;
  const today = data.today;
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const quick = [
    ["Heute", today],
    ["Morgen", addDays(today, 1)],
    ["Freitag", addDays(today, (5 - dow + 7) % 7)],
  ].filter(([, d], i, all) => all.findIndex(([, x]) => x === d) === i);
  const overdue = data.open.filter((t) => t.due && t.due < today).length;

  return (
    <section className="bsec">
      <h2>
        Meine To-dos
        {data.open.length > 0 && <span className={`cntb${overdue ? "" : " quiet"}`}>{data.open.length}</span>}
      </h2>
      <form className="mytodo-add card" onSubmit={add}>
        <input type="text" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} placeholder="Neues To-do, z. B. Messmittel kalibrieren lassen" aria-label="Neues To-do" />
        <div className="mytodo-due">
          {quick.map(([l, d]) => (
            <button key={l} type="button" className={`chipf${date === d ? " on" : ""}`} onClick={() => setDate(date === d ? "" : d)}>
              {l}
            </button>
          ))}
          <input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Frist (freiwillig)" title="Frist (freiwillig)" />
          <button type="submit" className="btn sm primary" disabled={busy || !text.trim()}>
            <Ico n="plus" s={15} />
            Hinzufügen
          </button>
        </div>
      </form>
      {data.open.length === 0 && <div className="bnote quiet">Keine offenen To-dos. Was du hier einträgst, sieht nur du.</div>}
      <div className="brecent">
        {data.open.map((t) => {
          const u = due(t.due, today, null);
          const editing = edit && edit.id === t.id;
          return (
            <div key={t.id} className={`card task mytodo due-${t.due ? u.cls : "later"}`}>
              <button type="button" className="mytodo-check" disabled={busy} onClick={() => run(() => call("PATCH", `/api/ich/todos/${t.id}`, { done: true }))} aria-label={`Erledigt: ${t.text}`} title="Erledigt">
                <Ico n="check" s={16} />
              </button>
              {editing ? (
                <form
                  className="mytodo-edit"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(() => call("PATCH", `/api/ich/todos/${t.id}`, { text: edit.text, due: edit.due || null }))) setEdit(null);
                  }}
                >
                  <input type="text" maxLength={200} autoFocus value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} aria-label="To-do" />
                  <input type="date" value={edit.due || ""} onChange={(e) => setEdit({ ...edit, due: e.target.value })} aria-label="Frist" />
                  <button type="submit" className="btn sm primary" disabled={busy || !edit.text.trim()}>
                    Speichern
                  </button>
                  <button type="button" className="btn sm" onClick={() => setEdit(null)}>
                    Abbrechen
                  </button>
                </form>
              ) : (
                <>
                  <div className="task-main">
                    <b className="task-sum mytodo-text">{t.text}</b>
                    {t.due && <span className="task-meta"><span className="task-due">{u.text}</span></span>}
                  </div>
                  <div className="task-act">
                    <button type="button" className="btn sm quiet" onClick={() => setEdit({ id: t.id, text: t.text, due: t.due })}>
                      Bearbeiten
                    </button>
                    <button type="button" className="btn sm quiet icon" disabled={busy} onClick={() => run(() => call("DELETE", `/api/ich/todos/${t.id}`))} aria-label="Löschen" title="Löschen">
                      <Ico n="trash" s={16} />
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {data.done.length > 0 && (
        <div className="task-sent">
          <button type="button" className="btn quiet info-toggle" onClick={() => setShowDone((v) => !v)}>
            Erledigt: {data.done.length} {showDone ? "▴" : "▾"}
          </button>
          {showDone && (
            <div className="brecent">
              {data.done.map((t) => (
                <div key={t.id} className="card task mytodo done due-later">
                  <button type="button" className="mytodo-check on" disabled={busy} onClick={() => run(() => call("PATCH", `/api/ich/todos/${t.id}`, { done: false }))} aria-label={`Wieder öffnen: ${t.text}`} title="Wieder öffnen">
                    <Ico n="check" s={16} />
                  </button>
                  <div className="task-main">
                    <b className="task-sum mytodo-text">{t.text}</b>
                  </div>
                  <div className="task-act">
                    <button type="button" className="btn sm quiet icon" disabled={busy} onClick={() => run(() => call("DELETE", `/api/ich/todos/${t.id}`))} aria-label="Löschen" title="Löschen">
                      <Ico n="trash" s={16} />
                    </button>
                  </div>
                </div>
              ))}
              <div className="bnote quiet">Erledigte To-dos werden nach 30 Tagen gelöscht.</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Notes() {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null); // { id?, title, text }
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [open, setOpen] = useState({});

  const load = useCallback(() => {
    fetch("/api/ich/notizen")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Notizen nicht verfügbar");
        setItems(d.items);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  async function run(fn) {
    setBusy(true);
    try {
      await fn();
      load();
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(e) {
    e.preventDefault();
    if (!form.text.trim() || busy) return;
    const body = { title: form.title, text: form.text };
    const ok = await run(() => (form.id ? call("PATCH", `/api/ich/notizen/${form.id}`, body) : call("POST", "/api/ich/notizen", body)));
    if (ok) setForm(null);
  }

  if (err) return null;
  if (!items) return null;

  return (
    <section className="bsec">
      <h2>
        Meine Notizen
        {items.length > 0 && <span className="cntb quiet">{items.length}</span>}
        {!form && (
          <button type="button" className="btn sm task-new" onClick={() => setForm({ title: "", text: "" })}>
            <Ico n="plus" s={15} />
            Neue Notiz
          </button>
        )}
      </h2>
      {form && (
        <form className="mynote-form card" onSubmit={save}>
          <input type="text" maxLength={80} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Titel (freiwillig)" aria-label="Titel" />
          <textarea rows={5} maxLength={4000} autoFocus value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Notiz …" aria-label="Notiz" />
          <div className="mynote-actions">
            <button type="button" className="btn sm" onClick={() => setForm(null)}>
              Abbrechen
            </button>
            <button type="submit" className="btn sm primary" disabled={busy || !form.text.trim()}>
              Speichern
            </button>
          </div>
        </form>
      )}
      {items.length === 0 && !form && <div className="bnote quiet">Noch keine Notizen. Was du hier einträgst, sieht nur du.</div>}
      <div className="mynotes">
        {items.map((n) => {
          const long = n.text.length > FOLD || n.text.split("\n").length > 6;
          const isOpen = !!open[n.id];
          return (
            <div key={n.id} className={`card mynote${n.pinned ? " pinned" : ""}`}>
              <div className="mynote-top">
                {n.title ? <b className="mynote-title">{n.title}</b> : <span />}
                <span className="mynote-tools">
                  <button type="button" className={`btn sm quiet icon${n.pinned ? " on" : ""}`} disabled={busy} onClick={() => run(() => call("PATCH", `/api/ich/notizen/${n.id}`, { pinned: !n.pinned }))} aria-pressed={n.pinned} aria-label={n.pinned ? "Nicht mehr anheften" : "Anheften"} title={n.pinned ? "Nicht mehr anheften" : "Oben anheften"}>
                    <Ico n="pin" s={16} />
                  </button>
                </span>
              </div>
              <div className={`mynote-text${long && !isOpen ? " fold" : ""}`}>{n.text}</div>
              {long && (
                <button type="button" className="btn sm quiet" onClick={() => setOpen({ ...open, [n.id]: !isOpen })}>
                  {isOpen ? "Weniger" : "Mehr anzeigen"}
                </button>
              )}
              <div className="mynote-actions">
                <button type="button" className="btn sm quiet" onClick={() => setForm({ id: n.id, title: n.title, text: n.text })}>
                  Bearbeiten
                </button>
                {confirm === n.id ? (
                  <>
                    <button type="button" className="btn sm ok" disabled={busy} onClick={async () => (await run(() => call("DELETE", `/api/ich/notizen/${n.id}`))) && setConfirm(null)}>
                      Ja, löschen
                    </button>
                    <button type="button" className="btn sm" onClick={() => setConfirm(null)}>
                      Nein
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn sm quiet" onClick={() => setConfirm(n.id)}>
                    Löschen
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
