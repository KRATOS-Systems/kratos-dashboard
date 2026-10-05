import { unzipSync, strFromU8 } from "fflate";

// Spaltenüberschriften des Odoo-Exports "Fertigungsauftrag (mrp.production)"
const COLUMNS = {
  ref: "Referenz",
  due: "Frist",
  product: "Produkt",
  source: "Quelle",
  quantity: "Zu produzierende Menge",
  status: "Status",
};

const columnIndex = (ref) =>
  ref
    .replace(/\d+/g, "")
    .split("")
    .reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Excel speichert Datum als Tageszahl seit 30.12.1899, die Uhrzeit ist egal
const isoDate = (serial) => new Date((Math.floor(serial) - 25569) * 86400000).toISOString().slice(0, 10);

function readSheet(files) {
  const parse = (name) => new DOMParser().parseFromString(strFromU8(files[name]), "application/xml");
  const shared = files["xl/sharedStrings.xml"]
    ? [...parse("xl/sharedStrings.xml").getElementsByTagName("si")].map((si) =>
        [...si.getElementsByTagName("t")].map((t) => t.textContent).join("")
      )
    : [];

  return [...parse("xl/worksheets/sheet1.xml").getElementsByTagName("row")].map((row) => {
    const cells = [];
    for (const c of row.getElementsByTagName("c")) {
      const type = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0]?.textContent;
      let value = "";
      if (type === "s" && v != null) value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = [...c.getElementsByTagName("t")].map((t) => t.textContent).join("");
      else if (v != null) value = v;
      cells[columnIndex(c.getAttribute("r"))] = value;
    }
    return cells;
  });
}

// Liest den Odoo-Export (xlsx) und liefert die Fertigungsaufträge. Entwürfe und
// Zeilen ohne Referenz werden übersprungen.
export function parseOdooExport(buffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new Error("Die Datei ist keine gültige Excel-Datei (.xlsx)");
  }
  if (!files["xl/worksheets/sheet1.xml"]) throw new Error("In der Datei wurde keine Tabelle gefunden");

  const rows = readSheet(files);
  const header = rows[0] || [];
  const idx = {};
  for (const [key, title] of Object.entries(COLUMNS)) {
    idx[key] = header.indexOf(title);
    if (idx[key] === -1) throw new Error(`Die Spalte „${title}“ fehlt im Export`);
  }

  // Die ID ist optional (ältere Exporte haben sie nicht, dann gibt es keinen Odoo-Link)
  const idCol = header.indexOf("ID");
  // Komponentenstatus (Material verfügbar / nicht verfügbar / erwartet) ist optional
  const statusCol = header.indexOf("Komponentenstatus");

  const items = [];
  for (const row of rows.slice(1)) {
    const ref = (row[idx.ref] || "").trim();
    if (!ref || row[idx.status] === "Entwurf") continue;
    const due = Number(row[idx.due]);
    const quantity = Number(row[idx.quantity]);
    items.push({
      odoo_ref: ref,
      odoo_id: idCol !== -1 && Number.isInteger(Number(row[idCol])) && Number(row[idCol]) > 0 ? Number(row[idCol]) : null,
      component_status: statusCol === -1 ? undefined : (row[statusCol] || "").trim() || null,
      source: (row[idx.source] || "").trim() || null,
      product: (row[idx.product] || "").trim() || null,
      quantity: row[idx.quantity] !== undefined && row[idx.quantity] !== "" && Number.isFinite(quantity) ? quantity : null,
      due: Number.isFinite(due) && due > 1000 ? isoDate(due) : null,
    });
  }
  if (items.length === 0) throw new Error("Im Export wurden keine Fertigungsaufträge gefunden");
  return items;
}
