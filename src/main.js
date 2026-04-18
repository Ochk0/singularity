import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';

import { createBlackHoleMaterial, createBlackHoleMesh } from './BlackHole.js';
import { MatterStream } from './MatterStream.js';
import { createPostFX } from './PostFX.js';
import { AudioEngine } from './Audio.js';
import { Director } from './Director.js';
import { Hud } from './Hud.js';
import { applyPreset, makeTdeScheduler } from './Presets.js';
import { buildSkyBox } from './SkyBox.js';
import { HoleTrails } from './HoleTrails.js';

// ------------------------------------------------------------------
// renderer / camera / controls
// ------------------------------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const pxRatio = Math.min(window.devicePixelRatio, 1.75);
renderer.setPixelRatio(pxRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClearColor = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(18, 6.5, 22);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5.5;
controls.maxDistance = 80;
controls.rotateSpeed = 0.8;
controls.zoomSpeed = 0.8;
controls.target.set(0, 0, 0);

// ------------------------------------------------------------------
// half-res black hole pass: render BH shader to an RT at 0.5x, then
// composite into the main scene via a trivial blit material.
// ------------------------------------------------------------------
// Build the sky cubemap ONCE. Takes ~30-80ms; happens before first frame.
const skyTexture = buildSkyBox(renderer, 1024);

const resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
const bhMat = createBlackHoleMaterial({ camera, resolution });
bhMat.uniforms.uSkyBox.value = skyTexture;
const bhMesh = createBlackHoleMesh(bhMat);
bhMesh.renderOrder = -1000;
scene.add(bhMesh);

// ------------------------------------------------------------------
// particles + trails
// ------------------------------------------------------------------
const matter = new MatterStream();
scene.add(matter.trails);
scene.add(matter.points);

const holeTrails = new HoleTrails();
scene.add(holeTrails.mesh);

// ------------------------------------------------------------------
// trajectory preview line
// ------------------------------------------------------------------
const aimGeo = new THREE.BufferGeometry();
aimGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
const aimMat = new THREE.LineDashedMaterial({
  color: 0xaaccff, dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.75, depthTest: false,
});
const aimLine = new THREE.Line(aimGeo, aimMat);
aimLine.frustumCulled = false;
aimLine.visible = false;
aimLine.renderOrder = 10;
scene.add(aimLine);

function setAim(a, b) {
  const p = aimGeo.attributes.position.array;
  p[0] = a.x; p[1] = a.y; p[2] = a.z;
  p[3] = b.x; p[4] = b.y; p[5] = b.z;
  aimGeo.attributes.position.needsUpdate = true;
  aimLine.computeLineDistances();
}

// ------------------------------------------------------------------
// post-processing
// ------------------------------------------------------------------
const { composer, bloom, finishPass } = createPostFX(renderer, scene, camera);

// ------------------------------------------------------------------
// audio + tde flash
// ------------------------------------------------------------------
const audio = new AudioEngine();
matter.onImpact = () => audio.chime();
let tdeFlash = 0;
matter.onTdeFlash = () => {
  tdeFlash = 1.0;
  audio.chime();
  audio.chime();
};

// ------------------------------------------------------------------
// N-body
// ------------------------------------------------------------------
const primary = { pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(), rs: 1.0 };
const extras = [];
const allHoles = () => [primary, ...extras];

const ripple = { pos: new THREE.Vector3(), age: -1, strength: 1 };
function triggerMerger(pos) {
  ripple.pos.copy(pos);
  ripple.age = 0;
  ripple.strength = 1.2;
  audio.merger();
}

// Scratch vectors to avoid GC in tight loops.
const _tmp = new THREE.Vector3();

// ---- Artistic mode (the original feel): primary pinned, radiation damping,
//      eager merging so inspirals finish cleanly.
function updateArtistic(dt) {
  const dt2 = Math.min(dt, 0.04);
  for (let i = 0; i < extras.length; i++) {
    const a = extras[i];
    const acc = new THREE.Vector3();
    for (let j = 0; j <= extras.length; j++) {
      const b = j === extras.length ? primary : extras[j];
      if (b === a) continue;
      _tmp.subVectors(b.pos, a.pos);
      const r2 = Math.max(_tmp.lengthSq(), (a.rs + b.rs) * 0.5);
      const r = Math.sqrt(r2);
      const M = b.rs * b.rs * 3.0;
      acc.addScaledVector(_tmp, M / (r2 * r));
    }
    const distToPrim = a.pos.distanceTo(primary.pos);
    const reactScale = Math.max(0, (6.0 - distToPrim)) * 0.4;
    acc.addScaledVector(a.vel, -reactScale);
    a.vel.addScaledVector(acc, dt2);
  }
  for (const a of extras) { a.pos.addScaledVector(a.vel, dt2); a.age += dt2; }

  // merges (artistic: readily absorb)
  for (let i = extras.length - 1; i >= 0; i--) {
    const a = extras[i];
    if (a.pos.distanceTo(primary.pos) < primary.rs + a.rs * 0.9) {
      triggerMerger(a.pos.clone());
      primary.rs = Math.min(primary.rs + a.rs * 0.6, 2.2);
      extras.splice(i, 1);
      continue;
    }
    for (let j = i - 1; j >= 0; j--) {
      const b = extras[j];
      if (a.pos.distanceTo(b.pos) < a.rs + b.rs * 0.9) {
        triggerMerger(a.pos.clone().add(b.pos).multiplyScalar(0.5));
        b.rs = Math.min(b.rs + a.rs * 0.6, 2.0);
        extras.splice(i, 1);
        break;
      }
    }
  }
}

// ---- Chaos mode: proper N-body with velocity Verlet.
//      All bodies (including primary) integrate. Softening length prevents NaN
//      on close passes. Only merges on true overlap. No damping.
const _acc = [];
function computeAccelerations(bodies) {
  while (_acc.length < bodies.length) _acc.push(new THREE.Vector3());
  for (let i = 0; i < bodies.length; i++) _acc[i].set(0, 0, 0);
  const G = 1.0;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      _tmp.subVectors(b.pos, a.pos);
      const soft = (a.rs + b.rs) * 0.4;
      const r2 = _tmp.lengthSq() + soft * soft;
      const r  = Math.sqrt(r2);
      const inv3 = 1 / (r2 * r);
      const Mb = b.rs * b.rs * 3.0;
      const Ma = a.rs * a.rs * 3.0;
      _acc[i].addScaledVector(_tmp, G * Mb * inv3);
      _acc[j].addScaledVector(_tmp, -G * Ma * inv3);
    }
  }
}

