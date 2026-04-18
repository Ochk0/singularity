import * as THREE from 'three';
import particleVert from './shaders/particle.vert?raw';
import particleFrag from './shaders/particle.frag?raw';
import trailVert    from './shaders/trail.vert?raw';
import trailFrag    from './shaders/trail.frag?raw';

const MAX = 6000;
const TRAIL_LEN = 10;       // positions per particle in the ring
const SEG_PER = TRAIL_LEN - 1;

export class MatterStream {
  constructor() {
    this.count = MAX;
    this.positions  = new Float32Array(MAX * 3);
    this.velocities = new Float32Array(MAX * 3);
    this.life       = new Float32Array(MAX);
    this.temp       = new Float32Array(MAX);
    this.size       = new Float32Array(MAX);
    this.isStar     = new Uint8Array(MAX);    // 1 if star awaiting tidal disruption
    this.cursor     = 0;

    // ---- particle mesh ----
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aLife',    new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute('aTemp',    new THREE.BufferAttribute(this.temp, 1));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(this.size, 1));
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

    // ---- trail ring buffer ----
    this.trailRing = new Float32Array(MAX * TRAIL_LEN * 3);
    this.trailHead = new Int32Array(MAX);   // index of latest entry per particle

    const SEG_VERTS = MAX * SEG_PER * 2;
    this.trailPos = new Float32Array(SEG_VERTS * 3);
    this.trailAge = new Float32Array(SEG_VERTS);
    this.trailTemp = new Float32Array(SEG_VERTS);

    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    tGeo.setAttribute('aAge',     new THREE.BufferAttribute(this.trailAge, 1));
    tGeo.setAttribute('aTemp',    new THREE.BufferAttribute(this.trailTemp, 1));
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

    this.onImpact = null;
    this.onTdeFlash = null;    // called when a star spaghettifies
  }

  _alloc() {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    // reset ring for this slot
    const base = i * TRAIL_LEN * 3;
    for (let k = 0; k < TRAIL_LEN * 3; k++) this.trailRing[base + k] = 0;
    this.trailHead[i] = 0;
    this.isStar[i] = 0;
    return i;
  }

  // Fill the ring for a freshly-spawned particle with its current position
  // so the first rendered frame doesn't have a trail extending from origin.
  _seedRing(i) {
    const base = i * TRAIL_LEN * 3;
    const px = this.positions[i * 3], py = this.positions[i * 3 + 1], pz = this.positions[i * 3 + 2];
    for (let k = 0; k < TRAIL_LEN; k++) {
      this.trailRing[base + k * 3]     = px;
      this.trailRing[base + k * 3 + 1] = py;
      this.trailRing[base + k * 3 + 2] = pz;
    }
  }

  spawn(origin, direction, count = 140) {
    const dir = direction.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, up).normalize();
    if (right.lengthSq() < 0.01) right.set(1, 0, 0);
    const nup = new THREE.Vector3().crossVectors(right, dir).normalize();

    for (let n = 0; n < count; n++) {
      const i = this._alloc();

      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.5) * 0.18;
      const jR = Math.cos(a) * r, jU = Math.sin(a) * r;

      const speed = 4.5 + Math.random() * 2.8;
      const vx = (dir.x + right.x * jR + nup.x * jU) * speed;
      const vy = (dir.y + right.y * jR + nup.y * jU) * speed;
      const vz = (dir.z + right.z * jR + nup.z * jU) * speed;

      const kick = 2.2 * (Math.random() - 0.5);
      const kx = right.x * kick, ky = right.y * kick, kz = right.z * kick;

