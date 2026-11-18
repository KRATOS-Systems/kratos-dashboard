import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Extern & Wareneingang: bestellt, aber noch nicht da (Wareneingang nicht validiert), wer muss nachfragen, wo fehlt eine Bestellung,
// wie pünktlich sind die Lieferanten. Daten aus server/extern.js (Odoo, nur lesen). Die App sendet keine Mails selbst.

const day = (s) => (s ? fmtShort(s) : "–");
const STATUS = {
  ueberfaellig: (x) => `${x.tage} ${x.tage === 1 ? "Tag" : "Tage"} überfällig`,
  heute: () => "heute fällig",
  bald: () => "in 2 Werktagen fällig",
  ok: () => "im Plan",
  "ohne Termin": () => "ohne Termin",
};
const AKTION = { anfragen: "Lieferant anfragen", erneut: "Erneut anfragen (keine Antwort)", vorab: "Vorab nachfragen", warten: "Angefragt, wartet auf Antwort" };

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Hat nicht geklappt");
  return j;
}

function MailBox({ x, onClose, onChanged }) {
  const [m, setM] = useState(null);
  const [marked, setMarked] = useState(false); // beim Öffnen automatisch "angefragt per Mail" abgehakt
  const [lang, setLang] = useState(x.lang);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    fetch(`/api/extern/${encodeURIComponent(x.po)}/mail?lang=${lang}${x.aktion === "vorab" ? "&vorab=1" : ""}`)
      .then((r) => r.json())
      .then(setM)
      .catch(() => setM({ error: "Entwurf nicht lesbar" }));
  }, [x.po, lang]);
  if (!m) return <div className="fg-faint">Entwurf wird erstellt …</div>;
  if (m.error) return <div className="fg-err">{m.error}</div>;
  const copy = () => {
    const t = `${m.subject}\n\n${m.body}`;
    navigator.clipboard?.writeText(t).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div className="ex-mail">
      <div className="ex-mail-top">
        <span>
          An <b>{m.to || "keine Mailadresse in Odoo"}</b>
        </span>
        <span className="ex-lang">
          <button type="button" className={lang === "de" ? "on" : ""} onClick={() => setLang("de")}>
            Deutsch
          </button>
          <button type="button" className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
            Englisch
          </button>
        </span>
      </div>
      <div className="ex-subj">{m.subject}</div>
      <pre className="ex-body">{m.body}</pre>
      <div className="fg-actions">
        {m.to && (
          <a
            className="btn sm primary"
            href={m.mailto}
            onClick={() => {
              // Öffnen zählt als angefragt; falls die Mail doch nicht rausgeht: Rückgängig
              post(`/api/extern/${encodeURIComponent(x.po)}/angefragt`, { weg: "mail" })
                .then(() => (setMarked(true), onChanged && onChanged()))
                .catch(() => {});
            }}
          >
            Im Mailprogramm öffnen
          </a>
        )}
        <button type="button" className="btn sm" onClick={copy}>
          {copied ? "Kopiert" : "Text kopieren"}
        </button>
        <button type="button" className="btn sm" onClick={onClose}>
          Schließen
        </button>
      </div>
      {marked ? (
        <div className="fg-msg">
          Als „angefragt per Mail“ abgehakt.{" "}
          <button
            type="button"
            className="fg-more"
            onClick={() => post(`/api/extern/${encodeURIComponent(x.po)}/rueckgaengig`, {}).then(() => (setMarked(false), onChanged && onChanged())).catch(() => {})}
          >
            Rückgängig (Mail nicht abgeschickt)
          </button>
        </div>
      ) : (
        <div className="fg-faint">Die App sendet nichts. Die Mail öffnet sich im Mailprogramm; beim Öffnen wird „angefragt per Mail“ abgehakt.</div>
      )}
    </div>
  );
}

