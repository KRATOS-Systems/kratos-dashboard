// Abgleich der Fertigungsaufträge mit Odoo (nur lesen).
//
// Regeln:
// - Beim ersten Abgleich merkt sich die App alle alten offenen Fertigungsaufträge als "bekannt" (nichts wird geändert). Was in den
//   letzten drei Tagen angelegt wurde und der App noch fehlt, kommt gleich als neu in die Liste.
// - Danach kommt jeder neu bestätigte Fertigungsauftrag (FA-Nummer) automatisch in die Liste "noch nicht eingeplant", sofern der
//   Verkaufsauftrag noch nicht vollständig ausgeliefert ist. Der Abgleich läuft alle 10 Minuten und auf Knopfdruck.
// - Grundsatz: Jeder bestätigte Kundenauftrag muss in der Arbeitsvorbereitung oder Planung sichtbar sein. Als laufend gilt ein Kundenauftrag,
//   der bestätigt ist und ab dem Stichtag ORDERS_SINCE bestellt wurde. Ältere offene Aufträge sind Altlasten und bleiben draußen.
// - Entwürfe: Ein Fertigungsauftrag im Entwurf kommt ebenfalls, sobald sein Kundenauftrag laufend ist, gekennzeichnet als "nicht freigegeben".
//   Bestätigt wird der Fertigungsauftrag in Odoo, die App ändert dort nichts. Entwürfe zu gelieferten oder stornierten Aufträgen bleiben draußen.
// - Nachholen: Ein offener Fertigungsauftrag eines laufenden Kundenauftrags, den die App nur als "bekannt" führt (z. B. vom ersten Abgleich), wird
//   einmalig ergänzt. Testaufträge (Herkunft oder Artikel beginnt mit TEST) kommen nie herein.
// - Vollständigkeit: Nach jedem Abgleich und auf Knopfdruck vergleicht die App alle laufenden, nicht vollständig gelieferten Kundenaufträge mit ihren
//   Positionen. Fehlt ein offener Fertigungsauftrag, ist das eine Differenz (muss null sein). Kundenaufträge ohne Fertigungs- oder Einkaufsbeleg
//   stehen in einer Warnliste, gefertigte oder beschaffte, aber noch nicht gelieferte in der Liste "Lieferung offen".
// - Bei Aufträgen, die die App schon kennt, werden Menge, Produkt und Materialstatus aktualisiert (der Liefertermin bleibt).
// - Schließen schlägt die App nur vor: Der Fertigungsauftrag ist in Odoo nicht mehr offen oder der Verkaufsauftrag ist vollständig
//   ausgeliefert. Geschlossen wird erst nach Bestätigung.
// - Fremdfertigung: Eine bestätigte Einkaufsbestellung zu einem Kundenauftrag (A-Nummer), bei der das bestellte Teil das verkaufte Teil ist,
//   kommt automatisch in die Spur "Fertigung extern" (Beginn = Bestätigung, Ende = Liefertermin des Lieferanten). Zum Schließen
//   vorgeschlagen, sobald die Ware eingegangen ist.
// - Lücken: Steht ein Auftrag in der Odoo-Fertigungsplanung (Projekt "01 Fertigungsplanung") offen auf einer Station, hat aber einen offenen
//   Fertigungsauftrag, den die App nicht kennt (z. B. weil er schon beim ersten Abgleich offen war), wird er einmalig ergänzt und auf
//   die Maschine gelegt, auf der die Aufgabe in Odoo steht (sonst "Noch nicht eingeplant"). Was die App schon kennt, bleibt unberührt.
// - Fräszeit: Die geplante Zeit der Fräsen-Arbeitsgänge in Odoo (aus dem Arbeitsplan der Stückliste) wird als Stunden übernommen, wenn bei der
//   Position noch keine stehen, einmalig und ohne etwas zu überschreiben. Maschine und Zeit laut Odoo stehen als Hinweis an der Position.
// - Material: Eine bestätigte Einkaufsbestellung, deren Herkunft die FA-Nummer nennt und deren Ware noch nicht eingegangen ist, hält die Position
//   in der Planung bis zum Liefertermin des Lieferanten zurück (nur Termin, die App bestellt nichts). Ist das Material in der AV als bereit gemeldet, gilt es nicht.
// Odoo wird nur gelesen, und nur wenn ODOO_URL und ODOO_API_KEY gesetzt sind.

import { staffName } from "../src/staffLib.js";

const OPEN_STATES = ["confirmed", "progress", "to_close"];
// Stichtag für das laufende Geschäft: Kundenaufträge mit Auftragsdatum ab diesem Tag. Ältere offene Aufträge sind Altlasten und bleiben draußen.
const ORDERS_SINCE = /^\d{4}-\d{2}-\d{2}$/.test(process.env.ORDERS_SINCE || "") ? process.env.ORDERS_SINCE : "2026-01-01";
const isTestText = (v) => typeof v === "string" && /^\s*test\b/i.test(v);
const dayPart = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const m2oName = (v) => (Array.isArray(v) && v[1] ? String(v[1]) : null);
// "Hof Sonderanlagenbau GmbH, Henrik Weber" -> Firma ohne Ansprechpartner
const customerOf = (v) => {
  const n = m2oName(v);
  return n ? n.split(",")[0].trim().slice(0, 120) : null;
};
const PLANNING_PROJECT = "01 Fertigungsplanung";
const TASK_OPEN_STATES = ["01_in_progress", "02_changes_requested", "03_approved", "04_waiting_normal"];
const FINAL_STAGES = new Set(["Geliefert & Abgerechnet", "Nachkalkulation"]);
const STAGE_MACHINE = { "DMG M1": "m1", "DMG 40 EVO": "dmu40", "POS H 800U": "h800u", "DMG DMU 50": "dmu50", "DMU 50": "dmu50" };
// Arbeitsplatz des Fräsen-Arbeitsgangs in Odoo -> Maschine der App ("" = Sammelplatz FRÄSEN oder unbekannt)
const WORKCENTER_MACHINE = { "DMU 40 EVO": "dmu40", "DMU 50": "dmu50", "DMG M1": "m1", "POS H 800 U": "h800u" };
// Mehr als so viele Fräsen-Stunden in Odoo sind kein Plan, sondern ein Platzhalter (z. B. 1 h je Stück bei 1000 Stück): nur als Hinweis, nicht als Stunden
const MAX_TAKE_HOURS = 300;
// Referenz der Musterstücklisten in Odoo: Maschine und Zeit sind dort noch Platzhalter und müssen geprüft werden
const BOM_MUSTER_CODE = "MUSTER";
// Stückliste eines Fertigungsauftrags: none = weder Stückliste noch Arbeitsgänge, leer = Stückliste ohne Arbeitsgänge (fehlt dann in der Planung),
// muster = nur Musterwerte, ok. Hat der Auftrag Arbeitsgänge, aber keinen Stückliste-Eintrag (z. B. ein älterer, schon laufender Auftrag), ist das kein Hinweis wert.
function bomState(p, musterIds) {
  const bomId = Array.isArray(p.bom_id) ? p.bom_id[0] : p.bom_id;
  const hasOps = Array.isArray(p.workorder_ids) && p.workorder_ids.length > 0;
  if (!hasOps) return bomId ? "leer" : "none";
  if (!bomId) return "ok";
  return musterIds.has(bomId) ? "muster" : "ok";
}
// Musterwerte auch ohne Referenz MUSTER erkennen: Jeder Arbeitsgang steht auf genau 60 Minuten (bzw. 60 Minuten je Stück, z. B. Fräsen
// 16 Stk = 960 min). So legt die Vorlage neue Stücklisten an; echte Zeiten sind praktisch nie überall genau eine Stunde.
export function looksMuster(mill, qty) {
  const ops = mill && Array.isArray(mill.ops) ? mill.ops : [];
  if (ops.length < 3) return false;
  return ops.every((m) => m != null && (Math.abs(m - 60) < 0.01 || Math.abs(m - 60 * qty) < 0.01));
}
const EVERY = 10 * 60 * 1000;
const EXT_OFFSET = 1000000000; // Einkaufspositionen liegen in odoo_seen oberhalb dieser Zahl, getrennt von den Fertigungsaufträgen
const FRESH_DAYS = 3; // beim ersten Abgleich gelten Aufträge, die in den letzten Tagen angelegt wurden, als neu

