import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// Gemeinsame Bausteine: Symbole, Logo, Maschinen- und App-Kacheln, Vorschaubild, Hinweis (Toast)

const RED = "#EE3340";
const LIGHT = "#F6F6F6";

export function BrandMark({ size = 34 }) {
  const inner = Math.round(size * 0.53);
  const pad = Math.round((size - inner) / 2);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <rect width={size} height={size} rx={Math.round(size * 0.235)} fill="#1E252D" />
      <svg x={pad} y={pad} width={inner} height={inner} viewBox="0 0 1932 1932">
        <path d="M0 0H703L0 703Z" fill={LIGHT} />
        <path d="M1053 0H1580L0 1580V1053Z" fill={LIGHT} />
        <path d="M0 1932L965 965 1932 1932H1405L965 1492 526 1932Z" fill={RED} />
      </svg>
    </svg>
  );
}

export function WordMark({ width = 92 }) {
  return (
    <svg className="wm" width={width} viewBox="0 0 2000 403" role="img" aria-label="KRATOS">
      <path d="M0 10H77V181L208 10H297L153 198 304 398H216L77 216V398H0Z" fill={LIGHT} />
      <path
        fillRule="evenodd"
        d="M337 10H495C570 10 622 70 622 140C622 200 585 240 547 252L632 398H550L472 264H414V398H337ZM414 82V196H495C525 196 546 170 546 139C546 108 525 82 495 82Z"
        fill={LIGHT}
      />
      <path d="M789 10H884L1021 398H938L837 98 736 398H653Z" fill={LIGHT} />
      <path d="M782 398L837 233 893 398Z" fill={RED} />
      <path d="M987 10H1273V84H1168V398H1092V84H987Z" fill={LIGHT} />
      <path d="M1444 6A203 203 0 0 0 1444 404V326A127 127 0 0 1 1444 84Z" fill={LIGHT} />
      <path d="M1521 6A203 203 0 0 1 1521 404V326A127 127 0 0 0 1521 84Z" fill={LIGHT} />
      <path
        d="M1962 100C1936 55 1902 37 1862 37C1805 37 1763 68 1763 114C1763 160 1800 177 1860 195C1920 213 1962 227 1962 290C1962 336 1925 365 1862 365C1805 365 1772 340 1750 292"
        fill="none"
        stroke={LIGHT}
        strokeWidth="76"
      />
    </svg>
  );
}

const IC = {
  plan: '<path d="M4 6h10M4 12h16M4 18h8" /><circle cx="17" cy="6" r="2"/><circle cx="14" cy="18" r="2"/>',
  av: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 13l2 2 4-4"/>',
  dash: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  left: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M10 6l6 6-6 6"/>',
  up: '<path d="M12 19V7M6 11l6-6 6 6"/>',
  down: '<path d="M12 4v12M6 12l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  bell: '<path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15z"/><path d="M10 21h4"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-4M4 5v4h4M4 13a8 8 0 0 0 14 4M20 19v-4h-4"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  ext: '<path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5"/>',
  cal: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M4 11h16M9 3v4M15 3v4"/>',
  split: '<path d="M12 4v6M12 10l-6 6v4M12 10l6 6v4"/>',
  team: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2A4.5 4.5 0 0 1 21 18.5"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/>',
  chip: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h3v4H8z"/><path d="M14 10h3M14 14h3"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5.5" width="4" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="5.5" width="4" height="13" rx="1" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  swap: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
};

export function Ico({ n, s = 18 }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: IC[n] }}
    />
  );
}

export const SparkIcon = ({ s = 16 }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l2.2 6.3L21 10l-6.8 1.7L12 18l-2.2-6.3L3 10l6.8-1.7z" />
    <path d="M19 15l.9 2.4L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.6z" />
  </svg>
);

// Gemeinsame Verläufe für die Teilevorschau
export function SvgDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f6f8fa" />
          <stop offset=".42" stopColor="#bcc4cc" />
          <stop offset=".68" stopColor="#e6eaee" />
          <stop offset="1" stopColor="#8f99a4" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// Maschinen-Piktogramm; mit Bild ein freigestelltes Foto der Maschine in der Kachel (Hintergrund in der Maschinenfarbe)
export function MTile({ c, size, img, imgZoom, title }) {
  if (img)
    return (
      <span className="mtile mpic" style={{ "--mc": c, ...(size ? { "--ps": `${size}px` } : {}) }} title={title}>
        <img src={img} alt="" loading="lazy" style={imgZoom ? { width: `calc((100% - 8px) * ${imgZoom})`, height: `calc((100% - 8px) * ${imgZoom})` } : undefined} />
      </span>
    );
  return (
    <span className="mtile" style={{ "--mc": c, ...(size ? { width: size, height: size } : {}) }}>
      <svg width="24" height="24" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="11" width="25" height="15.5" rx="2.5" />
        <rect x="7.5" y="15" width="10.5" height="7" rx="1.2" />
        <path d="M23 4.5v8M21 12.5h4M23 12.5v2.5" />
        <path d="M21.5 19h3.5" />
      </svg>
    </span>
  );
}

