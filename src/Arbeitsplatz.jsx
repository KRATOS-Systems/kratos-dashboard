import React, { useCallback, useEffect, useRef, useState } from "react";
import { Ico, useToast } from "./ui.jsx";
import { Clock, MachineRuns, OdooLink, Complaints, MachineGlyph, MachineStop } from "./Team.jsx";
import Maschinenzeit from "./Maschinenzeit.jsx";
import Greeting, { berlinHour } from "./Greeting.jsx";
import Aufgaben from "./Aufgaben.jsx";
import Teile from "./Teile.jsx";
import { ActButtons, JobRef } from "./BdeControls.jsx";
import { useMini, notifyChanged, BDE_CHANGED, BDE_OPEN_PICKER } from "./MiniWindow.jsx";
import { todayStr } from "./lib.js";
import { useNow, clock, since, fmtTime, hm, splitProduct, act, isPhoneView, bookingRef, bookingKey } from "./bdeLib.js";
import Avatar from "./Avatar.jsx";
import { afterStop, LaufzeitOffen } from "./Laufzeit.jsx";
import RechnungBereit from "./Rechnung.jsx";
import { AmpelLeiste } from "./Ampel.jsx";
import { pollEvery } from "./poll.js";

// Mein Arbeitsplatz: persönliche Seite nach Anmeldung mit PIN.
// Oben groß die laufende Tätigkeit mit den drei Knöpfen Wechseln, Unterbrechen/Weiter, Stopp; darunter Zeiten der Woche, Resturlaub,
// die letzten Tätigkeiten. Am Büro-PC gibt es ein kleines schwebendes Fenster (Chrome/Edge), und der Tabtitel zeigt die laufende Tätigkeit.
// Die Leitung sieht die Hinweise (vergessen, doppelt, Maschine zu lang), kann fremde Buchungen beenden und die Maschinenzeit prüfen.
// Am Handy gibt es nur die Anzeige.

const REFRESH_MS = 30 * 1000;
const TABLET_IDLE_MS = 2 * 60 * 1000;
// Maschinenzeit-Prüfung vorerst ausgeblendet (Nutzerentscheidung 22.10.2026): sinnvoll erst, wenn jede Maschine in Odoo einen
// eigenen Arbeitsplatz hat und einige Wochen live gestempelt wurde. Code und Schnittstelle bleiben.
const SHOW_MASCHINENZEIT = false;

// Begrüßung beim Anmelden und Verabschiedung beim Abmelden liegen über der Seite
export default function Arbeitsplatz({ goTo }) {
  const [greet, setGreet] = useState(null);
  const done = useCallback(() => setGreet(null), []);
  return (
    <>
      <ArbeitsplatzInner onGreet={setGreet} goTo={goTo} />
      {greet && <Greeting name={greet.name} id={greet.id} kind={greet.kind} onDone={done} />}
    </>
  );
}

