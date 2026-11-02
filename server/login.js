// Passwortschutz mit eigener Anmeldeseite (statt des grauen Browser-Fensters).
// Ist APP_PASSWORD gesetzt, braucht jede Anfrage eines von beiden:
//   - das Anmelde-Cookie (nach Eingabe des Passworts auf /login, 30 Tage gültig), oder
//   - die bisherige Anmeldung mit Benutzername und Passwort im Kopf (Basic), damit Skripte wie die Datensicherung auf dem PC weiterlaufen.
// Browser ohne gültige Anmeldung werden auf /login geschickt; Skripte bekommen weiter die Aufforderung zur Basic-Anmeldung.
// Ohne APP_PASSWORD (lokal) ist alles offen.

import express from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COOKIE = "kratos_sess";
const SESSION_DAYS = 30;
const MAX_FAILS = 8; // Fehlversuche je Adresse ...
const FAIL_WINDOW_MS = 10 * 60 * 1000; // ... innerhalb dieser Zeit, danach gesperrt
const LOCK_MS = 5 * 60 * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => createHash("sha256").update(String(s)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Nur Ziele auf dieser Seite (kein //fremde.de, keine Rückschleife auf /login)
export function safeNext(n) {
  return typeof n === "string" && /^\/(?![/\\])[^\r\n]*$/.test(n) && !/^\/login(?![\w-])/.test(n) ? n : "/";
}

export default function registerLogin(app, { user, password, distPath }) {
  if (!password) return;
  const key = createHmac("sha256", "kratos-anmeldung-v1").update(password).digest();
  const sign = (exp) => createHmac("sha256", key).update(String(exp)).digest("base64url");
  const makeToken = () => {
    const exp = Date.now() + SESSION_DAYS * 86400000;
    return `${exp}.${sign(exp)}`;
  };
  const validToken = (t) => {
    const i = typeof t === "string" ? t.indexOf(".") : -1;
    if (i < 1) return false;
    const exp = Number(t.slice(0, i));
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    return same(t.slice(i + 1), sign(exp));
  };
  const cookieOf = (req) => {
    for (const part of (req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return "";
  };
  const basicOk = (req) => {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Basic ")) return false;
    const d = Buffer.from(h.slice(6), "base64").toString("utf8");
    const i = d.indexOf(":");
    const u = i < 0 ? d : d.slice(0, i);
    const p = i < 0 ? "" : d.slice(i + 1);
    return same(u, user) && same(p, password);
  };
  const isSecure = (req) => req.secure || (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  const setCookie = (req, res, token, maxAgeS) =>
    res.append("Set-Cookie", `${COOKIE}=${token}; Path=/; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${isSecure(req) ? "; Secure" : ""}`);
  const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  // Fehlversuche je Adresse
  const fails = new Map();
  const locked = (ip) => {
    const f = fails.get(ip);
    return !!f && f.until > Date.now();
  };
  const fail = (ip) => {
    const now = Date.now();
    const f = fails.get(ip);
    const cur = f && now - f.first < FAIL_WINDOW_MS ? { first: f.first, n: f.n + 1, until: 0 } : { first: now, n: 1, until: 0 };
    if (cur.n >= MAX_FAILS) cur.until = now + LOCK_MS;
    fails.set(ip, cur);
    if (fails.size > 500) for (const [k, v] of fails) if (now - v.first > FAIL_WINDOW_MS && v.until < now) fails.delete(k);
  };

  const page = readFileSync(path.join(here, "login.html"), "utf8");
  const render = (next, state) =>
    page
      .replace("{{NEXT}}", () => esc(next))
      .replace("{{USER}}", () => esc(user))
      .replace("{{MELDUNG}}", () => (state === "fehler" ? "Das Passwort stimmt nicht." : state === "gesperrt" ? "Zu viele Versuche. Bitte in ein paar Minuten noch einmal." : ""))
      .replace("{{MELDUNGSKLASSE}}", () => (state ? " show" : ""));
  const noStore = (res) => res.set("Cache-Control", "no-store");

  // Öffentlich: Anmeldeseite, ihre Bilder und das Symbol
  app.use("/login-assets", express.static(path.join(distPath, "login"), { maxAge: "7d" }));
  app.get(["/favicon-dark.svg", "/favicon-light.svg"], (req, res, next) => {
    const f = path.join(distPath, req.path);
    res.sendFile(f, (err) => err && next());
  });
  app.get("/login", (req, res) => {
    noStore(res);
    const next = safeNext(req.query.next);
    if (validToken(cookieOf(req)) || basicOk(req)) return res.redirect(303, next);
    const state = locked(ipOf(req)) ? "gesperrt" : req.query.fehler ? "fehler" : "";
    res.type("html").send(render(next, state));
  });
  app.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    noStore(res);
    const next = safeNext(req.body && req.body.next);
    const ip = ipOf(req);
    const back = (flag) => res.redirect(303, `/login?${flag}=1&next=${encodeURIComponent(next)}`);
    if (locked(ip)) return back("gesperrt");
    const pw = (req.body && req.body.password) || "";
    if (!same(pw, password)) {
      fail(ip);
      return back(locked(ip) ? "gesperrt" : "fehler");
    }
    fails.delete(ip);
    setCookie(req, res, makeToken(), SESSION_DAYS * 86400);
    res.redirect(303, next);
  });
  app.get("/logout", (req, res) => {
    noStore(res);
    setCookie(req, res, "", 0);
    res.redirect(303, "/login");
  });

  // Alles andere nur mit Anmeldung
  app.use((req, res, next) => {
    if (validToken(cookieOf(req)) || basicOk(req)) return next();
    const fromBrowser = !!req.headers["sec-fetch-mode"];
    if (fromBrowser && req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate") {
      noStore(res);
      return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    // Browser-Abfragen der Seite bekommen kein Anmeldefenster, nur Skripte die Aufforderung
    if (!fromBrowser) res.set("WWW-Authenticate", 'Basic realm="Kratos Produktion", charset="UTF-8"');
    res.status(401).send("Anmeldung erforderlich");
  });
}
