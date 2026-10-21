import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Ico } from "./ui.jsx";

// Zeichnung (PDF) und 3D-Modell (STEP) eines Artikels, aus Odoo geholt. Das 3D-Modell wird im Browser gelesen (occt-import-js).

const VIEWS = {
  Isometrisch: [1, -1.3, 0.9],
  Oben: [0, 0, 1],
  Unten: [0, 0, -1],
  Vorne: [0, -1, 0],
  Hinten: [0, 1, 0],
  Links: [-1, 0, 0],
  Rechts: [1, 0, 0],
};
const mm = (v) => v.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " mm";
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

// ---- STEP im Browser einlesen
let occtP = null;
function occtBrowser() {
  occtP =
    occtP ||
    new Promise((resolve, reject) => {
      const init = () => window.occtimportjs({ locateFile: (p) => `/occt/${p}` }).then(resolve, reject);
      if (window.occtimportjs) return init();
      const s = document.createElement("script");
      s.src = "/occt/occt-import-js.js";
      s.onload = init;
      s.onerror = () => reject(new Error("3D-Baustein konnte nicht geladen werden"));
      document.head.appendChild(s);
    }).catch((e) => {
      occtP = null;
      throw e;
    });
  return occtP;
}
const meshes = new Map();
export function loadMesh(file) {
  if (!meshes.has(file.id)) {
    meshes.set(
      file.id,
      (async () => {
        const r = await fetch(`/api/product-file/${file.id}`, { credentials: "same-origin" });
        if (!r.ok) throw new Error(`Datei konnte nicht geladen werden (${r.status})`);
        const buf = new Uint8Array(await r.arrayBuffer());
        const o = await occtBrowser();
        const params = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.0008, angularDeflection: 0.25 };
        const res = /\.(igs|iges)$/i.test(file.name) ? o.ReadIgesFile(buf, params) : o.ReadStepFile(buf, params);
        if (!res.success || !res.meshes.length) throw new Error("Das Modell konnte nicht gelesen werden");
        const positions = [];
        const indices = [];
        let off = 0;
        for (const m of res.meshes) {
          const pos = m.attributes.position.array;
          const idx = m.index.array;
          for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
          for (let i = 0; i < idx.length; i++) indices.push(idx[i] + off);
          off += pos.length / 3;
        }
        return { positions, indices };
      })().catch((e) => {
        meshes.delete(file.id);
        throw e;
      })
    );
  }
  return meshes.get(file.id);
}

export function Viewer3D({ file }) {
  const host = useRef(null);
  const st = useRef(null);
  const [state, setState] = useState("loading");
  const [err, setErr] = useState("");
  const [dims, setDims] = useState(null);
  const [showDims, setShowDims] = useState(false);
  const [wire, setWire] = useState(false);

  useEffect(() => {
    const el = host.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
    camera.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    scene.add(dl);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.8;
    controls.screenSpacePanning = true;
    const dimGrp = new THREE.Group();
    scene.add(dimGrp);
    let raf = 0;
    let dirty = true;
    const frame = () => {
      raf = 0;
      const moving = controls.update();
      if (dirty || moving) {
        dirty = false;
        dl.position.copy(camera.position);
        renderer.render(scene, camera);
      }
      if (moving) raf = requestAnimationFrame(frame);
    };
    const invalidate = () => {
      dirty = true;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    controls.addEventListener("change", invalidate);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      invalidate();
    });
    ro.observe(el);
    st.current = { renderer, scene, camera, controls, dimGrp, invalidate };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, []);

  const setView = (dir = VIEWS.Isometrisch) => {
    const s = st.current;
    if (!s || !s.obj) return;
    const box = new THREE.Box3().setFromObject(s.obj);
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const dist = (r / Math.sin((s.camera.fov * Math.PI) / 360)) * 1.1;
    const d = new THREE.Vector3(...dir);
    if (Math.abs(d.z) > 0.99) d.y -= 0.001;
    s.camera.position.copy(c).add(d.normalize().multiplyScalar(dist));
    s.camera.near = dist / 100;
    s.camera.far = dist * 100;
    s.camera.updateProjectionMatrix();
    s.controls.target.copy(c);
    s.controls.update();
    s.invalidate();
  };

  useEffect(() => {
    let alive = true;
    setState("loading");
    loadMesh(file)
      .then((mesh) => {
        const s = st.current;
        if (!alive || !s) return;
        if (s.obj) s.scene.remove(s.obj);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
        g.setIndex(mesh.indices);
        g.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({ color: 0xb9c0c9, metalness: 0.15, roughness: 0.6, side: THREE.DoubleSide });
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x4a5563 }));
        const grp = new THREE.Group();
        grp.add(new THREE.Mesh(g, mat), edges);
        s.scene.add(grp);
        s.obj = grp;
        s.mat = mat;
        const size = new THREE.Box3().setFromObject(grp).getSize(new THREE.Vector3());
        setDims([size.x, size.y, size.z]);
        setView();
        setState("ok");
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e.message);
        setState("error");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  useEffect(() => {
    const s = st.current;
    if (!s || !s.mat) return;
    s.mat.wireframe = wire;
    s.invalidate();
  }, [wire, state]);

  useEffect(() => {
    const s = st.current;
    if (!s) return;
    s.dimGrp.clear();
    if (showDims && s.obj) {
      const box = new THREE.Box3().setFromObject(s.obj);
      const a = box.min;
      const b = box.max;
      const corners = [[a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, b.y, a.z], [a.x, b.y, a.z], [a.x, a.y, b.z], [b.x, a.y, b.z], [b.x, b.y, b.z], [a.x, b.y, b.z]].map((p) => new THREE.Vector3(...p));
      const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      s.dimGrp.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(E.flatMap(([i, j]) => [corners[i], corners[j]])), new THREE.LineBasicMaterial({ color: 0x8a96a6, transparent: true, opacity: 0.7 })));
    }
    s.invalidate();
  }, [showDims, state]);

  return (
    <div className="v3d">
      <div ref={host} className="v3d-host" />
      {state === "loading" && <div className="v3d-msg">3D-Modell wird geladen …</div>}
      {state === "error" && <div className="v3d-msg">{err || "Das 3D-Modell konnte nicht angezeigt werden."} Bitte herunterladen.</div>}
      {state === "ok" && (
        <>
          <div className="v3d-tools">
            <select aria-label="Ansicht" defaultValue="" onChange={(e) => e.target.value && setView(VIEWS[e.target.value])}>
              <option value="">Ansicht …</option>
              {Object.keys(VIEWS).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button type="button" className="btn sm" title="Ansicht einpassen" onClick={() => setView()}>
              Einpassen
            </button>
            <button type="button" className={"btn sm" + (showDims ? " primary" : "")} title="Rahmen um das Teil" onClick={() => setShowDims((v) => !v)}>
              Maße
            </button>
            <button type="button" className={"btn sm" + (wire ? " primary" : "")} title="Drahtmodell" onClick={() => setWire((v) => !v)}>
              Draht
            </button>
          </div>
          {dims && (
            <div className="v3d-dims">
              {mm(dims[0])} × {mm(dims[1])} × {mm(dims[2])}
            </div>
          )}
          <div className="v3d-hint">Ziehen: drehen · Rechte Maustaste: verschieben · Mausrad: zoomen</div>
        </>
      )}
    </div>
  );
}


