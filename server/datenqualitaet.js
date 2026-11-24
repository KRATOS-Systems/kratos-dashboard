// Datenqualität: Was in Odoo, der Kalkulation oder der App fehlt und die KI ausbremst – als Arbeitsliste mit Links.
// Nur lesen; die Liste sammelt, was andere Teile der App schon wissen (Abgleich, AV-Pakete, Zeichnungen, Extern).
//
//   stueckliste    Fertigungsauftrag ohne Stückliste, ohne Arbeitsgänge oder auf Musterwerten -> Maschine/Zeit in Odoo pflegen
//   zeichnung      keine Zeichnung (PDF) am Artikel in Odoo -> anhängen (sonst kann die KI sie nicht lesen)
//   kalkulation    Teil ist in der Kalkulation nicht kalkuliert -> "In der Kalkulation berechnen" im AV-Paket
//   material       AV hat Material als bereit abgehakt, Odoo meldet „nicht verfügbar“ -> Bestand buchen oder AV zurücksetzen
//   stunden        offene Position ohne Stunden (kann nicht eingeplant werden)
//   schliessen     in Odoo erledigt, in der App noch offen -> beim Odoo-Abgleich schließen
//   einkauf        Altlasten im Einkauf: Bestellung ohne Wareneingang, Wareneingang ohne Bestellung
//   stempel        Buchung über 12 Stunden (vergessenes Ausstempeln) -> verfälscht Soll/Ist und Kennzahlen

import { LANE_IDS } from "../src/planLogic.js";

export default function registerDatenqualitaet(app, db) {
  async function build() {
    const open = db.prepare("SELECT id, odoo_ref, odoo_id, order_no, source, product, customer, hours, machine, odoo_bom, is_split FROM orders WHERE done = 0").all();
    const byRef = new Map(open.filter((o) => o.odoo_ref).map((o) => [o.odoo_ref, o]));
    const pos = (o, extra = {}) => ({ ref: o.odoo_ref || o.order_no || `#${o.id}`, odooId: o.odoo_id || null, source: o.source || null, customer: o.customer || null, product: o.product || null, ...extra });
    const gruppen = [];
    const add = (id, titel, wie, items) => gruppen.push({ id, titel, wie, n: items.length, items: items.slice(0, 100) });

    const BOM = { none: "keine Stückliste", leer: "Stückliste ohne Arbeitsgänge", muster: "Stückliste auf Musterwerten" };
    add(
      "stueckliste",
      "Stückliste fehlt oder läuft auf Musterwerten",
      "In Odoo am Fertigungsauftrag Stückliste und Arbeitsplan (Maschine, Zeiten) pflegen.",
      open.filter((o) => o.odoo_ref && BOM[o.odoo_bom] && !o.is_split).map((o) => pos(o, { grund: BOM[o.odoo_bom] }))
    );

    const z = db.prepare("SELECT fa, grund FROM zeichnungen WHERE daten IS NULL AND grund LIKE 'Keine Zeichnung%'").all();
    add("zeichnung", "Keine Zeichnung am Artikel", "PDF-Zeichnung in Odoo am Artikel anhängen. Danach liest die KI sie beim nächsten Lauf.", z.filter((r) => byRef.has(r.fa)).map((r) => pos(byRef.get(r.fa), { grund: r.grund })));

    const pakete = db.prepare("SELECT bezug, daten FROM freigaben WHERE art = 'av' AND status = 'offen'").all();
    const nichtKalk = [];
    for (const p of pakete) {
      let d;
      try {
        d = JSON.parse(p.daten);
      } catch {
        continue;
      }
      if (d.kalkMoeglich && byRef.has(p.bezug)) nichtKalk.push(pos(byRef.get(p.bezug), { grund: "nicht kalkuliert" }));
    }
    add("kalkulation", "Teil nicht kalkuliert", "Im AV-Paket „In der Kalkulation berechnen“ drücken (legt das Teil an und rechnet es mit der STEP-Datei).", nichtKalk);

    // Material: in der AV als bereit abgehakt, laut Odoo nicht verfügbar (gleiche Regel wie avLib.materialStand)
    const matWider = db
      .prepare(
        `SELECT o.id, o.odoo_ref, o.odoo_id, o.order_no, o.source, o.product, o.customer, o.component_status FROM orders o
         JOIN av_checks c ON c.order_id = o.id AND c.item = 'material' AND c.status = 'bereit'
         WHERE o.done = 0 AND lower(COALESCE(o.component_status, '')) LIKE '%nicht verf%'
         GROUP BY COALESCE(o.odoo_ref, 'id' || o.id)
         ORDER BY o.source, o.odoo_ref`
      )
      .all();
    add(
      "material",
      "Material: AV sagt da, Odoo sagt fehlt",
      "Liegt die Ware da, in Odoo den Wareneingang bzw. Bestand buchen (dann ist sie reserviert). Fehlt sie doch, in der AV den Punkt Material zurücksetzen.",
      matWider.map((o) => pos(o, { grund: `Odoo: ${o.component_status}`, orderId: o.id, klaeren: "material" }))
    );

    add(
      "stunden",
      "Offene Position ohne Stunden",
      "Stunden eintragen (Vorschlag im AV-Paket oder in der Planung), sonst kann sie nicht eingeplant werden.",
      open.filter((o) => !(o.hours > 0) && !LANE_IDS.includes(o.machine) && !o.is_split).map((o) => pos(o))
    );

    let pending = [];
    try {
      pending = JSON.parse((db.prepare("SELECT value FROM odoo_sync WHERE key = 'pending_closing'").get() || {}).value || "[]");
    } catch {
      pending = [];
    }
    add("schliessen", "In Odoo erledigt, in der App noch offen", "Beim Odoo-Abgleich (Planung → Odoo) zum Schließen bestätigen.", pending.map((p) => ({ ref: p.ref, odooId: null, source: p.source || null, grund: p.reason || null })));

    let einkauf = [];
    try {
      if (app.locals.extern) einkauf = (await app.locals.extern.get(false)).altlasten || [];
    } catch {
      einkauf = [];
    }
    add("einkauf", "Altlasten im Einkauf", "In Odoo prüfen: abschließen, stornieren oder Wareneingang anlegen.", einkauf.map((a) => ({ ref: a.ref, odooId: null, source: null, customer: a.lieferant, grund: `${a.grund}${a.datum ? ", " + a.datum : ""}` })));

    let stempel = [];
    try {
      const read = app.locals.odooRead;
      if (read) {
        const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const lines = await read("account.analytic.line", { domain: [["date", ">=", since], ["unit_amount", ">", 12]], fields: ["date", "unit_amount", "employee_id", "task_id"], limit: 50 });
        stempel = lines.map((l) => ({ ref: Array.isArray(l.task_id) ? String(l.task_id[1]).slice(0, 60) : "Stempel", odooId: null, source: null, customer: Array.isArray(l.employee_id) ? String(l.employee_id[1]) : null, grund: `${String(Math.round(l.unit_amount * 10) / 10).replace(".", ",")} h am ${l.date}` }));
      }
    } catch {
      stempel = [];
    }
    add("stempel", "Auffällige Stempelzeiten (über 12 h)", "In Odoo die Zeitbuchung korrigieren (vergessenes Ausstempeln verfälscht Soll/Ist und Kennzahlen).", stempel);

    return { stand: new Date().toISOString(), gesamt: gruppen.reduce((s, g) => s + g.n, 0), gruppen };
  }

  app.get("/api/datenqualitaet", async (req, res) => {
    try {
      res.json(await build());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
