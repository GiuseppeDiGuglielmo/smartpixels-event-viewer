import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  SENSOR, point, traceParticle, intersectVolume, traversedPixels,
  progressAtZ, pointAtProgress, trackSegments,
} from './geometry.js';
import {
  SCENE_SCALE, toScene, fromScene, cameraDirection, anglesFromDirection,
} from './sceneTransform.js';
import { chargeColor, pixelShading } from './chargeColors.js';

/**
 * WebGL (Three.js) volumetric view of the sensor.
 *
 * Every position is computed in physical µm by geometry.js and only then
 * mapped to the scene by sceneTransform.toScene(p, zStretch). The Z stretch
 * therefore changes the picture only. Nothing in this file decides hits,
 * pixels — it only draws what geometry.js returns.
 */

const COLORS = Object.freeze({
  slab: 0x4b78a6,
  slabEdge: 0x9cc4e0,
  gridMinor: 0x9fd8f5,
  gridMajor: 0xb8f0ff,
  mid: 0x4b91f9,
  bottom: 0x22364c,
  particle: 0xffb050,
  beam: 0xff9c55,
  beamSilicon: 0xfff0a0,
  top: 0x62f5f3,
  midMarker: 0x8fc3ff,
  exit: 0xffa070,
  side: 0xe879c9,
  traversed: 0xff3b30,
  outside: 0x8a99a8,
});

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const FACE_NAMES = { top: 'top', bottom: 'bottom', 'x-': 'x− side', 'x+': 'x+ side', 'y-': 'y− side', 'y+': 'y+ side' };

/**
 * Free GPU resources of a rebuilt group. Long-lived shared resources (the
 * pixel texture, glow sprite texture) are passed in `keep` and disposed only
 * in dispose(). ArrowHelper shares module-level geometries, so only its
 * materials are released.
 */
function disposeTree(object, keep = new Set()) {
  object.traverse((child) => {
    const sharedGeometry = child.parent?.type === 'ArrowHelper';
    if (!sharedGeometry && child.geometry && !keep.has(child.geometry)) child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
    for (const material of materials) {
      if (material.map && !keep.has(material.map)) material.map.dispose();
      material.dispose?.();
    }
    if (child.isInstancedMesh) child.dispose(); // frees the instanceMatrix buffer
    if (child.isCSS2DObject) child.element.remove();
  });
}

function makeLabel(text, className, center = [0, 1.25]) {
  const element = document.createElement('div');
  element.className = `scene-label ${className}`;
  element.textContent = text;
  const label = new CSS2DObject(element);
  label.center.set(center[0], center[1]);
  return label;
}

function glowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,240,210,1)');
  g.addColorStop(0.2, 'rgba(255,190,110,0.85)');
  g.addColorStop(0.5, 'rgba(255,140,60,0.25)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createRenderer3D({ frame, getState, onCameraChange, zoomRange = [0.3, 80] }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  try {
    return setupScene({ renderer, frame, getState, onCameraChange, zoomRange });
  } catch (error) {
    renderer.dispose();
    renderer.domElement.remove();
    frame.querySelector('.scene-labels')?.remove();
    throw error;
  }
}