function updateChaos(dt) {
  // clamp dt and subcycle for stability during close passes
  const target = Math.min(dt, 0.04);
  const sub = 4;                 // 4 substeps per frame
  const h = target / sub;
  const bodies = allHoles();

  for (let s = 0; s < sub; s++) {
    // velocity Verlet:
    // a_n  = a(x_n)
    // x_{n+1} = x_n + v_n h + 0.5 a_n h²
    // a_{n+1} = a(x_{n+1})
    // v_{n+1} = v_n + 0.5 (a_n + a_{n+1}) h
    computeAccelerations(bodies);
    const a0 = _acc.map(v => v.clone());
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.pos.addScaledVector(b.vel, h);
      b.pos.addScaledVector(a0[i], 0.5 * h * h);
    }
    computeAccelerations(bodies);
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.vel.addScaledVector(a0[i], 0.5 * h);
      b.vel.addScaledVector(_acc[i], 0.5 * h);
    }
  }

  // Merge only on clear overlap (event-horizon contact).
  // Primary survives if involved; otherwise lower-index survives.
  for (let i = extras.length - 1; i >= 0; i--) {
    const a = extras[i];
    if (a.pos.distanceTo(primary.pos) < (primary.rs + a.rs) * 0.85) {
      triggerMerger(a.pos.clone().add(primary.pos).multiplyScalar(0.5));
      // conserve momentum
      const Ma = primary.rs * primary.rs * 3.0;
      const Mb = a.rs * a.rs * 3.0;
      const M = Ma + Mb;
      primary.vel.multiplyScalar(Ma / M).addScaledVector(a.vel, Mb / M);
      primary.rs = Math.min(Math.cbrt(primary.rs ** 3 + a.rs ** 3), 3.0);
      extras.splice(i, 1);
      continue;
    }
    for (let j = i - 1; j >= 0; j--) {
      const b = extras[j];
      if (a.pos.distanceTo(b.pos) < (a.rs + b.rs) * 0.85) {
        triggerMerger(a.pos.clone().add(b.pos).multiplyScalar(0.5));
        const Ma = a.rs * a.rs * 3.0;
        const Mb = b.rs * b.rs * 3.0;
        const M = Ma + Mb;
        b.vel.multiplyScalar(Mb / M).addScaledVector(a.vel, Ma / M);
        b.rs = Math.min(Math.cbrt(a.rs ** 3 + b.rs ** 3), 2.5);
        extras.splice(i, 1);
        break;
      }
    }
  }
}

