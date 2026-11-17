// Extern & Wareneingang: Was ist bestellt und noch nicht da, wer muss nachfragen, wo fehlt eine Bestellung?
//
// Quelle Odoo (nur lesen):
//   - bestätigte Einkaufsbestellungen mit offenem Wareneingang (Fremdfertigung, Lohnarbeit, Material). Solange der Wareneingang (WH/IN)
//     nicht validiert ist, ist die Ware nicht im Lager.
//   - externe Arbeitsgänge im Arbeitsplan (Arbeitsplatz "… (EXTERN)": Strahlen, Schleifen, Härten, Oberfläche, Drehen extern) ohne Bestellung
//   - erledigte Wareneingänge der letzten 12 Monate für die Lieferanten-Bewertung (Termintreue, Durchlaufzeit)
// Handlungsbedarf:
//   überfällig      Wareneingang nach dem (zugesagten) Termin noch offen -> Lieferant anfragen; angefragt und nach 2 Werktagen ohne neuen Termin -> erneut
//   bald            Termin in den nächsten 2 Werktagen, noch nicht angefragt -> vorab nachfragen
//   Bestellung fehlt externer Arbeitsgang ohne Bestellung, die Maschine ist in 7 Tagen fertig (oder schon)
// Lieferant anfragen: die App baut die Mail (Bestellnummer, Positionen, Termin, deren Referenz) und öffnet sie im Mailprogramm. Gesendet wird
// nur von Hand. Danach: "angefragt" abhaken und den neuen Termin eintragen. Der neue Termin gilt in der Planung (Materialtermin, Fremdfertigung).
// In Odoo schreibt hier nichts.

import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { addDays, daysBetween, todayStr, MACHINES } from "../src/lib.js";

export const EXTERN_DDL = `
  CREATE TABLE IF NOT EXISTS extern_status (
    po TEXT PRIMARY KEY,
    angefragt_am TEXT,
    angefragt_von TEXT,
    neuer_termin TEXT,
    notiz TEXT,
    verlauf TEXT NOT NULL DEFAULT '[]',
    geaendert TEXT
  );`;

const TTL = 10 * 60 * 1000;
const RATING_TTL = 6 * 3600 * 1000;
const dayPart = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const m2oId = (v) => (Array.isArray(v) ? v[0] : null);
const m2oName = (v) => (Array.isArray(v) && v[1] ? String(v[1]) : null);
const fmtDay = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");
const codeOf = (s) => {
  const m = /^\s*\[([^\]]+)\]/.exec(String(s || ""));
  return m ? m[1].trim() : null;
};
const firstLine = (s) => String(s || "").split("\n")[0].trim();
const refsOf = (origin, re) => [...new Set(String(origin || "").match(re) || [])];
const isWeekend = (d) => [0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay());
// Werktage zwischen heute und d (d in der Zukunft: positiv)
function workdaysUntil(today, d) {
  let n = 0;
  if (d <= today) return 0;
  for (let x = addDays(today, 1); x <= d; x = addDays(x, 1)) if (!isWeekend(x)) n++;
  return n;
}
function addWorkdays(d, n) {
  let x = d;
  let k = 0;
  while (k < n) {
    x = addDays(x, 1);
    if (!isWeekend(x)) k++;
  }
  return x;
}
// Art der Bestellung: Material (Herkunft FA, Halbzeug), Lohnarbeit (Oberfläche usw.), sonst Fremdfertigung (ganze Teile)
function artOf(origin, lines) {
  const text = lines.map((l) => l.name).join(" ").toLowerCase();
  if (/elox|härt|haert|beschicht|strahl|schleif|brünier|vernick|verzink|pulver|galvan/.test(text) && !lines.some((l) => codeOf(l.name))) return "Lohnarbeit";
  if (/\bFA\d{4,}/.test(origin || "") && !/\bA\d{4,}/.test(origin || "")) return "Material";
  return lines.some((l) => codeOf(l.name)) ? "Fremdfertigung" : "Material";
}
// Ansprechpartner "Firma, Vorname Nachname" -> Anrede-Name
const contactName = (partner) => {
  const parts = String(partner || "").split(",");
  return parts.length > 1 ? parts.slice(1).join(",").trim() : "";
};

