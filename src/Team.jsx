import React, { useCallback, useEffect, useState } from "react";
import { Ico, useToast } from "./ui.jsx";
import { useNow, clock, since, fmtTime, splitProduct, odooLink, act, useBdeSession, canOperate, toLocalInput, fromLocalInput, bookingRef, bookingKey } from "./bdeLib.js";
import Avatar from "./Avatar.jsx";
import { JobRef } from "./BdeControls.jsx";

// Team-Tafel: eine Karte pro Mitarbeiter, wer ist da und woran wird gerade gearbeitet.
// Farbe statt Text: grün = da und Buchung läuft, grau = da, nichts gebucht, orange = doppelt gestempelt, rot = Buchung vergessen,
// ohne Farbe = nicht da. Keine Stunden, keine Überstunden, kein Urlaub. Daten alle 30 Sekunden, die Uhren laufen im Browser weiter.
// Wer angemeldet ist, kann auf seiner eigenen Karte unterbrechen, weitermachen und stoppen; die Leitung kann fremde Buchungen beenden.

const REFRESH_MS = 30 * 1000;

export function useBdeTeam() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    fetch("/api/bde/team")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Odoo ist gerade nicht erreichbar");
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);
  return { data, error, reload: load };
}

export const MachineGlyph = ({ s = 16 }) => (
  <svg width={s} height={s} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="11" width="25" height="15.5" rx="2.5" />
    <rect x="7.5" y="15" width="10.5" height="7" rx="1.2" />
    <path d="M23 4.5v8M21 12.5h4M23 12.5v2.5" />
  </svg>
);

export function Clock({ start, now, big }) {
  const c = clock(start, now);
  return (
    <span className={`bclock mono${big ? " big" : ""}`}>
      {c.main}
      {c.sec && <small>:{c.sec}</small>}
    </span>
  );
}

export function OdooLink({ base, id, s = 16 }) {
  const href = odooLink(base, id);
  if (!href) return null;
  return (
    <a className="olink" href={href} target="_blank" rel="noreferrer" title="Fertigungsauftrag in Odoo öffnen" aria-label="Fertigungsauftrag in Odoo öffnen">
      <Ico n="ext" s={s} />
    </a>
  );
}

// Reklamationen zum Artikel
export function Complaints({ list }) {
  if (!list || !list.length) return null;
  return (
    <div className="bcompl" title={list.join("\n")}>
      <Ico n="warn" s={15} />
      <span>{list.length === 1 ? `Reklamation: ${list[0]}` : `${list.length} Reklamationen zum Artikel`}</span>
    </div>
  );
}

