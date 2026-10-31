import React, { useEffect, useRef, useState } from "react";
import { useBdeSession } from "./bdeLib.js";

// Rückmeldungen der Mitarbeiter: schreiben (mit Bild), die eigenen ansehen, als Leitung alle bearbeiten.

const ARTEN = [
  { id: "fehler", label: "Fehler", hint: "Etwas klappt nicht oder zeigt etwas Falsches" },
  { id: "idee", label: "Idee", hint: "Das wünsche ich mir, so wäre es besser" },
  { id: "lob", label: "Lob", hint: "Das funktioniert gut" },
];
const STATUS = [
  { id: "neu", label: "Neu" },
  { id: "arbeit", label: "In Arbeit" },
  { id: "erledigt", label: "Erledigt" },
  { id: "verworfen", label: "Nicht geplant" },
];
const MAX_SIDE = 1600;
const MAX_BYTES = 1_200_000;
const artLabel = (id) => (ARTEN.find((a) => a.id === id) || {}).label || id;
const statusLabel = (id) => (STATUS.find((s) => s.id === id) || {}).label || id;
const when = (iso) => new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

// Bild verkleinern, damit die Datenbank nicht wächst: längste Seite 1600 Pixel, JPEG
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const url = c.toDataURL("image/jpeg", q);
    if (Math.ceil((url.length - 23) * 0.75) <= MAX_BYTES) return url;
  }
  throw new Error("Das Bild ist zu groß");
}

async function getJson(url, opt) {
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
  return d;
}

function Write({ onSent }) {
  const [art, setArt] = useState("fehler");
  const [text, setText] = useState("");
  const [img, setImg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);

  async function addFile(file) {
    if (!file) return;
    setErr("");
    try {
      setImg(await shrink(file));
    } catch (e) {
      setErr(e.message || "Das Bild konnte nicht gelesen werden");
    }
  }
  function onPaste(ev) {
    const item = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) {
      ev.preventDefault();
      addFile(item.getAsFile());
    }
  }
  async function send() {
    setBusy(true);
    setErr("");
    try {
      await getJson("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          art,
          text,
          image: img,
          page: `${document.title.replace(/^Kratos\s*/, "")} ${window.location.hash}`.trim(),
          context: { titel: document.title, fenster: `${window.innerWidth}x${window.innerHeight}`, geraet: navigator.userAgent.slice(0, 160) },
        }),
      });
      onSent();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  }
  return (
    <div onPaste={onPaste}>
      <div className="seg fb-art" role="group" aria-label="Art der Rückmeldung">
        {ARTEN.map((a) => (
          <button key={a.id} type="button" className={art === a.id ? "on" : ""} onClick={() => setArt(a.id)}>
            {a.label}
          </button>
        ))}
      </div>
      <div className="fb-hint">{ARTEN.find((a) => a.id === art).hint}</div>
      <textarea
        className="fb-text"
        rows={5}
        maxLength={3000}
        value={text}
        placeholder="Was ist dir aufgefallen? Zum Beispiel: Beim Eintragen der Aufspannungen bei FA01314 kam die Meldung …"
        onChange={(e) => setText(e.target.value)}
      />
      {img ? (
        <div className="fb-shot">
          <img src={img} alt="Angehängtes Bild" />
          <button type="button" className="btn sm" onClick={() => setImg(null)}>
            Bild entfernen
          </button>
        </div>
      ) : (
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn sm" onClick={() => fileRef.current && fileRef.current.click()}>
            Bild anhängen
          </button>
          <span className="fb-hint" style={{ margin: 0 }}>
            oder mit Strg+V einfügen
          </span>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => (addFile(e.target.files[0]), (e.target.value = ""))} />
        </div>
      )}
      <div className="fb-hint">Seite, Gerät und Uhrzeit werden automatisch mitgeschickt. Bitte keine Passwörter oder PINs ins Bild.</div>
      {err && <div className="fb-err">{err}</div>}
      <div className="actions" style={{ marginTop: 14 }}>
        <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={send}>
          {busy ? "Sende …" : "Abschicken"}
        </button>
      </div>
    </div>
  );
}

