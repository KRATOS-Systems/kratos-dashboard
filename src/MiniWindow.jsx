import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MachineGlyph, Clock } from "./Team.jsx";
import { useNow, act, isPhoneView, bookingRef, bookingKey } from "./bdeLib.js";
import Avatar from "./Avatar.jsx";
import { ActButtons, JobRef } from "./BdeControls.jsx";

// Kleines schwebendes Fenster (Document Picture-in-Picture, Chrome/Edge am PC): laufende Tätigkeit mit Uhr, darunter
// Unterbrechen/Weiter, Stopp, Wechseln (nur wenn Bedienen freigeschaltet ist). Es hängt an der App, nicht an einer Seite,
// und bleibt deshalb offen, solange der Tab offen ist, auch beim Wechsel in Planung oder Dashboard.
// Es öffnet sich automatisch nach der Anmeldung in "Mein Arbeitsplatz" und beim Stempeln (der Browser erlaubt das nur direkt
// nach einem Klick). Abschaltbar unter "Mehr"; die Wahl merkt sich der PC.
// "Wechseln" (⇄) klappt die Auswahl direkt im kleinen Fenster auf (Zuletzt, Nächste, Suchen); das Fenster wird dafür größer
// und nach dem Start wieder klein. "Helfen" und alles Weitere gibt es in "Mein Arbeitsplatz".
// Darunter ungelesene Odoo-Nachrichten des Angemeldeten (Chats, Posteingang): nur Anzeige, ein Klick öffnet sie in Odoo.

const PREF_KEY = "kratos-bde-mini";
const SIZE_SMALL = [340, 290];
const MSG_REFRESH_MS = 60 * 1000;
const MSG_SHOW = 2;
const SIZE_PICK = [380, 540];
const REFRESH_MS = 30 * 1000;
export const BDE_CHANGED = "bde-changed"; // Ereignis: es wurde gebucht, Anzeigen neu laden
export const BDE_OPEN_PICKER = "bde-open-picker"; // Ereignis: Auswahl "Wechseln" in Mein Arbeitsplatz öffnen

