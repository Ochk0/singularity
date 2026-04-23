import * as THREE from 'three';
import particleVert from './shaders/particle.vert?raw';
import particleFrag from './shaders/particle.frag?raw';
import trailVert    from './shaders/trail.vert?raw';
import trailFrag    from './shaders/trail.frag?raw';
import { loadMatterWasm } from './wasm/loader.js';

// The hot path — particle integration + trail geometry rebuild — lives in
// wasm/matter.ts. This class owns the Three.js geometry and delegates all
// per-frame work to the WASM module. Buffer attributes alias the WASM linear
// memory directly, so there is zero CPU→GPU copy beyond the upload.
export class MatterStream {
  // Async factory: wasm is loaded before the instance is usable.
  static async create() {
    const wasm = await loadMatterWasm();
    return new MatterStream(wasm);
  }

  constructor(wasm) {
    this.wasm    = wasm;
    this.exports = wasm.exports;
    const { MAX, SEG_VERTS, MAX_HOLES } = wasm.sizes;
    this.count     = MAX;
    this.MAX_HOLES = MAX_HOLES;

    // Views into WASM memory. Cached forever — memory is fixed-size so the
    // underlying ArrayBuffer never detaches.
    this.positions  = wasm.positions;
    this.velocities = wasm.velocities;
    this.life       = wasm.life;
    this.temp       = wasm.temp;
    this.size       = wasm.size;
    this.isStar     = wasm.isStar;
    this._holes     = wasm.holes;

    // ---- particle mesh ----
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aLife',    new THREE.BufferAttribute(this.life,      1));
    geo.setAttribute('aTemp',    new THREE.BufferAttribute(this.temp,      1));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(this.size,      1));
    geo.setDrawRange(0, MAX);
    const mat = new THREE.ShaderMaterial({
      vertexShader: particleVert,
      fragmentShader: particleFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.geo = geo;

    // ---- trail mesh ----
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(wasm.trailPos,  3));
    tGeo.setAttribute('aAge',     new THREE.BufferAttribute(wasm.trailAge,  1));
    tGeo.setAttribute('aTemp',    new THREE.BufferAttribute(wasm.trailTemp, 1));
    tGeo.setDrawRange(0, SEG_VERTS);
    const tMat = new THREE.ShaderMaterial({
      vertexShader: trailVert,
      fragmentShader: trailFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trails = new THREE.LineSegments(tGeo, tMat);
    this.trails.frustumCulled = false;
    this.trailGeo = tGeo;

    this.onImpact   = null;  // fired once per captured particle
    this.onTdeFlash = null;  // fired once per tidal disruption
  }

  spawn(origin, direction, count = 140) {
    const dir = direction.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, up).normalize();
    if (right.lengthSq() < 0.01) right.set(1, 0, 0);
    const nup = new THREE.Vector3().crossVectors(right, dir).normalize();

    const ex = this.exports;
    for (let n = 0; n < count; n++) {
      const i = ex.alloc();
      const i3 = i * 3;

      const a  = Math.random() * Math.PI * 2;
      const r  = Math.pow(Math.random(), 0.5) * 0.18;
      const jR = Math.cos(a) * r, jU = Math.sin(a) * r;

      const speed = 4.5 + Math.random() * 2.8;
      const vx = (dir.x + right.x * jR + nup.x * jU) * speed;
      const vy = (dir.y + right.y * jR + nup.y * jU) * speed;
      const vz = (dir.z + right.z * jR + nup.z * jU) * speed;

      const kick = 2.2 * (Math.random() - 0.5);
      const kx = right.x * kick, ky = right.y * kick, kz = right.z * kick;

      this.positions[i3]     = origin.x + (Math.random() - 0.5) * 0.3;
      this.positions[i3 + 1] = origin.y + (Math.random() - 0.5) * 0.3;
      this.positions[i3 + 2] = origin.z + (Math.random() - 0.5) * 0.3;

      this.velocities[i3]     = vx + kx;
      this.velocities[i3 + 1] = vy + ky;
      this.velocities[i3 + 2] = vz + kz;

      this.life[i] = 1.0;
      this.temp[i] = 0.05 + Math.random() * 0.1;
      this.size[i] = 2.0 + Math.random() * 3.0;
      ex.seedRing(i);
    }
  }

  // Launch one massive "star" particle with a given initial velocity.
  spawnStarWithVelocity(origin, velocity) {
    const ex = this.exports;
    const i = ex.alloc();
    const i3 = i * 3;
    this.positions[i3]     = origin.x;
    this.positions[i3 + 1] = origin.y;
    this.positions[i3 + 2] = origin.z;
    this.velocities[i3]     = velocity.x;
    this.velocities[i3 + 1] = velocity.y;
    this.velocities[i3 + 2] = velocity.z;
    this.life[i] = 1.0;
    this.temp[i] = 0.2;
    this.size[i] = 22.0;
    ex.markStar(i);
    ex.seedRing(i);
  }

  // Convenience: aim a star at `target` with a grazing tangential component.
  spawnStar(origin, target) {
    const dir = new THREE.Vector3().subVectors(target, origin).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const tangent = new THREE.Vector3().crossVectors(dir, up).normalize();
    if (tangent.lengthSq() < 0.01) tangent.set(1, 0, 0);
    const v = dir.multiplyScalar(3.6).addScaledVector(tangent, 2.0);
    this.spawnStarWithVelocity(origin, v);
  }

  update(dt, holes) {
    const n = Math.min(holes.length, this.MAX_HOLES);
    const hv = this._holes;
    for (let i = 0; i < n; i++) {
      const H = holes[i];
      const b = i * 4;
      hv[b]     = H.pos.x;
      hv[b + 1] = H.pos.y;
      hv[b + 2] = H.pos.z;
      hv[b + 3] = H.rs;
    }

    this.exports.update(dt, n);

    // Drain events. Positions aren't tracked per-event on the WASM side —
    // audio callbacks here don't use them, so we just fire N calls with
    // the primary hole's position as a neutral argument.
    const impacts = this.exports.consumeImpacts();
    if (impacts > 0 && this.onImpact) {
      const p = holes[0].pos;
      for (let k = 0; k < impacts; k++) this.onImpact(p);
    }
    if (this.exports.consumeTdeFlash() && this.onTdeFlash) this.onTdeFlash();

    // The Float32Arrays alias WASM memory, so the CPU side is already
    // up-to-date. Flag the attributes so WebGL re-uploads them.
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate    = true;
    this.geo.attributes.aTemp.needsUpdate    = true;
    this.trailGeo.attributes.position.needsUpdate = true;
    this.trailGeo.attributes.aAge.needsUpdate     = true;
    this.trailGeo.attributes.aTemp.needsUpdate    = true;
  }
}