function updateNBody(dt) {
  if (params.chaos) updateChaos(dt);
  else              updateArtistic(dt);
}

// ------------------------------------------------------------------
// UI state: spawn mode + drag-aim
// ------------------------------------------------------------------
let mode = 'view';
const toolbar = document.getElementById('toolbar');
function setMode(m) {
  mode = m;
  document.querySelectorAll('#toolbar button[data-mode]').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === m);
  });
}
toolbar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.mode) setMode(b.dataset.mode);
  if (b.dataset.preset) {
    document.querySelectorAll('#toolbar button[data-preset]').forEach(x => x.classList.toggle('active', x === b));
    applyPreset(b.dataset.preset, { params, primary, extras, matter, tde: tdeScheduler, holeTrails, guiRefs: { gui } });
  }
  if (b.id === 'btn-cinema') toggleCinema();
});

window.addEventListener('keydown', (e) => {
  // ignore shortcuts when the user is typing in the lil-gui number inputs
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === '1') setMode('matter');
  else if (e.key === '2') setMode('hole');
  else if (e.key === '3') setMode('star');
  else if (e.key === 'v' || e.key === 'V' || e.key === 'Escape') setMode('view');
  else if (e.key === 'c' || e.key === 'C') toggleCinema();
});

// "spawned ✓" toast
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);
let toastTimer = null;
function flashSpawn(kind) {
  const icons = { matter: '· · ·', hole: '◉', star: '☄' };
  toastEl.textContent = `spawned ${icons[kind] || ''}`;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 900);
}

// convert a click point into a world-space aim target at the primary's focal plane
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function worldAtPointer(clientX, clientY, dist = null) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const t = dist !== null ? dist : Math.max(camera.position.length(), 18);
  return raycaster.ray.at(t, new THREE.Vector3());
}

// drag state
let drag = null;
const CLICK_THRESHOLD = 8;

