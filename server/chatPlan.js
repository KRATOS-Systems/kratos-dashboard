// Planen im Chat: Schreib-Werkzeuge für den Planungs-MCP, nur über den eigenen Schlüssel PLAN_CHAT_SECRET (nicht für Talos).
// Gedacht für den Chat mit Claude (Claude Code / claude.ai), in dem Alexander plant.
//
// Jedes Werkzeug, das etwas ändert, rechnet ohne bestaetigt: true nur vor (was würde sich ändern, wer wird später) und ändert nichts.
// Erst wenn der Nutzer im Chat ausdrücklich zugestimmt hat, ruft Claude es mit bestaetigt: true erneut auf. Jede Änderung steht mit
// dem Namen PLAN_CHAT_NAME (Standard "Chat (Alexander)") im Verlauf: Terminverlauf, Freigaben, Extern-Verlauf; Umplanen wie beim Ziehen
// einer Karte (in Odoo stellt sich der noch nicht begonnene Arbeitsplan mit um).

import { MACHINES } from "../src/lib.js";
import { applyMove, byPosition, groupLabelOf } from "../src/planLogic.js";
import { loadPlanInputs, planTools, findPositions } from "./talosPlan.js";
import { makeAllowed } from "./maschinenRegel.js";
import { startedOf } from "./neuordnen.js";

const machineOf = (key) => {
  const k = String(key || "").toLowerCase().replace(/\s+/g, "");
  return MACHINES.find((m) => m.id === k || m.short.toLowerCase().replace(/\s+/g, "") === k || m.name.toLowerCase().replace(/\s+/g, "").includes(k));
};
const machineIds = MACHINES.map((m) => m.short).join(", ");
const CONFIRM = {
  type: "boolean",
  description: "Erst true setzen, wenn der Nutzer im Chat ausdrücklich zugestimmt hat. Ohne: nur Vorschau, nichts wird geändert.",
};
const preview = (data) => ({ vorschau: true, geaendert: false, ...data, hinweis: "Nichts geändert. Zum Ausführen dem Nutzer die Folgen nennen und nach seinem Ja mit bestaetigt: true erneut aufrufen." });