export default function registerOdooSync(app, db, { isDate, nextPosition }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_seen (
      odoo_id INTEGER PRIMARY KEY,
      first_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS odoo_sync (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    -- Kundenaufträge ohne Fertigungs- oder Einkaufsbeleg, die jemand geprüft hat (nichts zu fertigen, z. B. Lagerware)
    CREATE TABLE IF NOT EXISTS odoo_sale_ack (
      source TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      by_name TEXT,
      at TEXT NOT NULL
    );
  `);
  const getState = (k) => db.prepare("SELECT value FROM odoo_sync WHERE key = ?").get(k)?.value ?? null;
  const setState = (k, v) =>
    db.prepare("INSERT INTO odoo_sync (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v === null ? null : String(v));

  const url = (process.env.ODOO_URL || "").replace(/\/+$/, "");
  const key = process.env.ODOO_API_KEY || "";
  const database = process.env.ODOO_DB || "";
  const enabled = !!(url && key);
  // Lesender Odoo-Zugang für andere Teile der App (z. B. Frühwarnung: Ansprechpartner des Kundenauftrags)
  app.locals.odooRead = enabled ? (model, params) => odoo(model, "search_read", params) : null;

  async function odoo(model, method, params) {
    const headers = { "Content-Type": "application/json; charset=utf-8", Authorization: `bearer ${key}`, "User-Agent": "kratos-dashboard/1.0" };
    if (database) headers["X-Odoo-Database"] = database;
    const res = await fetch(`${url}/json/2/${model}/${method}`, { method: "POST", headers, body: JSON.stringify({ context: { lang: "de_DE" }, ...params }), signal: AbortSignal.timeout(30000) });
    if (res.status === 429) throw new Error("Odoo hat zu viele Anfragen gemeldet (Limit). Später noch einmal versuchen.");
    if (!res.ok) throw new Error(`Odoo antwortete mit HTTP ${res.status}`);
    return res.json();
  }

  // Offene Fertigungsaufträge mit FA-Nummer (dazu Entwürfe bestätigter Kundenaufträge) und der Lieferstatus ihrer Verkaufsaufträge
  async function fetchOpen() {
    const FIELDS = ["name", "state", "origin", "product_id", "product_qty", "date_deadline", "components_availability", "create_date", "bom_id", "workorder_ids"];
    const open = await odoo("mrp.production", "search_read", {
      domain: [["state", "in", OPEN_STATES], ["name", "=like", "FA%"]],
      fields: FIELDS,
      limit: 2000,
    });
    const draftCands = await odoo("mrp.production", "search_read", {
      domain: [["state", "=", "draft"], ["name", "=like", "FA%"]],
      fields: FIELDS,
      limit: 500,
    });
    let prods = [...open, ...draftCands];
    let musterIds = new Set();
    try {
      const boms = await odoo("mrp.bom", "search_read", { domain: [["code", "=", BOM_MUSTER_CODE]], fields: ["id"], limit: 5000 });
      musterIds = new Set(boms.map((b) => b.id));
    } catch (err) {
      console.error("Odoo-Abgleich: Musterstücklisten nicht lesbar", err.message); // ohne Kennzeichnung weiter
    }
    const origins = [...new Set(prods.map((p) => (p.origin || "").trim()).filter((o) => /^[A-Z]\d{3,}$/.test(o)))];
    const delivery = new Map();
    for (let i = 0; i < origins.length; i += 150) {
      const chunk = origins.slice(i, i + 150);
      const sales = await odoo("sale.order", "search_read", { domain: [["name", "in", chunk]], fields: ["name", "delivery_status", "state", "partner_id", "date_order", "commitment_date"], limit: 500 });
      sales.forEach((s) => delivery.set(s.name, s));
    }
    // Laufender Kundenauftrag: bestätigt (nicht Angebot, nicht storniert) und ab dem Stichtag bestellt
    const currentSale = (p) => {
      const s = delivery.get((p.origin || "").trim());
      return !!s && s.state === "sale" && (dayPart(s.date_order) || "") >= ORDERS_SINCE;
    };
    // Entwurf nur zu einem laufenden Kundenauftrag
    prods = prods.filter((p) => p.state !== "draft" || currentSale(p));
    // Material laut Einkauf je Fertigungsauftrag (Bestellungen, deren Herkunft die FA-Nummer nennt). Nicht lesbar = ohne Materialtermin weiter
    let material = new Map();
    try {
      material = await fetchMaterial(new Set(prods.map((p) => String(p.name).trim())));
    } catch (err) {
      console.error("Odoo-Abgleich: Einkauf (Material) nicht lesbar", err.message);
    }
    // Geplante Fräszeit und Maschine je Fertigungsauftrag aus den Fräsen-Arbeitsgängen (Minuten laut Arbeitsplan, 0 = Odoo hat keine Zeit).
    // Dazu die schon gestempelte Zeit auf Rüsten und Fräsen (Fortschritt aus dem Stempeln).
    const milling = new Map();
    const prodIds = prods.map((p) => p.id).filter(Number.isInteger);
    for (let i = 0; i < prodIds.length; i += 150) {
      try {
        const wos = await odoo("mrp.workorder", "search_read", {
          domain: [["production_id", "in", prodIds.slice(i, i + 150)], ["state", "!=", "cancel"], "|", ["name", "ilike", "Fräs"], ["name", "ilike", "Rüst"]],
          fields: ["production_id", "workcenter_id", "duration_expected", "duration", "name", "state"],
          limit: 3000,
        });
        wos.forEach((w) => {
          const pid = Array.isArray(w.production_id) ? w.production_id[0] : null;
          if (!pid) return;
          const cur = milling.get(pid) || { minutes: 0, machine: null, stamped: 0, open: 0, ops: [] };
          cur.stamped += typeof w.duration === "number" && w.duration > 0 ? w.duration : 0;
          cur.ops.push(typeof w.duration_expected === "number" ? w.duration_expected : null);
          if (w.state !== "done") cur.open++;
          if (/fräs/i.test(w.name || "")) {
            cur.minutes += typeof w.duration_expected === "number" ? w.duration_expected : 0;
            if (cur.machine === null) cur.machine = Array.isArray(w.workcenter_id) ? WORKCENTER_MACHINE[String(w.workcenter_id[1]).trim()] || "" : "";
          }
          milling.set(pid, cur);
        });
      } catch (err) {
        console.error("Odoo-Abgleich: Fräszeiten nicht lesbar", err.message); // ohne Zeiten weiter, der Rest des Abgleichs läuft
      }
    }
    // Stunden-Vorschlag für Aufträge ohne Fräszeit im Arbeitsplan: echte Zeiten (gestempelt) des letzten erledigten Fertigungsauftrags desselben Teils
    let history = new Map();
    try {
      const pids = [...new Set(prods.filter((p) => !(milling.get(p.id)?.minutes > 0)).map((p) => (Array.isArray(p.product_id) ? p.product_id[0] : null)).filter(Number.isInteger))];
      history = await fetchHistory(pids);
    } catch (err) {
      console.error("Odoo-Abgleich: frühere Zeiten nicht lesbar", err.message);
    }
    return prods.map((p) => {
      const mill = milling.get(p.id);
      const hist = !(mill && mill.minutes > 0) && Array.isArray(p.product_id) ? history.get(p.product_id[0]) : null;
      const qty = typeof p.product_qty === "number" && p.product_qty > 0 ? p.product_qty : 1;
      const suggest = hist ? Math.max(0.5, Math.ceil(((hist.setup + (hist.mill / hist.qty) * qty) / 60) * 2) / 2) : null;
      const origin = (p.origin || "").trim();
      const sale = delivery.get(origin);
      const due = typeof p.date_deadline === "string" ? p.date_deadline.slice(0, 10) : null;
      return {
        odoo_ref: String(p.name).trim(),
        odoo_id: Number.isInteger(p.id) ? p.id : null,
        source: origin && origin.length <= 40 ? origin : null,
        product: Array.isArray(p.product_id) ? String(p.product_id[1]).slice(0, 200) : null,
        quantity: typeof p.product_qty === "number" ? p.product_qty : null,
        due: due && isDate(due) ? due : sale && dayPart(sale.commitment_date) ? dayPart(sale.commitment_date) : null,
        customer: sale ? customerOf(sale.partner_id) : null,
        sale_date: sale ? dayPart(sale.date_order) : null,
        current: currentSale(p),
        test: isTestText(p.origin) || isTestText(m2oName(p.product_id)),
        hours_suggest: suggest,
        hours_suggest_src: hist ? `aus ${hist.ref}: Fräsen ${h1(hist.mill / 60)} h für ${hist.qty} Stk${hist.setup > 0 ? `, Rüsten ${h1(hist.setup / 60)} h` : ""}` : null,
        material_date: (material.get(String(p.name).trim()) || {}).date || null,
        material_info: (material.get(String(p.name).trim()) || {}).info || null,
        component_status: p.components_availability ? String(p.components_availability).slice(0, 60) : null,
        odoo_hours: mill && mill.minutes > 0 ? Math.round((mill.minutes / 60) * 100) / 100 : null,
        odoo_machine: mill ? mill.machine : null,
        stamped_hours: mill && mill.stamped > 0 ? Math.round((mill.stamped / 60) * 100) / 100 : null,
        odoo_bom: bomState(p, musterIds) === "ok" && looksMuster(mill, qty) ? "muster" : bomState(p, musterIds),
        draft: p.state === "draft",
        created: typeof p.create_date === "string" ? p.create_date.replace(" ", "T") + "Z" : null,
        delivered: !!sale && sale.delivery_status === "full",
        saleCancelled: !!sale && sale.state === "cancel",
      };
    });
  }

  // Frühere echte Zeiten je Teil: der neueste erledigte Fertigungsauftrag mit gestempelter Fräszeit. Teil -> { ref, setup, mill (Minuten), qty }
  const h1 = (x) => String(Math.round(x * 10) / 10).replace(".", ",");
  async function fetchHistory(pids) {
    const out = new Map();
    for (let i = 0; i < pids.length; i += 100) {
      const wos = await odoo("mrp.workorder", "search_read", {
        domain: [["product_id", "in", pids.slice(i, i + 100)], ["state", "=", "done"], ["production_id.state", "=", "done"], "|", ["name", "ilike", "Fräs"], ["name", "ilike", "Rüst"]],
        fields: ["production_id", "product_id", "name", "duration", "qty_production"],
        limit: 3000,
      });
      const byProd = new Map();
      wos.forEach((w) => {
        const prod = Array.isArray(w.production_id) ? w.production_id : null;
        const pid = Array.isArray(w.product_id) ? w.product_id[0] : null;
        if (!prod || !pid) return;
        const cur = byProd.get(prod[0]) || { pid, ref: String(prod[1]), setup: 0, mill: 0, qty: 0 };
        const d = typeof w.duration === "number" ? w.duration : 0;
        if (/fräs/i.test(w.name || "")) {
          cur.mill += d;
          cur.qty = Math.max(cur.qty, Number(w.qty_production) || 0);
        } else cur.setup += d;
        byProd.set(prod[0], cur);
      });
      // je Teil der neueste Fertigungsauftrag (höchste ID) mit Fräszeit
      [...byProd.entries()]
        .sort((a, b) => b[0] - a[0])
        .forEach(([, c]) => {
          if (c.mill > 0 && c.qty > 0 && !out.has(c.pid)) out.set(c.pid, c);
        });
    }
    return out;
  }

  // Material laut Einkauf: Bestellungen, deren Herkunft eine FA-Nummer nennt (z. B. "FA01356" oder "FA01344, FA01345").
  //   bestätigt, Wareneingang offen -> date = Liefertermin des Lieferanten (spätester, wenn es mehrere gibt); die Planung startet frühestens danach
  //   bestätigt, alles eingegangen  -> nur Info "Material eingegangen"
  //   nur Anfrage (Entwurf)         -> nur Info "Material noch nicht bestellt", kein Termin (der Liefertermin einer Anfrage ist nicht verlässlich)
  const fmtDay = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
  async function fetchMaterial(refs) {
    const out = new Map();
    if (!refs.size) return out;
    const since = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const pos = await odoo("purchase.order", "search_read", {
      domain: [["origin", "ilike", "FA0"], ["state", "in", ["draft", "sent", "to approve", "purchase", "done"]], ["date_order", ">=", since + " 00:00:00"]],
      fields: ["name", "origin", "state", "receipt_status", "date_planned", "partner_id"],
      limit: 2000,
    });
    const by = new Map();
    pos.forEach((p) => {
      (String(p.origin || "").match(/\bFA\d{4,}\b/g) || []).forEach((fa) => {
        if (!refs.has(fa)) return;
        if (!by.has(fa)) by.set(fa, []);
        by.get(fa).push(p);
      });
    });
    by.forEach((list, fa) => {
      const who = (p) => `${p.name}${Array.isArray(p.partner_id) ? " " + String(p.partner_id[1]).split(",")[0].trim() : ""}`;
      const ordered = list.filter((p) => p.state === "purchase" || p.state === "done");
      const pending = ordered.filter((p) => p.receipt_status !== "full" && dayPart(p.date_planned));
      if (pending.length) {
        const last = pending.reduce((a, b) => (dayPart(b.date_planned) > dayPart(a.date_planned) ? b : a));
        // Hat der Lieferant auf Nachfrage einen neuen Termin genannt (Extern & Wareneingang), gilt der
        const neu = app.locals.externTermin ? app.locals.externTermin(String(last.name)) : null;
        const d = neu || dayPart(last.date_planned);
        out.set(fa, { date: d, info: `${who(last)}, Wareneingang offen, ${neu ? "neuer Termin" : "geplant"} ${fmtDay(d)}${neu ? " (vom Lieferanten)" : ""}` });
      } else if (ordered.length) out.set(fa, { date: null, info: `${who(ordered[0])}, Material eingegangen` });
      else {
        // Nur angefragt: Oft wird woanders gesammelt bestellt, die Anfrage in Odoo sagt also nichts Sicheres. Kein Termin, nichts wird verschoben;
        // die AV zeigt „Material klären“, bis dort jemand bereit oder „in Arbeit“ mit Datum einträgt.
        out.set(fa, { date: null, info: `${who(list[0])}, nur Anfrage in Odoo (noch nicht bestellt), Material klären` });
      }
    });
    return out;
  }

  // Fertigungsaufträge im Entwurf, die die App NICHT übernimmt (Kundenauftrag nicht bestätigt oder Altlast vor DRAFT_SINCE): sie werden nur gezählt,
  // damit man sieht, was in Odoo noch aussteht und was dabei ohne Stückliste ist (run() filtert die übernommenen heraus)
  async function fetchDrafts() {
    const prods = await odoo("mrp.production", "search_read", { domain: [["state", "=", "draft"], ["name", "=like", "FA%"]], fields: ["name", "bom_id", "origin", "product_id"], limit: 500 });
    return prods.filter((p) => !isTestText(p.origin) && !isTestText(m2oName(p.product_id))).map((p) => ({ ref: String(p.name).trim(), noBom: !(Array.isArray(p.bom_id) ? p.bom_id[0] : p.bom_id) }));
  }

  // Aufträge (A-Nummern), die in der Odoo-Fertigungsplanung offen auf einer Station stehen: A-Nummer -> Maschine der App ("" = keine bekannte Maschine).
  // Gibt es zu einem Auftrag mehrere Aufgaben (Kopien), gilt die Aufgabe ohne "(Kopie)".
  async function fetchPlanningSources() {
    const projects = await odoo("project.project", "search_read", { domain: [["name", "=", PLANNING_PROJECT]], fields: ["name"], limit: 1 });
    if (!Array.isArray(projects) || !projects.length) return new Map();
    const tasks = await odoo("project.task", "search_read", {
      domain: [["project_id", "=", projects[0].id], ["state", "in", TASK_OPEN_STATES]],
      fields: ["name", "stage_id", "sale_order_id"],
      limit: 1000,
    });
    const best = new Map(); // A-Nummer -> { machine, isCopy }
    tasks.forEach((t) => {
      const stage = Array.isArray(t.stage_id) ? String(t.stage_id[1]) : "";
      if (!stage || FINAL_STAGES.has(stage)) return;
      const fromSale = Array.isArray(t.sale_order_id) ? String(t.sale_order_id[1]).trim() : "";
      const fromName = /^\s*(A\d{3,})\b/.exec(String(t.name || ""));
      const source = /^[A-Z]\d{3,}$/.test(fromSale) ? fromSale : fromName ? fromName[1] : null;
      if (!source) return;
      const cand = { machine: STAGE_MACHINE[stage] || "", isCopy: /\(Kopie\)/i.test(String(t.name || "")) };
      const cur = best.get(source);
      // Eine Aufgabe ohne "(Kopie)" geht vor, bei gleichem Rang die mit bekannter Maschine
      if (!cur || (cur.isCopy && !cand.isCopy) || (cur.isCopy === cand.isCopy && !cur.machine && cand.machine)) best.set(source, cand);
    });
    return new Map([...best].map(([source, c]) => [source, c.machine]));
  }

  // Von Hand nachgeholte Aufträge (A-Nummern), die nicht in der Odoo-Planungsliste stehen
  function getExtraSources() {
    try {
      const l = JSON.parse(getState("gap_extra") || "[]");
      return Array.isArray(l) ? l.filter((s) => typeof s === "string" && /^[A-Z]\d{3,}$/.test(s)) : [];
    } catch {
      return [];
    }
  }

  // Fremdgefertigte Teile: Einkaufsbestellungen zu Kundenaufträgen, bei denen das bestellte Teil das verkaufte ist (kein Materialeinkauf)
  const dayOf = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  async function fetchExternal() {
    const since = new Date(Date.now() - 150 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const lines = await odoo("purchase.order.line", "search_read", {
      domain: [["order_id.state", "in", ["purchase", "done"]], ["order_id.origin", "=like", "A%"], ["order_id.date_order", ">=", since], ["display_type", "=", false]],
      fields: ["order_id", "product_id", "product_qty", "qty_received", "date_planned", "name"],
      limit: 2000,
    });
    if (!lines.length) return [];
    const poIds = [...new Set(lines.map((l) => (Array.isArray(l.order_id) ? l.order_id[0] : null)).filter(Boolean))];
    const pos = new Map();
    for (let i = 0; i < poIds.length; i += 150) {
      const recs = await odoo("purchase.order", "read", { ids: poIds.slice(i, i + 150), fields: ["name", "origin", "partner_id", "date_approve", "date_order", "date_planned", "create_date"] });
      recs.forEach((p) => pos.set(p.id, p));
    }
    const sourceOf = (p) => {
      const m = /\bA\d{4,}\b/.exec(p.origin || "");
      return m ? m[0] : null;
    };
    const sources = [...new Set([...pos.values()].map(sourceOf).filter(Boolean))];
    const sales = new Map();
    const sold = new Map(); // Kundenauftrag -> Artikel, die verkauft wurden
    for (let i = 0; i < sources.length; i += 100) {
      const chunk = sources.slice(i, i + 100);
      const so = await odoo("sale.order", "search_read", { domain: [["name", "in", chunk]], fields: ["name", "state", "delivery_status", "commitment_date"], limit: 300 });
      so.forEach((r) => sales.set(r.name, r));
      const sl = await odoo("sale.order.line", "search_read", { domain: [["order_id.name", "in", chunk], ["display_type", "=", false]], fields: ["order_id", "product_id"], limit: 3000 });
      sl.forEach((r) => {
        const n = Array.isArray(r.order_id) ? r.order_id[1] : null;
        const pid = Array.isArray(r.product_id) ? r.product_id[0] : null;
        if (!n || !pid) return;
        if (!sold.has(n)) sold.set(n, new Set());
        sold.get(n).add(pid);
      });
    }
    const out = [];
    lines.forEach((l) => {
      const po = pos.get(Array.isArray(l.order_id) ? l.order_id[0] : null);
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : null;
      const source = po && sourceOf(po);
      if (!po || !pid || !source || !sold.has(source) || !sold.get(source).has(pid)) return;
      const sale = sales.get(source);
      const created = typeof po.create_date === "string" ? po.create_date.replace(" ", "T") + "Z" : null;
      const planned = dayOf(l.date_planned) || dayOf(po.date_planned);
      out.push({
        odoo_ref: String(po.name) + "-" + l.id,
        line_id: l.id,
        po_id: po.id,
        po: String(po.name),
        source,
        supplier: Array.isArray(po.partner_id) ? String(po.partner_id[1]).slice(0, 120) : null,
        product: Array.isArray(l.product_id) ? String(l.product_id[1]).slice(0, 200) : String(l.name || "").slice(0, 200),
        quantity: typeof l.product_qty === "number" ? l.product_qty : null,
        received: (l.product_qty || 0) > 0 && (l.qty_received || 0) >= l.product_qty,
        start: dayOf(po.date_approve) || dayOf(po.date_order) || (created && created.slice(0, 10)),
        planned,
        due: sale ? dayOf(sale.commitment_date) : null,
        delivered: !!sale && sale.delivery_status === "full",
        saleCancelled: !!sale && sale.state === "cancel",
        created,
      });
    });
    return out;
  }
  const extDays = (e) => {
    if (!e.start || !e.planned) return 7;
    const d = Math.round((Date.parse(e.planned) - Date.parse(e.start)) / 86400000);
    return Math.min(120, Math.max(1, d));
  };
  // Fremdfertigung: neue Positionen und Schließvorschläge (beim ersten Mal gelten nur frisch angelegte Bestellungen als neu)
  function computeExternal(ext) {
    const seenKey = (e) => EXT_OFFSET + e.line_id;
    const seen = new Set(db.prepare("SELECT odoo_id FROM odoo_seen WHERE odoo_id >= ?").all(EXT_OFFSET).map((r) => r.odoo_id));
    const inApp = new Map(db.prepare("SELECT odoo_ref, done, source, product FROM orders WHERE odoo_ref LIKE 'P%-%'").all().map((r) => [r.odoo_ref, r]));
    const manual = db.prepare("SELECT id FROM orders WHERE source = ? AND product = ? AND done = 0 AND odoo_ref IS NULL");
    const baseline = getState("ext_baseline_done") !== "1";
    const cutoff = Date.now() - FRESH_DAYS * 24 * 3600 * 1000;
    const isNew = (e) =>
      !inApp.has(e.odoo_ref) && !e.received && !e.delivered && !e.saleCancelled && !manual.get(e.source, e.product) && (baseline ? e.created && Date.parse(e.created) >= cutoff : !seen.has(seenKey(e)));
    const created = ext.filter(isNew);
    const byRef = new Map(ext.map((e) => [e.odoo_ref, e]));
    const closing = [];
    inApp.forEach((r, ref) => {
      if (r.done !== 0) return;
      const e = byRef.get(ref);
      if (!e) closing.push({ ref, source: r.source, product: r.product, reason: "Bestellung in Odoo nicht mehr offen (storniert oder zurückgesetzt)" });
      else if (e.received) closing.push({ ref, source: r.source, product: r.product, reason: "Ware vom Lieferanten laut Odoo eingegangen" });
      else if (e.delivered) closing.push({ ref, source: r.source, product: r.product, reason: "Ware laut Odoo vollständig an den Kunden ausgeliefert" });
      else if (e.saleCancelled) closing.push({ ref, source: r.source, product: r.product, reason: "Verkaufsauftrag in Odoo storniert" });
    });
    return { created, closing, baseline, seenKey };
  }
  function applyExternal(x, ext, closeRefs) {
    const now = new Date().toISOString();
    const insert = db.prepare(
      "INSERT INTO orders (machine, order_no, due_date, position, odoo_ref, source, product, quantity, extern_start, extern_days, supplier, po_id) VALUES ('extern_fert', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const seenNew = db.prepare("INSERT OR IGNORE INTO odoo_seen (odoo_id, first_seen) VALUES (?, ?)");
    const seenOld = db.prepare("INSERT OR IGNORE INTO odoo_seen (odoo_id, first_seen) VALUES (?, 'baseline')");
    const close = db.prepare("UPDATE orders SET done = 1, done_date = COALESCE(done_date, date('now')) WHERE odoo_ref = ?");
    const dueBySource = new Map(
      db
        .prepare("SELECT source, MIN(due_date) AS d FROM orders WHERE source IS NOT NULL AND done = 0 AND due_date IS NOT NULL GROUP BY source")
        .all()
        .map((r) => [r.source, r.d])
    );
    db.exec("BEGIN");
    try {
      let position = nextPosition("extern_fert");
      x.created.forEach((e) => {
        insert.run(e.po, e.due || dueBySource.get(e.source) || null, position++, e.odoo_ref, e.source, e.product, e.quantity, e.start || new Date().toISOString().slice(0, 10), extDays(e), e.supplier, e.po_id);
        seenNew.run(x.seenKey(e), now);
      });
      if (x.baseline) {
        const made = new Set(x.created.map((e) => e.odoo_ref));
        ext.filter((e) => !made.has(e.odoo_ref)).forEach((e) => seenOld.run(x.seenKey(e)));
      }
      // Bereits übernommene Positionen: Link zur Bestellung nachtragen
      const link = db.prepare("UPDATE orders SET po_id = ?, supplier = COALESCE(supplier, ?) WHERE odoo_ref = ? AND po_id IS NULL");
      ext.forEach((e) => link.run(e.po_id, e.supplier, e.odoo_ref));
      closeRefs.forEach((ref) => close.run(ref));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    if (x.baseline) setState("ext_baseline_done", "1");
  }

  // Was würde passieren? (ohne etwas zu schreiben)
  // wanted: A-Nummer -> Maschine aus der Odoo-Fertigungsplanung. Ein offener Fertigungsauftrag, den die App nicht kennt und der beim ersten
  // Abgleich nur als "bekannt" gemerkt wurde, wird einmalig ergänzt, wenn sein Auftrag dort offen steht.
  function computePlan(items, wanted = new Map(), force = null) {
    const seen = new Set(db.prepare("SELECT odoo_id FROM odoo_seen").all().map((r) => r.odoo_id));
    const inApp = new Map(db.prepare("SELECT id, odoo_ref, odoo_id, done, source, product FROM orders WHERE odoo_ref LIKE 'FA%'").all().map((r) => [r.odoo_ref, r]));
    const openIds = new Set(items.map((i) => i.odoo_ref));
    const byRef = new Map(items.map((i) => [i.odoo_ref, i]));
    let gapDone = new Set();
    try {
      gapDone = new Set(JSON.parse(getState("gap_done") || "[]"));
    } catch {
      gapDone = new Set();
    }
    // Nachholen (einmalig): der Auftrag steht offen in der Odoo-Fertigungsplanung, wurde gezielt angefordert oder gehört zu einem laufenden Kundenauftrag
    const isGap = (i) => seen.has(i.odoo_id) && !gapDone.has(i.odoo_id) && ((!!i.source && wanted.has(i.source)) || !!i.current);
    // Ausdrücklich angefordert (Knopf "Übernehmen" der Vollständigkeitsprüfung): auch wenn der Auftrag schon einmal nachgeholt und wieder entfernt wurde
    const forced = (i) => !!force && i.source === force;
    const created = items.filter((i) => !inApp.has(i.odoo_ref) && (!seen.has(i.odoo_id) || isGap(i) || forced(i)) && !i.delivered && !i.saleCancelled && !i.test);
    created.forEach((i) => {
      i.gap = isGap(i) || (forced(i) && seen.has(i.odoo_id));
      i.machine = i.gap ? (i.source && wanted.get(i.source)) || "" : "";
    });
    const updated = items.filter((i) => inApp.has(i.odoo_ref) && inApp.get(i.odoo_ref).done === 0);
    const closing = [];
    inApp.forEach((r, ref) => {
      if (r.done !== 0) return;
      const i = byRef.get(ref);
      if (!openIds.has(ref)) closing.push({ ref, source: r.source, product: r.product, reason: "In Odoo nicht mehr offen (erledigt, storniert oder zurück im Entwurf)" });
      else if (i.test) closing.push({ ref, source: r.source, product: r.product, reason: "Testauftrag (Herkunft oder Artikel beginnt mit TEST)" });
      else if (i.delivered) closing.push({ ref, source: r.source, product: r.product, reason: "Ware laut Odoo vollständig ausgeliefert" });
      else if (i.saleCancelled) closing.push({ ref, source: r.source, product: r.product, reason: "Verkaufsauftrag in Odoo storniert" });
    });
    const known = items.filter((i) => inApp.has(i.odoo_ref)).length;
    return { created, updated, closing, openCount: items.length, knownInApp: known };
  }

  function applyPlan(plan, { closeRefs = [], markAllSeen = false } = {}) {
    const insert = db.prepare(
      "INSERT INTO orders (machine, order_no, due_date, position, odoo_ref, source, product, quantity, odoo_id, component_status, customer, sale_date, extern_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 7)"
    );
    const update = db.prepare(
      "UPDATE orders SET source = COALESCE(?, source), product = COALESCE(?, product), quantity = CASE WHEN is_split = 1 THEN quantity ELSE COALESCE(?, quantity) END, odoo_id = COALESCE(?, odoo_id), component_status = ? WHERE odoo_ref = ? AND done = 0"
    );
    const close = db.prepare("UPDATE orders SET done = 1, done_date = COALESCE(done_date, date('now')) WHERE odoo_ref = ? OR parent_ref = ?");
    const hint = db.prepare("UPDATE orders SET odoo_hours = ?, odoo_machine = ?, odoo_bom = ? WHERE odoo_ref = ? AND done = 0");
    const setDraft = db.prepare("UPDATE orders SET odoo_draft = ?, customer = COALESCE(?, customer), sale_date = COALESCE(?, sale_date) WHERE (odoo_ref = ? OR parent_ref = ?) AND done = 0");
    const setMaterial = db.prepare("UPDATE orders SET material_date = ?, material_info = ? WHERE (odoo_ref = ? OR parent_ref = ?) AND done = 0");
    const setSuggest = db.prepare("UPDATE orders SET hours_suggest = ?, hours_suggest_src = ? WHERE odoo_ref = ? AND done = 0");
    // Fortschritt aus dem Stempeln: gestempelte Stunden (Rüsten + Fräsen) als erledigte Stunden, nie weniger als von Hand eingetragen
    // und höchstens 95 % (fertig ist eine Position erst, wenn sie abgeschlossen wird). Geteilte Positionen haben eigene Stunden.
    const setStamped = db.prepare(
      "UPDATE orders SET done_hours = MIN(?, ROUND(hours * 0.95, 1)), progress_date = COALESCE(progress_date, date('now')) WHERE odoo_ref = ? AND done = 0 AND is_split = 0 AND hours > 0 AND COALESCE(done_hours, 0) + 0.05 < MIN(?, ROUND(hours * 0.95, 1))"
    );
    const takeHours = db.prepare("UPDATE orders SET hours = ?, hours_basis = 'odoo', odoo_hours_applied = 1 WHERE odoo_ref = ? AND done = 0 AND is_split = 0 AND odoo_hours_applied = 0 AND (hours IS NULL OR hours = 0)");
    const seen = db.prepare("INSERT OR IGNORE INTO odoo_seen (odoo_id, first_seen) VALUES (?, ?)");
    const seenOld = db.prepare("INSERT OR IGNORE INTO odoo_seen (odoo_id, first_seen) VALUES (?, 'baseline')");
    // Neue Positionen eines bekannten Auftrags übernehmen dessen aktuellen Liefertermin (den frühesten der offenen Positionen)
    const dueBySource = new Map(
      db
        .prepare("SELECT source, MIN(due_date) AS d FROM orders WHERE source IS NOT NULL AND done = 0 AND due_date IS NOT NULL GROUP BY source")
        .all()
        .map((r) => [r.source, r.d])
    );
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      const nextPos = new Map();
      const takePosition = (machine) => {
        if (!nextPos.has(machine)) nextPos.set(machine, nextPosition(machine));
        const p = nextPos.get(machine);
        nextPos.set(machine, p + 1);
        return p;
      };
      const gapIds = [];
      plan.created.forEach((i) => {
        const machine = i.gap ? i.machine || "" : "";
        insert.run(machine, i.odoo_ref, (i.source && dueBySource.get(i.source)) || i.due, takePosition(machine), i.odoo_ref, i.source, i.product, i.quantity, i.odoo_id, i.component_status, i.customer || null, i.sale_date || null);
        seen.run(i.odoo_id, now);
        if (i.gap) gapIds.push(i.odoo_id);
      });
      if (gapIds.length) {
        // Als neu kennzeichnen (NEU in "Noch nicht eingeplant"), obwohl Odoo sie schon vom ersten Abgleich als bekannt führte
        const markNew = db.prepare("UPDATE odoo_seen SET first_seen = ? WHERE odoo_id = ? AND first_seen = 'baseline'");
        gapIds.forEach((id) => markNew.run(now, id));
        let done = [];
        try {
          done = JSON.parse(getState("gap_done") || "[]");
        } catch {
          done = [];
        }
        setState("gap_done", JSON.stringify([...new Set([...done, ...gapIds])]));
      }
      plan.updated.forEach((i) => update.run(i.source, i.product, i.quantity, i.odoo_id, i.component_status, i.odoo_ref));
      // Fräszeit laut Odoo: immer als Hinweis merken, als Stunden nur einmal und nur bei leeren Stunden (geteilte Positionen haben eigene Stunden)
      [...plan.created, ...plan.updated].forEach((i) => {
        setDraft.run(i.draft ? 1 : 0, i.customer || null, i.sale_date || null, i.odoo_ref, i.odoo_ref);
        if (i.material_date !== undefined) setMaterial.run(i.material_date, i.material_info, i.odoo_ref, i.odoo_ref);
        if (i.hours_suggest !== undefined) setSuggest.run(i.hours_suggest, i.hours_suggest_src, i.odoo_ref);
        if (i.odoo_hours === undefined) return;
        hint.run(i.odoo_hours, i.odoo_machine, i.odoo_bom || null, i.odoo_ref);
        if (i.odoo_hours > 0 && i.odoo_hours <= MAX_TAKE_HOURS) takeHours.run(i.odoo_hours, i.odoo_ref);
        // erst nach den Stunden: ohne Stunden kein Fortschritt
        if (i.stamped_hours > 0) setStamped.run(i.stamped_hours, i.odoo_ref, i.stamped_hours);
      });
      closeRefs.forEach((ref) => close.run(ref, ref));
      materialAv();
      if (markAllSeen) plan.all.forEach((i) => seenOld.run(i.odoo_id));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // Vollständigkeit: Jeder laufende, nicht vollständig gelieferte Kundenauftrag wird einer von vier Gruppen zugeordnet (nur lesen):
  //   sichtbar       mindestens eine offene Position in der App
  //   fehlt          ein offener Fertigungsauftrag (auch Entwurf) hat keine Position in der App: die Differenz, sie muss null sein
  //   ohneBeleg      weder Fertigungsauftrag noch Einkaufsbestellung: Warnliste (abhakbar, wenn nichts zu fertigen ist)
  //   lieferungOffen gefertigt oder beschafft, aber noch nicht (vollständig) geliefert
  async function checkCompleteness() {
    const sales = await odoo("sale.order", "search_read", {
      domain: [["state", "=", "sale"], ["date_order", ">=", ORDERS_SINCE + " 00:00:00"], ["delivery_status", "!=", "full"]],
      fields: ["name", "partner_id", "date_order", "commitment_date", "delivery_status"],
      limit: 2000,
    });
    let names = sales.map((s) => String(s.name).trim());
    // Aufträge nur aus Dienstleistungen (z. B. Servicetechniker, Fracht): es gibt nichts zu fertigen. Nicht lesbar = alle bleiben drin
    // (nur Aufträge mit Positionen zählen: hat ein Auftrag Positionen, aber keine Ware mit Menge, gibt es nichts zu fertigen)
    const goods = new Set();
    const withLines = new Set();
    let linesRead = false;
    try {
      for (let i = 0; i < names.length; i += 150) {
        const ls = await odoo("sale.order.line", "search_read", { domain: [["order_id.name", "in", names.slice(i, i + 150)], ["display_type", "=", false]], fields: ["order_id", "product_type", "product_uom_qty"], limit: 5000 });
        ls.forEach((l) => {
          if (!Array.isArray(l.order_id)) return;
          const n = String(l.order_id[1]).trim();
          withLines.add(n);
          if (l.product_type !== "service" && (l.product_uom_qty || 0) > 0) goods.add(n);
        });
      }
      linesRead = true;
    } catch (err) {
      console.error("Vollständigkeit: Positionen der Kundenaufträge nicht lesbar", err.message);
    }
    const serviceOnly = linesRead ? names.filter((n) => withLines.has(n) && !goods.has(n)) : [];
    if (serviceOnly.length) {
      const skip = new Set(serviceOnly);
      sales.splice(0, sales.length, ...sales.filter((s) => !skip.has(String(s.name).trim())));
      names = names.filter((n) => !skip.has(n));
    }
    const mos = new Map(); // A-Nummer -> Fertigungsaufträge
    for (let i = 0; i < names.length; i += 150) {
      const recs = await odoo("mrp.production", "search_read", {
        domain: [["origin", "in", names.slice(i, i + 150)], ["state", "!=", "cancel"]],
        fields: ["name", "state", "origin", "product_id"],
        limit: 2000,
      });
      recs.forEach((p) => {
        if (isTestText(m2oName(p.product_id))) return;
        const o = String(p.origin || "").trim();
        if (!mos.has(o)) mos.set(o, []);
        mos.get(o).push({ ref: String(p.name).trim(), state: p.state });
      });
    }
    // Einkaufsbestellungen zu Kundenaufträgen (Herkunft enthält die A-Nummer); nicht lesbar = ohne Einkauf weiter, mit Vermerk
    const pos = new Map();
    let poError = null;
    try {
      const recs = await odoo("purchase.order", "search_read", {
        domain: [["origin", "ilike", "A0"], ["state", "!=", "cancel"], ["date_order", ">=", ORDERS_SINCE + " 00:00:00"]],
        fields: ["name", "origin", "state", "receipt_status"],
        limit: 3000,
      });
      recs.forEach((p) => {
        (String(p.origin || "").match(/\bA\d{4,}\b/g) || []).forEach((a) => {
          if (!pos.has(a)) pos.set(a, []);
          pos.get(a).push({ name: String(p.name), ordered: p.state === "purchase" || p.state === "done", received: p.receipt_status === "full" });
        });
      });
    } catch (err) {
      poError = err.message;
    }
    const rows = db.prepare("SELECT odoo_ref, parent_ref, source, done FROM orders").all();
    const openBySource = new Map();
    const refs = new Set();
    rows.forEach((r) => {
      if (r.odoo_ref) refs.add(r.odoo_ref);
      if (r.parent_ref) refs.add(r.parent_ref);
      if (r.done === 0 && r.source) openBySource.set(r.source, (openBySource.get(r.source) || 0) + 1);
    });
    const OPEN = new Set([...OPEN_STATES, "draft"]);
    const out = { at: new Date().toISOString(), since: ORDERS_SINCE, total: sales.length, sichtbar: 0, fehlt: [], ohneBeleg: [], lieferungOffen: [], poError, nurDienstleistung: serviceOnly };
    sales.forEach((s) => {
      const name = String(s.name).trim();
      const e = { source: name, customer: customerOf(s.partner_id), due: dayPart(s.commitment_date), date: dayPart(s.date_order), partial: s.delivery_status === "partial" };
      const mine = mos.get(name) || [];
      const missing = mine.filter((m) => OPEN.has(m.state) && !refs.has(m.ref));
      const po = pos.get(name) || [];
      if (missing.length) out.fehlt.push({ ...e, refs: missing.map((m) => m.ref), drafts: missing.filter((m) => m.state === "draft").map((m) => m.ref) });
      else if (openBySource.get(name)) out.sichtbar++;
      else if (!mine.length && !po.length) out.ohneBeleg.push(e);
      else {
        const parts = [];
        if (mine.length) parts.push(mine.some((m) => OPEN.has(m.state)) ? "in der App erledigt, in Odoo noch offen: " + mine.filter((m) => OPEN.has(m.state)).map((m) => m.ref).join(", ") : "Fertigung erledigt");
        po.forEach((p) => parts.push(`Einkauf ${p.name} (${!p.ordered ? "Anfrage" : p.received ? "Ware eingegangen" : "Wareneingang offen"})`));
        out.lieferungOffen.push({ ...e, detail: parts.join(" · ") });
      }
    });
    const byDue = (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.source.localeCompare(b.source);
    out.fehlt.sort(byDue);
    out.ohneBeleg.sort(byDue);
    out.lieferungOffen.sort(byDue);
    return out;
  }
  async function storeCompleteness() {
    try {
      const r = await checkCompleteness();
      setState("vollst", JSON.stringify(r));
      setState("vollst_error", null);
      return r;
    } catch (err) {
      setState("vollst_error", err.message);
      throw err;
    }
  }
  // Gespeichertes Ergebnis, mit den abgehakten Aufträgen ("nichts zu fertigen") aus der Warnliste in die Liste "Lieferung offen" verschoben
  function completeness() {
    let r = null;
    try {
      r = JSON.parse(getState("vollst") || "null");
    } catch {
      r = null;
    }
    if (!r) return null;
    const acks = new Map(db.prepare("SELECT source, note, by_name, at FROM odoo_sale_ack").all().map((a) => [a.source, a]));
    const acked = (r.ohneBeleg || []).filter((e) => acks.has(e.source)).map((e) => {
      const a = acks.get(e.source);
      return { ...e, ack: true, detail: `geprüft${a.by_name ? " von " + a.by_name : ""}: ${a.note || "nichts zu fertigen"}` };
    });
    return {
      ...r,
      ohneBeleg: (r.ohneBeleg || []).filter((e) => !acks.has(e.source)),
      lieferungOffen: [...(r.lieferungOffen || []), ...acked].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.source.localeCompare(b.source)),
    };
  }

  // AV-Punkt Material aus dem Einkauf setzen (nur Punkte, die noch niemand von Hand geändert hat, wie bei der QS-Verbindung):
  //   bestätigt, Wareneingang offen -> in Arbeit, Termin = Liefertermin des Lieferanten
  //   eingegangen                   -> bereit
  //   nur angefragt                 -> offen, mit Hinweis
  function materialAv() {
    if (!db.prepare("PRAGMA table_info(av_checks)").all().some((c) => c.name === "auto")) return;
    const rows = db.prepare("SELECT id, material_date, material_info, component_status FROM orders WHERE done = 0 AND (material_info IS NOT NULL OR component_status IS NOT NULL)").all();
    const cur = db.prepare("SELECT status, due, note, auto FROM av_checks WHERE order_id = ? AND item = 'material'");
    const put = db.prepare(
      `INSERT INTO av_checks (order_id, item, status, due, note, assignee, updated_at, auto) VALUES (?, 'material', ?, ?, ?, NULL, datetime('now'), 1)
       ON CONFLICT (order_id, item) DO UPDATE SET status = excluded.status, due = excluded.due, note = excluded.note, updated_at = excluded.updated_at WHERE av_checks.auto = 1`
    );
    // Wareneingang in Odoo: Das Material ist da, das gilt auch über einen Eintrag von Hand
    const force = db.prepare(
      `INSERT INTO av_checks (order_id, item, status, due, note, assignee, updated_at, auto) VALUES (?, 'material', 'bereit', NULL, ?, NULL, datetime('now'), 1)
       ON CONFLICT (order_id, item) DO UPDATE SET status = 'bereit', due = NULL, note = excluded.note, updated_at = excluded.updated_at, auto = 1`
    );
    rows.forEach((r) => {
      const c = cur.get(r.id);
      if (c && c.auto !== 1) {
        // von Hand gesetzt: nie anfassen – außer der Wareneingang ist in Odoo gebucht
        if (/eingegangen/.test(r.material_info || "") && c.status !== "bereit" && c.status !== "entfaellt") force.run(r.id, "Einkauf: " + r.material_info);
        return;
      }
      // ohne Bestellung zum Auftrag: Odoo meldet die Komponenten als verfügbar (Lager) -> bereit; sonst nichts setzen
      if (!r.material_info) {
        if (!/^(verfügbar|available)$/i.test(String(r.component_status || "").trim())) return;
        if (c && c.status === "bereit" && c.note === "Lager: Material laut Odoo verfügbar") return;
        put.run(r.id, "bereit", null, "Lager: Material laut Odoo verfügbar");
        return;
      }
      const received = /eingegangen/.test(r.material_info);
      const nurAnfrage = /noch nicht bestellt/.test(r.material_info);
      const want = received ? ["bereit", null] : nurAnfrage ? ["offen", null] : r.material_date ? ["in_arbeit", r.material_date] : ["offen", null];
      const note = "Einkauf: " + r.material_info;
      if (c && c.status === want[0] && (c.due || null) === want[1] && c.note === note) return;
      put.run(r.id, want[0], want[1], note);
    });
  }

  // Neue Fertigungsaufträge bekommen ihr AV-Paket gleich (im Hintergrund, der Abgleich wartet nicht darauf), nicht erst beim nächsten Lauf
  function avPaketeBald() {
    if (!app.locals.freigaben || !app.locals.freigaben.vorbereiten || process.env.FREIGABEN_AUTO === "0") return;
    setTimeout(() => app.locals.freigaben.vorbereiten().catch((err) => console.error("AV-Pakete für neue Aufträge:", err.message)), 2000);
  }

  let running = false;
  async function run({ dryRun, closeRefs = [], auto = false, force = null }) {
    if (!enabled) throw new Error("Odoo ist nicht verbunden (ODOO_URL und ODOO_API_KEY fehlen auf dem Server).");
    if (running) throw new Error("Ein Abgleich läuft gerade.");
    running = true;
    try {
      const items = await fetchOpen();
      if (!dryRun || auto) {
        try {
          const taken = new Set(items.filter((i) => i.draft && !i.delivered && !i.saleCancelled).map((i) => i.odoo_ref));
          setState("drafts", JSON.stringify((await fetchDrafts()).filter((d) => !taken.has(d.ref))));
        } catch (err) {
          console.error("Odoo-Abgleich: Entwürfe nicht lesbar", err.message); // nur ein Hinweis, der Abgleich läuft weiter
        }
      }
      let ext = null;
      let extX = null;
      try {
        ext = await fetchExternal();
        extX = computeExternal(ext);
        setState("ext_error", null);
      } catch (err) {
        setState("ext_error", err.message);
      }
      const extCreated = () => (extX ? extX.created.map((e) => ({ ref: e.odoo_ref, source: e.source, product: e.product, quantity: e.quantity, due: e.due, supplier: e.supplier })) : []);
      const baseline = getState("baseline_done") !== "1";
      // Aufträge aus der Odoo-Fertigungsplanung; schlägt das fehl (z. B. keine Rechte auf Projekte), läuft der Abgleich wie bisher
      let wanted = new Map();
      if (!baseline) {
        try {
          wanted = await fetchPlanningSources();
          setState("gap_error", null);
        } catch (err) {
          setState("gap_error", err.message);
        }
        // Gezielt nachgeholte Aufträge (POST /api/odoo/nachholen): ohne Maschine, sie kommen in "Noch nicht eingeplant"
        getExtraSources().forEach((s) => !wanted.has(s) && wanted.set(s, ""));
      }
      const plan = computePlan(items, wanted, force);
      plan.all = items;
      if (baseline) {
        // Erster Abgleich: alle alten offenen Aufträge sind "bekannt". Was in den letzten Tagen neu angelegt wurde, kommt als neu in die Liste.
        const cutoff = Date.now() - FRESH_DAYS * 24 * 3600 * 1000;
        const inApp = new Set(db.prepare("SELECT odoo_ref FROM orders WHERE odoo_ref LIKE 'FA%'").all().map((r) => r.odoo_ref));
        const isFresh = (i) => !inApp.has(i.odoo_ref) && !i.delivered && !i.saleCancelled && !i.test && (i.current || (i.created && Date.parse(i.created) >= cutoff));
        const fresh = items.filter(isFresh);
        const old = items.filter((i) => !isFresh(i));
        if (!dryRun) {
          applyPlan({ created: fresh, updated: [], closing: [], all: old }, { markAllSeen: true });
          if (extX) applyExternal(extX, ext, []);
          setState("baseline_done", "1");
          setState("last_sync", new Date().toISOString());
          setState("last_error", null);
          setState("pending_closing", "[]");
          if (fresh.length || (extX && extX.created.length)) setState("last_change", new Date().toISOString());
          if (fresh.length) avPaketeBald();
          await storeCompleteness().catch((err) => console.error("Odoo-Abgleich: Vollständigkeit nicht prüfbar", err.message));
        }
        return {
          baseline: true,
          openCount: plan.openCount,
          knownInApp: plan.knownInApp,
          updated: 0,
          created: [...fresh.map((i) => ({ ref: i.odoo_ref, source: i.source, product: i.product, quantity: i.quantity, due: i.due })), ...extCreated()],
          closing: [],
        };
      }
      if (!dryRun) {
        // Nur Vorschläge, die die App gerade selbst berechnet hat, dürfen geschlossen werden
        const extClosing = extX ? extX.closing : [];
        const allowed = new Set(plan.closing.map((c) => c.ref));
        const allowedExt = new Set(extClosing.map((c) => c.ref));
        applyPlan(plan, { closeRefs: closeRefs.filter((r) => allowed.has(r)) });
        if (extX) applyExternal(extX, ext, closeRefs.filter((r) => allowedExt.has(r)));
        setState("last_sync", new Date().toISOString());
        setState("last_error", null);
        if (plan.created.length || closeRefs.length || (extX && extX.created.length)) setState("last_change", new Date().toISOString());
        if (plan.created.length) avPaketeBald();
        const remaining = [...computePlan(items).closing, ...(extX ? computeExternal(ext).closing : [])];
        setState("pending_closing", JSON.stringify(remaining));
        // Nach dem Übernehmen prüfen, ob jeder laufende Kundenauftrag sichtbar ist (ein Fehler hier hält den Abgleich nicht auf)
        await storeCompleteness().catch((err) => console.error("Odoo-Abgleich: Vollständigkeit nicht prüfbar", err.message));
      } else if (auto) {
        setState("pending_closing", JSON.stringify([...plan.closing, ...(extX ? extX.closing : [])]));
      }
      return {
        baseline: false,
        openCount: plan.openCount,
        created: [...plan.created.map((i) => ({ ref: i.odoo_ref, source: i.source, product: i.product, quantity: i.quantity, due: i.due })), ...extCreated()],
        updated: plan.updated.length,
        closing: [...plan.closing, ...(extX ? extX.closing : [])],
      };
    } catch (err) {
      setState("last_error", err.message);
      throw err;
    } finally {
      running = false;
    }
  }

  app.get("/api/odoo/status", (req, res) => {
    let pending = [];
    try {
      pending = JSON.parse(getState("pending_closing") || "[]");
    } catch {
      pending = [];
    }
    res.json({
      enabled,
      baselineDone: getState("baseline_done") === "1",
      lastSync: getState("last_sync"),
      lastChange: getState("last_change"),
      lastError:
        getState("last_error") ||
        (getState("ext_error") ? "Einkauf (Fremdfertigung): " + getState("ext_error") : null) ||
        (getState("gap_error") ? "Odoo-Planungsliste: " + getState("gap_error") : null),
      pendingClosing: pending,
      bomCheck: bomCheck(),
      vollst: vollstSummary(),
    });
  });

  // für "Heute zu tun" (server/heute.js): Vollständigkeit, Schließvorschläge, Musterwerte
  app.locals.odooHeute = () => {
    let pending = [];
    try {
      pending = JSON.parse(getState("pending_closing") || "[]");
    } catch {
      pending = [];
    }
    return { vollst: completeness(), closing: pending.length, muster: bomCheck().muster.length };
  };

  // Kurzfassung der Vollständigkeitsprüfung für Hinweise (Zahlen statt Listen)
  function vollstSummary() {
    const r = completeness();
    return r ? { at: r.at, total: r.total, sichtbar: r.sichtbar, fehlt: r.fehlt.length, ohneBeleg: r.ohneBeleg.length, lieferungOffen: r.lieferungOffen.length } : null;
  }

  // Vollständigkeit: gespeichertes Ergebnis des letzten Abgleichs (GET) oder sofort neu gegen Odoo prüfen (POST)
  app.get("/api/odoo/vollstaendigkeit", (req, res) => {
    res.json({ enabled, result: completeness(), error: getState("vollst_error") });
  });
  app.post("/api/odoo/vollstaendigkeit", async (req, res) => {
    if (!enabled) return res.status(409).json({ error: "Odoo ist nicht verbunden" });
    try {
      // Erst abgleichen (übernimmt, was fehlt), dann prüfen. Läuft gerade ein Abgleich, nur prüfen.
      if (getState("baseline_done") === "1" && !running) await run({ dryRun: false, closeRefs: [], auto: true });
      else await storeCompleteness();
      res.json({ enabled, result: completeness(), error: null });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
  // Kundenauftrag ohne Beleg abhaken (nichts zu fertigen) oder den Haken wieder lösen
  app.post("/api/odoo/vollstaendigkeit/geprueft", (req, res) => {
    const source = String((req.body && req.body.source) || "").trim().toUpperCase();
    const note = String((req.body && req.body.note) || "").trim().slice(0, 200);
    if (!/^[A-Z]\d{3,}$/.test(source)) return res.status(400).json({ error: "Bitte eine Auftragsnummer wie A01109 angeben" });
    if (req.body && req.body.undo) db.prepare("DELETE FROM odoo_sale_ack WHERE source = ?").run(source);
    else {
      const session = app.locals.bdeSession ? app.locals.bdeSession(req) : null;
      db.prepare("INSERT INTO odoo_sale_ack (source, note, by_name, at) VALUES (?, ?, ?, ?) ON CONFLICT (source) DO UPDATE SET note = excluded.note, by_name = excluded.by_name, at = excluded.at").run(
        source,
        note,
        session ? staffName(session.e) || null : null,
        new Date().toISOString()
      );
    }
    res.json({ enabled, result: completeness(), error: getState("vollst_error") });
  });

  // Was bei den Stücklisten auffällt: Entwürfe (fehlen in der Planung), Aufträge ohne Stückliste oder Arbeitsgänge, Aufträge mit Musterwerten
  function bomCheck() {
    let drafts = [];
    try {
      drafts = JSON.parse(getState("drafts") || "[]");
    } catch {
      drafts = [];
    }
    const flagged = db.prepare("SELECT odoo_ref AS ref, odoo_bom AS bom FROM orders WHERE done = 0 AND odoo_ref LIKE 'FA%' AND odoo_bom IN ('none', 'leer', 'muster') ORDER BY odoo_ref").all();
    const refs = (k) => flagged.filter((f) => f.bom === k).map((f) => f.ref);
    return {
      drafts: drafts.length,
      draftsNoBom: drafts.filter((d) => d.noBom).map((d) => d.ref),
      none: refs("none"),
      leer: refs("leer"),
      muster: refs("muster"),
    };
  }

  app.post("/api/odoo/sync", async (req, res) => {
    const { dryRun, close } = req.body || {};
    if (close !== undefined && !(Array.isArray(close) && close.length <= 500 && close.every((r) => typeof r === "string" && r.length <= 40))) {
      return res.status(400).json({ error: "invalid payload" });
    }
    try {
      res.json(await run({ dryRun: dryRun !== false, closeRefs: close || [] }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Einen Auftrag gezielt nachholen: Seine offenen Fertigungsaufträge, die die App nicht kennt, kommen in "Noch nicht eingeplant" (einmalig)
  app.post("/api/odoo/nachholen", async (req, res) => {
    const source = String((req.body && req.body.source) || "").trim().toUpperCase();
    if (!/^[A-Z]\d{3,}$/.test(source)) return res.status(400).json({ error: "Bitte eine Auftragsnummer wie A01378 angeben" });
    if (getState("baseline_done") !== "1") return res.status(409).json({ error: "Der erste Abgleich mit Odoo ist noch nicht gelaufen" });
    try {
      const extra = getExtraSources();
      if (!extra.includes(source)) setState("gap_extra", JSON.stringify([...extra, source]));
      const r = await run({ dryRun: false, closeRefs: [], force: req.body && req.body.force === true ? source : null });
      res.json({ source, created: r.created.filter((c) => c.source === source) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Abgleich im Hintergrund (alle 10 Minuten): übernimmt neue Aufträge und aktualisiert bekannte, schließt nie von selbst
  async function auto() {
    if (!enabled || getState("baseline_done") !== "1") return;
    try {
      const r = await run({ dryRun: false, closeRefs: [], auto: true });
      if (r.created.length) console.log(`Odoo-Abgleich: ${r.created.length} neue Fertigungsaufträge übernommen`);
    } catch (err) {
      console.error("Odoo-Abgleich fehlgeschlagen:", err.message);
    }
  }
  if (enabled) {
    setTimeout(auto, 45 * 1000);
    setInterval(auto, EVERY);
  }
}