renderer.domElement.addEventListener('pointerdown', (e) => {
  // cinema cancels on any click
  if (director.active) { director.stop(); return; }
  if (e.button !== 0) return;
  // In View mode the canvas belongs entirely to OrbitControls — no spawn path.
  if (mode === 'view') return;
  drag = {
    startX: e.clientX, startY: e.clientY,
    startWorld: worldAtPointer(e.clientX, e.clientY),
    curWorld: worldAtPointer(e.clientX, e.clientY),
  };
  aimLine.visible = true;
  setAim(drag.startWorld, drag.curWorld);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.curWorld = worldAtPointer(e.clientX, e.clientY);
  setAim(drag.startWorld, drag.curWorld);
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  const dragLen = Math.hypot(dx, dy);
  const endWorld = worldAtPointer(e.clientX, e.clientY);
  aimLine.visible = false;

  // short tap → default aim toward primary (legacy behavior)
  const haveAim = dragLen >= CLICK_THRESHOLD;
  // velocity scale: drag length in px → speed, capped
  const speedScale = haveAim ? Math.min(dragLen / 180, 1.4) : 0.4;

  const origin = drag.startWorld.clone();
  let dir;
  if (haveAim) {
    dir = new THREE.Vector3().subVectors(endWorld, origin).normalize();
  } else {
    dir = new THREE.Vector3().subVectors(primary.pos, origin).normalize();
  }

  if (mode === 'matter') {
    const spawnOrigin = camera.position.clone().add(
      new THREE.Vector3().subVectors(origin, camera.position).normalize().multiplyScalar(3.0)
    );
    const d = haveAim
      ? new THREE.Vector3().subVectors(endWorld, spawnOrigin).normalize()
      : new THREE.Vector3().subVectors(primary.pos, spawnOrigin).normalize();
    matter.spawn(spawnOrigin, d, 180);
    flashSpawn('matter');
  } else if (mode === 'hole') {
    const v = dir.clone().multiplyScalar(1.8 * speedScale);
    // if no drag, give an orbital kick instead
    if (!haveAim) {
      const toPrim = new THREE.Vector3().subVectors(primary.pos, origin);
      const up = new THREE.Vector3(0, 1, 0);
      v.copy(new THREE.Vector3().crossVectors(toPrim, up).normalize().multiplyScalar(0.9));
    }
    extras.push({
      pos: origin,
      vel: v,
      rs: 0.35 + Math.random() * 0.2,
      age: 0,
    });
    flashSpawn('hole');
  } else if (mode === 'star') {
    // Safe-origin: if the projected click point is inside the danger zone,
    // push it outward so the star doesn't spawn on top of the horizon.
    const SAFE_R = Math.max(26, primary.rs * params.mass * 14);
    const starOrigin = origin.clone();
    const toHole = starOrigin.clone().sub(primary.pos);
    let r = toHole.length();
    if (r < SAFE_R) {
      if (r < 1e-3) toHole.set(1, 0, 0);
      starOrigin.copy(primary.pos).addScaledVector(toHole.normalize(), SAFE_R);
    }

    let v;
    if (haveAim) {
      const toAim = new THREE.Vector3().subVectors(endWorld, starOrigin).normalize();
      v = toAim.multiplyScalar(4.0 + 3.0 * speedScale);
    } else {
      // tap → generic grazing plunge
      const toPrim = new THREE.Vector3().subVectors(primary.pos, starOrigin).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const tangent = new THREE.Vector3().crossVectors(toPrim, up);
      if (tangent.lengthSq() < 0.01) tangent.set(1, 0, 0);
      tangent.normalize();
      v = toPrim.multiplyScalar(3.6).addScaledVector(tangent, 2.0);
    }
    matter.spawnStarWithVelocity(starOrigin, v);
    flashSpawn('star');
  }

  drag = null;
});

// ------------------------------------------------------------------
// GUI
// ------------------------------------------------------------------
const gui = new GUI({ title: 'tune' });
const params = {
  mass:       1.0,
  spin:       0.5,
  diskDensity: 1.0,
  diskTemp:    1.0,
  diskInner:   3.0,
  diskOuter:  14.0,
  bloom:       1.25,
  grain:       0.03,
  vignette:    0.65,
  timeScale:   1.0,
  chaos:       false,
  reset()     {
    extras.length = 0;
    primary.rs = 1.0;
    primary.pos.set(0, 0, 0);
    primary.vel.set(0, 0, 0);
    tdeScheduler.stop();
    holeTrails.reset();
  },
  screenshot() {
    renderer.domElement.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `singularity-${Date.now()}.png`;
      a.click();
    });
  },
};
gui.add(params, 'mass',         0.4, 2.5, 0.01);
gui.add(params, 'spin',         0.0, 1.0, 0.01);
gui.add(params, 'diskDensity',  0.0, 2.0, 0.01);
gui.add(params, 'diskTemp',     0.2, 2.0, 0.01);
gui.add(params, 'diskInner',    2.0, 6.0, 0.1);
gui.add(params, 'diskOuter',    8.0, 24.0, 0.1);
gui.add(params, 'bloom',        0.0, 2.0, 0.01);
gui.add(params, 'grain',        0.0, 0.1, 0.001);
gui.add(params, 'vignette',     0.0, 1.0, 0.01);
gui.add(params, 'timeScale',    0.0, 3.0, 0.01);
gui.add(params, 'chaos').name('chaos n-body').onChange((v) => {
  if (!v) {
    primary.pos.set(0, 0, 0);
    primary.vel.set(0, 0, 0);
  }
  holeTrails.reset();
});
gui.add(params, 'reset');
gui.add(params, 'screenshot');
gui.close();

