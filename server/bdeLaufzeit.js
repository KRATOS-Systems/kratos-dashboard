// Arbeitsgänge fertig melden, Fertigungsauftrag abschließen, weiterer Arbeitsschritt auf einer anderen Maschine und die Programmlaufzeit je Aufspannung (Fräsen).
//
// Laufzeit: Mehrere Aufspannungen bleiben EIN Arbeitsgang "Fräsen" je Maschine in Odoo. Die Zeiten stehen als interne Notizen im Verlauf des
// Fertigungsauftrags, eine Zeile je Eintrag in festem Aufbau (keine eigenen Odoo-Felder oder -Modelle, nichts muss in Odoo eingerichtet werden):
//   "Aufspannungen (DMU 40 EVO): 3 (Aurel Rama, 29.10.2026)"
//   "Laufzeit Aufspannung 2 (DMU 40 EVO): 12:00 Min:Sek für 2 Teile = 6:00 je Stück (Aurel Rama, 29.10.2026[, Programm geändert | , unverändert])"
// Die Maschine in Klammern ist der Arbeitsplatz des Fräsen-Arbeitsgangs. Aufspannung 1, 2 ... zählt je Maschine. Je Maschine und Aufspannung
// gilt die neueste Notiz. Notizen ohne Maschine (von Hand oder älter) zählen für jede Maschine, die keine eigenen hat. Wer eine Zeile so
// umschreibt, dass sie nicht mehr lesbar ist, wird einfach neu gefragt. Die Zeiterfassung (mrp.workcenter.productivity) wird hier weder gelesen
// noch geändert: die Stempelzeit des Arbeitsgangs (mrp.workorder.duration) dient nur dem Plausibilitätsvergleich.
//
// Fertig melden: mrp.workorder.button_finish, Odoo gibt den nächsten Arbeitsgang selbst frei. Beim Fräsen nur mit vollständigen Laufzeiten.
// Auftrag abschließen: mrp.production.button_mark_done, erst wenn alle Arbeitsgänge fertig sind (die QS ist der letzte).
// Weiterer Arbeitsschritt: hängt "Rüsten" und "Fräsen" einer anderen Maschine vor die QS, solange der Fertigungsauftrag nicht abgeschlossen ist.

import { m2o, parseOdoo, toOdoo, isPhone, stepOf } from "./bde.js";

const WO_FIELDS = ["name", "state", "workcenter_id", "production_id", "product_id", "qty_production", "duration", "sequence"];
const MAX_AUFSPANNUNGEN = 20;
const MAX_SECONDS = 24 * 3600;
const MAX_MINUTES = 60 * 24 * 14;
const userErr = (msg) => Object.assign(new Error(msg), { user: true });
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const mmss = (min) => {
  const s = Math.round(min * 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Notiz-HTML aus Odoo -> reiner Text
const plain = (html) =>
  String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const RE_ANZAHL = /Aufspannungen(?: \(([^)]+)\))?:\s*(\d+)/;
const RE_ZEILE = /Laufzeit Aufspannung (\d+)(?: \(([^)]+)\))?:\s*(\d+):(\d{2})(?:\D+?(\d+)\s*Teil)?/;
const RE_VON = /\(([^,)]+),/;
const FINAL = ["done", "cancel"];

// Schritt eines Arbeitsgangs (am Namen, sonst am Arbeitsplatz)
const stepOfWo = (w) => stepOf(w.name) || stepOf(m2o(w.workcenter_id)?.name);
const machineOf = (w) => m2o(w.workcenter_id)?.name || "";