function setupScene({ renderer, frame, getState, onCameraChange, zoomRange }) {
  const [ZOOM_MIN, ZOOM_MAX] = zoomRange;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.className = 'scene-webgl';
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', 'Rotatable 3D WebGL view of the pixel sensor and particle trajectory. Drag to orbit, right-drag or shift-drag to pan, scroll to zoom. Arrow keys orbit, + and − zoom.');
  frame.prepend(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'scene-labels';
  frame.insertBefore(labelRenderer.domElement, renderer.domElement.nextSibling);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 5000);
  scene.add(new THREE.AmbientLight(0xbfd6ff, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-6, 14, 9);
  scene.add(sun);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.25;
  controls.maxDistance = 600;
  controls.minPolarAngle = THREE.MathUtils.degToRad(1);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(179);
  controls.zoomSpeed = 1.1;

  // ---- static sensor group (depends on zStretch / grid / midplane) ----
  let staticGroup = null;
  let staticKey = '';
  // ---- track group (depends on particle and overlay toggles) ----
  let trackGroup = null;
  let trackKey = '';
  let track = null; // cached geometry results + dynamic objects

  // Top-surface pixel texture: 48 × 192, one texel per pixel.
  const texData = new Uint8Array(SENSOR.pixelsX * SENSOR.pixelsY * 4);
  const pixelTexture = new THREE.DataTexture(texData, SENSOR.pixelsX, SENSOR.pixelsY, THREE.RGBAFormat);
  pixelTexture.magFilter = THREE.NearestFilter;
  pixelTexture.minFilter = THREE.LinearMipmapLinearFilter;
  pixelTexture.generateMipmaps = true;
  pixelTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  pixelTexture.colorSpace = THREE.SRGBColorSpace;
  const sharedGlow = glowTexture();
  const keep = new Set([pixelTexture, sharedGlow]);

  let fit = { center: new THREE.Vector3(), distance: 40 };
  let userPanned = false;
  let focused = false;
  let fitKey = '';
  let applyingCamera = false;
  let dirty = true;
  let frameHandle = null;
  let width = 1;
  let height = 1;

  const state = () => getState();
  const V = (p, stretch = state().zStretch) => new THREE.Vector3(...toScene(p, stretch));

  /* ------------------------------------------------------------------ */
  function buildStatic() {
    const s = state();
    const key = `${s.zStretch}|${s.showGrid}|${s.showMid}|${s.showLabels}`;
    if (key === staticKey) return;
    staticKey = key;
    if (staticGroup) { scene.remove(staticGroup); disposeTree(staticGroup, keep); }
    staticGroup = new THREE.Group();
    const st = s.zStretch;
    const W = 2 * SENSOR.halfX * SCENE_SCALE;
    const D = 2 * SENSOR.halfY * SCENE_SCALE;
    const T = SENSOR.thickness * SCENE_SCALE * st;
    const eps = 0.0015;

    // Silicon bulk (translucent volume) and its edges.
    const box = new THREE.BoxGeometry(W, T, D);
    const slab = new THREE.Mesh(box, new THREE.MeshPhysicalMaterial({
      color: COLORS.slab, transparent: true, opacity: 0.26, roughness: 0.35, metalness: 0.05,
      clearcoat: 0.6, depthWrite: false, side: THREE.DoubleSide,
    }));
    slab.position.y = -T / 2;
    slab.renderOrder = 1;
    staticGroup.add(slab);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: COLORS.slabEdge, transparent: true, opacity: 0.9 }));
    edges.position.y = -T / 2;
    staticGroup.add(edges);

    // Top surface pixel pads (texture filled per track update).
    const topPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshBasicMaterial({ map: pixelTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    // PlaneGeometry lies in local XY; rotating −90° about X puts local +Y
    // onto scene −Z, i.e. physical +y. Texture u → +x, v → +y (row index).
    topPlane.rotation.x = -Math.PI / 2;
    topPlane.position.y = eps;
    topPlane.renderOrder = 3;
    staticGroup.add(topPlane);

    // Backside plane (z = −100 µm).
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({
      color: COLORS.bottom, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, roughness: 0.8,
    }));
    back.rotation.x = -Math.PI / 2;
    back.position.y = -T - eps;
    back.renderOrder = 0;
    staticGroup.add(back);

    if (s.showGrid) {
      const minor = [];
      const major = [];
      const h = SENSOR.halfX;
      const k = SENSOR.halfY;
      for (let col = 0; col <= SENSOR.pixelsX; col++) {
        const x = -h + col * SENSOR.pitchX;
        (col % 16 === 0 ? major : minor).push(...toScene(point(x, -k, 0), st), ...toScene(point(x, k, 0), st));
      }
      for (let row = 0; row <= SENSOR.pixelsY; row++) {
        const y = -k + row * SENSOR.pitchY;
        (row % 16 === 0 ? major : minor).push(...toScene(point(-h, y, 0), st), ...toScene(point(h, y, 0), st));
      }
      for (const [list, color, opacity] of [[minor, COLORS.gridMinor, 0.16], [major, COLORS.gridMajor, 0.5]]) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
        const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
        lines.position.y = 2 * eps;
        lines.renderOrder = 4;
        staticGroup.add(lines);
      }
      // Pixel-column boundaries every 16 pixels on the two front side faces.
      const sides = [];
      for (let col = 0; col <= SENSOR.pixelsX; col += 16) {
        const x = -h + col * SENSOR.pitchX;
        sides.push(...toScene(point(x, -k, 0), st), ...toScene(point(x, -k, SENSOR.zBottom), st));
      }
      for (let row = 0; row <= SENSOR.pixelsY; row += 16) {
        const y = -k + row * SENSOR.pitchY;
        sides.push(...toScene(point(-h, y, 0), st), ...toScene(point(-h, y, SENSOR.zBottom), st));
      }
      const sideGeometry = new THREE.BufferGeometry();
      sideGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sides, 3));
      staticGroup.add(new THREE.LineSegments(sideGeometry, new THREE.LineBasicMaterial({ color: COLORS.gridMajor, transparent: true, opacity: 0.3 })));
    }

    if (s.showMid) {
      const mid = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({
        color: COLORS.mid, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false,
      }));
      mid.rotation.x = -Math.PI / 2;
      mid.position.y = SENSOR.zMid * SCENE_SCALE * st;
      mid.renderOrder = 2;
      staticGroup.add(mid);
      const loop = [
        point(-SENSOR.halfX, -SENSOR.halfY, SENSOR.zMid), point(SENSOR.halfX, -SENSOR.halfY, SENSOR.zMid),
        point(SENSOR.halfX, SENSOR.halfY, SENSOR.zMid), point(-SENSOR.halfX, SENSOR.halfY, SENSOR.zMid),
        point(-SENSOR.halfX, -SENSOR.halfY, SENSOR.zMid),
      ].map((p) => V(p, st));
      const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop), new THREE.LineDashedMaterial({
        color: 0x5aa6ff, dashSize: 0.5, gapSize: 0.3, transparent: true, opacity: 0.9,
      }));
      outline.computeLineDistances();
      staticGroup.add(outline);
    }

    // Axis triad at the (x−, y−) corner, physical directions.
    const origin = V(point(-SENSOR.halfX - 550, -SENSOR.halfY - 550, 0), st);
    const axisLength = 4;
    for (const [name, dir, color] of [
      ['+X', point(1, 0, 0), 0xff9992],
      ['+Y', point(0, 1, 0), 0x9efac3],
      ['+Z', point(0, 0, 1), 0x9bcbfc],
    ]) {
      const d = new THREE.Vector3(...toScene(dir, 1)).normalize();
      staticGroup.add(new THREE.ArrowHelper(d, origin, axisLength, color, 0.9, 0.45));
      if (s.showLabels) {
        const label = makeLabel(name, 'axis', [0.5, 0.5]);
        label.element.style.color = `#${color.toString(16).padStart(6, '0')}`;
        label.position.copy(origin).addScaledVector(d, axisLength + 0.9);
        staticGroup.add(label);
      }
    }

    if (s.showLabels) {
      const h = SENSOR.halfX;
      const k = SENSOR.halfY;
      const add = (text, p, cls, center) => {
        const label = makeLabel(text, cls, center);
        label.position.copy(V(p, st));
        staticGroup.add(label);
      };
      add('X · 48 px × 50 µm = 2.4 mm', point(0, -k - 140, 0), 'dim', [0.5, 0]);
      add('Y · 192 px × 12.5 µm = 2.4 mm', point(-h - 140, 0, 0), 'dim', [1, 0.5]);
      add('col 0', point(-h + 25, -k - 40, 0), 'tick', [0.5, 0]);
      add('col 47', point(h - 25, -k - 40, 0), 'tick', [0.5, 0]);
      add('row 0', point(-h - 40, -k + 6.25, 0), 'tick', [1, 0.5]);
      add('row 191', point(-h - 40, k - 6.25, 0), 'tick', [1, 0.5]);
      add(`100 µm thick · Z display ×${st}`, point(h, -k, SENSOR.zBottom), 'dim', [0, -0.3]);
      if (s.showMid) add('midplane z = −50 µm', point(h, k, SENSOR.zMid), 'mid', [0, 0.5]);
    }
    scene.add(staticGroup);
  }

  /* ------------------------------------------------------------------ */
  function fillPixelTexture(s) {
    const shading = pixelShading(s);
    const dataCharge = shading === 'charge' ? s.charge : null;
    for (let iy = 0; iy < SENSOR.pixelsY; iy++) {
      for (let ix = 0; ix < SENSOR.pixelsX; ix++) {
        const i = iy * SENSOR.pixelsX + ix;
        const checker = s.showGrid ? ((ix + iy) & 1) : 0;
        let r = checker ? 70 : 58;
        let g = checker ? 104 : 92;
        let b = checker ? 136 : 124;
        let a = 120;
        // pixelAV SIMULATED charge replaces the pad colour (data mode only).
        const q = dataCharge ? dataCharge.dense[i] : 0;
        if (q !== 0) { // negative charge is drawn too
          [r, g, b] = chargeColor(q, dataCharge.scale);
          a = 245;
        }
        texData[i * 4] = r; texData[i * 4 + 1] = g; texData[i * 4 + 2] = b; texData[i * 4 + 3] = a;
      }
    }
    pixelTexture.needsUpdate = true;
  }

  function cellOutline(pixel, z, color, st) {
    const x0 = -SENSOR.halfX + pixel.x * SENSOR.pitchX;
    const y0 = -SENSOR.halfY + pixel.y * SENSOR.pitchY;
    const pts = [
      point(x0, y0, z), point(x0 + SENSOR.pitchX, y0, z), point(x0 + SENSOR.pitchX, y0 + SENSOR.pitchY, z),
      point(x0, y0 + SENSOR.pitchY, z), point(x0, y0, z),
    ].map((p) => V(p, st));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    line.renderOrder = 10;
    return line;
  }

  function columnBox(pixel, color, opacity, st) {
    const c = {
      x: -SENSOR.halfX + (pixel.x + 0.5) * SENSOR.pitchX,
      y: -SENSOR.halfY + (pixel.y + 0.5) * SENSOR.pitchY,
      z: SENSOR.zMid,
    };
    const geometry = new THREE.BoxGeometry(SENSOR.pitchX * SCENE_SCALE, SENSOR.thickness * SCENE_SCALE * st, SENSOR.pitchY * SCENE_SCALE);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    mesh.position.copy(V(c, st));
    mesh.renderOrder = 5;
    return mesh;
  }

  function marker(color, flat = true) {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 48), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false,
    }));
    if (flat) ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 12;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 14), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
    dot.renderOrder = 13;
    group.add(ring, dot);
    group.userData.ring = ring;
    return group;
  }

  function beam(color, opacity) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 14, 1, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
    );
    mesh.renderOrder = 8;
    return mesh;
  }

  function placeBeam(mesh, a, b, radius) {
    const delta = new THREE.Vector3().subVectors(b, a);
    const length = delta.length();
    mesh.visible = length > 1e-6;
    if (!mesh.visible) return;
    mesh.position.copy(a).addScaledVector(delta, 0.5);
    mesh.quaternion.setFromUnitVectors(Y_AXIS, delta.normalize());
    mesh.scale.set(radius, length, radius);
  }

  const fmt = (v) => (Math.abs(v) < 0.05 ? '0' : v.toFixed(Math.abs(v) >= 100 ? 0 : 1));

  function buildTrack() {
    const s = state();
    const key = [s.x0, s.y0, s.z0, s.thetaX, s.thetaY, s.zStretch, s.showTrackOff, s.showTrackIn,
      s.showTraversed, s.showLabels, s.showGrid, s.markTop, s.markMid, s.markExit, s.mode, s.charge?.key, s.showChargeBars].join('|');
    if (key === trackKey) return false;
    trackKey = key;
    if (trackGroup) { scene.remove(trackGroup); disposeTree(trackGroup, keep); }
    trackGroup = new THREE.Group();
    const st = s.zStretch;
    const trace = traceParticle(s);
    const volume = intersectVolume(s);
    const traversed = traversedPixels(s);
    fillPixelTexture(s);

    const start = V(trace.start, st);
    const end = V(trace.bottom, st);

    // Trajectory, split at the silicon: a dashed guide and a solid travelled beam per enabled part.
    const beams = [];
    for (const seg of trackSegments(trace, volume)) {
      if (!(seg.kind === 'in' ? s.showTrackIn : s.showTrackOff)) continue;
      const a = V(pointAtProgress(trace, seg.from), st);
      const b = V(pointAtProgress(trace, seg.to), st);
      const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineDashedMaterial({
        color: COLORS.beam, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.55,
      }));
      guide.computeLineDistances();
      const mesh = beam(seg.kind === 'in' ? COLORS.beamSilicon : COLORS.beam, seg.kind === 'in' ? 1 : 0.95);
      trackGroup.add(guide, mesh);
      beams.push({ ...seg, mesh, a, width: seg.kind === 'in' ? 0.55 : 0.35 });
    }

    const particle = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffe1b0 }));
    particle.renderOrder = 14;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sharedGlow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.renderOrder = 15;
    trackGroup.add(particle, glow);

    const startMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: COLORS.particle, transparent: true, opacity: 0.6 }));
    startMarker.position.copy(start);
    startMarker.visible = s.showTrackOff;
    trackGroup.add(startMarker);

    // Plane crossings: top (z=0), midplane (z=−50), exit/bottom (z=−100).
    const crossings = [
      { key: 'top', p: trace.top, pixel: trace.topPixel, color: COLORS.top, z: SENSOR.zTop, title: 'surface' },
      { key: 'mid', p: trace.mid, pixel: trace.midPixel, color: COLORS.midMarker, z: SENSOR.zMid, title: 'midplane' },
      { key: 'exit', p: trace.bottom, pixel: trace.exitPixel, color: COLORS.exit, z: SENSOR.zBottom, title: 'exit' },
    ].filter((c) => ({ top: s.markTop, mid: s.markMid, exit: s.markExit })[c.key]);

    const reveal = [];
    for (const c of crossings) {
      const inside = !!c.pixel;
      const group = new THREE.Group();
      const m = marker(inside ? c.color : COLORS.outside);
      m.position.copy(V(c.p, st));
      group.add(m);
      if (inside) {
        group.add(cellOutline(c.pixel, c.z, c.color, st));
        if (c.key === 'top') group.add(columnBox(c.pixel, COLORS.top, 0.32, st));
      }
      if (s.showLabels) {
        const text = inside
          ? `${c.title} · px (${c.pixel.x}, ${c.pixel.y})`
          : `${c.title} · outside sensor`;
        const center = { top: [-0.1, 1.35], mid: [-0.12, 0.5], exit: [-0.1, -0.4] }[c.key];
        const label = makeLabel(text, c.key, center);
        label.position.copy(V(c.p, st));
        group.add(label);
      }
      group.visible = false;
      trackGroup.add(group);
      reveal.push({ group, marker: m, progress: progressAtZ(trace, c.z) });
    }

    // Side entry / exit (volume test) — shown separately; never counted as a HIT.
    // They belong to the in-sensor trajectory and follow its toggle.
    if (volume && s.showTrackIn) {
      for (const [which, p, face] of [['entry', volume.entry, volume.entryFace], ['exit', volume.exit, volume.exitFace]]) {
        if (face === 'top' || face === 'bottom') continue;
        const group = new THREE.Group();
        const m = marker(COLORS.side, false);
        m.position.copy(V(p, st));
        group.add(m);
        if (s.showLabels) {
          const label = makeLabel(`side ${which} (${FACE_NAMES[face]})${which === 'entry' ? ' · not a top HIT' : ''}`, 'side', [-0.12, 1.25]);
          label.position.copy(V(p, st));
          group.add(label);
        }
        group.visible = false;
        trackGroup.add(group);
        reveal.push({ group, marker: m, progress: progressAtZ(trace, p.z), billboard: true });
      }
    }

    // Pixels crossed by the in-silicon segment (geometric only): thin red borders on the surface.
    if (s.showTraversed && traversed.length) {
      const pts = [];
      for (const p of traversed) {
        const x0 = -SENSOR.halfX + p.x * SENSOR.pitchX;
        const y0 = -SENSOR.halfY + p.y * SENSOR.pitchY;
        const corners = [[x0, y0], [x0 + SENSOR.pitchX, y0], [x0 + SENSOR.pitchX, y0 + SENSOR.pitchY], [x0, y0 + SENSOR.pitchY]]
          .map(([x, y]) => V(point(x, y, SENSOR.zTop), st));
        corners.forEach((c, k) => pts.push(c, corners[(k + 1) % 4]));
      }
      const borders = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: COLORS.traversed, depthTest: false, transparent: true }),
      );
      borders.renderOrder = 9;
      trackGroup.add(borders);
    }

    // pixelAV SIMULATED charge as bars above the pads: height ∝ charge (linear),
    // colour = log-scale ramp. Display only; the bar height axis is not z.
    if (pixelShading(s) === 'charge' && s.showChargeBars) {
      const { dense, scale } = s.charge;
      const hits = [];
      for (let p = 0; p < dense.length; p++) if (dense[p] > 0) hits.push(p);
      if (hits.length && scale > 0) {
        const BAR_MAX = 4; // scene units (= 400 µm of display height) for the event's largest pixel
        const geometry = new THREE.BoxGeometry(SENSOR.pitchX * SCENE_SCALE * 0.86, 1, SENSOR.pitchY * SCENE_SCALE * 0.86);
        geometry.translate(0, 0.5, 0);
        const bars = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, transparent: true, opacity: 0.88 }), hits.length);
        const m4 = new THREE.Matrix4();
        const color = new THREE.Color();
        hits.forEach((p, i) => {
          const ix = p % SENSOR.pixelsX;
          const iy = Math.floor(p / SENSOR.pixelsX);
          const base = V(point(-SENSOR.halfX + (ix + 0.5) * SENSOR.pitchX, -SENSOR.halfY + (iy + 0.5) * SENSOR.pitchY, 0), st);
          const h = Math.max(0.01, (dense[p] / scale) * BAR_MAX);
          m4.makeScale(1, h, 1).setPosition(base.x, base.y + 0.004, base.z);
          bars.setMatrixAt(i, m4);
          const [r, g, b] = chargeColor(dense[p], scale);
          bars.setColorAt(i, color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace));
        });
        bars.renderOrder = 6;
        trackGroup.add(bars);
        if (s.showLabels) {
          let peak = hits[0];
          for (const p of hits) if (dense[p] > dense[peak]) peak = p;
          const c = point(-SENSOR.halfX + ((peak % SENSOR.pixelsX) + 0.5) * SENSOR.pitchX, -SENSOR.halfY + (Math.floor(peak / SENSOR.pixelsX) + 0.5) * SENSOR.pitchY, 0);
          const label = makeLabel(`pixelAV simulated · max ${Math.round(dense[peak])} e⁻ (slice ${s.charge.slice})`, 'charge', [0.5, 1.2]);
          label.position.copy(V(c, st)).add(new THREE.Vector3(0, (dense[peak] / scale) * BAR_MAX, 0));
          trackGroup.add(label);
        }
      }
    }

    if (s.showLabels && s.showTrackOff) {
      const label = makeLabel(`start (${fmt(trace.start.x)}, ${fmt(trace.start.y)}, ${fmt(trace.start.z)}) µm`, 'start', [-0.1, 1.3]);
      label.position.copy(start);
      trackGroup.add(label);
    }

    scene.add(trackGroup);
    track = { trace, start, end, beams, particle, glow, startMarker, reveal, st };
    return true;
  }

  /* ------------------------------------------------------------------ */
  function updateDynamic() {
    if (!track) return;
    const s = state();
    const { trace, beams, particle, glow, startMarker, reveal, st } = track;
    const fraction = s.progress;
    const current = V(pointAtProgress(trace, fraction), st);
    const scale = camera.position.distanceTo(controls.target) * 0.0065;

    for (const b of beams) {
      if (fraction > b.from) placeBeam(b.mesh, b.a, V(pointAtProgress(trace, Math.min(fraction, b.to)), st), scale * b.width);
      else b.mesh.visible = false;
    }
    particle.position.copy(current);
    particle.scale.setScalar(scale * 1.1);
    glow.position.copy(current);
    glow.scale.setScalar(scale * 9);
    particle.visible = glow.visible = fraction < 0.999;
    startMarker.scale.setScalar(scale * 0.8);

    for (const r of reveal) {
      r.group.visible = fraction >= r.progress - 1e-9;
      r.marker.scale.setScalar(scale * 1.6);
      if (r.billboard) r.marker.userData.ring.quaternion.copy(camera.quaternion);
    }
  }

  /* ------------------------------------------------------------------ */
  /**
   * Fit the sensor box plus the particle start/exit into the view for the
   * CURRENT camera direction: project the points onto the camera's right/up
   * axes, centre on their bounding rectangle and back off until both the
   * horizontal and vertical field of view contain it.
   */
  function computeFit() {
    const s = state();
    const trace = traceParticle(s);
    const pts = [];
    for (const x of [-SENSOR.halfX, SENSOR.halfX]) {
      for (const y of [-SENSOR.halfY, SENSOR.halfY]) {
        for (const z of [SENSOR.zTop, SENSOR.zBottom]) pts.push(V(point(x, y, z)));
      }
    }
    pts.push(V(trace.start), V(trace.bottom));
    const back = new THREE.Vector3(...toScene(cameraDirection(s.azimuth, s.elevation), 1)).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0); // same as camera.up; elevation ≤ 89° keeps it non-degenerate
    const right = new THREE.Vector3().crossVectors(worldUp, back).normalize();
    const up = new THREE.Vector3().crossVectors(back, right).normalize();
    let minR = Infinity; let maxR = -Infinity; let minU = Infinity; let maxU = -Infinity; let maxB = -Infinity;
    for (const p of pts) {
      const r = p.dot(right); const u = p.dot(up); const b = p.dot(back);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      maxB = Math.max(maxB, b);
    }
    const cR = (minR + maxR) / 2;
    const cU = (minU + maxU) / 2;
    const cB = pts.reduce((sum, p) => sum + p.dot(back), 0) / pts.length;
    const center = new THREE.Vector3().addScaledVector(right, cR).addScaledVector(up, cU).addScaledVector(back, cB);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * camera.aspect;
    const margin = 1.12;
    const distance = Math.max(
      ((maxR - minR) / 2) * margin / tanH,
      ((maxU - minU) / 2) * margin / tanV,
    ) + (maxB - cB);
    return { center, distance: Math.max(distance, 2) };
  }

  function applyStateCamera() {
    const s = state();
    const dir = cameraDirection(s.azimuth, s.elevation);
    const offset = new THREE.Vector3(...toScene(dir, 1)).normalize().multiplyScalar(fit.distance / s.zoom);
    applyingCamera = true;
    camera.position.copy(controls.target).add(offset);
    camera.up.set(0, 1, 0);
    camera.lookAt(controls.target);
    // Drop any leftover drag momentum so slider/keyboard input is not fought.
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
    applyingCamera = false;
    dirty = true;
  }

  controls.addEventListener('change', () => {
    dirty = true;
    if (applyingCamera) return;
    if (controls.target.distanceTo(fit.center) > 1e-6) userPanned = true;
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const physical = fromScene(offset.toArray(), 1);
    const { azimuth, elevation } = anglesFromDirection(physical);
    onCameraChange?.({ azimuth, elevation, zoom: THREE.MathUtils.clamp(fit.distance / offset.length(), ZOOM_MIN, ZOOM_MAX) });
  });

  function setFit(next) {
    fit = next;
    // Keep wheel zoom inside the same range as the keyboard / state.zoom.
    controls.minDistance = fit.distance / ZOOM_MAX;
    controls.maxDistance = fit.distance / ZOOM_MIN;
  }

  function focusPoint() {
    const s = state();
    const trace = traceParticle(s);
    const volume = intersectVolume(s);
    return V(trace.hit ? trace.top : volume ? volume.entry : trace.start);
  }

  function refit({ force = false } = {}) {
    const next = computeFit();
    if (force || !userPanned) {
      setFit(next);
      controls.target.copy(next.center);
      userPanned = false;
      focused = false;
    } else if (focused) {
      // "Focus impact" follows the impact point when the track changes.
      controls.target.copy(focusPoint());
    }
    applyStateCamera();
  }

  /* ------------------------------------------------------------------ */
  function loop() {
    frameHandle = requestAnimationFrame(loop);
    const moved = controls.update();
    if (!dirty && !moved) return;
    dirty = false;
    updateDynamic();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  function render() {
    buildStatic();
    buildTrack();
    // Only geometry that changes the framing triggers a refit; overlay toggles do not.
    const s = state();
    const key = [s.x0, s.y0, s.z0, s.thetaX, s.thetaY, s.zStretch].join('|');
    if (key !== fitKey) {
      fitKey = key;
      refit();
    }
    dirty = true;
  }

  function resize() {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    width = rect.width;
    height = rect.height;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(width, height, false);
    labelRenderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    setFit(userPanned ? { ...fit, distance: computeFit().distance } : computeFit());
    if (!userPanned) controls.target.copy(fit.center);
    applyStateCamera();
  }

  function setView(name) {
    const s = state();
    if (name === 'focus') {
      controls.target.copy(focusPoint());
      userPanned = true;
      focused = true;
      // ~600 µm across: zoom so the camera sits ~14 scene units away.
      s.zoom = fit.distance / 14;
      applyStateCamera();
      return;
    }
    controls.target.copy(fit.center);
    userPanned = false;
    refit({ force: true });
  }

  function exportPNG() {
    updateDynamic();
    renderer.setClearColor(0x0c1729, 1);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    renderer.setClearColor(0x000000, 0);
    renderer.render(scene, camera);
    return url;
  }

  function dispose() {
    cancelAnimationFrame(frameHandle);
    controls.dispose();
    if (staticGroup) disposeTree(staticGroup, keep);
    if (trackGroup) disposeTree(trackGroup, keep);
    pixelTexture.dispose();
    sharedGlow.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    labelRenderer.domElement.remove();
  }

  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); // allow the browser to restore the context
    cancelAnimationFrame(frameHandle);
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    staticKey = '';
    trackKey = '';
    pixelTexture.needsUpdate = true;
    render();
    loop();
  });

  render();
  loop();

  return {
    kind: 'webgl',
    element: renderer.domElement,
    render,
    resize,
    syncCamera: applyStateCamera,
    resetCamera: () => setView('reset'),
    setView,
    exportPNG,
    dispose,
  };
}
