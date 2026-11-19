// Interne Notiz im Odoo-Chatter mit Formatierung (fett, Absätze).
// Über die Schnittstelle behandelt Odoo den Text sonst als reinen Text und zeigt <p> und <b> als Zeichen an.
// body_is_html: true sagt Odoo, dass der (bereits maskierte) Text HTML ist. Kennt Odoo den Schalter nicht,
// wird die Notiz als reiner Text ohne Tags geschrieben (Absätze als Zeilenumbrüche).

export function htmlZuText(html) {
  return String(html)
    .replace(/<\/p>\s*<p>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export async function postNotiz(odoo, model, id, html) {
  const base = { ids: [id], message_type: "comment", subtype_xmlid: "mail.mt_note" };
  try {
    return await odoo.write(model, "message_post", { ...base, body: html, body_is_html: true });
  } catch (err) {
    if (!/body_is_html|unexpected keyword|keyword argument/i.test(String(err && err.message))) throw err;
    return odoo.write(model, "message_post", { ...base, body: htmlZuText(html) });
  }
}