export function mailFor(item, { sender = "", vorab = false } = {}) {
  const en = item.lang === "en";
  const name = contactName(item.partner);
  const pos = item.lines.filter((l) => l.offen > 0).map((l) => `- ${l.offen} x ${l.name}`);
  const ref = item.partnerRef ? (en ? ` (your reference ${item.partnerRef})` : ` (Ihre Referenz ${item.partnerRef})`) : "";
  const termin = fmtDay(item.termin);
  const subject = en ? `Delivery date – our purchase order ${item.po}${item.partnerRef ? " / " + item.partnerRef : ""}` : `Liefertermin – unsere Bestellung ${item.po}${item.partnerRef ? " / " + item.partnerRef : ""}`;
  const body = en
    ? [
        `Dear ${name || "Sir or Madam"},`,
        "",
        vorab
          ? `regarding our purchase order ${item.po}${ref}, delivery is agreed for ${termin}. Could you please briefly confirm that this date will be met?`
          : `regarding our purchase order ${item.po}${ref}, delivery was agreed for ${termin}. We have not received the following items yet:`,
        ...(vorab ? [] : ["", ...pos, "", "Could you please let us know when the goods will arrive, and whether a partial delivery is possible?"]),
        "",
        "Thank you and kind regards",
        sender || "",
        "KRATOS Precision GmbH",
      ]
    : [
        `Guten Tag${name ? " " + name : ""},`,
        "",
        vorab
          ? `zu unserer Bestellung ${item.po}${ref} ist die Lieferung für den ${termin} vereinbart. Können Sie uns bitte kurz bestätigen, dass der Termin gehalten wird?`
          : `zu unserer Bestellung ${item.po}${ref} war die Lieferung für den ${termin} vereinbart. Bei uns ist bisher nicht eingegangen:`,
        ...(vorab ? [] : ["", ...pos, "", "Bitte teilen Sie uns kurz mit, wann die Ware bei uns eintrifft und ob eine Teillieferung möglich ist."]),
        "",
        "Vielen Dank und freundliche Grüße",
        sender || "",
        "KRATOS Precision GmbH",
      ];
  const text = body.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").replace(/\n{3,}/g, "\n\n");
  return {
    to: item.email || "",
    subject,
    body: text,
    mailto: `mailto:${encodeURIComponent(item.email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`,
  };
}