      this.positions[i * 3]     = origin.x + (Math.random() - 0.5) * 0.3;
      this.positions[i * 3 + 1] = origin.y + (Math.random() - 0.5) * 0.3;
      this.positions[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.3;

      this.velocities[i * 3]     = vx + kx;
      this.velocities[i * 3 + 1] = vy + ky;
      this.velocities[i * 3 + 2] = vz + kz;

      this.life[i] = 1.0;
      this.temp[i] = 0.05 + Math.random() * 0.1;
      this.size[i] = 2.0 + Math.random() * 3.0;
      this._seedRing(i);
    }
  }

  // Launch one massive "star" particle with a given initial velocity.
  spawnStarWithVelocity(origin, velocity) {
    const i = this._alloc();
    this.positions[i * 3]     = origin.x;
    this.positions[i * 3 + 1] = origin.y;
    this.positions[i * 3 + 2] = origin.z;
    this.velocities[i * 3]     = velocity.x;
    this.velocities[i * 3 + 1] = velocity.y;
    this.velocities[i * 3 + 2] = velocity.z;
    this.life[i] = 1.0;
    this.temp[i] = 0.2;
    this.size[i] = 22.0;
    this.isStar[i] = 1;
    this._seedRing(i);
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

  // Replace a star with a stream of child particles stretched radially.
  _spaghettify(starIdx, center) {
    const cx = center.x, cy = center.y, cz = center.z;
    const sx = this.positions[starIdx * 3], sy = this.positions[starIdx * 3 + 1], sz = this.positions[starIdx * 3 + 2];
    const svx = this.velocities[starIdx * 3], svy = this.velocities[starIdx * 3 + 1], svz = this.velocities[starIdx * 3 + 2];

    // radial unit (from hole to star)
    let rx = sx - cx, ry = sy - cy, rz = sz - cz;
    const rlen = Math.hypot(rx, ry, rz) || 1;
    rx /= rlen; ry /= rlen; rz /= rlen;

    // kill the star
    this.life[starIdx] = 0;
    this.isStar[starIdx] = 0;

    // spawn 120 children along the radial line
    const N = 120;
    for (let n = 0; n < N; n++) {
      const i = this._alloc();
      // spread along radial from -stretchIn to +stretchOut
      const t = (n / (N - 1)) - 0.5;                    // -0.5..0.5
      const stretch = 3.5 + Math.random() * 1.2;
      const dx = rx * t * stretch;
      const dy = ry * t * stretch;
      const dz = rz * t * stretch;

      // small perpendicular jitter
      const jx = (Math.random() - 0.5) * 0.35;
      const jy = (Math.random() - 0.5) * 0.35;
      const jz = (Math.random() - 0.5) * 0.35;

      this.positions[i * 3]     = sx + dx + jx;
      this.positions[i * 3 + 1] = sy + dy + jy;
      this.positions[i * 3 + 2] = sz + dz + jz;

      // inherit velocity + radial spread (leading bits fall faster)
      const vShift = -t * 2.4;        // inner pieces fall in faster
      this.velocities[i * 3]     = svx + rx * vShift + (Math.random() - 0.5) * 0.6;
      this.velocities[i * 3 + 1] = svy + ry * vShift + (Math.random() - 0.5) * 0.6;
      this.velocities[i * 3 + 2] = svz + rz * vShift + (Math.random() - 0.5) * 0.6;

      this.life[i] = 1.0;
      this.temp[i] = 0.5 + Math.random() * 0.35;
      this.size[i] = 2.8 + Math.random() * 2.5;
      this._seedRing(i);
    }

    if (this.onTdeFlash) this.onTdeFlash();
  }

  update(dt, holes) {
    const G = 1.0;
    const dt2 = Math.min(dt, 0.04);
    const primary = holes[0];

    // advance physics
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0.0) continue;

      const px = this.positions[i * 3], py = this.positions[i * 3 + 1], pz = this.positions[i * 3 + 2];
      let vx = this.velocities[i * 3], vy = this.velocities[i * 3 + 1], vz = this.velocities[i * 3 + 2];

      let tempRaise = 0.0;
      let captured = false;

      for (let h = 0; h < holes.length; h++) {
        const H = holes[h];
        const dx = H.pos.x - px, dy = H.pos.y - py, dz = H.pos.z - pz;
        const r2 = dx * dx + dy * dy + dz * dz;
        const r  = Math.sqrt(r2);

        if (r < H.rs * 1.1) {
          captured = true;
          if (this.onImpact) this.onImpact(H.pos);
          break;
        }

        const M = H.rs * H.rs * 3.0;
        const invR3 = 1.0 / (r2 * r + 1e-3);
        const f = G * M * invR3;
        vx += dx * f * dt2;
        vy += dy * f * dt2;
        vz += dz * f * dt2;
        tempRaise += Math.max(0, (H.rs * 4.0 - r)) * 0.04;
      }

      if (captured) {
        this.life[i] = 0.0;
        continue;
      }

      this.positions[i * 3]     = px + vx * dt2;
      this.positions[i * 3 + 1] = py + vy * dt2;
      this.positions[i * 3 + 2] = pz + vz * dt2;
      this.velocities[i * 3]     = vx;
      this.velocities[i * 3 + 1] = vy;
      this.velocities[i * 3 + 2] = vz;

      this.temp[i] = Math.min(1.0, this.temp[i] + tempRaise * dt2);

      // tidal disruption check for stars
      if (this.isStar[i]) {
        const dxp = primary.pos.x - this.positions[i * 3];
        const dyp = primary.pos.y - this.positions[i * 3 + 1];
        const dzp = primary.pos.z - this.positions[i * 3 + 2];
        const dist = Math.sqrt(dxp * dxp + dyp * dyp + dzp * dzp);
        if (dist < primary.rs * 3.0) {
          this._spaghettify(i, primary.pos);
          continue;
        }
      }

      const dist = Math.hypot(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      if (dist > 140.0) this.life[i] = 0.0;
      this.life[i] -= dt2 * 0.02;
      if (this.life[i] < 0) this.life[i] = 0;
    }

    // advance trail ring (for alive particles only)
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0.0) continue;
      const head = (this.trailHead[i] + 1) % TRAIL_LEN;
      this.trailHead[i] = head;
      const base = i * TRAIL_LEN * 3 + head * 3;
      this.trailRing[base]     = this.positions[i * 3];
      this.trailRing[base + 1] = this.positions[i * 3 + 1];
      this.trailRing[base + 2] = this.positions[i * 3 + 2];
    }

    // rebuild trail line geometry (line segments pair consecutive ring entries)
    for (let i = 0; i < MAX; i++) {
      const alive = this.life[i] > 0.0;
      const head = this.trailHead[i];
      const ringBase = i * TRAIL_LEN * 3;
      const segBase = i * SEG_PER * 2;

      for (let k = 0; k < SEG_PER; k++) {
        // segment k connects (head - k) and (head - k - 1)
        const ia = ((head - k) + TRAIL_LEN * 4) % TRAIL_LEN;
        const ib = ((head - k - 1) + TRAIL_LEN * 4) % TRAIL_LEN;
        const aBase = ringBase + ia * 3;
        const bBase = ringBase + ib * 3;
        const vIdx = (segBase + k * 2) * 3;

        if (alive) {
          this.trailPos[vIdx]     = this.trailRing[aBase];
          this.trailPos[vIdx + 1] = this.trailRing[aBase + 1];
          this.trailPos[vIdx + 2] = this.trailRing[aBase + 2];
          this.trailPos[vIdx + 3] = this.trailRing[bBase];
          this.trailPos[vIdx + 4] = this.trailRing[bBase + 1];
          this.trailPos[vIdx + 5] = this.trailRing[bBase + 2];
          const ageA = k / SEG_PER;
          const ageB = (k + 1) / SEG_PER;
          this.trailAge[segBase + k * 2]     = ageA;
          this.trailAge[segBase + k * 2 + 1] = ageB;
          this.trailTemp[segBase + k * 2]     = this.temp[i];
          this.trailTemp[segBase + k * 2 + 1] = this.temp[i];
        } else {
          // collapse segment so it's degenerate and invisible
          this.trailPos[vIdx] = this.trailPos[vIdx + 3] = 0;
          this.trailPos[vIdx + 1] = this.trailPos[vIdx + 4] = 0;
          this.trailPos[vIdx + 2] = this.trailPos[vIdx + 5] = 0;
          this.trailAge[segBase + k * 2]     = 1.0;
          this.trailAge[segBase + k * 2 + 1] = 1.0;
          this.trailTemp[segBase + k * 2]     = 0;
          this.trailTemp[segBase + k * 2 + 1] = 0;
        }
      }
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
    this.geo.attributes.aTemp.needsUpdate = true;
    this.trailGeo.attributes.position.needsUpdate = true;
    this.trailGeo.attributes.aAge.needsUpdate = true;
    this.trailGeo.attributes.aTemp.needsUpdate = true;
  }
}