function ArbeitsplatzInner({ onGreet, goTo }) {
  const [state, setState] = useState("loading"); // loading | login | ok | error
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [viewId, setViewId] = useState(null);
  const [picker, setPicker] = useState(false); // false oder { tab, q }
  const mini = useMini();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const now = useNow();

  const load = useCallback(() => {
    fetch(`/api/bde/me${viewId ? `?id=${viewId}` : ""}`)
      .then(async (r) => {
        const d = await r.json();
        if (r.status === 401) {
          setState("login");
          setData(null);
          return;
        }
        if (!r.ok) throw new Error(d.error || "Odoo ist gerade nicht erreichbar");
        setData(d);
        setError(null);
        setState("ok");
      })
      .catch((err) => {
        setError(err.message);
        setState((s) => (s === "loading" ? "error" : s));
      });
  }, [viewId]);
  useEffect(() => {
    load();
    return pollEvery(load, REFRESH_MS);
  }, [load]);

  // Abmelden; mit Knopf verabschiedet die Seite den Mitarbeiter (schon ausgestempelt oder ab 12 Uhr: Feierabend, sonst "Bis später"),
  // beim automatischen Abmelden am Tablet nicht
  const logout = useCallback((name, present, id) => {
    if (typeof name === "string" && name) onGreet({ name, id, kind: !present || berlinHour() >= 12 ? "out" : "bye" });
    if (mini) mini.close();
    fetch("/api/bde/logout", { method: "POST" }).finally(() => {
      setViewId(null);
      setData(null);
      setPicker(false);
      setState("login");
    });
  }, [onGreet, mini]);

  // Am Tablet (geteiltes Gerät) nach 2 Minuten ohne Berührung abmelden
  useEffect(() => {
    if (state !== "ok" || !window.matchMedia("(pointer: coarse) and (min-width: 700px)").matches) return undefined;
    let t = setTimeout(logout, TABLET_IDLE_MS);
    const poke = () => {
      clearTimeout(t);
      t = setTimeout(logout, TABLET_IDLE_MS);
    };
    ["pointerdown", "keydown", "scroll"].forEach((e) => window.addEventListener(e, poke, { passive: true }));
    return () => {
      clearTimeout(t);
      ["pointerdown", "keydown", "scroll"].forEach((e) => window.removeEventListener(e, poke));
    };
  }, [state, logout]);

  const own = !!data && data.viewing.id === data.me.id;
  const b = data && data.card && data.card.person;
  const operate = !!data && own && data.write && !data.phone && !isPhoneView();

  // Tabtitel: "⏱ 0:38 Programmierung FA01262"
  const minute = Math.floor(now / 60000);
  useEffect(() => {
    if (!own || !b) return undefined;
    const prev = document.title;
    document.title = `⏱ ${clock(b.start, Date.now()).main} ${b.label} ${b.fa || ""}`.trim();
    return () => {
      document.title = prev.startsWith("⏱") ? "Kratos Mein Arbeitsplatz" : prev;
    };
  }, [own, b && bookingKey(b), b && b.start, minute]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(
    async (body, msg) => {
      if (mini) mini.openAuto(); // direkt im Klick, sonst lässt der Browser das Fenster nicht zu
      setBusy(true);
      try {
        await act(body);
        if (msg) toast(msg);
        setPicker(false);
        load();
        notifyChanged();
        return true;
      } catch (err) {
        toast(err.message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, toast, mini]
  );

  // Buchungen aus dem kleinen Fenster neu laden; "Wechseln" im kleinen Fenster öffnet hier die Auswahl
  useEffect(() => {
    const onChanged = () => load();
    const onPicker = () => setPicker(true);
    window.addEventListener(BDE_CHANGED, onChanged);
    window.addEventListener(BDE_OPEN_PICKER, onPicker);
    return () => {
      window.removeEventListener(BDE_CHANGED, onChanged);
      window.removeEventListener(BDE_OPEN_PICKER, onPicker);
    };
  }, [load]);


  if (state === "loading")
    return (
      <div className="bde">
        <div className="bnote quiet">Lade …</div>
      </div>
    );
  if (state === "login")
    return (
      <Login
        onDone={(who) => {
          onGreet({ name: who.name, id: who.id, kind: "in" });
          if (mini) mini.openAuto();
          load();
        }}
      />
    );
  if (state === "error" || !data)
    return (
      <div className="bde">
        <div className="bnote">{error}</div>
      </div>
    );

  const prod = splitProduct(b && b.product);
  const diff = data.attendanceH - data.personH - (data.overheadH || 0);
  const startMsg = (r) => `${r.label}${r.fa ? ` ${r.fa}` : ""} gestartet`;
  const controls = operate && (
    <Controls
      b={b}
      resume={data.resume}
      busy={busy}
      onSwitch={() => setPicker(true)}
      onPause={() => run({ action: "pause" }, "Unterbrochen")}
      onResume={() => run({ action: "resume" }, data.resume ? `Weiter: ${data.resume.label} ${data.resume.fa || ""}` : null)}
      onStop={async () => {
        if (!b) return;
        const ok = await run({ action: "stop", ...bookingRef(b) }, "Gestoppt");
        // Arbeitsgang beendet: fertig? (Programmierung, Fräsen mit Laufzeiten, Rüsten, QS mit Abschluss des Fertigungsauftrags)
        if (ok) afterStop(b);
      }}
    />
  );

  return (
    <div className="bde">
      <div className="page-head">
        <div className="bme">
          <Avatar id={data.viewing.id} name={data.viewing.name} size={52} />
          <div>
          <h1>{own ? "Mein Arbeitsplatz" : data.viewing.name}</h1>
          <p>{own ? `Angemeldet als ${data.me.name}` : `Angesehen von ${data.me.name}`}</p>
          </div>
        </div>
        <div className="actions">
          {data.people && (
            <select aria-label="Mitarbeiter ansehen" value={data.viewing.id} onChange={(e) => setViewId(Number(e.target.value) === data.me.id ? null : Number(e.target.value))}>
              {data.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === data.me.id ? `${p.name} (ich)` : p.name}
                </option>
              ))}
            </select>
          )}
          {own && mini && mini.supported && (
            <details className="more">
              <summary className="btn">Mehr</summary>
              <div className="more-menu card">
                <button type="button" className="btn quiet" onClick={() => (mini.isOpen ? mini.close() : mini.open())}>
                  <Ico n="pip" s={16} />
                  {mini.isOpen ? "Kleines Fenster schließen" : "Kleines Fenster öffnen"}
                </button>
                <label className="chk more-chk">
                  <input type="checkbox" checked={mini.auto} onChange={(ev) => mini.setAuto(ev.target.checked)} />
                  Automatisch öffnen
                </label>
              </div>
            </details>
          )}
          <button type="button" className="btn" onClick={() => logout(data.me.name, own ? !!(data.card && data.card.present) : true, data.me.id)}>
            Abmelden
          </button>
        </div>
      </div>
      {(error || data.notice || data.stale) && <div className="bnote">{error || data.notice || "Odoo ist gerade nicht erreichbar, es werden die letzten Daten gezeigt."}</div>}
      {own && data.write === false && data.me.leitung && <div className="bnote quiet">Bedienen ist noch nicht freigeschaltet. Die Seite zeigt nur an.</div>}
      {own && <AmpelLeiste />}

      <section className={`bhero card st-${!b && own ? "idle-warn" : data.card ? data.card.state : "away"}`}>
        {data.card && data.card.double && <div className="bflag">Doppelt gestempelt</div>}
        {b ? (
          <>
            <div className="bhero-top">
              <span className="bact">{b.label}</span>
              <OdooLink base={data.odooUrl} id={b.productionId} s={20} />
            </div>
            <Clock start={b.start} now={now} big />
            <div className="bjob">
              <JobRef fa={b.fa} order={b.order} />
              {prod.name && <span>{prod.name}</span>}
              {prod.code && <span className="code mono">{prod.code}</span>}
            </div>
            <div className="bsince">{since(b.start, now)}</div>
            <Complaints list={b.complaints} />
            {data.card.persons.slice(1).map((x) => (
              <div className="bextra" key={bookingKey(x)}>
                Außerdem: <b>{x.label}</b> {x.fa} · <Clock start={x.start} now={now} />
              </div>
            ))}
          </>
        ) : (
          <div className="bhero-none">Keine Zeit läuft</div>
        )}
        {controls}
        <MachineRuns list={data.card && data.card.machine} now={now} odooUrl={data.odooUrl} canStop={operate || (data.me.leitung && data.write && !data.phone && !isPhoneView())} employeeId={own ? undefined : data.viewing.id} onChanged={load} />
      </section>

      {/* Meine Aufgaben stehen direkt unter der Zeiterfassung, damit man sie im Blick hat */}
      <Aufgaben viewId={viewId} canStamp={operate} onStamp={(fa) => setPicker({ tab: "suchen", q: fa })} />

      {operate && <LaufzeitOffen />}

      <Teile viewId={viewId} today={todayStr()} goTo={goTo} canStart={operate} onStart={(st) => run({ action: "start", workorderId: st.workorderId }, `${st.label} gestartet`)} />

      <div className="btiles">
        <div className="card btile">
          <span className="lab">Anwesend diese Woche</span>
          <span className="val mono">
            {hm(data.attendanceH)}
            <small>h</small>
          </span>
        </div>
        <div className="card btile">
          <span className="lab">Auf Aufträge gebucht</span>
          <span className="val mono">
            {hm(data.personH)}
            <small>h</small>
          </span>
        </div>
        <div className="card btile">
          <span className="lab">Ohne Auftrag gebucht</span>
          <span className="val mono">
            {hm(data.overheadH || 0)}
            <small>h</small>
          </span>
          <span className="sub">AV, QS, Instandhaltung, Unterbrechung</span>
        </div>
        <div className="card btile">
          <span className="lab">Nicht gebucht</span>
          <span className="val mono">
            {hm(diff)}
            <small>h</small>
          </span>
          <span className="sub">Anwesend, aber nirgends gebucht</span>
        </div>
        <div className="card btile">
          <span className="lab">Resturlaub</span>
          <span className="val mono">
            {data.vacation == null ? "–" : String(data.vacation).replace(".", ",")}
            <small>{data.vacation === 1 ? "Tag" : "Tage"}</small>
          </span>
        </div>
      </div>

      <section className="bsec">
        <h2>Zuletzt</h2>
        {data.recent.length === 0 && <div className="bnote quiet">Noch keine Buchungen</div>}
        <div className="brecent">
          {data.recent.map((r) => (
            <PickRow key={bookingKey(r)} r={r} now={now} odooUrl={data.odooUrl} onPick={operate && r.open ? () => run({ action: "start", ...bookingRef(r) }, startMsg(r)) : null} />
          ))}
        </div>
      </section>

      {data.me.leitung && own && <RechnungBereit odooUrl={data.odooUrl} />}
      {data.hints && <LeitungHints hints={data.hints} now={now} odooUrl={data.odooUrl} canStop={data.write && !data.phone && !isPhoneView()} onChanged={load} />}
      {SHOW_MASCHINENZEIT && data.me.leitung && own && <Maschinenzeit />}
      <p className="bfoot">Stand {data.at ? fmtTime(data.at) : "–"} · Zeiten aus Odoo, Woche ab Montag</p>

      {picker && <Picker data={data} now={now} busy={busy} initial={picker === true ? null : picker} onClose={() => setPicker(false)} onPick={(r) => run({ action: "start", ...bookingRef(r) }, startMsg(r))} />}
    </div>
  );
}

