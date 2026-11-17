// Kennzahlen: Hilft die KI wirklich? Drei Zahlen über die Zeit, nur lesen.
//   Liefertreue      gelieferte Kundenaufträge je Monat: pünktlich zum ursprünglich zugesagten Termin (Odoo: Lieferdatum vs. Zusage;
//                    ohne Odoo: in der App fertig gemeldet vs. erster Liefertermin)
//   AV und Planung   gestempelte Stunden je Woche auf der Odoo-Aufgabe "AV / Planung allgemein" (AV_TASK_ID, Standard 699)
//   KI-Vorschläge    wie viele Freigaben übernommen, abgelehnt oder überholt wurden (je Art)
// Odoo-Werte werden eine Stunde zwischengespeichert.

const TTL = 3600 * 1000;
const WEEKS = 10;
const MONTHS = 6;
const AV_TASK = Number(process.env.AV_TASK_ID || 699);

const dayPart = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const monthOf = (d) => d.slice(0, 7);
function mondayOfDate(d) {
  const t = new Date(d + "T00:00:00Z");
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() - dow + 1);
  return t.toISOString().slice(0, 10);
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const quote = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

// Liefertreue je Monat aus einer Liste { fertig, termin }
export function treueJeMonat(list) {
  const by = new Map();
  for (const x of list) {
    if (!x.fertig || !x.termin) continue;
    const m = monthOf(x.fertig);
    const cur = by.get(m) || { monat: m, gesamt: 0, puenktlich: 0, spaetTage: 0 };
    cur.gesamt++;
    if (x.fertig <= x.termin) cur.puenktlich++;
    else cur.spaetTage += Math.round((Date.parse(x.fertig) - Date.parse(x.termin)) / 86400000);
    by.set(m, cur);
  }
  return [...by.values()]
    .sort((a, b) => a.monat.localeCompare(b.monat))
    .slice(-MONTHS)
    .map((m) => ({ ...m, quote: quote(m.puenktlich, m.gesamt), spaetTageSchnitt: m.gesamt - m.puenktlich > 0 ? Math.round((m.spaetTage / (m.gesamt - m.puenktlich)) * 10) / 10 : 0 }));
}

export default function registerKennzahlen(app, db) {
  let cache = null;

  // Ohne Odoo: je Auftrag (Quelle) der letzte Fertig-Tag in der App gegen den ersten zugesagten Termin
  function treueApp() {
    const rows = db
      .prepare(
        `SELECT COALESCE(source, order_no) AS k, MAX(done_date) AS fertig, MIN(COALESCE(NULLIF(due_original, ''), due_date)) AS termin
         FROM orders WHERE done = 1 AND done_date >= ? GROUP BY k`
      )
      .all(daysAgo(MONTHS * 31));
    return treueJeMonat(rows);
  }

  async function treueOdoo(read) {
    const sales = await read("sale.order", {
      domain: [["state", "=", "sale"], ["effective_date", ">=", daysAgo(MONTHS * 31) + " 00:00:00"]],
      fields: ["name", "effective_date", "commitment_date", "delivery_status"],
      limit: 2000,
    });
    // Zusage: der erste Termin, den die App kennt (vor Verschiebungen), sonst die Zusage in Odoo
    const first = new Map(
      db
        .prepare("SELECT source, MIN(COALESCE(NULLIF(due_original, ''), due_date)) AS d FROM orders WHERE source IS NOT NULL GROUP BY source")
        .all()
        .map((r) => [r.source, r.d])
    );
    return treueJeMonat(
      sales
        .filter((s) => s.delivery_status === "full" || s.delivery_status === undefined)
        .map((s) => ({ fertig: dayPart(s.effective_date), termin: first.get(s.name) || dayPart(s.commitment_date) }))
    );
  }

  async function avStunden(read) {
    const since = mondayOfDate(daysAgo(WEEKS * 7));
    const lines = await read("account.analytic.line", {
      domain: [["task_id", "=", AV_TASK], ["date", ">=", since]],
      fields: ["date", "unit_amount", "employee_id"],
      limit: 5000,
    });
    const by = new Map();
    for (const l of lines) {
      const d = dayPart(l.date);
      if (!d) continue;
      const w = mondayOfDate(d);
      const cur = by.get(w) || { woche: w, stunden: 0, auffaellig: 0 };
      const h = Number(l.unit_amount) || 0;
      cur.stunden += h;
      if (h > 12) cur.auffaellig++; // vergessenes Ausstempeln
      by.set(w, cur);
    }
    return [...by.values()].sort((a, b) => a.woche.localeCompare(b.woche)).map((w) => ({ ...w, stunden: Math.round(w.stunden * 10) / 10 }));
  }

  function kiQuote() {
    const rows = db.prepare("SELECT art, status, COUNT(*) AS n FROM freigaben WHERE erstellt >= ? GROUP BY art, status").all(daysAgo(30));
    const arts = {};
    for (const r of rows) {
      const a = (arts[r.art] = arts[r.art] || { art: r.art, freigegeben: 0, abgelehnt: 0, hinfaellig: 0, offen: 0 });
      if (r.status in a) a[r.status] += r.n;
    }
    return Object.values(arts).map((a) => ({ ...a, quote: quote(a.freigegeben, a.freigegeben + a.abgelehnt) }));
  }

  app.get("/api/kennzahlen", async (req, res) => {
    const read = app.locals.odooRead;
    const fresh = req.query.neu === "1";
    let odoo = cache && Date.now() - cache.at < TTL && !fresh ? cache : null;
    if (!odoo) {
      odoo = { at: Date.now(), treue: null, treueQuelle: "app", av: null, fehler: [] };
      if (read) {
        try {
          odoo.treue = await treueOdoo(read);
          odoo.treueQuelle = "odoo";
        } catch (err) {
          odoo.fehler.push("Liefertreue aus Odoo: " + err.message);
        }
        try {
          odoo.av = await avStunden(read);
        } catch (err) {
          odoo.fehler.push("AV-Stunden aus Odoo: " + err.message);
        }
      }
      cache = odoo;
    }
    res.json({
      stand: new Date(odoo.at).toISOString(),
      liefertreue: odoo.treue || treueApp(),
      liefertreueQuelle: odoo.treue ? "odoo" : "app",
      avStunden: odoo.av,
      avAufgabe: AV_TASK,
      ki: kiQuote(),
      fehler: odoo.fehler,
    });
  });
}