// ---- Dateien eines Artikels aus Odoo (Liste je Fertigungsauftrag)
const lists = new Map();
export function useFiles(odooId) {
  const [st, setSt] = useState({ loading: true, files: [], error: "" });
  useEffect(() => {
    let alive = true;
    setSt({ loading: true, files: [], error: "" });
    if (!lists.has(odooId)) {
      lists.set(
        odooId,
        fetch("/api/product-files/" + odooId)
          .then(async (r) => {
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || "Fehler " + r.status);
            return j;
          })
          .catch((e) => {
            lists.delete(odooId);
            throw e;
          })
      );
    }
    lists.get(odooId).then(
      (j) => alive && setSt({ loading: false, files: j.files, product: j.product, enabled: j.enabled, error: "" }),
      (e) => alive && setSt({ loading: false, files: [], error: e.message })
    );
    return () => {
      alive = false;
    };
  }, [odooId]);
  return st;
}

// ---- Vorschaubilder: erste Seite der Zeichnung und das Modell isometrisch (im Browser gezeichnet, nur einmal je Datei)
const thumbs = new Map();
function pdfThumb(file) {
  const k = "pdf" + file.id;
  if (!thumbs.has(k)) {
    thumbs.set(
      k,
      (async () => {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
        const doc = await pdfjs.getDocument({ url: "/api/product-file/" + file.id }).promise;
        const page = await doc.getPage(1);
        const v0 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 640 / v0.width });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        return c.toDataURL("image/png");
      })().catch((e) => {
        thumbs.delete(k);
        throw e;
      })
    );
  }
  return thumbs.get(k);
}
function stepThumb(file) {
  const k = "step" + file.id;
  if (!thumbs.has(k)) {
    thumbs.set(
      k,
      loadMesh(file)
        .then((mesh) => {
          const W = 420;
          const H = 300;
          const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
          renderer.setSize(W, H);
          renderer.setPixelRatio(1);
          const scene = new THREE.Scene();
          const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100000);
          camera.up.set(0, 0, 1);
          scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
          const dl = new THREE.DirectionalLight(0xffffff, 1.4);
          scene.add(dl);
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
          g.setIndex(mesh.indices);
          g.computeVertexNormals();
          const grp = new THREE.Group();
          grp.add(
            new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb9c0c9, metalness: 0.15, roughness: 0.6, side: THREE.DoubleSide })),
            new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x4a5563 }))
          );
          scene.add(grp);
          const box = new THREE.Box3().setFromObject(grp);
          const c = box.getCenter(new THREE.Vector3());
          const r = box.getSize(new THREE.Vector3()).length() / 2;
          const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.15;
          camera.position.copy(c).add(new THREE.Vector3(1, -1.3, 0.9).normalize().multiplyScalar(dist));
          camera.near = dist / 100;
          camera.far = dist * 100;
          camera.updateProjectionMatrix();
          camera.lookAt(c);
          dl.position.copy(camera.position);
          renderer.render(scene, camera);
          const url = renderer.domElement.toDataURL("image/png");
          renderer.dispose();
          g.dispose();
          return url;
        })
        .catch((e) => {
          thumbs.delete(k);
          throw e;
        })
    );
  }
  return thumbs.get(k);
}
function Thumbnail({ make, file, label, kind, onOpen }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    setErr(false);
    if (file) make(file).then((u) => alive && setSrc(u), () => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [file && file.id]);
  if (!file) return <div className="fthumb none"><span>Kein{kind === "3D" ? "" : "e"} {label} in Odoo</span></div>;
  return (
    <button type="button" className="fthumb" onClick={onOpen} title={label + " groß ansehen"}>
      {src ? <img src={src} alt={label} /> : <span className="fthumb-msg">{err ? "Vorschau nicht möglich, Klick zum Öffnen" : "Wird geladen …"}</span>}
      <i className="fthumb-tag">{kind}</i>
    </button>
  );
}