export default function registerExtern(app, db, helpers) {
  db.exec(EXTERN_DDL);
  const statusOf = db.prepare("SELECT * FROM extern_status WHERE po = ?");
  const now = () => new Date().toISOString();
  const sessionName = (req) => {
    const s = app.locals.bdeSession ? app.locals.bdeSession(req) : null;
    return s && helpers.staffName ? helpers.staffName(s.e) || null : null;
  };
  let cache = null;
  let rating = null;
  let loading = null;

  async function readAll(read, model, domain, fields, limit = 2000) {
    return read(model, { domain, fields, limit });
  }

  // Lieferanten-Bewertung aus erledigten Wareneingängen (12 Monate)
  async function loadRating(read) {
    if (rating && Date.now() - rating.at < RATING_TTL) return rating.list;
    const since = addDays(todayStr(), -365);
    const picks = await readAll(read, "stock.picking", [["picking_type_code", "=", "incoming"], ["state", "=", "done"], ["purchase_id", "!=", false], ["date_done", ">=", since + " 00:00:00"]], ["partner_id", "date_done", "date_deadline", "scheduled_date", "purchase_id"], 3000);
    const poIds = [...new Set(picks.map((p) => m2oId(p.purchase_id)).filter(Boolean))];
    const pos = poIds.length ? await readAll(read, "purchase.order", [["id", "in", poIds]], ["date_approve", "partner_id"], 3000) : [];
    const approve = new Map(pos.map((p) => [p.id, dayPart(p.date_approve)]));
    const by = new Map();
    for (const p of picks) {
      const partner = (m2oName(p.partner_id) || "unbekannt").split(",")[0].trim();
      const done = dayPart(p.date_done);
      const due = dayPart(p.date_deadline) || dayPart(p.scheduled_date);
      if (!done || !due) continue;
      const cur = by.get(partner) || { lieferant: partner, eingaenge: 0, puenktlich: 0, spaetTage: [], durchlauf: [] };
      cur.eingaenge++;
      const late = daysBetween(due, done);
      if (late <= 0) cur.puenktlich++;
      else cur.spaetTage.push(late);
      const a = approve.get(m2oId(p.purchase_id));
      if (a) cur.durchlauf.push(Math.max(0, daysBetween(a, done)));
      by.set(partner, cur);
    }
    const median = (xs) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const list = [...by.values()]
      .map((r) => ({
        lieferant: r.lieferant,
        eingaenge: r.eingaenge,
        quote: Math.round((r.puenktlich / r.eingaenge) * 100),
        spaetSchnitt: r.spaetTage.length ? Math.round((r.spaetTage.reduce((s, x) => s + x, 0) / r.spaetTage.length) * 10) / 10 : 0,
        durchlaufMedian: median(r.durchlauf),
      }))
      .sort((a, b) => b.eingaenge - a.eingaenge);
    rating = { at: Date.now(), list };
    return list;
  }

  async function load() {
    const read = app.locals.odooRead;
    if (!read) return { enabled: false, stand: now(), offen: [], fehlt: [], bewertung: [], altlasten: [], zahlen: zahlenOf([], []) };
    const today = todayStr();
    // 1. offene Bestellungen mit offenem Wareneingang
    const pos = await readAll(read, "purchase.order", [["state", "=", "purchase"], ["receipt_status", "in", ["pending", "partial"]]], ["name", "origin", "partner_id", "partner_ref", "date_approve", "date_planned", "receipt_status"], 500);
    const ids = pos.map((p) => p.id);
    const picks = ids.length
      ? await readAll(read, "stock.picking", [["picking_type_code", "=", "incoming"], ["state", "not in", ["done", "cancel"]], ["purchase_id", "in", ids]], ["name", "scheduled_date", "date_deadline", "state", "purchase_id"], 1000)
      : [];
    const lines = ids.length ? await readAll(read, "purchase.order.line", [["order_id", "in", ids]], ["order_id", "name", "product_id", "product_qty", "qty_received", "date_planned", "display_type"], 3000) : [];
    const pids = [...new Set(pos.map((p) => m2oId(p.partner_id)).filter(Boolean))];
    let partners = pids.length ? await readAll(read, "res.partner", [["id", "in", pids]], ["name", "email", "phone", "mobile", "lang", "country_id", "parent_id"], 500) : [];
    const parentIds = [...new Set(partners.map((p) => m2oId(p.parent_id)).filter((x) => x && !pids.includes(x)))];
    if (parentIds.length) partners = partners.concat(await readAll(read, "res.partner", [["id", "in", parentIds]], ["name", "email", "phone", "mobile", "lang", "country_id", "parent_id"], 500));
    const partnerBy = new Map(partners.map((p) => [p.id, p]));
    const contact = (id) => {
      const p = partnerBy.get(id) || {};
      const parent = partnerBy.get(m2oId(p.parent_id)) || {};
      const country = m2oName(p.country_id) || m2oName(parent.country_id) || "";
      const lang = String(p.lang || parent.lang || "");
      return {
        email: p.email || parent.email || null,
        phone: p.phone || p.mobile || parent.phone || parent.mobile || null,
        lang: lang ? (lang.startsWith("de") ? "de" : "en") : /deutschland|germany|österreich|austria|schweiz|switzerland/i.test(country) || !country ? "de" : "en",
      };
    };

    // App-Positionen, die von einer Bestellung abhängen
    const inp = loadPlanInputs(db, helpers, today);
    const open = inp.orders.filter((o) => !o.done);
    const ctx = makeContext(inp);
    const { plan } = ctx.compute(inp.orders);
    const endOf = new Map();
    plan.forEach((p) => p.items.forEach((i) => i.scheduled && endOf.set(i.o.id, ctx.endDateOf(i.end))));

    const offen = pos
      .map((p) => {
        const ls = lines.filter((l) => m2oId(l.order_id) === p.id && !l.display_type).map((l) => ({ name: firstLine(l.name), code: codeOf(l.name) || codeOf(m2oName(l.product_id)), menge: l.product_qty, offen: Math.max(0, (l.product_qty || 0) - (l.qty_received || 0)), termin: dayPart(l.date_planned) }));
        const pk = picks.filter((x) => m2oId(x.purchase_id) === p.id);
        const st = statusOf.get(p.name) || null;
        // ursprünglich zugesagt: Frist des Wareneingangs (bleibt beim Verschieben), sonst Plan
        const zugesagt = pk.map((x) => dayPart(x.date_deadline) || dayPart(x.scheduled_date)).filter(Boolean).sort()[0] || dayPart(p.date_planned);
        const odooTermin = pk.map((x) => dayPart(x.scheduled_date)).filter(Boolean).sort()[0] || zugesagt;
        const termin = (st && st.neuer_termin) || odooTermin;
        const refsA = refsOf(p.origin, /\bA\d{4,}\b/g);
        const refsFA = refsOf(p.origin, /\bFA\d{4,}\b/g);
        const codes = new Set(ls.map((l) => l.code).filter(Boolean));
        const betroffen = open
          .filter((o) => refsFA.includes(o.odoo_ref) || o.po_id === p.id || (refsA.includes(o.source) && (codes.size === 0 || codes.has(codeOf(o.product)) || o.machine === "extern_fert")) || (refsA.includes(o.source) && refsFA.length === 0 && codes.size === 0))
          .map((o) => ({ id: o.id, ref: o.odoo_ref || o.order_no, source: o.source, customer: o.customer, due: o.due, machine: o.machine, ende: endOf.get(o.id) || null }));
        const tage = termin ? daysBetween(termin, today) : 0; // > 0 = überfällig
        const kundeGefahr = betroffen.some((b) => b.due && termin && b.due <= termin);
        const angefragt = st && st.angefragt_am ? dayPart(st.angefragt_am) : null;
        const status = !termin ? "ohne Termin" : tage > 0 ? "ueberfaellig" : tage === 0 ? "heute" : workdaysUntil(today, termin) <= 2 ? "bald" : "ok";
        let aktion = null;
        if (status === "ueberfaellig" || status === "heute") {
          if (!angefragt) aktion = "anfragen";
          else if (!(st && st.neuer_termin && st.neuer_termin >= today) && addWorkdays(angefragt, 2) <= today) aktion = "erneut";
          else aktion = "warten";
        } else if (status === "bald" && !angefragt) aktion = "vorab";
        const c = contact(m2oId(p.partner_id));
        return {
          poId: p.id,
          po: p.name,
          partner: m2oName(p.partner_id) || "",
          lieferant: (m2oName(p.partner_id) || "").split(",")[0].trim(),
          partnerRef: p.partner_ref || null,
          origin: p.origin || null,
          art: artOf(p.origin, ls),
          bestellt: dayPart(p.date_approve),
          zugesagt,
          odooTermin,
          termin,
          neuerTermin: (st && st.neuer_termin) || null,
          tage,
          status,
          aktion,
          angefragt,
          angefragtVon: (st && st.angefragt_von) || null,
          notiz: (st && st.notiz) || null,
          verlauf: st ? JSON.parse(st.verlauf || "[]") : [],
          wareneingang: pk.map((x) => x.name),
          teilweise: p.receipt_status === "partial",
          lines: ls,
          betroffen,
          kundeGefahr,
          ...c,
        };
      })
      .sort((a, b) => (a.termin || "9999").localeCompare(b.termin || "9999"));

    // 2. externe Arbeitsgänge ohne Bestellung
    const wos = await readAll(read, "mrp.workorder", [["state", "not in", ["done", "cancel"]], ["workcenter_id.name", "ilike", "EXTERN"], ["production_id.state", "in", ["confirmed", "progress", "to_close"]]], ["name", "production_id", "workcenter_id", "state"], 500);
    const prodIds = [...new Set(wos.map((w) => m2oId(w.production_id)).filter(Boolean))];
    const prods = prodIds.length ? await readAll(read, "mrp.production", [["id", "in", prodIds]], ["name", "origin", "product_id", "date_deadline"], 500) : [];
    const prodBy = new Map(prods.map((p) => [p.id, p]));
    const since = addDays(today, -240);
    const anyPo = await readAll(read, "purchase.order", [["state", "!=", "cancel"], ["date_order", ">=", since + " 00:00:00"], ["origin", "!=", false]], ["name", "origin", "state", "partner_id"], 3000);
    // Bestellungen zu den betroffenen Aufträgen samt Positionstext: gedeckt ist der Arbeitsgang nur, wenn die Bestellung zur Art passt
    // (z. B. "Strahlen") oder das ganze Teil zukauft (gleiche Zeichnungsnummer). Material zum FA deckt keinen externen Arbeitsgang.
    const keysOf = new Map(wos.map((w) => [m2oId(w.production_id), true]));
    const faNames = new Set(prods.map((p) => String(p.name)));
    const aNames = new Set(prods.flatMap((p) => refsOf(p.origin, /\bA\d{4,}\b/g)));
    const cand = anyPo.filter((p) => refsOf(p.origin, /\bFA\d{4,}\b/g).some((x) => faNames.has(x)) || refsOf(p.origin, /\bA\d{4,}\b/g).some((x) => aNames.has(x)));
    const candLines = cand.length && keysOf.size ? await readAll(read, "purchase.order.line", [["order_id", "in", cand.map((p) => p.id)]], ["order_id", "name"], 3000) : [];
    const textOf = new Map(cand.map((p) => [p.id, candLines.filter((l) => m2oId(l.order_id) === p.id).map((l) => String(l.name || "")).join(" ").toLowerCase()]));
    const KINDS = [["strahl", /strahl/], ["schleif", /schleif/], ["härt", /härt|haert|vergüt/], ["elox", /elox/], ["beschicht", /beschicht|pulver|lack/], ["brünier", /brünier|schwärz/], ["galvanik", /vernick|verzink|galvan|chrom/], ["dreh", /dreh/]];
    const kindOf = (s) => (KINDS.find(([, re]) => re.test(String(s).toLowerCase())) || [null])[0];
    const covered = (fa, a, kind, code) => {
      const hits = cand.filter((p) => (fa && refsOf(p.origin, /\bFA\d{4,}\b/g).includes(fa)) || (a && refsOf(p.origin, /\bA\d{4,}\b/g).includes(a)));
      const fits = hits.filter((p) => {
        const t = textOf.get(p.id) || "";
        return (kind && KINDS.find(([k]) => k === kind)[1].test(t)) || (code && t.includes("[" + code.toLowerCase() + "]"));
      });
      const ordered = fits.find((p) => p.state === "purchase" || p.state === "done");
      return ordered ? { po: ordered.name, bestellt: true } : fits[0] ? { po: fits[0].name, bestellt: false } : null;
    };
    const fehlt = [];
    for (const w of wos) {
      const pr = prodBy.get(m2oId(w.production_id));
      if (!pr) continue;
      const fa = String(pr.name);
      const a = refsOf(pr.origin, /\bA\d{4,}\b/g)[0] || null;
      const cov = covered(fa, a, kindOf(w.name) || kindOf(m2oName(w.workcenter_id)), codeOf(m2oName(pr.product_id)));
      if (cov && cov.bestellt) continue;
      const pos2 = open.filter((o) => o.odoo_ref === fa || o.parent_ref === fa);
      const ende = pos2.map((o) => endOf.get(o.id)).filter(Boolean).sort().pop() || null;
      const anMaschine = pos2.some((o) => MACHINES.some((m) => m.id === o.machine));
      fehlt.push({
        fa,
        source: a,
        produkt: m2oName(pr.product_id),
        schritt: w.name,
        arbeitsplatz: m2oName(w.workcenter_id),
        maschineFertig: ende,
        inApp: pos2.length > 0,
        dringend: !!ende && ende <= addDays(today, 7),
        customer: pos2[0] ? pos2[0].customer : null,
        due: pos2[0] ? pos2[0].due : dayPart(pr.date_deadline),
        anMaschine,
        anfrage: cov ? cov.po : null, // Anfrage (Entwurf) gibt es schon, bestellt ist noch nicht
      });
    }
    fehlt.sort((x, y) => (y.dringend - x.dringend) || (x.maschineFertig || "9999").localeCompare(y.maschineFertig || "9999"));

    // 3. Altlasten: bestätigt, aber ohne Wareneingang; Wareneingänge im Entwurf ohne Bestellung
    const alt = await readAll(read, "purchase.order", [["state", "=", "purchase"], ["receipt_status", "=", false]], ["name", "partner_id", "date_approve", "origin"], 200);
    const altPicks = await readAll(read, "stock.picking", [["picking_type_code", "=", "incoming"], ["state", "not in", ["done", "cancel"]], ["purchase_id", "=", false]], ["name", "partner_id", "scheduled_date"], 200);
    const altlasten = [
      ...alt.map((p) => ({ ref: p.name, lieferant: (m2oName(p.partner_id) || "").split(",")[0], datum: dayPart(p.date_approve), grund: "Bestellung bestätigt, aber ohne Wareneingang" })),
      ...altPicks.map((p) => ({ ref: p.name, lieferant: (m2oName(p.partner_id) || "").split(",")[0], datum: dayPart(p.scheduled_date), grund: "Wareneingang ohne Bestellung" })),
    ];

    let bewertung = [];
    try {
      bewertung = await loadRating(read);
    } catch (err) {
      console.error("Extern: Lieferanten-Bewertung nicht lesbar", err.message);
    }
    // aktuell offene/überfällige je Lieferant dazu
    const offenBy = new Map();
    offen.forEach((x) => {
      const r = offenBy.get(x.lieferant) || { offen: 0, ueberfaellig: 0 };
      r.offen++;
      if (x.status === "ueberfaellig") r.ueberfaellig++;
      offenBy.set(x.lieferant, r);
    });
    const names = new Set([...bewertung.map((b) => b.lieferant), ...offenBy.keys()]);
    bewertung = [...names].map((n) => ({ ...(bewertung.find((b) => b.lieferant === n) || { lieferant: n, eingaenge: 0, quote: null, spaetSchnitt: null, durchlaufMedian: null }), ...(offenBy.get(n) || { offen: 0, ueberfaellig: 0 }) })).sort((a, b) => b.ueberfaellig - a.ueberfaellig || b.offen - a.offen || b.eingaenge - a.eingaenge);

    return { enabled: true, stand: now(), heute: today, offen, fehlt, bewertung, altlasten, zahlen: zahlenOf(offen, fehlt) };
  }

  function zahlenOf(offen, fehlt) {
    return {
      ueberfaellig: offen.filter((x) => x.status === "ueberfaellig").length,
      anfragen: offen.filter((x) => x.aktion === "anfragen" || x.aktion === "erneut").length,
      vorab: offen.filter((x) => x.aktion === "vorab").length,
      kundeGefahr: offen.filter((x) => x.kundeGefahr && (x.status === "ueberfaellig" || x.status === "heute")).length,
      fehltDringend: fehlt.filter((x) => x.dringend).length,
      fehlt: fehlt.length,
    };
  }

  async function get(force) {
    if (!force && cache && Date.now() - cache.at < TTL) return cache.data;
    if (loading) return loading;
    loading = load()
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => (loading = null));
    return loading;
  }
  // Nach einer Änderung (angefragt, neuer Termin) nur den Status neu einrechnen, ohne Odoo neu zu lesen
  const invalidate = () => {
    if (cache) cache.at = 0;
  };

  app.get("/api/extern", async (req, res) => {
    try {
      res.json(await get(req.query.neu === "1"));
    } catch (err) {
      res.status(502).json({ error: "Odoo nicht lesbar: " + err.message });
    }
  });

  const findItem = async (po) => (await get(false)).offen.find((x) => x.po === po);

  app.get("/api/extern/:po/mail", async (req, res) => {
    const item = await findItem(req.params.po);
    if (!item) return res.status(404).json({ error: "Keine offene Bestellung " + req.params.po });
    res.json(mailFor({ ...item, lang: req.query.lang === "en" || req.query.lang === "de" ? req.query.lang : item.lang }, { sender: sessionName(req) || "", vorab: req.query.vorab === "1" || item.aktion === "vorab" }));
  });

  const log = (po, eintrag) => {
    const cur = statusOf.get(po);
    const verlauf = cur ? JSON.parse(cur.verlauf || "[]") : [];
    verlauf.push({ at: now(), ...eintrag });
    return JSON.stringify(verlauf.slice(-30));
  };

  // "Lieferant angefragt" abhaken (Telefon oder Mail)
  app.post("/api/extern/:po/angefragt", async (req, res) => {
    const po = req.params.po;
    const item = await findItem(po);
    if (!item) return res.status(404).json({ error: "Keine offene Bestellung " + po });
    const who = sessionName(req) || String((req.body && req.body.von) || "").slice(0, 60) || "App";
    const notiz = String((req.body && req.body.notiz) || "").slice(0, 300) || null;
    const weg = req.body && req.body.weg === "telefon" ? "telefonisch" : "per Mail";
    db.prepare(
      `INSERT INTO extern_status (po, angefragt_am, angefragt_von, notiz, verlauf, geaendert) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (po) DO UPDATE SET angefragt_am = excluded.angefragt_am, angefragt_von = excluded.angefragt_von, notiz = COALESCE(excluded.notiz, notiz), verlauf = excluded.verlauf, geaendert = excluded.geaendert`
    ).run(po, now(), who, notiz, log(po, { was: `angefragt ${weg}`, von: who, notiz }), now());
    invalidate();
    res.json({ ok: true });
  });

  // Neuer Termin vom Lieferanten: gilt sofort in der Planung (Materialtermin der Fertigungsaufträge, Dauer der Fremdfertigung)
  app.post("/api/extern/:po/termin", async (req, res) => {
    const po = req.params.po;
    const termin = String((req.body && req.body.termin) || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(termin)) return res.status(400).json({ error: "termin: JJJJ-MM-TT" });
    const item = await findItem(po);
    if (!item) return res.status(404).json({ error: "Keine offene Bestellung " + po });
    const who = sessionName(req) || String((req.body && req.body.von) || "").slice(0, 60) || "App";
    const notiz = String((req.body && req.body.notiz) || "").slice(0, 300) || null;
    db.prepare(
      `INSERT INTO extern_status (po, angefragt_am, angefragt_von, neuer_termin, notiz, verlauf, geaendert) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (po) DO UPDATE SET neuer_termin = excluded.neuer_termin, angefragt_am = COALESCE(angefragt_am, excluded.angefragt_am), angefragt_von = COALESCE(angefragt_von, excluded.angefragt_von), notiz = COALESCE(excluded.notiz, notiz), verlauf = excluded.verlauf, geaendert = excluded.geaendert`
    ).run(po, now(), who, termin, notiz, log(po, { was: `neuer Termin ${fmtDay(termin)}`, von: who, notiz }), now());
    // Planung: Fertigungsaufträge, deren Material an dieser Bestellung hängt, und Fremdfertigung dieser Bestellung
    const refsFA = refsOf(item.origin, /\bFA\d{4,}\b/g);
    const setMat = db.prepare("UPDATE orders SET material_date = ?, material_info = ? WHERE (odoo_ref = ? OR parent_ref = ?) AND done = 0");
    const info = `${po} ${item.lieferant}, Wareneingang offen, neuer Termin ${fmtDay(termin).slice(0, 6)} (vom Lieferanten)`;
    refsFA.forEach((fa) => setMat.run(termin, info, fa, fa));
    const fert = db.prepare("SELECT id, extern_start FROM orders WHERE po_id = ? AND done = 0 AND machine = 'extern_fert'").all(item.poId);
    const upd = db.prepare("UPDATE orders SET extern_days = ? WHERE id = ?");
    fert.forEach((o) => o.extern_start && upd.run(Math.max(1, Math.min(180, daysBetween(o.extern_start, termin))), o.id));
    invalidate();
    res.json({ ok: true, planung: refsFA.length + fert.length });
  });

  // Neuer Termin, den die App selbst kennt (für den Odoo-Abgleich: der Materialtermin bleibt beim Termin des Lieferanten)
  app.locals.externTermin = (po) => {
    const r = statusOf.get(po);
    return r && r.neuer_termin ? r.neuer_termin : null;
  };
  app.locals.extern = {
    get: (force) => get(force),
    zahlen: () => (cache ? cache.data.zahlen : null),
  };

  if (process.env.EXTERN_AUTO !== "0") {
    setTimeout(() => get(true).catch((err) => console.error("Extern:", err.message)), 60 * 1000).unref();
    setInterval(() => get(true).catch((err) => console.error("Extern:", err.message)), 15 * 60 * 1000).unref();
  }
}