export function chatTools(app, db, helpers) {
  const who = () => process.env.PLAN_CHAT_NAME || "Chat (Alexander)";
  const inputs = () => loadPlanInputs(db, helpers);
  const read = planTools(inputs);
  const sim = read.find((t) => t.name === "plan_simulieren");
  const need = (name) => {
    if (!app.locals[name]) throw new Error("Dieser Teil der App ist gerade nicht verfügbar.");
    return app.locals[name];
  };
  const one = (orders, ref) => {
    const list = findPositions(orders, ref);
    if (!list.length) throw new Error(`Keine offene Position zu "${ref}" gefunden.`);
    return list;
  };

  return [
    {
      name: "position_verschieben",
      readOnly: false,
      description: `Verschiebt eine offene Position (FA-Nummer, Auftragsnummer = alle Positionen des Auftrags, oder id) auf eine Maschine (${machineIds}) an einen Platz in der Reihenfolge. Ohne bestaetigt nur Vorschau mit allen Folgen (wer wird später, wer zu spät). Mit bestaetigt wird gespeichert wie beim Ziehen einer Karte; in Odoo stellt sich der noch nicht begonnene Arbeitsplan auf die neue Maschine um.`,
      inputSchema: {
        type: "object",
        properties: {
          position: { type: "string", description: "FA-Nummer, Auftragsnummer oder id" },
          maschine: { type: "string", description: `Zielmaschine (${machineIds})` },
          platz: { type: "integer", minimum: 1, description: "1 = als Nächstes" },
          bestaetigt: CONFIRM,
        },
        required: ["position", "maschine", "platz"],
        additionalProperties: false,
      },
      run: async ({ position, maschine, platz, bestaetigt }) => {
        const m = machineOf(maschine);
        if (!m) throw new Error(`Maschine "${maschine}" unbekannt. Bekannt: ${machineIds}`);
        const inp = inputs();
        const list = one(inp.orders, position);
        const ids = list.map((o) => o.id);
        const warn = [];
        const fits = makeAllowed(inp.orders);
        list.forEach((o) => !fits(o, m.id) && warn.push(`${o.order_no || o.odoo_ref} ist für die ${m.short} nicht freigegeben (eingeschränkte Maschine). Nur verschieben, wenn das Teil dort sicher geht.`));
        const queue = inp.orders.filter((o) => o.machine === m.id && !o.done && !ids.includes(o.id)).sort(byPosition);
        queue.slice(platz - 1).forEach((o) => startedOf(o, inp.today) && warn.push(`Vor ${o.order_no || o.odoo_ref}, die schon läuft.`));
        const s = sim.run({ maschine: m.short, platz, position: String(position) });
        if (!bestaetigt) return preview({ ...s, warnungen: warn.length ? warn : undefined });
        const before = db.prepare(`SELECT id, machine, odoo_id, odoo_ref, done FROM orders WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
        const moved = applyMove(inp.orders, ids, m.id, platz - 1);
        const upd = db.prepare("UPDATE orders SET machine = ?, position = ? WHERE id = ? AND done = 0");
        db.exec("BEGIN");
        try {
          moved.ids.forEach((id, i) => upd.run(m.id, i, id));
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        const odoo = helpers.odooMachineMoves ? await helpers.odooMachineMoves(before, m.id) : [];
        return { geaendert: true, von: who(), maschine: m.short, platz, positionen: list.map((o) => o.order_no || o.odoo_ref), folgen: { zu_spaet_vorher: s.zu_spaet_vorher, zu_spaet_nachher: s.zu_spaet_nachher, neu_zu_spaet: s.neu_zu_spaet }, odoo, warnungen: warn.length ? warn : undefined };
      },
    },
    {
      name: "stunden_setzen",
      readOnly: false,
      description: "Setzt die Stunden (Maschinenzeit gesamt) einer offenen Position. Ohne bestaetigt nur Vorschau (alt -> neu, Folgen für die Planung).",
      inputSchema: {
        type: "object",
        properties: { position: { type: "string", description: "FA-Nummer oder id (genau eine Position)" }, stunden: { type: "number", exclusiveMinimum: 0, maximum: 1000 }, bestaetigt: CONFIRM },
        required: ["position", "stunden"],
        additionalProperties: false,
      },
      run: ({ position, stunden, bestaetigt }) => {
        const list = one(inputs().orders, position);
        if (list.length > 1) throw new Error(`"${position}" passt auf ${list.length} Positionen. Bitte FA-Nummer oder id angeben.`);
        const o = list[0];
        if (!bestaetigt) return preview({ position: o.order_no || o.odoo_ref, auftrag: groupLabelOf(o), stunden_alt: o.hours ?? null, stunden_neu: stunden, maschine: MACHINES.find((m) => m.id === o.machine)?.short || "noch nicht eingeplant" });
        db.prepare("UPDATE orders SET hours = ?, hours_plan = ? WHERE id = ? AND done = 0").run(stunden, stunden, o.id);
        return { geaendert: true, von: who(), position: o.order_no || o.odoo_ref, stunden_alt: o.hours ?? null, stunden_neu: stunden };
      },
    },
    {
      name: "liefertermin_setzen",
      readOnly: false,
      description: "Setzt den Liefertermin eines Auftrags (Auftragsnummer: alle offenen Positionen) oder einer Position (FA-Nummer). Der ursprüngliche Termin bleibt im Terminverlauf sichtbar, mit Grund. Ohne bestaetigt nur Vorschau.",
      inputSchema: {
        type: "object",
        properties: { auftrag: { type: "string", description: "Auftragsnummer (A…), FA-Nummer oder id" }, termin: { type: "string", description: "JJJJ-MM-TT" }, grund: { type: "string", maxLength: 300 }, bestaetigt: CONFIRM },
        required: ["auftrag", "termin"],
        additionalProperties: false,
      },
      run: ({ auftrag, termin, grund, bestaetigt }) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(termin) || Number.isNaN(Date.parse(termin))) throw new Error("termin: JJJJ-MM-TT");
        const list = one(inputs().orders, auftrag);
        const alt = [...new Set(list.map((o) => o.due).filter(Boolean))];
        if (!bestaetigt) return preview({ positionen: list.map((o) => o.order_no || o.odoo_ref), termin_alt: alt, termin_neu: termin, grund: grund || undefined });
        const upd = db.prepare("UPDATE orders SET due_date = ? WHERE id = ? AND done = 0");
        db.exec("BEGIN");
        try {
          list.forEach((o) => {
            if (helpers.dueChange) helpers.dueChange(o.id, termin, { by: who(), reason: grund || null, via: "chat" });
            upd.run(termin, o.id);
          });
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return { geaendert: true, von: who(), positionen: list.map((o) => o.order_no || o.odoo_ref), termin_alt: alt, termin_neu: termin };
      },
    },
    {
      name: "position_fixieren",
      readOnly: false,
      description: "Fixiert eine Position auf ihrer Maschine und ihrem Platz (Planvorschlag und Neu ordnen lassen sie dann stehen) oder hebt das auf. Ohne bestaetigt nur Vorschau.",
      inputSchema: {
        type: "object",
        properties: { position: { type: "string" }, fixiert: { type: "boolean" }, bestaetigt: CONFIRM },
        required: ["position", "fixiert"],
        additionalProperties: false,
      },
      run: ({ position, fixiert, bestaetigt }) => {
        const list = one(inputs().orders, position);
        if (!bestaetigt) return preview({ positionen: list.map((o) => `${o.order_no || o.odoo_ref}: ${o.pinned ? "fixiert" : "frei"} -> ${fixiert ? "fixiert" : "frei"}`) });
        const upd = db.prepare("UPDATE orders SET pinned = ? WHERE id = ? AND done = 0");
        list.forEach((o) => upd.run(fixiert ? 1 : 0, o.id));
        return { geaendert: true, von: who(), positionen: list.map((o) => o.order_no || o.odoo_ref), fixiert };
      },
    },
    {
      name: "freigabe_entscheiden",
      readOnly: false,
      description: "Gibt einen Vorschlag aus der Freigabe-Liste frei oder lehnt ihn ab (AV-Paket: Stunden und Hinweise übernehmen; Planvorschlag: Plan übernehmen; Hinweis: abhaken). Ids aus freigaben_offen. Ohne bestaetigt nur Vorschau des Vorschlags.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer" }, aktion: { type: "string", enum: ["freigeben", "ablehnen"] }, notiz: { type: "string", maxLength: 300 }, bestaetigt: CONFIRM },
        required: ["id", "aktion"],
        additionalProperties: false,
      },
      run: async ({ id, aktion, notiz, bestaetigt }) => {
        const f = need("freigaben").offen().find((x) => x.id === id);
        if (!f) throw new Error(`Keine offene Freigabe mit id ${id}.`);
        if (!bestaetigt) return preview({ id, art: f.art, titel: f.titel, text: f.text ? String(f.text).slice(0, 800) : undefined, aktion });
        return { geaendert: true, von: who(), ...(await need("freigaben").entscheiden(id, aktion, notiz, who())) };
      },
    },
    {
      name: "freigaben_vorbereiten",
      readOnly: false,
      description: "Rechnet AV-Pakete und den Planvorschlag des Tages jetzt neu (ändert an der Planung nichts, legt nur Vorschläge in die Freigabe-Liste).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => ({ ok: true, ...(await need("freigaben").vorbereiten()) }),
    },
    {
      name: "lieferant_mail_entwurf",
      description: "Mail-Entwurf an den Lieferanten zu einer offenen Bestellung (Bestellnummer P…): offene Mengen, Termin, deren Referenz. Deutsch oder englisch. Sendet nichts.",
      inputSchema: { type: "object", properties: { bestellung: { type: "string" }, sprache: { type: "string", enum: ["de", "en"] } }, required: ["bestellung"], additionalProperties: false },
      run: ({ bestellung, sprache }) => need("extern").mail(String(bestellung).trim().toUpperCase(), { lang: sprache, sender: "" }),
    },
    {
      name: "lieferant_status_setzen",
      readOnly: false,
      description: "Extern & Wareneingang: hält fest, dass der Lieferant zu einer Bestellung angefragt wurde (per Mail oder Telefon), und/oder trägt den neuen Liefertermin des Lieferanten ein (gilt sofort in der Planung). Ohne bestaetigt nur Vorschau.",
      inputSchema: {
        type: "object",
        properties: {
          bestellung: { type: "string", description: "P…" },
          angefragt: { type: "string", enum: ["mail", "telefon"] },
          neuer_termin: { type: "string", description: "JJJJ-MM-TT" },
          notiz: { type: "string", maxLength: 300 },
          bestaetigt: CONFIRM,
        },
        required: ["bestellung"],
        additionalProperties: false,
      },
      run: async ({ bestellung, angefragt, neuer_termin, notiz, bestaetigt }) => {
        const po = String(bestellung).trim().toUpperCase();
        if (!angefragt && !neuer_termin) throw new Error("angefragt oder neuer_termin angeben.");
        const ext = need("extern");
        const item = (await ext.get(false)).offen.find((x) => x.po === po);
        if (!item) throw new Error(`Keine offene Bestellung ${po}.`);
        if (!bestaetigt) return preview({ bestellung: po, lieferant: item.lieferant, termin_jetzt: item.termin, neuer_termin: neuer_termin || undefined, angefragt: angefragt || undefined, haengt_dran: item.betroffen.map((b) => b.ref) });
        if (angefragt) await ext.angefragt(po, { weg: angefragt, notiz, who: who() });
        const t = neuer_termin ? await ext.termin(po, neuer_termin, { notiz, who: who() }) : null;
        return { geaendert: true, von: who(), bestellung: po, angefragt: angefragt || undefined, neuer_termin: neuer_termin || undefined, planung_angepasst: t ? t.planung : undefined };
      },
    },
  ];
}