const readPref = () => {
  try {
    return window.localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
};
export const notifyChanged = () => window.dispatchEvent(new Event(BDE_CHANGED));

const MiniCtx = createContext(null);
export const useMini = () => useContext(MiniCtx);

export function MiniProvider({ goTo, children }) {
  const supported = typeof window !== "undefined" && "documentPictureInPicture" in window && !window.matchMedia("(pointer: coarse)").matches && !isPhoneView();
  const [win, setWin] = useState(null);
  const [auto, setAutoState] = useState(readPref);
  const opening = useRef(false);

  const open = useCallback(async () => {
    if (!supported || opening.current) return false;
    if (window.documentPictureInPicture.window) return true;
    opening.current = true;
    try {
      const w = await window.documentPictureInPicture.requestWindow({ width: SIZE_SMALL[0], height: SIZE_SMALL[1] });
      [...document.styleSheets].forEach((sheet) => {
        try {
          const style = w.document.createElement("style");
          style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
          w.document.head.appendChild(style);
        } catch {
          if (sheet.href) {
            const link = w.document.createElement("link");
            link.rel = "stylesheet";
            link.href = sheet.href;
            w.document.head.appendChild(link);
          }
        }
      });
      w.document.documentElement.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") || "dark");
      w.document.title = "Kratos";
      w.addEventListener("pagehide", () => setWin(null));
      setWin(w);
      return true;
    } catch {
      return false;
    } finally {
      opening.current = false;
    }
  }, [supported]);

  // Automatisch öffnen (nur aufrufen direkt nach einem Klick des Mitarbeiters)
  const openAuto = useCallback(() => {
    if (auto) open();
  }, [auto, open]);
  const close = useCallback(() => {
    if (window.documentPictureInPicture && window.documentPictureInPicture.window) window.documentPictureInPicture.window.close();
    setWin(null);
  }, []);
  const setAuto = useCallback((on) => {
    try {
      window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
    } catch {
      /* ohne Speicher gilt die Wahl nur bis zum Neuladen */
    }
    setAutoState(on);
  }, []);

  // Farbschema mitnehmen, wenn es in der App umgeschaltet wird
  useEffect(() => {
    if (!win) return undefined;
    const obs = new MutationObserver(() => win.document.documentElement.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") || "dark"));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, [win]);

  return (
    <MiniCtx.Provider value={{ supported, isOpen: !!win, open, openAuto, close, auto, setAuto }}>
      {children}
      {win && createPortal(<MiniContent goTo={goTo} onGone={close} win={win} />, win.document.body)}
    </MiniCtx.Provider>
  );
}

// Inhalt des kleinen Fensters: liest selbst (Anmeldung + Team-Tafel), damit es auf jeder Seite der App aktuell bleibt
function MiniContent({ goTo, onGone, win }) {
  const [session, setSession] = useState(null);
  const [card, setCard] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(false);
  const now = useNow();
  // Fenstergröße: der Browser erlaubt das Ändern nur direkt nach einem Klick; sonst bleibt es klein und die Liste scrollt
  const resize = (size) => {
    try {
      win.resizeTo(size[0] + (win.outerWidth - win.innerWidth), size[1] + (win.outerHeight - win.innerHeight));
    } catch {
      /* nicht erlaubt: Inhalt scrollt */
    }
  };
  const openPick = () => {
    setMsg(null);
    setPick(true);
    resize(SIZE_PICK);
  };
  const closePick = () => {
    setPick(false);
    resize(SIZE_SMALL);
  };

  const load = useCallback(async () => {
    try {
      const s = await fetch("/api/bde/session").then((r) => r.json());
      setSession(s);
      if (!s.id) return setCard(null);
      const t = await fetch("/api/bde/team").then((r) => r.json());
      setCard(t.mine || (t.cards || []).find((c) => c.id === s.id) || { id: s.id, persons: [], machine: [], name: "" });
    } catch {
      /* nächster Versuch beim nächsten Takt */
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    window.addEventListener(BDE_CHANGED, load);
    return () => {
      clearInterval(t);
      window.removeEventListener(BDE_CHANGED, load);
    };
  }, [load]);

  // Nach dem Abmelden schließt sich das Fenster
  useEffect(() => {
    if (session && !session.id) onGone();
  }, [session, onGone]);

  async function run(body) {
    setBusy(true);
    setMsg(null);
    try {
      await act(body);
      notifyChanged();
      return true;
    } catch (err) {
      setMsg(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const switchTo = () => {
    window.focus();
    if (goTo) goTo("platz");
    setTimeout(() => window.dispatchEvent(new Event(BDE_OPEN_PICKER)), 300);
  };

  if (!session || !card) return <div className="bmini">…</div>;
  const b = card.persons && card.persons[0];
  const canAct = session.write;
  if (pick && canAct)
    return (
      <MiniPicker
        busy={busy}
        msg={msg}
        onClose={closePick}
        onMore={() => {
          closePick();
          switchTo();
        }}
        onPick={async (r) => {
          if (await run({ action: "start", ...bookingRef(r) })) closePick();
        }}
      />
    );
  // Zustand über Farbe: grün = Zeit läuft, gelb = keine Zeit läuft (fällt auf), rot = Buchung vergessen
  const state = b ? (b.forgotten ? "alarm" : "run") : "idle";
  return (
    <div className={`bmini st-${state}`}>
      <div className="bmini-top">
        <Avatar id={session.id} name={card.name} size={30} />
        {b ? (
          <div className="bmini-what">
            <span className="bact">{b.label}</span>
            <JobRef fa={b.fa} order={b.order} />
          </div>
        ) : (
          <div className="bmini-what">
            <span className="bmini-none">Keine Zeit läuft</span>
          </div>
        )}
      </div>
      {b ? <Clock start={b.start} now={now} /> : <div className="bmini-hint">{canAct ? "Mit ▶ weitermachen oder mit ⇄ eine Tätigkeit wählen" : "Bitte eine Tätigkeit starten"}</div>}
      {card.machine && card.machine.length > 0 && (
        <div className="bmini-m" title="Maschinenlauf, läuft parallel">
          <MachineGlyph s={14} /> Maschine: {card.machine.map((x) => `${x.label} ${x.fa}${x.order ? ` · ${x.order}` : ""}`).join(", ")}
        </div>
      )}
      {msg && <div className="bmini-msg">{msg}</div>}
      <MiniMessages />
      {canAct ? (
        <ActButtons
          compact
          running={!!b}
          busy={busy}
          onSwitch={openPick}
          onPause={() => run({ action: "pause" })}
          onResume={() => run({ action: "resume" })}
          onStop={() => b && run({ action: "stop", ...bookingRef(b) })}
        />
      ) : (
        <button type="button" className="bbtn bmini-open" onClick={switchTo}>
          Mein Arbeitsplatz
        </button>
      )}
    </div>
  );
}

// Auswahl im kleinen Fenster: Zuletzt, Nächste (die ersten 5), Ohne Auftrag (Gemeinkosten), Suchen nach FA, Auftrag oder Aufgabe
const MINI_TABS = [
  ["zuletzt", "Zuletzt"],
  ["next", "Nächste"],
  ["ohne", "Ohne Auftrag"],
  ["suchen", "Suchen"],
];
function MiniPicker({ busy, msg, onClose, onMore, onPick }) {
  const [tab, setTab] = useState("zuletzt");
  const [items, setItems] = useState(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState(null);
  useEffect(() => {
    setErr(null);
    setItems(null);
    if (tab === "zuletzt")
      fetch("/api/bde/me")
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : setItems((d.recent || []).filter((r) => r.open !== false))))
        .catch(() => setErr("Odoo ist gerade nicht erreichbar"));
    if (tab === "ohne")
      fetch("/api/bde/gemeinkosten")
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : setItems(d.items || [])))
        .catch(() => setErr("Odoo ist gerade nicht erreichbar"));
    if (tab === "next")
      fetch("/api/bde/next")
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : setItems(d.items.slice(0, 5))))
        .catch(() => setErr("Odoo ist gerade nicht erreichbar"));
  }, [tab]);
  useEffect(() => {
    if (tab !== "suchen" || q.trim().length < 2) return undefined;
    const t = setTimeout(() => {
      fetch(`/api/bde/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : setItems(d.items.slice(0, 8))))
        .catch(() => setErr("Odoo ist gerade nicht erreichbar"));
    }, 350);
    return () => clearTimeout(t);
  }, [q, tab]);
  const waiting = items == null && !err && (tab !== "suchen" || q.trim().length >= 2);
  return (
    <div className="bmini bmini-pick">
      <div className="bmini-pick-head">
        <b>Woran arbeitest du?</b>
        <button type="button" className="bbtn bmini-x" onClick={onClose} aria-label="Zurück">
          ✕
        </button>
      </div>
      <div className="seg bmini-tabs">
        {MINI_TABS.map(([id, l]) => (
          <button key={id} type="button" className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {l}
          </button>
        ))}
      </div>
      {tab === "suchen" && <input type="search" autoFocus placeholder="FA- oder Auftragsnummer" value={q} onChange={(e) => setQ(e.target.value)} className="bsearch" />}
      {(err || msg) && <div className="bmini-msg">{err || msg}</div>}
      <div className="bmini-list">
        {waiting && <div className="bmini-hint">Lade …</div>}
        {items && items.length === 0 && <div className="bmini-hint">Nichts gefunden</div>}
        {items &&
          items.map((r) => (
            <button key={bookingKey(r)} type="button" className="bmini-row" disabled={busy} onClick={() => onPick(r)}>
              <span className="bact">{r.label}</span>
              <JobRef fa={r.fa} order={r.order} />
              {r.product && <span className="bmini-prod">{r.product}</span>}
              <span className="bmini-go" aria-hidden="true">
                ▶
              </span>
            </button>
          ))}
      </div>
      <button type="button" className="bbtn bmini-more" onClick={onMore}>
        Helfen und mehr in Mein Arbeitsplatz
      </button>
    </div>
  );
}

// Ungelesene Odoo-Nachrichten: die neuesten zwei mit Absender und den ersten Worten, darunter wie viele es noch gibt
function MiniMessages() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const load = () =>
      fetch("/api/bde/nachrichten")
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((d) => setItems(d.items || []))
        .catch(() => {
          /* nächster Versuch beim nächsten Takt */
        });
    load();
    const t = setInterval(load, MSG_REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  if (!items.length) return null;
  const more = items.length - MSG_SHOW;
  return (
    <div className="bmini-news" aria-label="Neue Nachrichten in Odoo">
      {items.slice(0, MSG_SHOW).map((x) => (
        <a key={x.key} className="bmini-new" href={x.link || undefined} target="_blank" rel="noreferrer" title={x.text}>
          <span className="bmini-new-who">
            {x.kind === "posteingang" ? "@" : "💬"} {x.from.split(" ")[0]}
            {x.group ? ` · ${x.group}` : x.about ? ` · ${x.about}` : ""}
            {x.count > 1 && <span className="bmini-new-n">{x.count}</span>}
          </span>
          <span className="bmini-new-text">{x.text}</span>
        </a>
      ))}
      {more > 0 && <div className="bmini-hint">+ {more} weitere in Odoo</div>}
    </div>
  );
}