function Karte({ x, onChanged }) {
  const [mail, setMail] = useState(false);
  const [termin, setTermin] = useState("");
  const [notiz, setNotiz] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async (fn) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const bad = x.status === "ueberfaellig" || x.aktion === "erneut";
  return (
    <div className={`fg-card ex-card${bad ? " warnung" : ""}`}>
      <div className="fg-top">
        <b>{x.po}</b>
        <span>{x.lieferant}</span>
        <span className="ex-art">{x.art}</span>
        <span className={`ex-st ${x.status}`}>{STATUS[x.status] ? STATUS[x.status](x) : x.status}</span>
      </div>
      <div className="fg-faint">
        {x.wareneingang.length ? `Wareneingang ${x.wareneingang.join(", ")} nicht validiert` : "kein Wareneingang angelegt"}
        {x.partnerRef ? ` · deren Ref. ${x.partnerRef}` : ""} · bestellt {day(x.bestellt)} · zugesagt {day(x.zugesagt)}
        {x.neuerTermin ? ` · neuer Termin ${day(x.neuerTermin)}` : ""}
        {x.teilweise ? " · teilweise geliefert" : ""}
      </div>
      <ul className="fg-notes">
        {x.lines
          .filter((l) => l.offen > 0)
          .slice(0, 6)
          .map((l, i) => (
            <li key={i}>
              {l.offen} × {l.name}
            </li>
          ))}
        {x.lines.filter((l) => l.offen > 0).length > 6 && <li className="fg-faint">… {x.lines.filter((l) => l.offen > 0).length - 6} weitere</li>}
      </ul>
      {x.betroffen.length > 0 && (
        <div className="ex-betr">
          Hängt dran:{" "}
          {x.betroffen.map((b) => (
            <span key={b.id} className={b.due && x.termin && b.due <= x.termin ? "bad" : ""} title={b.customer || ""}>
              {b.ref}
              {b.source && b.source !== b.ref ? ` (${b.source})` : ""}
              {b.due ? `, Termin ${day(b.due)}` : ""}
            </span>
          ))}
          {x.kundeGefahr && <b className="bad"> · Kundentermin in Gefahr</b>}
        </div>
      )}
      <div className="fg-faint">
        {[x.email, x.phone].filter(Boolean).join(" · ") || "Keine Kontaktdaten in Odoo"}
        {x.angefragt ? ` · angefragt ${day(x.angefragt)}${x.angefragtVon ? " von " + x.angefragtVon : ""}` : ""}
      </div>
      {x.aktion && <div className={`ex-todo ${x.aktion}`}>{AKTION[x.aktion]}</div>}
      {mail ? (
        <MailBox x={x} onClose={() => setMail(false)} onChanged={onChanged} />
      ) : (
        <div className="fg-actions">
          <button type="button" className={`btn sm${x.aktion && x.aktion !== "warten" ? " primary" : ""}`} onClick={() => setMail(true)}>
            Mail an Lieferant
          </button>
          <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => post(`/api/extern/${encodeURIComponent(x.po)}/angefragt`, { weg: "mail", notiz }))}>
            Angefragt per Mail
          </button>
          <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => post(`/api/extern/${encodeURIComponent(x.po)}/angefragt`, { weg: "telefon", notiz }))}>
            Angefragt per Telefon
          </button>
        </div>
      )}
      <div className="fg-actions">
        <label className="ex-new">
          Neuer Termin vom Lieferanten
          <input type="date" value={termin} onChange={(e) => setTermin(e.target.value)} />
        </label>
        <span className="ex-quick">
          {[["+3 Tage", 3], ["+1 Woche", 7], ["+2 Wochen", 14]].map(([l, n]) => (
            <button key={l} type="button" onClick={() => setTermin(new Date(Date.now() + n * 86400000).toLocaleDateString("sv-SE"))} title="ab heute">
              {l}
            </button>
          ))}
        </span>
        <input className="ex-notiz" value={notiz} onChange={(e) => setNotiz(e.target.value)} placeholder="Notiz (freiwillig)" maxLength={300} />
        <button type="button" className="btn sm" disabled={busy || !termin} onClick={() => run(() => post(`/api/extern/${encodeURIComponent(x.po)}/termin`, { termin, notiz }).then(() => setTermin("")))}>
          Termin übernehmen
        </button>
        {err && <span className="fg-err">{err}</span>}
      </div>
      {x.verlauf.length > 0 && (
        <div className="ex-log">
          {x.verlauf
            .slice(-4)
            .reverse()
            .map((v, i) => (
              <div key={i}>
                {new Date(v.at).toLocaleDateString("de-DE")} {v.was}
                {v.von ? ` (${v.von})` : ""}
                {v.notiz ? `: ${v.notiz}` : ""}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export default function Extern({ reloadKey, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [alt, setAlt] = useState(false);
  const load = (neu) => {
    setBusy(true);
    return fetch("/api/extern" + (neu ? "?neu=1" : ""))
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "nicht lesbar");
        setD(j);
        setErr("");
      })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    load(false);
  }, [reloadKey]);
  if (!d) return <div className="card ex fg-faint">{err ? `Extern: ${err}` : "Extern wird geladen …"}</div>;
  if (!d.enabled) return <div className="card ex fg-faint">Odoo ist nicht angebunden, deshalb gibt es hier nichts zu sehen.</div>;
  const changed = () => {
    load(false);
    onChanged && onChanged();
  };
  const todo = d.offen.filter((x) => x.aktion);
  const z = d.zahlen;
  return (
    <div className="card ex">
      <div className="kz-head">
        <b>Extern & Wareneingang</b>
        <span className="fg-faint">Stand {new Date(d.stand).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} · aus Odoo, nur gelesen</span>
        <button type="button" className="btn sm" disabled={busy} onClick={() => load(true)}>
          {busy ? "Lädt …" : "Neu laden"}
        </button>
      </div>
      <div className="ex-chips">
        <span className={z.ueberfaellig ? "bad" : ""}>
          <b>{z.ueberfaellig}</b> überfällig
        </span>
        <span className={z.anfragen ? "bad" : ""}>
          <b>{z.anfragen}</b> anfragen
        </span>
        <span className={z.vorab ? "warn" : ""}>
          <b>{z.vorab}</b> vorab nachfragen
        </span>
        <span className={z.fehltDringend ? "warn" : ""}>
          <b>{z.fehlt}</b> ohne Bestellung{z.fehltDringend ? ` (${z.fehltDringend} dringend)` : ""}
        </span>
        <span className={z.kundeGefahr ? "bad" : ""}>
          <b>{z.kundeGefahr}</b> Kundentermin in Gefahr
        </span>
      </div>
      {err && <div className="fg-err">{err}</div>}

      <section className="ex-sec">
        <h4>Handlungsbedarf</h4>
        {todo.length ? (
          <div className="fg-grid">
            {todo.map((x) => (
              <Karte key={x.po} x={x} onChanged={changed} />
            ))}
          </div>
        ) : (
          <div className="fg-faint">Keine Lieferung überfällig oder kurz vor dem Termin.</div>
        )}
      </section>

      <section className="ex-sec">
        <h4>Externer Arbeitsgang ohne Bestellung</h4>
        <p className="fg-faint">Strahlen, Schleifen, Härten, Oberfläche, Drehen extern laut Arbeitsplan, aber keine passende bestätigte Bestellung (Lohnarbeit oder Zukauf des Teils). Dringend = Maschine ist in 7 Tagen fertig.</p>
        {d.fehlt.length ? (
          <div className="fg-detail">
            <table>
              <thead>
                <tr>
                  <th>FA</th>
                  <th>Auftrag</th>
                  <th>Schritt</th>
                  <th>Maschine fertig</th>
                  <th>Liefertermin</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.fehlt.map((x, i) => (
                  <tr key={x.fa + i}>
                    <td>{x.fa}</td>
                    <td>
                      {x.source || "–"} <span className="fg-faint">{x.customer || ""}</span>
                    </td>
                    <td>
                      {x.schritt} <span className="fg-faint">{x.arbeitsplatz}</span>
                    </td>
                    <td className={x.dringend ? "warn" : ""}>{x.maschineFertig ? day(x.maschineFertig) : x.inApp ? "nicht eingeplant" : "nicht in der App"}</td>
                    <td>{day(x.due)}</td>
                    <td className="fg-faint">{x.anfrage ? `Anfrage ${x.anfrage}, noch nicht bestellt` : x.dringend ? <b className="warn">bestellen</b> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="fg-faint">Alle externen Arbeitsgänge sind bestellt.</div>
        )}
      </section>

      <section className="ex-sec">
        <h4>Alle offenen Wareneingänge</h4>
        <div className="fg-detail">
          <table>
            <thead>
              <tr>
                <th>Termin</th>
                <th>Bestellung</th>
                <th>Lieferant</th>
                <th>Art</th>
                <th>Stand</th>
                <th>Hängt dran</th>
              </tr>
            </thead>
            <tbody>
              {d.offen.map((x) => (
                <tr key={x.po}>
                  <td>{day(x.termin)}</td>
                  <td>
                    {x.po} <span className="fg-faint">{x.wareneingang.join(", ")}</span>
                  </td>
                  <td>{x.lieferant}</td>
                  <td>{x.art}</td>
                  <td className={x.status === "ueberfaellig" ? "bad" : x.status === "heute" || x.status === "bald" ? "warn" : ""}>
                    {STATUS[x.status] ? STATUS[x.status](x) : x.status}
                    {x.angefragt ? <span className="fg-faint"> · angefragt {day(x.angefragt)}</span> : ""}
                  </td>
                  <td className={x.kundeGefahr ? "bad" : ""}>{x.betroffen.map((b) => b.ref).join(", ") || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ex-sec">
        <h4>Termintreue der Lieferanten (12 Monate)</h4>
        <p className="fg-faint">Validierte Wareneingänge gegen den zugesagten Termin. Durchlauf = Bestellung bis Wareneingang (Median).</p>
        <div className="fg-detail">
          <table>
            <thead>
              <tr>
                <th>Lieferant</th>
                <th>Eingänge</th>
                <th>pünktlich</th>
                <th>zu spät im Schnitt</th>
                <th>Durchlauf</th>
                <th>jetzt offen</th>
              </tr>
            </thead>
            <tbody>
              {d.bewertung.map((b) => (
                <tr key={b.lieferant}>
                  <td>{b.lieferant}</td>
                  <td>{b.eingaenge || "–"}</td>
                  <td className={b.quote == null ? "" : b.quote >= 90 ? "ok" : b.quote >= 70 ? "warn" : "bad"}>{b.quote == null ? "–" : b.quote + " %"}</td>
                  <td>{b.spaetSchnitt ? `${String(b.spaetSchnitt).replace(".", ",")} Tage` : "–"}</td>
                  <td>{b.durchlaufMedian != null ? `${b.durchlaufMedian} Tage` : "–"}</td>
                  <td className={b.ueberfaellig ? "bad" : ""}>
                    {b.offen}
                    {b.ueberfaellig ? ` (${b.ueberfaellig} überfällig)` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {d.altlasten.length > 0 && (
        <section className="ex-sec">
          <button type="button" className="fg-more" onClick={() => setAlt((v) => !v)}>
            {alt ? "Altlasten ausblenden" : `${d.altlasten.length} Altlasten in Odoo (zum Aufräumen)`}
          </button>
          {alt && (
            <ul className="fg-notes">
              {d.altlasten.map((a) => (
                <li key={a.ref}>
                  <b>{a.ref}</b> {a.lieferant} · {day(a.datum)} · {a.grund}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