// Die drei Knöpfe: Wechseln, Unterbrechen (oder Weiter), Stopp
function Controls({ b, resume, busy, onSwitch, onPause, onResume, onStop }) {
  return <ActButtons running={!!b} busy={busy} onSwitch={onSwitch} onPause={onPause} onResume={onResume} onStop={onStop} resumeLabel={resume ? `${resume.label} ${resume.fa || ""}` : null} />;
}

function PickRow({ r, now, odooUrl, onPick, busy }) {
  const p = splitProduct(r.product);
  const inner = (
    <>
      <span className="bact">
        {r.kind === "maschine" && <MachineGlyph s={15} />} {r.label}
      </span>
      {r.overhead ? <span className="ohtag">Ohne Auftrag</span> : <b className="mono">{r.fa}</b>}
      <span className="t">{p.name}</span>
      <span className="when">{r.state === "blocked" ? "wartet auf Vorgänger" : r.who ? r.who : r.last ? since(r.last, now).replace("seit", "zuletzt") : ""}</span>
    </>
  );
  return (
    <div className="card brow">
      {onPick ? (
        <button type="button" className="brow-btn" disabled={busy} onClick={onPick}>
          {inner}
        </button>
      ) : (
        inner
      )}
      <OdooLink base={odooUrl} id={r.productionId} />
    </div>
  );
}