const LANE_ICON = {
  qs: '<circle cx="14" cy="14" r="7.5"/><path d="M20 20l6.5 6.5"/><path d="M10.6 14.2l2.6 2.6 4.4-5"/>',
  extern_fert: '<path d="M4 26.5V14l8 4.2V14l8 4.2V6.5h6.5v20z"/><path d="M8.5 26.5v-3.5M14.5 26.5v-3.5M21 26.5v-3.5"/>',
  extern: '<path d="M16 5l11.5 6.2L16 17.4 4.5 11.2z"/><path d="M4.5 16.4L16 22.6l11.5-6.2"/><path d="M4.5 21.4L16 27.6l11.5-6.2"/>',
};

export function LaneTile({ id, c }) {
  return (
    <span className="mtile" style={{ "--mc": c }}>
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: LANE_ICON[id] }} />
    </span>
  );
}

// App-Symbole der Arbeitsvorbereitung
const AIC = {
  material: ["var(--m1)", '<path d="M6 11l10-5 10 5v10l-10 5-10-5z"/><path d="M6 11l10 5 10-5M16 16v10"/>'],
  programm: ["var(--dmu)", '<rect x="4.5" y="6" width="23" height="20" rx="3"/><path d="M10 13l4 3-4 3M17 20h5"/>'],
  werkzeuge: ["var(--ext)", '<path d="M13 4.5h6v10l-1.2 2.2V27h-3.6V16.7L13 14.5z"/><path d="M13 9h6M13 12.4h6"/>'],
  spannmittel: ["var(--teal)", '<path d="M5 25h22"/><path d="M7 25V15h6v10M19 25V15h6v10"/><path d="M13 20h6M9 11h14"/>'],
  pruefplan: ["var(--qs)", '<rect x="7" y="5.5" width="18" height="22" rx="3"/><path d="M12 5.5V4h8v1.5M11 13h10M11 18h10M11 23h6"/>'],
  liefertermin: ["var(--brand)", '<rect x="5" y="7" width="22" height="20" rx="3"/><path d="M5 13h22M11 4v5M21 4v5M11 20l3.2 3L21 17"/>'],
  planung: ["var(--slate)", '<rect x="5" y="7" width="12" height="4.6" rx="2.3"/><rect x="11" y="14" width="16" height="4.6" rx="2.3"/><rect x="7" y="21" width="11" height="4.6" rx="2.3"/>'],
  muss: ["var(--warn)", '<circle cx="16" cy="16" r="10.5"/><path d="M16 10v6.4l4.2 2.6"/>'],
  empb: ["var(--iris)", '<path d="M8 4h13l5 5v19H8z"/><path d="M21 4v5h5M12 15h10M12 20h6"/><circle cx="21.5" cy="24.5" r="3"/>'],
  search: ["var(--slate)", null],
  page_plan: ["var(--slate)", null],
  page_av: ["var(--teal)", null],
  page_dash: ["var(--dmu)", null],
};

export function AppTile({ id, size = 34, i = 0, color, children }) {
  const a = AIC[id] || [color || "var(--slate)", null];
  const s = Math.round(size * 0.62);
  return (
    <span className="aic" style={{ "--mc": color || a[0], "--s": `${size}px`, "--i": i }}>
      {a[1] ? (
        <svg width={s} height={s} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: a[1] }} />
      ) : (
        children
      )}
    </span>
  );
}

// Bild des Teils aus Odoo (Fertigungsauftrag): kommt vom Server, ohne Bild bleibt das neutrale Symbol
export const partImg = (o) => (o && o.odoo_id ? "/api/part-image/" + o.odoo_id : null);
const failedImages = new Set();

// Vorschaubild eines Teils: freigestellt auf dem Zeichenblatt, ohne Bild ein neutrales Symbol
export function Thumb({ src, size = 40, title }) {
  const [state, setState] = useState(src && failedImages.has(src) ? "none" : "wait");
  useEffect(() => {
    setState(src && !failedImages.has(src) ? "wait" : "none");
  }, [src]);
  const has = !!src && state !== "none";
  return (
    <span className={"thumb" + (state === "ok" ? "" : " none")} style={{ "--s": size + "px" }} title={title || (state === "ok" ? "Vorschaubild aus Odoo" : "Kein Bild hinterlegt")}>
      {has && (
        <img
          src={src}
          alt=""
          onLoad={() => setState("ok")}
          onError={() => {
            failedImages.add(src);
            setState("none");
          }}
          style={{ width: "82%", height: "82%", objectFit: "contain", position: "relative", filter: "drop-shadow(0 2px 2.5px rgba(20,24,29,.32))", display: state === "ok" ? "block" : "none" }}
        />
      )}
      {state !== "ok" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
          <circle cx="12" cy="13.5" r="3.5" />
          <path d="M3 3l18 18" />
        </svg>
      )}
      {state === "ok" && size >= 34 && <i className="src" />}
    </span>
  );
}

// Hinweis unten mit optionalem "Rückgängig"
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [t, setT] = useState(null);
  const timer = useRef(null);
  const show = useCallback((msg, undo) => {
    clearTimeout(timer.current);
    setT({ msg, undo, id: Date.now() });
    timer.current = setTimeout(() => setT(null), undo ? 6500 : 3200);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className="toast" role="status" key={t.id}>
          <span>{t.msg}</span>
          {t.undo && (
            <button
              type="button"
              className="undo"
              onClick={() => {
                const f = t.undo;
                setT(null);
                f();
              }}
            >
              Rückgängig
            </button>
          )}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