// Maschinenlauf beenden: jetzt oder mit der echten Endzeit ("fertig um 22:10")
export function MachineStop({ run, employeeId, onDone, onCancel }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState(() => toLocalInput(Date.now()));
  async function go(endAt) {
    setBusy(true);
    try {
      await act({ action: "stop", workorderId: run.workorderId, employeeId, endAt });
      toast(`${run.label} ${run.fa} beendet`);
      onDone();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mstop">
      <button type="button" className="bbtn" disabled={busy} onClick={() => go(null)}>
        Jetzt beenden
      </button>
      <div className="mstop-at">
        <label className="f">
          Maschine war fertig um
          <input type="datetime-local" value={when} min={toLocalInput(run.start)} max={toLocalInput(Date.now())} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <button type="button" className="bbtn" disabled={busy || !when} onClick={() => go(fromLocalInput(when))}>
          Mit dieser Zeit beenden
        </button>
      </div>
      <button type="button" className="btn quiet" onClick={onCancel}>
        Abbrechen
      </button>
    </div>
  );
}

export function MachineRuns({ list, now, odooUrl, canStop, employeeId, onChanged }) {
  const [open, setOpen] = useState(null);
  if (!list || !list.length) return null;
  return (
    <div className="mruns">
      {list.map((m) => (
        <div key={m.workorderId} className={`mrun-wrap${m.long ? " long" : ""}`}>
          <div className="mrun">
            <MachineGlyph />
            <span className="t">
              {m.label} · <b>{m.fa}</b>
              {m.order ? ` · ${m.order}` : ""}
            </span>
            <Clock start={m.start} now={now} />
            {canStop && (
              <button type="button" className="btn sm" onClick={() => setOpen(open === m.workorderId ? null : m.workorderId)}>
                Beenden
              </button>
            )}
            <OdooLink base={odooUrl} id={m.productionId} s={15} />
          </div>
          {m.long && <div className="mhint">Läuft länger als geplant · {since(m.start, now)}</div>}
          {open === m.workorderId && (
            <MachineStop
              run={m}
              employeeId={employeeId}
              onCancel={() => setOpen(null)}
              onDone={() => {
                setOpen(null);
                onChanged && onChanged();
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function PersonLine({ b, now, main }) {
  const prod = splitProduct(b.product);
  return (
    <div className={`bnow${main ? "" : " extra"}`}>
      <div className="bact">{b.label}</div>
      <Clock start={b.start} now={now} />
      <div className="bjob">
        <JobRef fa={b.fa} order={b.order} />
        {prod.name && <span title={prod.code || undefined}>{prod.name}</span>}
      </div>
      {b.forgotten && <div className="bsince">{since(b.start, now)}</div>}
      <Complaints list={b.complaints} />
    </div>
  );
}

export function TeamCard({ c, now, odooUrl, session, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const own = session && session.id === c.id;
  const operate = canOperate(session);
  const mayStop = operate && (own || session.leitung);
  const linkId = (c.person && c.person.productionId) || (c.machine[0] && c.machine[0].productionId);
  async function run(body, msg) {
    setBusy(true);
    try {
      await act(body);
      toast(msg);
      onChanged && onChanged();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={`bcard st-${c.state}${own ? " own" : ""}`}>
      <header>
        <span className={`bav${c.present ? " here" : ""}`} title={c.present ? "Anwesend" : "Nicht da"}>
          <Avatar id={c.id} name={c.name} size={46} />
        </span>
        <b className="bname">{c.name}</b>
        <OdooLink base={odooUrl} id={linkId} s={17} />
      </header>
      {c.double && <div className="bflag">Doppelt gestempelt</div>}
      {c.persons.length ? (
        c.persons.map((b, i) => <PersonLine key={bookingKey(b)} b={b} now={now} main={i === 0} />)
      ) : (
        <div className="bnow none">{c.present && !c.machine.length ? "Nichts gebucht" : ""}</div>
      )}
      <MachineRuns list={c.machine} now={now} odooUrl={odooUrl} canStop={mayStop} employeeId={own ? undefined : c.id} onChanged={onChanged} />
      {mayStop && c.persons.length > 0 && (
        <div className="bcard-act">
          {own && (
            <button type="button" className="bbtn" disabled={busy} onClick={() => run({ action: "pause" }, "Unterbrochen")}>
              Unterbrechen
            </button>
          )}
          <button
            type="button"
            className="bbtn"
            disabled={busy}
            onClick={() => run({ action: "stop", ...bookingRef(c.persons[0]), employeeId: own ? undefined : c.id }, own ? "Gestoppt" : `${c.persons[0].label} von ${c.name} beendet`)}
          >
            {own ? "Stopp" : "Beenden"}
          </button>
        </div>
      )}
    </article>
  );
}

export function TeamGrid({ data, now, session, onChanged }) {
  return (
    <>
      <div className="bgrid">
        {data.cards.map((c) => (
          <TeamCard key={c.id} c={c} now={now} odooUrl={data.odooUrl} session={session} onChanged={onChanged} />
        ))}
      </div>
      <div className="blegend" aria-label="Farben">
        <span>
          <i className="st-run" />
          Läuft
        </span>
        <span>
          <i className="st-idle" />
          Da, nichts gebucht
        </span>
        <span>
          <i className="st-double" />
          Doppelt gestempelt
        </span>
        <span>
          <i className="st-alarm" />
          Buchung vergessen?
        </span>
        <span>
          <i className="st-away" />
          Nicht da
        </span>
      </div>
    </>
  );
}

export default function Team({ kiosk, goTo }) {
  const { data, error, reload } = useBdeTeam();
  const [sessKey, setSessKey] = useState(0);
  const session = useBdeSession(sessKey);
  const now = useNow();
  const toggleKiosk = () => {
    if (kiosk) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      goTo("team");
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {});
      goTo("team/vollbild");
    }
  };
  return (
    <div className={`bde${kiosk ? " kiosk" : ""}`}>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p>Wer arbeitet woran{data && data.at ? ` · Stand ${fmtTime(data.at)}` : ""}</p>
        </div>
        <div className="actions">
          {kiosk && <span className="kclock mono">{fmtTime(now)}</span>}
          <button type="button" className="btn" onClick={toggleKiosk}>
            <Ico n={kiosk ? "x" : "full"} s={16} />
            {kiosk ? "Vollbild beenden" : "Vollbild"}
          </button>
        </div>
      </div>
      {(error || (data && data.notice)) && <div className="bnote">{error || data.notice}</div>}
      {!data && !error && <div className="bnote quiet">Lade Daten aus Odoo …</div>}
      {data && (
        <TeamGrid
          data={data}
          now={now}
          session={session}
          onChanged={() => {
            reload();
            setSessKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