function Item({ it, admin, onChanged }) {
  const [answer, setAnswer] = useState(it.answer);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save(patch) {
    setBusy(true);
    setErr("");
    try {
      await getJson(`/api/feedback/${it.id}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      onChanged();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  }
  return (
    <div className={`fb-item ${it.status}`}>
      <div className="fb-meta">
        <span className={`chip fb-${it.art}`}>{artLabel(it.art)}</span>
        <b>{it.name || "Nicht angemeldet"}</b>
        <span>{when(it.createdAt)}</span>
        <span className="fb-st">{statusLabel(it.status)}</span>
      </div>
      <div className="fb-body">{it.text}</div>
      {admin && it.page && <div className="fb-hint">Seite: {it.page}</div>}
      {it.hasImage && (
        <a href={`/api/feedback/${it.id}/bild`} target="_blank" rel="noreferrer">
          <img className="fb-thumb" src={`/api/feedback/${it.id}/bild`} alt="Angehängtes Bild" loading="lazy" />
        </a>
      )}
      {!admin && it.answer && (
        <div className="note" style={{ marginTop: 8, marginBottom: 0 }}>
          <b>Antwort{it.answeredBy ? ` von ${it.answeredBy}` : ""}:</b> {it.answer}
        </div>
      )}
      {admin && (
        <div className="fb-admin">
          <div className="seg" role="group" aria-label="Status">
            {STATUS.map((s) => (
              <button key={s.id} type="button" className={it.status === s.id ? "on" : ""} disabled={busy} onClick={() => save({ status: s.id })}>
                {s.label}
              </button>
            ))}
          </div>
          <textarea className="fb-text" rows={2} maxLength={1000} placeholder="Antwort an den Absender (er sieht sie unter „Meine“)" value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <div className="actions">
            <button type="button" className="btn sm" disabled={busy || answer.trim() === it.answer} onClick={() => save({ answer })}>
              Antwort speichern
            </button>
            {err && <span className="fb-err">{err}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function List({ url, admin, empty, onChanged }) {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState("");
  const load = () =>
    getJson(url)
      .then((d) => {
        setItems(d.items);
        setErr("");
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, [url]);
  if (err) return <div className="fb-err">{err}</div>;
  if (!items) return <div className="fb-hint">Lade …</div>;
  if (!items.length) return <div className="fb-hint">{empty}</div>;
  return (
    <div className="fb-list">
      {items.map((it) => (
        <Item
          key={it.id}
          it={it}
          admin={admin}
          onChanged={() => {
            load();
            onChanged && onChanged();
          }}
        />
      ))}
    </div>
  );
}

export function FeedbackDialog({ onClose, onChanged }) {
  const session = useBdeSession();
  const [tab, setTab] = useState("schreiben");
  const [sent, setSent] = useState(false);
  const leitung = !!(session && session.leitung);
  const loggedIn = !!(session && session.id);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog fb-dialog" role="dialog" aria-modal="true" aria-label="Feedback">
        <h3>Feedback</h3>
        <p>Fehler, Ideen und Lob helfen uns, die App gemeinsam besser zu machen.</p>
        <div className="tabs">
          <button type="button" className={tab === "schreiben" ? "on" : ""} onClick={() => (setTab("schreiben"), setSent(false))}>
            Schreiben
          </button>
          <button type="button" className={tab === "meine" ? "on" : ""} onClick={() => setTab("meine")}>
            Meine
          </button>
          {leitung && (
            <button type="button" className={tab === "alle" ? "on" : ""} onClick={() => setTab("alle")}>
              Alle
            </button>
          )}
        </div>
        {tab === "schreiben" &&
          (sent ? (
            <div className="note">
              <b>Danke, deine Rückmeldung ist angekommen.</b>
              <div>{loggedIn ? "Unter „Meine“ siehst du später, was daraus geworden ist." : "Melde dich in der App an, dann siehst du unter „Meine“ auch die Antworten."}</div>
              <div className="actions" style={{ marginTop: 10 }}>
                <button type="button" className="btn sm" onClick={() => setSent(false)}>
                  Noch eine schreiben
                </button>
              </div>
            </div>
          ) : (
            <Write
              onSent={() => {
                setSent(true);
                onChanged && onChanged();
              }}
            />
          ))}
        {tab === "meine" &&
          (loggedIn ? (
            <List url="/api/feedback/meine" empty="Du hast noch nichts geschrieben." />
          ) : (
            <div className="fb-hint">Melde dich in der App an (Mitarbeiter wählen und PIN), dann siehst du hier deine Rückmeldungen und die Antworten.</div>
          ))}
        {tab === "alle" && leitung && <List url="/api/feedback/liste" admin empty="Noch keine Rückmeldungen." onChanged={onChanged} />}
        <div className="actions" style={{ marginTop: 18, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}

// Zähler für die Leitung: wie viele Rückmeldungen sind neu? (einmal beim Start und nach Änderungen, kein Dauerabruf)
export function useFeedbackCount() {
  const [n, setN] = useState(0);
  const load = () =>
    fetch("/api/feedback/anzahl")
      .then((r) => (r.ok ? r.json() : { neu: 0 }))
      .then((d) => setN(d.neu || 0))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return [n, load];
}