// ------------------------------------------------------------------
// director, presets, HUD
// ------------------------------------------------------------------
const director = new Director(camera, controls);
const tdeScheduler = makeTdeScheduler();
const hud = new Hud(document.getElementById('physhud'));

function toggleCinema() {
  if (director.active) director.stop();
  else director.start(primary.pos);
  document.getElementById('btn-cinema').classList.toggle('active', director.active);
}

// ------------------------------------------------------------------
// splash & audio gesture
// ------------------------------------------------------------------
const splash = document.getElementById('splash');
function dismissSplash() {
  if (splash && !splash.classList.contains('hidden')) {
    splash.classList.add('hidden');
    audio.start();
    setTimeout(() => splash.remove(), 900);
  }
}
document.addEventListener('pointerdown', dismissSplash);

// ------------------------------------------------------------------
// resize
// ------------------------------------------------------------------
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resolution.set(w, h);
  bhMat.uniforms.uResolution.value.copy(resolution);
  finishPass.uniforms.uResolution.value.set(w, h);
}
window.addEventListener('resize', onResize);

// ------------------------------------------------------------------
// main loop
// ------------------------------------------------------------------
const clock = new THREE.Clock();

function render() {
  const dt = clock.getDelta() * params.timeScale;
  const t = clock.getElapsedTime();

  const effectiveRs = params.mass * primary.rs;
  controls.minDistance = Math.max(5.5, effectiveRs * 3.5);

  director.update(dt);
  if (!director.active) controls.update();

  tdeScheduler.update(dt);
  updateNBody(dt);
  matter.update(dt, allHoles());

  holeTrails.setVisible(params.chaos);
  if (params.chaos) holeTrails.update(allHoles());

  if (ripple.age >= 0) {
    ripple.age += dt;
    if (ripple.age > 3.5) ripple.age = -1;
  }

  tdeFlash *= Math.exp(-dt * 2.4);
  if (tdeFlash < 0.002) tdeFlash = 0;

  // BH uniforms
  const u = bhMat.uniforms;
  u.uTime.value = t;
  u.uCameraWorld.value.copy(camera.matrixWorld);
  u.uCameraProjInv.value.copy(camera.projectionMatrixInverse);
  u.uCameraPos.value.copy(camera.position);
  u.uMass.value = effectiveRs;
  u.uPrimaryPos.value.copy(primary.pos);
  u.uChaosMode.value = params.chaos ? 1 : 0;
  u.uSpin.value = params.spin;
  u.uDiskDensity.value = params.diskDensity;
  u.uDiskTemp.value = params.diskTemp;
  u.uDiskInner.value = params.diskInner;
  u.uDiskOuter.value = params.diskOuter;
  u.uJetStrength.value = params.spin * 0.9 + 0.25;
  u.uTdeFlash.value = tdeFlash;
  u.uExtraCount.value = Math.min(extras.length, 3);
  for (let i = 0; i < 3; i++) {
    const e = extras[i];
    if (e) u.uExtras.value[i].set(e.pos.x, e.pos.y, e.pos.z, e.rs);
    else   u.uExtras.value[i].set(0, 0, 0, 0);
  }
  u.uRipplePos.value.copy(ripple.pos);
  u.uRippleAge.value = ripple.age;
  u.uRippleStrength.value = ripple.strength;

  // post-fx knobs
  const dToHorizon = camera.position.length() - effectiveRs;
  audio.setProximity(THREE.MathUtils.clamp(1.0 - dToHorizon / 14.0, 0.0, 1.0));
  bloom.strength = params.bloom * (director.active ? 1.1 : 1.0);
  finishPass.uniforms.uTime.value = t;
  finishPass.uniforms.uGrain.value = params.grain;
  finishPass.uniforms.uVignette.value = params.vignette + (director.active ? 0.08 : 0);
  finishPass.uniforms.uCAmount.value = (director.active ? 1.6 : 1.0)
    + (ripple.age >= 0 ? Math.max(0, 1.0 - ripple.age) * 6.0 : 0);

  composer.render();

  hud.tick(dt, { params, primary, extras, mode, cinema: director.active });

  requestAnimationFrame(render);
}

render();