// Die beiden Vorschaubilder (Zeichnung oben, 3D darunter). Ein Klick öffnet das große Fenster.
export function FileThumbs({ o }) {
  const { loading, files, error, enabled } = useFiles(o.odoo_id);
  const [dlg, setDlg] = useState(null); // "pdf" | "step"
  if (error) return <div className="fthumbs-msg">Dateien konnten nicht geladen werden: {error}</div>;
  if (loading) return <div className="fthumbs-msg">Dateien aus Odoo werden geladen …</div>;
  if (!enabled && !files.length) return <div className="fthumbs-msg">Odoo ist nicht verbunden.</div>;
  const pdf = files.find((f) => f.kind === "pdf") || null;
  const step = files.find((f) => f.kind === "step") || null;
  return (
    <div className="fthumbs">
      <Thumbnail make={pdfThumb} file={pdf} label="Zeichnung" kind="PDF" onOpen={() => setDlg("pdf")} />
      <Thumbnail make={stepThumb} file={step} label="3D-Modell" kind="3D" onOpen={() => setDlg("step")} />
      {dlg && <FilesDialog o={o} files={files} start={dlg} onClose={() => setDlg(null)} />}
    </div>
  );
}

// Großes Fenster: Zeichnung oder 3D-Modell, Herunterladen, alle herunterladen
export function FilesDialog({ o, files, start, onClose }) {
  const pdfs = files.filter((f) => f.kind === "pdf");
  const steps = files.filter((f) => f.kind === "step");
  const [tab, setTab] = useState(start === "step" && steps.length ? "step" : pdfs.length ? "pdf" : "step");
  const [pdfId, setPdfId] = useState((pdfs[0] || {}).id);
  const [stepId, setStepId] = useState((steps[0] || {}).id);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const pdf = pdfs.find((f) => f.id === pdfId) || pdfs[0];
  const step = steps.find((f) => f.id === stepId) || steps[0];
  const cur = tab === "pdf" ? pdf : step;
  const list = tab === "pdf" ? pdfs : steps;
  const all = () =>
    files.forEach((f, i) =>
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = "/api/product-file/" + f.id;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 400)
    );
  return (
    <div className="modal fdlg-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="fdlg" role="dialog" aria-modal="true" aria-label="Dateien">
        <div className="fdlg-head">
          <div style={{ minWidth: 0 }}>
            <h3>{(o.product || "").replace(/^\[[^\]]*\]\s*/, "") || o.order_no} · Dateien</h3>
            <small>{cur ? cur.name : ""}</small>
          </div>
          <div className="actions">
            {list.length > 1 && (
              <select value={cur ? cur.id : ""} onChange={(e) => (tab === "pdf" ? setPdfId(Number(e.target.value)) : setStepId(Number(e.target.value)))} aria-label="Datei wählen" title="Mehrere Dateien am Artikel, die neueste steht oben">
                {list.map((f, i) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {i === 0 ? " (neueste)" : ""}
                  </option>
                ))}
              </select>
            )}
            <div className="seg" role="group" aria-label="Zeichnung oder 3D">
              <button type="button" className={tab === "pdf" ? "on" : ""} disabled={!pdfs.length} onClick={() => setTab("pdf")}>
                Zeichnung
              </button>
              <button type="button" className={tab === "step" ? "on" : ""} disabled={!steps.length} onClick={() => setTab("step")}>
                3D
              </button>
            </div>
            {cur && (
              <a className="btn" href={"/api/product-file/" + cur.id} download={cur.name}>
                <Ico n="down" s={15} />
                Herunterladen
              </a>
            )}
            <button type="button" className="btn" onClick={all}>
              Alle herunterladen ({files.length})
            </button>
            <button type="button" className="btn icon quiet" aria-label="Schließen" onClick={onClose}>
              <Ico n="x" />
            </button>
          </div>
        </div>
        <div className="fdlg-body">
          {tab === "pdf" && pdf && <iframe title={"Zeichnung " + pdf.name} src={"/api/product-file/" + pdf.id} />}
          {tab === "step" && step && <Viewer3D file={step} big />}
        </div>
      </div>
    </div>
  );
}