export default function registerBdeLaufzeit(app, ctx) {
  const { odoo } = ctx;

  // Fräsen-Arbeitsgang finden: direkt per Nummer oder über den Fertigungsauftrag (dort der erste noch nicht erledigte, sonst der letzte)
  async function fraesenOf({ workorderId, productionId }) {
    let w = null;
    if (Number.isInteger(workorderId) && workorderId > 0) [w] = await odoo.read("mrp.workorder", "read", { ids: [workorderId], fields: WO_FIELDS });
    else if (Number.isInteger(productionId) && productionId > 0) {
      const rows = (await odoo.read("mrp.workorder", "search_read", { domain: [["production_id", "=", productionId], ["state", "!=", "cancel"]], fields: WO_FIELDS, order: "id asc", limit: 30 })).filter(
        (r) => stepOfWo(r) === "Fräsen"
      );
      w = rows.find((r) => !FINAL.includes(r.state)) || rows[rows.length - 1] || null;
    }
    if (!w) throw userErr("Arbeitsgang nicht gefunden");
    if (stepOfWo(w) !== "Fräsen") throw userErr("Laufzeiten gibt es nur beim Fräsen");
    return w;
  }

  // Alle Laufzeit-Notizen der Fertigungsaufträge lesen: Fertigungsauftrag -> Maschine -> { anzahl, rows: Map nr -> Zeile }, die neueste Notiz gilt
  async function notesOf(productionIds) {
    const out = new Map();
    if (!productionIds.length) return out;
    const msgs = await odoo.read("mail.message", "search_read", {
      domain: [["model", "=", "mrp.production"], ["res_id", "in", productionIds], ["message_type", "=", "comment"], ["body", "ilike", "Aufspannung"]],
      fields: ["res_id", "body", "date"],
      order: "id asc",
      limit: 1000,
    });
    for (const m of msgs) {
      const text = plain(m.body);
      const z = RE_ZEILE.exec(text);
      const a = z ? null : RE_ANZAHL.exec(text);
      if (!z && !(a && Number(a[2]) > 0)) continue;
      const machines = out.get(m.res_id) || new Map();
      out.set(m.res_id, machines);
      const key = ((z ? z[2] : a[1]) || "").trim();
      const entry = machines.get(key) || { anzahl: 0, rows: new Map() };
      machines.set(key, entry);
      if (z) {
        const nr = Number(z[1]);
        const minutes = round(Number(z[3]) + Number(z[4]) / 60);
        const teile = Math.max(1, Number(z[5]) || 1);
        const von = RE_VON.exec(text);
        entry.rows.set(nr, {
          id: m.id,
          nr,
          minutes,
          teile,
          perPiece: round(minutes / teile),
          who: von ? von[1].trim() : null,
          at: parseOdoo(m.date),
          geaendert: /Programm geändert/.test(text),
          uebernommen: /unverändert/.test(text) && !/Programm geändert/.test(text),
        });
      } else entry.anzahl = Number(a[2]);
    }
    return out;
  }
  const entryFor = (notes, machine) => (notes && (notes.get(machine) || notes.get(""))) || { anzahl: 0, rows: new Map() };

  // Vorschlag bei Wiederholteilen: Zeiten des zuletzt erledigten Fräsens desselben Artikels auf derselben Maschine
  async function suggestionFor(w) {
    const pid = m2o(w.product_id)?.id;
    const wc = m2o(w.workcenter_id)?.id;
    if (!pid || !wc) return null;
    const prev = (
      await odoo.read("mrp.workorder", "search_read", { domain: [["id", "!=", w.id], ["product_id", "=", pid], ["workcenter_id", "=", wc], ["state", "=", "done"]], fields: ["production_id"], order: "id desc", limit: 15 })
    ).filter((p) => m2o(p.production_id));
    if (!prev.length) return null;
    const notes = await notesOf([...new Set(prev.map((p) => m2o(p.production_id).id))]);
    const machine = machineOf(w);
    for (const p of prev) {
      const prod = m2o(p.production_id);
      const n = entryFor(notes.get(prod.id), machine);
      if (!n.rows.size) continue;
      return {
        from: prod.name || null,
        anzahl: n.anzahl || n.rows.size,
        rows: [...n.rows.values()].map((r) => ({ nr: r.nr, minutes: r.minutes, teile: r.teile })).sort((a, b) => a.nr - b.nr),
      };
    }
    return null;
  }

  async function status(w) {
    const prod = m2o(w.production_id);
    const n = entryFor(prod ? (await notesOf([prod.id])).get(prod.id) : null, machineOf(w));
    const anzahl = n.anzahl || 0;
    const rows = [...n.rows.values()].sort((a, b) => a.nr - b.nr);
    const done = new Set(rows.map((r) => r.nr));
    const open = [];
    for (let i = 1; i <= anzahl; i++) if (!done.has(i)) open.push(i);
    const sum = round(rows.filter((r) => r.nr <= anzahl).reduce((s, r) => s + (r.perPiece || 0), 0));
    return {
      available: true,
      workorderId: w.id,
      productionId: prod ? prod.id : null,
      fa: prod ? prod.name : null,
      product: Array.isArray(w.product_id) ? String(w.product_id[1]) : null,
      machine: machineOf(w),
      state: w.state,
      qty: w.qty_production || 0,
      durationMin: w.duration || 0,
      anzahl,
      rows,
      open,
      complete: anzahl > 0 && open.length === 0,
      sumPerPiece: sum,
      suggestion: anzahl === 0 || open.length ? await suggestionFor(w) : null,
    };
  }

  // Arbeitsgänge eines Fertigungsauftrags: wie weit ist er, kann er abgeschlossen werden?
  async function productionInfo(productionId) {
    const [p] = await odoo.read("mrp.production", "read", { ids: [productionId], fields: ["name", "state"] });
    const rows = await odoo.read("mrp.workorder", "search_read", { domain: [["production_id", "=", productionId]], fields: WO_FIELDS, order: "sequence asc, id asc", limit: 40 });
    const steps = rows
      .filter((r) => r.state !== "cancel")
      .map((r) => ({ id: r.id, step: stepOfWo(r) || r.name, machine: machineOf(r), state: r.state, sequence: r.sequence || 0 }));
    return { id: productionId, fa: p ? p.name : null, state: p ? p.state : null, steps, allDone: steps.length > 0 && steps.every((s) => s.state === "done") };
  }

  // Notiz im Fertigungsauftrag ablegen (nur interne Notiz, keine E-Mail)
  const postNote = (productionId, html) => odoo.write("mrp.production", "message_post", { ids: [productionId], body: `<p>${html}</p>`, message_type: "comment", subtype_xmlid: "mail.mt_note" });
  const today = () => new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" });
  const nameOf = (id) => {
    const e = ctx.employees().get(id);
    return e ? e.name : "?";
  };

  // Alle Schreibwege: angemeldet, nicht am Handy, Bedienen freigeschaltet
  function guard(req, res) {
    const s = ctx.readSession(req);
    if (!s) {
      res.status(401).json({ error: "Bitte anmelden" });
      return null;
    }
    return s;
  }
  function guardWrite(req, res) {
    const s = guard(req, res);
    if (!s) return null;
    if (isPhone(req)) {
      res.status(403).json({ error: "Am Handy gibt es nur die Anzeige. Bitte am Tablet oder PC eintragen." });
      return null;
    }
    if (!odoo.writeEnabled) {
      res.status(403).json({ error: "Bedienen ist noch nicht freigeschaltet (BDE_WRITE)" });
      return null;
    }
    return s;
  }
  const toInt = (v) => (v == null || v === "" ? null : Number(v));
  const readWo = async (id) => {
    if (!Number.isInteger(id) || id <= 0) throw userErr("Arbeitsgang nicht gefunden");
    const [w] = await odoo.read("mrp.workorder", "read", { ids: [id], fields: WO_FIELDS });
    if (!w) throw userErr("Arbeitsgang nicht gefunden");
    return w;
  };

  app.get("/api/bde/laufzeit", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      await ctx.ensureEmployees();
      res.json(await status(await fraesenOf({ workorderId: toInt(req.query.workorderId), productionId: toInt(req.query.productionId) })));
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Eigene Arbeitsgänge der letzten 14 Tage, die gestoppt, aber noch nicht fertig gemeldet sind (Auffangnetz für Kiosk, kleines Fenster und
  // weggeklickte Fragen). Beim Fräsen steht dabei, wie viele Laufzeiten fehlen. Läuft der Arbeitsgang gerade, gehört er nicht in die Liste.
  app.get("/api/bde/offen", async (req, res) => {
    const s = guard(req, res);
    if (!s) return;
    try {
      const lines = await odoo.read("mrp.workcenter.productivity", "search_read", {
        domain: [["employee_id", "=", s.e], ["date_start", ">=", toOdoo(Date.now() - 14 * 24 * 3600 * 1000)]],
        fields: ["workorder_id", "workcenter_id", "date_end"],
        limit: 300,
      });
      const withWo = lines.filter((l) => m2o(l.workorder_id));
      const running = new Set(withWo.filter((l) => !l.date_end).map((l) => m2o(l.workorder_id).id));
      const ids = [...new Set(withWo.map((l) => m2o(l.workorder_id).id))].filter((id) => !running.has(id));
      if (!ids.length) return res.json({ items: [] });
      const wos = (await odoo.read("mrp.workorder", "read", { ids, fields: WO_FIELDS })).filter((w) => !FINAL.includes(w.state) && m2o(w.production_id) && stepOfWo(w));
      if (!wos.length) return res.json({ items: [] });
      const notes = await notesOf([...new Set(wos.map((w) => m2o(w.production_id).id))]);
      const items = wos.map((w) => {
        const step = stepOfWo(w);
        const n = step === "Fräsen" ? entryFor(notes.get(m2o(w.production_id).id), machineOf(w)) : null;
        return {
          workorderId: w.id,
          step,
          machine: machineOf(w),
          fa: m2o(w.production_id).name || null,
          productionId: m2o(w.production_id).id,
          product: Array.isArray(w.product_id) ? String(w.product_id[1]) : null,
          anzahl: n ? n.anzahl || 0 : 0,
          erfasst: n ? n.rows.size : 0,
        };
      });
      res.json({ items });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Anzahl der Aufspannungen festlegen (nach der Programmierung oder beim ersten Ausstempeln des Fräsens)
  app.post("/api/bde/laufzeit/anzahl", async (req, res) => {
    const s = guardWrite(req, res);
    if (!s) return;
    try {
      await ctx.ensureEmployees();
      const w = await fraesenOf({ workorderId: toInt(req.body && req.body.workorderId), productionId: toInt(req.body && req.body.productionId) });
      if (FINAL.includes(w.state)) throw userErr("Das Fräsen ist schon abgeschlossen");
      const n = toInt(req.body && req.body.anzahl);
      if (!Number.isInteger(n) || n < 1 || n > MAX_AUFSPANNUNGEN) throw userErr(`Die Anzahl der Aufspannungen muss zwischen 1 und ${MAX_AUFSPANNUNGEN} liegen`);
      const st = await status(w);
      const maxNr = Math.max(0, ...st.rows.map((r) => r.nr));
      if (n < maxNr) throw userErr(`Für Aufspannung ${maxNr} gibt es schon eine Laufzeit, weniger als ${maxNr} geht nicht`);
      if (!st.productionId) throw userErr("Der Arbeitsgang gehört zu keinem Fertigungsauftrag");
      if (st.anzahl !== n) await postNote(st.productionId, `<b>Aufspannungen (${escHtml(st.machine)}):</b> ${n} (${escHtml(nameOf(s.e))}, ${today()})`);
      res.json({ ok: true, ...(await status(w)) });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Laufzeit einer Aufspannung speichern (neu oder korrigieren: die neueste Notiz gilt)
  app.post("/api/bde/laufzeit/save", async (req, res) => {
    const s = guardWrite(req, res);
    if (!s) return;
    try {
      await ctx.ensureEmployees();
      const b = req.body || {};
      const w = await fraesenOf({ workorderId: toInt(b.workorderId), productionId: toInt(b.productionId) });
      if (FINAL.includes(w.state)) throw userErr("Das Fräsen ist schon abgeschlossen");
      const st = await status(w);
      const anzahl = st.anzahl;
      if (!anzahl) throw userErr("Bitte zuerst die Anzahl der Aufspannungen angeben");
      const nr = toInt(b.aufspannung);
      const sec = toInt(b.sekunden);
      const teile = b.teile == null || b.teile === "" ? 1 : toInt(b.teile);
      if (!Number.isInteger(nr) || nr < 1 || nr > anzahl) throw userErr(`Aufspannung 1 bis ${anzahl} wählen`);
      if (!Number.isInteger(sec) || sec < 1 || sec > MAX_SECONDS) throw userErr("Die Programmlaufzeit fehlt oder ist unglaubwürdig");
      if (!Number.isInteger(teile) || teile < 1 || teile > 9999) throw userErr("Teile je Aufspannung: eine ganze Zahl ab 1");
      const minutes = round(sec / 60);
      const perPiece = round(minutes / teile);

      // Plausibilität: Laufzeit je Stück (Summe) × Stückzahl darf die gestempelte Zeit des Fräsens nicht übersteigen
      const sumNew = round(st.rows.filter((r) => r.nr !== nr && r.nr <= anzahl).reduce((a, r) => a + (r.perPiece || 0), 0) + perPiece);
      const needed = sumNew * st.qty;
      if (!b.confirm && st.durationMin > 0 && st.qty > 0 && needed > st.durationMin) {
        return res.json({
          needsConfirm: true,
          warning: `Laufzeit je Stück ${mmss(sumNew)} (Min:Sek) × ${st.qty} Stück = ${Math.round(needed)} Minuten, gestempelt sind aber nur ${Math.round(st.durationMin)} Minuten. Vielleicht Minuten und Sekunden vertauscht?`,
          needed,
          stamped: st.durationMin,
        });
      }

      const geaendert = !!b.geaendert;
      const uebernommen = !!b.uebernommen && !geaendert;
      const tail = [nameOf(s.e), today(), geaendert ? "Programm geändert" : uebernommen ? "unverändert" : null].filter(Boolean).map(escHtml).join(", ");
      await postNote(
        st.productionId,
        `<b>Laufzeit Aufspannung ${nr} (${escHtml(st.machine)}):</b> ${mmss(minutes)} Min:Sek für ${teile} ${teile === 1 ? "Teil" : "Teile"} = ${mmss(perPiece)} je Stück (${tail})`
      );
      res.json({ ok: true, ...(await status(w)) });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Arbeitsgang fertig melden. Immer: es läuft keine Zeit mehr. Beim Fräsen zusätzlich: Anzahl steht fest und jede Aufspannung hat eine Laufzeit.
  async function finishWorkorder(w) {
    if (FINAL.includes(w.state)) throw userErr("Dieser Arbeitsgang ist schon abgeschlossen");
    const step = stepOfWo(w);
    if (step === "Fräsen") {
      const st = await status(w);
      if (!st.anzahl) throw userErr("Fräsen kann erst fertig gemeldet werden, wenn die Anzahl der Aufspannungen angegeben ist");
      if (st.open.length) throw userErr(`Fräsen kann erst fertig gemeldet werden: Es fehlt die Laufzeit für Aufspannung ${st.open.join(", ")}`);
    }
    const running = await odoo.read("mrp.workcenter.productivity", "search_count", { domain: [["workorder_id", "=", w.id], ["date_end", "=", false]] });
    if (running) throw userErr(`Beim ${step || "Arbeitsgang"} läuft noch eine Zeit. Bitte zuerst beenden.`);
    await odoo.write("mrp.workorder", "button_finish", { ids: [w.id] });
    ctx.invalidate();
    const prod = m2o(w.production_id);
    return { ok: true, finished: w.id, step, production: prod ? await productionInfo(prod.id) : null };
  }

  app.post("/api/bde/fertig", async (req, res) => {
    if (!guardWrite(req, res)) return;
    try {
      await ctx.ensureEmployees();
      res.json(await finishWorkorder(await readWo(toInt(req.body && req.body.workorderId))));
    } catch (err) {
      ctx.fail(res, err);
    }
  });
  // Altname aus der ersten Fassung (nur Fräsen), gleiche Prüfungen
  app.post("/api/bde/laufzeit/finish", async (req, res) => {
    if (!guardWrite(req, res)) return;
    try {
      await ctx.ensureEmployees();
      res.json(await finishWorkorder(await fraesenOf({ workorderId: toInt(req.body && req.body.workorderId), productionId: toInt(req.body && req.body.productionId) })));
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Stand eines Fertigungsauftrags: Arbeitsgänge und ob er abgeschlossen werden kann
  app.get("/api/bde/auftrag", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const id = toInt(req.query.productionId);
      if (!Number.isInteger(id) || id <= 0) throw userErr("Fertigungsauftrag nicht gefunden");
      res.json(await productionInfo(id));
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Fertigungsauftrag abschließen ("Alles produzieren", "Als erledigt markieren"): bucht in Odoo Material und fertiges Teil. Nur wenn alle
  // Arbeitsgänge fertig sind. Fragt Odoo etwas zurück (Mengenabweichung, Restmenge ...), bleibt der Auftrag offen und die App sagt, dass es in Odoo zu klären ist.
  app.post("/api/bde/auftrag/abschliessen", async (req, res) => {
    const s = guardWrite(req, res);
    if (!s) return;
    try {
      const id = toInt(req.body && req.body.productionId);
      if (!Number.isInteger(id) || id <= 0) throw userErr("Fertigungsauftrag nicht gefunden");
      const info = await productionInfo(id);
      if (["done", "cancel"].includes(info.state)) throw userErr("Der Fertigungsauftrag ist schon abgeschlossen");
      const offen = info.steps.filter((x) => x.state !== "done");
      if (offen.length) throw userErr(`Erst müssen alle Arbeitsgänge fertig sein. Offen: ${offen.map((x) => (x.machine && x.step === "Fräsen" ? `${x.step} (${x.machine})` : x.step)).join(", ")}`);
      const [p] = await odoo.read("mrp.production", "read", { ids: [id], fields: ["product_qty", "qty_producing"] });
      if (p && p.product_qty > 0 && p.qty_producing !== p.product_qty) await odoo.write("mrp.production", "write", { ids: [id], vals: { qty_producing: p.product_qty } });
      const result = await odoo.write("mrp.production", "button_mark_done", { ids: [id] });
      ctx.invalidate();
      const after = await productionInfo(id);
      if (after.state !== "done") {
        const wizard = result && typeof result === "object" && result.res_model ? String(result.res_model) : null;
        throw userErr(`Odoo hat den Auftrag noch nicht abgeschlossen${wizard ? " und fragt etwas zurück" : ""}. Bitte ${info.fa || "den Auftrag"} in Odoo öffnen und dort abschließen.`);
      }
      await postNote(id, `<b>Fertigungsauftrag abgeschlossen</b> über die Produktions-App (${escHtml(nameOf(s.e))}, ${today()})`).catch(() => {});
      res.json({ ok: true, ...after });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Maschinen für einen weiteren Arbeitsschritt: Arbeitsplätze, zu denen es einen passenden "… Rüsten"-Arbeitsplatz gibt (und die Sammelplätze FRÄSEN / RÜSTEN)
  async function machinePairs() {
    const wcs = await odoo.read("mrp.workcenter", "search_read", { domain: [], fields: ["name"], limit: 100 });
    const byName = new Map(wcs.map((c) => [String(c.name).trim().toLowerCase(), c]));
    const pairs = [];
    for (const c of wcs) {
      const n = String(c.name).trim().toLowerCase();
      if (n.endsWith(" rüsten") || n === "rüsten") continue;
      const r = byName.get(`${n} rüsten`) || (n === "fräsen" ? byName.get("rüsten") : null);
      if (r) pairs.push({ id: c.id, name: c.name, ruestenId: r.id, ruestenName: r.name });
    }
    return pairs;
  }

  app.get("/api/bde/schritt", async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const id = toInt(req.query.productionId);
      if (!Number.isInteger(id) || id <= 0) throw userErr("Fertigungsauftrag nicht gefunden");
      res.json({ production: await productionInfo(id), machines: await machinePairs() });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  const mins = (v) => {
    if (v == null || v === "") return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_MINUTES) throw userErr("Die geplante Zeit ist unglaubwürdig");
    return Math.round(n);
  };

  // Weiterer Arbeitsschritt: "Rüsten" und "Fräsen" der gewählten Maschine an den Fertigungsauftrag hängen, vor die QS (die bleibt der letzte Schritt und wartet auch auf das neue Fräsen)
  async function addStep(id, machine, ruestenMin, fraesenMin, who) {
    const info = await productionInfo(id);
    if (["done", "cancel"].includes(info.state)) throw userErr("Der Fertigungsauftrag ist schon abgeschlossen");
    const rows = await odoo.read("mrp.workorder", "search_read", { domain: [["production_id", "=", id], ["state", "!=", "cancel"]], fields: WO_FIELDS, order: "sequence asc, id asc", limit: 40 });
    const qs = rows.filter((r) => stepOfWo(r) === "QS").pop() || null;
    const before = rows.filter((r) => !qs || r.id !== qs.id);
    if (!before.length) throw userErr("Dieser Fertigungsauftrag hat noch keine Arbeitsgänge, an die ein weiterer Arbeitsschritt anschließen kann");
    const last = before[before.length - 1];
    const seq = Math.max(...before.map((r) => r.sequence || 0)) + 1;
    const [ruestenId] = await odoo.write("mrp.workorder", "create", {
      vals_list: [{ name: "Rüsten", workcenter_id: machine.ruestenId, production_id: id, sequence: seq, duration_expected: ruestenMin, blocked_by_workorder_ids: [[4, last.id]] }],
    });
    const [fraesenId] = await odoo.write("mrp.workorder", "create", {
      vals_list: [{ name: "Fräsen", workcenter_id: machine.id, production_id: id, sequence: seq + 1, duration_expected: fraesenMin, blocked_by_workorder_ids: [[4, ruestenId]] }],
    });
    if (qs) await odoo.write("mrp.workorder", "write", { ids: [qs.id], vals: { sequence: seq + 2, blocked_by_workorder_ids: [[4, fraesenId]] } });
    await postNote(id, `<b>Weiterer Arbeitsschritt auf ${escHtml(machine.name)}</b> angelegt: Rüsten und Fräsen (${escHtml(who)}, ${today()})`).catch(() => {});
    ctx.invalidate();
    return { ruestenId, fraesenId };
  }

  app.post("/api/bde/schritt", async (req, res) => {
    const s = guardWrite(req, res);
    if (!s) return;
    try {
      await ctx.ensureEmployees();
      const b = req.body || {};
      const id = toInt(b.productionId);
      if (!Number.isInteger(id) || id <= 0) throw userErr("Fertigungsauftrag nicht gefunden");
      const ruestenMin = mins(b.ruestenMin);
      const fraesenMin = mins(b.fraesenMin);
      const machine = (await machinePairs()).find((m) => m.id === toInt(b.machineId));
      if (!machine) throw userErr("Diese Maschine gibt es für einen weiteren Arbeitsschritt nicht");
      const made = await addStep(id, machine, ruestenMin, fraesenMin, nameOf(s.e));
      res.json({ ok: true, machine: machine.name, ...made, production: await productionInfo(id) });
    } catch (err) {
      ctx.fail(res, err);
    }
  });

  // Aus der Planung (Dashboard, Arbeitsgänge einer Position): je Arbeitsgang eine Maschine und Stunden. Der erste Arbeitsgang gehört zum Fräsen, das der
  // Fertigungsauftrag schon hat. Für jeden weiteren, den es in Odoo auf dieser Maschine noch nicht gibt, werden Rüsten und Fräsen vor der QS angelegt.
  // Fehlt für eine Maschine der Arbeitsplatz in Odoo, wird nichts angelegt und die App sagt, welcher fehlt.
  const PLAN_MACHINES = { dmu40: "DMU 40 EVO", dmu50: "DMU 50", m1: "DMG M1", h800u: "POS H 800 U" };
  app.post("/api/planung/odoo-schritte", async (req, res) => {
    try {
      if (!odoo.writeEnabled) throw Object.assign(new Error("Bedienen ist noch nicht freigeschaltet (BDE_WRITE), in Odoo wurde nichts angelegt"), { forbidden: true });
      const b = req.body || {};
      const id = toInt(b.productionId);
      if (!Number.isInteger(id) || id <= 0) throw userErr("Der Auftrag hat keine Verbindung zu einem Odoo-Fertigungsauftrag");
      const ags = Array.isArray(b.ags) ? b.ags : [];
      if (ags.length < 2 || ags.length > 6) throw userErr("Mindestens 2, höchstens 6 Arbeitsgänge");
      const pairs = await machinePairs();
      const plan = ags.map((a) => {
        const name = PLAN_MACHINES[a && a.machine];
        const pair = name && pairs.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
        if (!pair) throw userErr(`In Odoo fehlt der Arbeitsplatz „${name || String(a && a.machine)}“ samt „… Rüsten“. Bitte dort anlegen, dann klappt es. Es wurde nichts angelegt.`);
        return { pair, fraesenMin: mins(Number(a.hours) * 60) };
      });
      const rows = await odoo.read("mrp.workorder", "search_read", { domain: [["production_id", "=", id], ["state", "!=", "cancel"]], fields: WO_FIELDS, order: "sequence asc, id asc", limit: 40 });
      const claimed = new Set();
      const created = [];
      for (let i = 0; i < plan.length; i++) {
        const { pair, fraesenMin } = plan[i];
        const fraesen = rows.filter((w) => stepOfWo(w) === "Fräsen" && !claimed.has(w.id));
        const mine = fraesen.find((w) => machineOf(w).trim().toLowerCase() === pair.name.trim().toLowerCase()) || (i === 0 ? fraesen.find((w) => machineOf(w).trim().toUpperCase() === "FRÄSEN") : null);
        if (mine) {
          claimed.add(mine.id);
          continue;
        }
        const made = await addStep(id, pair, 0, fraesenMin, "Arbeitsvorbereitung");
        claimed.add(made.fraesenId);
        created.push({ machine: pair.name, ...made });
      }
      res.json({ ok: true, created, reused: plan.length - created.length });
    } catch (err) {
      ctx.fail(res, err);
    }
  });
}
