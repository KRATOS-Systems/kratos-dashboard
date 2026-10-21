import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { DEFAULT_WEEK_CAPACITY, SHIFT_MODELS, todayStr } from "./lib.js";
import Planning from "./Planning.jsx";
import Dashboard from "./Dashboard.jsx";
import { Palette, Alerts, alertsList } from "./Overlays.jsx";
import { BrandMark, WordMark, Ico, SvgDefs, ToastProvider } from "./ui.jsx";

const THEME_STORAGE_KEY = "kratos-dashboard-theme";

// Die Planung ist die erste Seite und öffnet beim Start
const PAGES = [
  { id: "planung", label: "Produktionsplanung", icon: "plan" },
  { id: "av", label: "Arbeitsvorbereitung", icon: "av" },
  { id: "dashboard", label: "Dashboard", icon: "dash" },
];
const readPage = () => (window.location.hash === "#dashboard" ? "dashboard" : window.location.hash === "#av" ? "av" : "planung");

function initialMode() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ohne Speicher gilt die Systemeinstellung */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [mode, setMode] = useState(initialMode);
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", mode);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      /* egal */
    }
  }, [mode]);
  const toggleMode = () => {
    const r = document.documentElement;
    r.classList.add("theming");
    setMode((m) => (m === "dark" ? "light" : "dark"));
    setTimeout(() => r.classList.remove("theming"), 450);
  };

  const [page, setPage] = useState(readPage);
  const [anim, setAnim] = useState(true);
  useEffect(() => {
    const onHash = () => {
      setPage(readPage());
      setAnim(true);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!anim) return undefined;
    const t = setTimeout(() => setAnim(false), 1600);
    return () => clearTimeout(t);
  }, [anim, page]);
  useEffect(() => {
    document.title = `Kratos ${PAGES.find((p) => p.id === page).label}`;
    window.scrollTo(0, 0);
  }, [page]);
  const goTo = useCallback((id) => {
    if (window.location.hash === `#${id}`) {
      setPage(id);
      setAnim(true);
    } else window.location.hash = id;
  }, []);

  const today = useMemo(() => todayStr(), []);
  const [weekCap, setWeekCap] = useState({}); // Schichtmodell (Stunden) je Woche. Schlüssel = Montag der Ablesung, ab dem es für die KOMMENDE Woche gilt
  const [capLoaded, setCapLoaded] = useState(false);
  useEffect(() => {
    fetch("/api/week-capacity")
      .then((r) => r.json())
      .then((d) => setWeekCap(d.capacities))
      .catch(() => {})
      .finally(() => setCapLoaded(true));
  }, []);
  function saveCapacity(date, hours) {
    setWeekCap((c) => ({ ...c, [date]: hours }));
    fetch("/api/week-capacity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, capacity_hours: hours }),
    }).catch((err) => console.error("Speichern fehlgeschlagen", err));
  }
  function deleteCapacity(date) {
    setWeekCap((c) => {
      const next = { ...c };
      delete next[date];
      return next;
    });
    fetch(`/api/week-capacity/${date}`, { method: "DELETE" }).catch((err) => console.error("Löschen fehlgeschlagen", err));
  }

  // Schichtmodell der laufenden Woche: der zuletzt eingetragene Wert bis heute (gilt, bis ein neuer eingetragen wird)
  const shiftNow = useMemo(() => {
    const last = Object.keys(weekCap)
      .filter((d) => d <= today)
      .sort()
      .pop();
    const hours = last ? weekCap[last] : DEFAULT_WEEK_CAPACITY;
    const model = SHIFT_MODELS.find((s) => s.hours === hours);
    return { hours, label: model ? model.label : "Eigener Wert" };
  }, [weekCap, today]);

  // Daten der Planung für Suche, Hinweise und Talos
  const [shared, setShared] = useState(null);
  const [avCount, setAvCount] = useState(0);
  const [openReq, setOpenReq] = useState(null);
  const openPosition = useCallback(
    (id, p) => {
      if (p) goTo(p);
      else if (page === "dashboard") goTo("planung");
      setOpenReq({ id, n: Date.now() });
    },
    [goTo, page]
  );

  const [showSearch, setShowSearch] = useState(false);
  const [talosQ, setTalosQ] = useState(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showData, setShowData] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setTalosQ(null);
        setShowSearch((v) => !v);
      } else if (e.key === "Escape") {
        setShowSearch(false);
        setShowAlerts(false);
        setShowData(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const alertTotal = useMemo(() => (shared ? alertsList(shared).reduce((a, g) => a + g.items.length, 0) : 0), [shared]);

  // Markierung der aktiven Seite in der Navigation
  const navRef = useRef(null);
  const [indY, setIndY] = useState(0);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const on = nav && nav.querySelector("button.on");
    if (on) setIndY(on.offsetTop + (on.offsetHeight - 20) / 2);
  }, [page, avCount]);

  return (
    <ToastProvider>
      <SvgDefs />
      <div className="app">
        <aside className="side">
          <div className="brand">
            <BrandMark size={34} />
            <div>
              <WordMark width={92} />
              <small>PRODUKTION</small>
            </div>
          </div>
          <nav className="nav" ref={navRef} aria-label="Hauptnavigation">
            <i className="navind" style={{ transform: `translateY(${indY}px)` }} />
            {PAGES.map((p) => (
              <button key={p.id} type="button" className={page === p.id ? "on" : ""} onClick={() => goTo(p.id)}>
                <Ico n={p.icon} />
                <span>{p.label}</span>
                {p.id === "av" && avCount > 0 && (
                  <span className="badge" title={`${avCount} Position(en) starten in den nächsten 7 Tagen und sind noch nicht bereit`}>
                    {avCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="side-foot">
            <button
              type="button"
              className="ghost-dark"
              aria-label="Suchen"
              onClick={() => {
                setTalosQ(null);
                setShowSearch(true);
              }}
            >
              <Ico n="search" />
              <span className="lbl">Suchen</span>
              <kbd>Strg K</kbd>
            </button>
            <button type="button" className="ghost-dark" aria-label="Hinweise" onClick={() => setShowAlerts((v) => !v)} data-alertbtn>
              <Ico n="bell" />
              <span className="lbl">Hinweise</span>
              {alertTotal > 0 && (
                <span className="cnt2" key={alertTotal}>
                  {alertTotal}
                </span>
              )}
            </button>
            <button type="button" className="ghost-dark" onClick={() => setShowData(true)}>
              <Ico n="save" />
              <span className="lbl">Datensicherung</span>
            </button>
            <button type="button" className="ghost-dark" onClick={toggleMode}>
              <Ico n={mode === "dark" ? "sun" : "moon"} />
              <span className="lbl">{mode === "dark" ? "Hell" : "Dunkel"}</span>
            </button>
          </div>
        </aside>
        <main className={`main${anim ? " anim" : ""}`} key={page === "dashboard" ? "dash" : "plan"}>
          {page !== "dashboard" && (
            <Planning
              section={page}
              today={today}
              shift={shiftNow}
              weekCap={weekCap}
              onSaveShift={saveCapacity}
              onDeleteShift={deleteCapacity}
              onAvCount={setAvCount}
              onShared={setShared}
              openReq={openReq}
              onOpenHandled={() => setOpenReq(null)}
              goTo={goTo}
              openTalos={(q) => {
                setTalosQ(q);
                setShowSearch(true);
              }}
            />
          )}
          {page === "dashboard" && capLoaded && <Dashboard weekCap={weekCap} saveCapacity={saveCapacity} today={today} shared={shared} openTalos={(q) => { setTalosQ(q); setShowSearch(true); }} />}
        </main>
      </div>
      {showSearch && (
        <Palette
          shared={shared}
          initialTalos={talosQ}
          onClose={() => setShowSearch(false)}
          onOpenPosition={(id) => {
            setShowSearch(false);
            openPosition(id);
          }}
          onGoPage={(id) => {
            setShowSearch(false);
            goTo(id);
          }}
        />
      )}
      {showAlerts && (
        <Alerts
          shared={shared}
          onClose={() => setShowAlerts(false)}
          onOpenPosition={(id) => {
            setShowAlerts(false);
            openPosition(id);
          }}
        />
      )}
      {showData && <DataDialog onClose={() => setShowData(false)} />}
    </ToastProvider>
  );
}

// Datensicherung: Backup herunterladen oder einspielen (ersetzt alle Daten, erst nach Bestätigung)
function DataDialog({ onClose }) {
  const [restore, setRestore] = useState(null); // { backup, counts, created, name } oder { error }
  async function onRestoreFile(ev) {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const res = await fetch("/api/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup, dryRun: true }),
      });
      const data = await res.json();
      setRestore(res.ok ? { backup, counts: data.counts, created: data.created, name: file.name } : { error: data.error });
    } catch {
      setRestore({ error: "Die Datei konnte nicht gelesen werden" });
    }
  }
  async function doRestore() {
    const res = await fetch("/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backup: restore.backup }),
    });
    const data = await res.json();
    if (res.ok) window.location.reload();
    else setRestore({ error: data.error });
  }
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Datensicherung">
        <h3>Datensicherung</h3>
        <p>Speichert alle Zählerstände, Aufträge, Arbeitsvorbereitung und Einstellungen als Datei.</p>
        <div className="actions">
          <a className="btn primary" href="/api/backup" download>
            <Ico n="down" s={16} />
            Backup herunterladen
          </a>
          <label className="btn" style={{ cursor: "pointer" }}>
            Backup einspielen
            <input type="file" accept=".json,application/json" onChange={onRestoreFile} style={{ display: "none" }} />
          </label>
        </div>
        {restore && (
          <div className="note" style={{ marginTop: 16, borderColor: restore.error ? "var(--bad)" : "var(--warn)" }}>
            {restore.error ? (
              <>
                <b style={{ color: "var(--bad)" }}>{restore.error}</b>
                <div className="actions" style={{ marginTop: 10 }}>
                  <button type="button" className="btn sm" onClick={() => setRestore(null)}>
                    Schließen
                  </button>
                </div>
              </>
            ) : (
              <>
                <b>
                  Backup {restore.created ? `vom ${restore.created.slice(0, 10)}` : restore.name} enthält: {restore.counts.readings} Zählerstände, {restore.counts.orders} Positionen, {restore.counts.free_days} freie Tage
                </b>
                <div style={{ color: "var(--bad)", marginTop: 6 }}>
                  Achtung: Beim Einspielen werden ALLE aktuellen Daten durch den Inhalt der Datei ersetzt. Lade vorher ein aktuelles Backup herunter, wenn du die jetzigen Daten behalten willst.
                </div>
                <div className="actions" style={{ marginTop: 10 }}>
                  <button type="button" className="btn sm" style={{ background: "var(--bad)", color: "#fff", borderColor: "var(--bad)" }} onClick={doRestore}>
                    Jetzt einspielen
                  </button>
                  <button type="button" className="btn sm" onClick={() => setRestore(null)}>
                    Abbrechen
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <div className="actions" style={{ marginTop: 18, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
