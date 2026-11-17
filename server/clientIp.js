// Adresse des Aufrufers. Hinter dem Proxy von Hostinger kommt jede Anfrage von dessen Adresse; die echte steht in X-Forwarded-For.
// Gilt nur der LETZTE Eintrag: den hängt unser Proxy an. Alles davor kann der Aufrufer selbst hineinschreiben (sonst ließe sich die
// Sperre nach Fehlversuchen mit einer erfundenen Adresse umgehen).
export function clientIp(req) {
  const list = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list[list.length - 1] : String((req.socket && req.socket.remoteAddress) || "?");
}

// Kam die Anfrage über einen Proxy (also von außen) oder direkt vom Rechner selbst?
export const viaProxy = (req) => !!req.headers["x-forwarded-for"];
export const isLoopback = (addr) => /^(::1$|127\.|::ffff:127\.)/.test(String(addr || ""));