// Schnellauswahl: Zuletzt, Als Nächstes, Bei Kollegen (helfen), Suchen
function Picker({ data, now, busy, initial, onClose, onPick }) {
  const [tab, setTab] = useState((initial && initial.tab) || "zuletzt");
  const [items, setItems] = useState(null);
  const [q, setQ] = useState((initial && initial.q) || "");
  const [err, setErr] = useState(null);
  const [colleagues, setColleagues] = useState(null);
  useEffect(() => {
    setErr(null);
    if (tab === "next") {
      setItems(null);
      fetch("/api/bde/next")
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : setItems(d.items)))
        .catch(() => setErr("Odoo ist gerade nicht erreichbar"));
    }
    if (tab === "ohne") {
      setItems(null);
      fetch("/api/bde/gemeinkosten")
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : d.project ? setItems(d.items) : setErr("Das Projekt „Gemeinkosten“ gibt es in Odoo nicht")))
        .catch(() => setErr("Odoo ist gerade nicht erreichbar"));
    }
    if (tab === "kollegen" && !colleagues) {
      fetch("/api/bde/team")
        .then((r) => r.json())
        .then((d) =>
          setColleagues(
            (d.cards || [])
              .filter((c) => c.id !== data.me.id)
              .flatMap((c) => c.persons.map((p) => ({ ...p, who: c.name })))
          )
        )
        .catch(() => setErr("Odoo ist gerade nicht erreichbar"));
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab !== "suchen" || q.trim().length < 2) return undefined;
    const t = setTimeout(() => {
      fetch(`/api/bde/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : setItems(d.items)))
        .catch(() => setErr("Odoo ist gerade nicht erreichbar"));
    }, 350);
    return () => clearTimeout(t);
  }, [q, tab]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const list = tab === "zuletzt" ? data.recent.filter((r) => r.open !== false) : tab === "kollegen" ? colleagues : items;
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog bpick" role="dialog" aria-modal="true" aria-label="Tätigkeit wählen">
        <div className="bpick-head">
          <h3>Woran arbeitest du?</h3>
          <button type="button" className="btn quiet icon" onClick={onClose} aria-label="Schließen">
            <Ico n="x" />
          </button>
        </div>
        <div className="seg bpick-tabs">
          {[
            ["zuletzt", "Zuletzt"],
            ["next", "Als Nächstes"],
            ["ohne", "Ohne Auftrag"],
            ["kollegen", "Helfen"],
            ["suchen", "Suchen"],
          ].map(([id, l]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "on" : ""}
              onClick={() => {
                setItems(null);
                setTab(id);
              }}
            >
              {l}
            </button>
          ))}
        </div>
        {tab === "suchen" && <input type="search" autoFocus placeholder="Auftragsnummer oder Artikel" value={q} onChange={(e) => setQ(e.target.value)} className="bsearch" />}
        {err && <div className="bnote">{err}</div>}
        <div className="brecent bpick-list">
          {list == null && !err && (tab !== "suchen" || q.trim().length >= 2) && <div className="bnote quiet">Lade …</div>}
          {list && list.length === 0 && <div className="bnote quiet">{tab === "kollegen" ? "Gerade arbeitet niemand sonst an einem Auftrag." : "Nichts gefunden"}</div>}
          {list &&
            (tab === "ohne" ? (
              <div className="ohgrid">
                {list.map((r) => (
                  <button key={r.taskId} type="button" className="ohbtn" disabled={busy} onClick={() => onPick(r)}>
                    {r.label}
                  </button>
                ))}
              </div>
            ) : (
              list.map((r) => <PickRow key={`${bookingKey(r)}-${r.who || ""}`} r={r} now={now} odooUrl={data.odooUrl} busy={busy} onPick={r.state === "blocked" ? null : () => onPick(r)} />)
            ))}
        </div>
      </div>
    </div>
  );
}

// Eine Zeile der Hinweise
function HintRow({ h, k, now, odooUrl, canStop, open, setOpen, confirm, setConfirm, stopPerson, onChanged }) {
  return (
    <div className={`card brow alarm${h.kind === "maschine" ? " warnrow" : ""}`}>
      <span className="bact">{h.who}</span>
      <b className="mono">{h.fa}</b>
      <span className="t">{h.label}</span>
      <span className="when">
        {since(h.start, now)} · <Clock start={h.start} now={now} />
      </span>
      {canStop && h.employeeId != null && (
        <>
          {h.kind === "maschine" ? (
            <button type="button" className="btn sm" onClick={() => setOpen(open === k ? null : k)}>
              Beenden
            </button>
          ) : confirm === k ? (
            <span className="actions">
              <button type="button" className="btn sm danger" onClick={() => stopPerson(h)}>
                Wirklich beenden
              </button>
              <button type="button" className="btn sm" onClick={() => setConfirm(null)}>
                Nein
              </button>
            </span>
          ) : (
            <button type="button" className="btn sm" onClick={() => setConfirm(k)}>
              Beenden
            </button>
          )}
        </>
      )}
      <OdooLink base={odooUrl} id={h.productionId} />
      {open === k && (
        <div className="brow-full">
          <MachineStop
            run={h}
            employeeId={h.employeeId}
            onCancel={() => setOpen(null)}
            onDone={() => {
              setOpen(null);
              onChanged();
            }}
          />
        </div>
      )}
    </div>
  );
}

// Hinweise für die Leitung, mit "Beenden"
function LeitungHints({ hints, now, odooUrl, canStop, onChanged }) {
  const toast = useToast();
  const [open, setOpen] = useState(null);
  const [confirm, setConfirm] = useState(null);
  async function stopPerson(h) {
    try {
      await act({ action: "stop", ...bookingRef(h), employeeId: h.employeeId });
      toast(`${h.label} von ${h.who} beendet`);
      setConfirm(null);
      onChanged();
    } catch (err) {
      toast(err.message);
    }
  }
  const shared = { now, odooUrl, canStop, open, setOpen, confirm, setConfirm, stopPerson, onChanged };
  return (
    <section className="bsec">
      <h2>
        Hinweise {hints.count > 0 && <span className="cntb">{hints.count}</span>}
      </h2>
      {hints.count === 0 && <div className="bnote quiet">Keine vergessenen oder doppelten Buchungen, kein Maschinenlauf über Plan.</div>}
      {hints.forgotten.length > 0 && <h3 className="bsub">Vergessen (länger als 12 Stunden oder seit gestern)</h3>}
      <div className="brecent">
        {hints.forgotten.map((h, i) => (
          <HintRow {...shared} key={`f${i}`} h={h} k={`f${i}`} />
        ))}
      </div>
      {hints.double.length > 0 && <h3 className="bsub">Doppelt gestempelt</h3>}
      <div className="brecent">
        {hints.double.flatMap((d, i) => d.bookings.map((h, j) => <HintRow {...shared} key={`d${i}-${j}`} h={h} k={`d${i}-${j}`} />))}
      </div>
      {hints.long.length > 0 && <h3 className="bsub">Maschinenlauf länger als geplant</h3>}
      <div className="brecent">
        {hints.long.map((h, i) => (
          <HintRow {...shared} key={`l${i}`} h={h} k={`l${i}`} />
        ))}
      </div>
    </section>
  );
}

// Anmeldung: Name antippen, dann PIN über große Tasten (auch mit Handschuhen)
function Login({ onDone }) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  const [who, setWho] = useState(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const pinRef = useRef("");
  pinRef.current = pin;

  useEffect(() => {
    fetch("/api/bde/people")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Odoo ist gerade nicht erreichbar");
        setPeople(d.people);
      })
      .catch((err) => setError(err.message));
  }, []);

  const submit = useCallback(async () => {
    if (!who || !pinRef.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/bde/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: who.id, pin: pinRef.current }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Anmeldung fehlgeschlagen");
      onDone(who);
    } catch (err) {
      setError(err.message);
      setPin("");
    } finally {
      setBusy(false);
    }
  }, [who, busy, onDone]);

  // Tastatur am PC
  useEffect(() => {
    if (!who) return undefined;
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 8 ? p + e.key : p));
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") submit();
      else if (e.key === "Escape") setWho(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [who, submit]);

  return (
    <div className="bde">
      <div className="page-head">
        <div>
          <h1>Mein Arbeitsplatz</h1>
          <p>{who ? `PIN für ${who.name}` : "Wer bist du?"}</p>
        </div>
      </div>
      {error && <div className="bnote">{error}</div>}
      {!who && (
        <div className="bwho">
          {!people && !error && <div className="bnote quiet">Lade …</div>}
          {people &&
            people.map((p) => (
              <button
                type="button"
                key={p.id}
                className="card bwho-btn"
                onClick={() => {
                  setWho(p);
                  setPin("");
                  setError(null);
                }}
              >
                <span className="bav">
                  <Avatar id={p.id} name={p.name} size={56} />
                </span>
                <b>{p.name}</b>
              </button>
            ))}
        </div>
      )}
      {who && (
        <div className="bpin card">
          <div className="bdots" aria-label={`${pin.length} Ziffern eingegeben`}>
            {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
              <i key={i} className={i < pin.length ? "on" : ""} />
            ))}
          </div>
          <div className="bpad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button type="button" key={d} onClick={() => setPin((p) => (p.length < 8 ? p + d : p))}>
                {d}
              </button>
            ))}
            <button type="button" className="soft" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Ziffer löschen">
              <Ico n="left" s={24} />
            </button>
            <button type="button" onClick={() => setPin((p) => (p.length < 8 ? p + "0" : p))}>
              0
            </button>
            <button type="button" className="go" disabled={!pin || busy} onClick={submit} aria-label="Anmelden">
              <Ico n="check" s={26} />
            </button>
          </div>
          <button type="button" className="btn quiet" onClick={() => setWho(null)}>
            Andere Person
          </button>
        </div>
      )}
    </div>
  );
}
