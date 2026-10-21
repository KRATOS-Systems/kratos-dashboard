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
function loadMesh(file) {
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

function Viewer3D({ file }) {
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

export default function PartDocs({ o, material }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [pdfId, setPdfId] = useState(null);
  const [stepId, setStepId] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError("");
    fetch(`/api/product-files/${o.odoo_id}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
        return j;
      })
      .then((j) => {
        if (!alive) return;
        setData(j);
        setPdfId((j.files.find((f) => f.kind === "pdf") || {}).id || null);
        setStepId((j.files.find((f) => f.kind === "step") || {}).id || null);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [o.odoo_id]);

  if (error) return <div className="pdocs-empty">Dateien konnten nicht geladen werden: {error}</div>;
  if (!data) return <div className="pdocs-empty">Dateien aus Odoo werden geladen …</div>;
  if (!data.enabled && !data.files.length) return <div className="pdocs-empty">Odoo ist nicht verbunden.</div>;
  const pdfs = data.files.filter((f) => f.kind === "pdf");
  const steps = data.files.filter((f) => f.kind === "step");
  const pdf = pdfs.find((f) => f.id === pdfId) || null;
  const step = steps.find((f) => f.id === stepId) || null;
  const pick = (list, id, set, label) =>
    list.length > 1 ? (
      <select value={id || ""} onChange={(e) => set(Number(e.target.value))} aria-label={label} title="Es gibt mehrere Dateien am Artikel. Die neueste steht oben.">
        {list.map((f, i) => (
          <option key={f.id} value={f.id}>
            {f.name}
            {i === 0 ? " (neueste)" : ""}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <div className="pdocs">
      <div className="pdocs-col">
        <div className="pdocs-head">
          <b>Zeichnung</b>
          {pdf ? (
            <>
              <span className="pdocs-name" title={pdf.name}>
                {list1(pdf)}
              </span>
              {pick(pdfs, pdfId, setPdfId, "Zeichnung wählen")}
              <a className="btn sm" href={`/api/product-file/${pdf.id}`} target="_blank" rel="noopener noreferrer">
                Öffnen <Ico n="ext" s={13} />
              </a>
            </>
          ) : null}
        </div>
        {pdf ? <iframe className="pdocs-pdf" title={`Zeichnung ${pdf.name}`} src={`/api/product-file/${pdf.id}`} /> : <div className="pdocs-none">Keine Zeichnung (PDF) am Artikel in Odoo.</div>}
      </div>
      <div className="pdocs-col">
        <div className="pdocs-head">
          <b>3D-Modell</b>
          {step ? (
            <>
              <span className="pdocs-name" title={step.name}>
                {list1(step)}
              </span>
              {pick(steps, stepId, setStepId, "Modell wählen")}
              <a className="btn sm" href={`/api/product-file/${step.id}`} download={step.name}>
                Herunterladen
              </a>
            </>
          ) : null}
        </div>
        {step ? <Viewer3D file={step} /> : <div className="pdocs-none">Kein 3D-Modell (STEP) am Artikel in Odoo.</div>}
      </div>
      {material && <div className="pdocs-mat">{material}</div>}
    </div>
  );
}
function list1(f) {
  return `${f.name} · ${kb(f.size)}${f.date ? " · " + f.date.slice(8, 10) + "." + f.date.slice(5, 7) + "." + f.date.slice(0, 4) : ""}`;
}
