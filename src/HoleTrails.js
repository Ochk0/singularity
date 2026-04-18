import * as THREE from 'three';

// Fading trails for every moving hole.  Each body (primary + up to extras)
// gets a ring of TRAIL_LEN positions; we rebuild a LineSegments geometry
// every frame.  Visible only in chaos mode.
const MAX_BODIES = 8;
const TRAIL_LEN  = 90;
const SEG_PER    = TRAIL_LEN - 1;

export class HoleTrails {
  constructor() {
    this.ring  = new Float32Array(MAX_BODIES * TRAIL_LEN * 3);
    this.head  = new Int32Array(MAX_BODIES);
    this.init  = new Uint8Array(MAX_BODIES);     // whether ring has been seeded

    const SEG_VERTS = MAX_BODIES * SEG_PER * 2;
    this.pos  = new Float32Array(SEG_VERTS * 3);
    this.age  = new Float32Array(SEG_VERTS);
    this.tint = new Float32Array(SEG_VERTS * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aAge',     new THREE.BufferAttribute(this.age, 1));
    geo.setAttribute('aTint',    new THREE.BufferAttribute(this.tint, 3));

    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aAge;
        attribute vec3  aTint;
        varying float vAge;
        varying vec3  vTint;
        void main() {
          vAge = aAge;
          vTint = aTint;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        varying float vAge;
        varying vec3  vTint;
        void main() {
          float a = pow(1.0 - vAge, 2.0);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vTint * a * 1.1, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.LineSegments(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.geo = geo;
    this.tintPalette = [
      [1.2, 0.6, 0.2],   // amber (primary)
      [0.5, 0.8, 1.3],   // blue
      [0.9, 0.5, 1.3],   // violet
      [0.5, 1.3, 0.8],   // teal
      [1.3, 0.4, 0.6],   // rose
      [1.0, 1.0, 0.8],   // pale
      [0.7, 0.9, 1.1],   // ice
      [1.3, 0.9, 0.5],   // warm
    ];
  }

  reset() {
    this.init.fill(0);
    this.head.fill(0);
    this.pos.fill(0);
    this.age.fill(1.0);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAge.needsUpdate = true;
  }

  setVisible(v) {
    this.mesh.visible = v;
    if (!v) this.reset();
  }

  update(bodies) {
    // push each body's current position into its ring
    for (let i = 0; i < Math.min(bodies.length, MAX_BODIES); i++) {
      const b = bodies[i];
      if (!this.init[i]) {
        // seed ring so we don't draw from origin
        const base = i * TRAIL_LEN * 3;
        for (let k = 0; k < TRAIL_LEN; k++) {
          this.ring[base + k * 3]     = b.pos.x;
          this.ring[base + k * 3 + 1] = b.pos.y;
          this.ring[base + k * 3 + 2] = b.pos.z;
        }
        this.init[i] = 1;
        this.head[i] = 0;
      } else {
        const h = (this.head[i] + 1) % TRAIL_LEN;
        this.head[i] = h;
        const idx = i * TRAIL_LEN * 3 + h * 3;
        this.ring[idx]     = b.pos.x;
        this.ring[idx + 1] = b.pos.y;
        this.ring[idx + 2] = b.pos.z;
      }
    }

    // rebuild line segments
    for (let i = 0; i < MAX_BODIES; i++) {
      const alive = i < bodies.length;
      const head = this.head[i];
      const ringBase = i * TRAIL_LEN * 3;
      const segBase = i * SEG_PER * 2;
      const tint = this.tintPalette[i % this.tintPalette.length];

      for (let k = 0; k < SEG_PER; k++) {
        const ia = ((head - k) + TRAIL_LEN * 4) % TRAIL_LEN;
        const ib = ((head - k - 1) + TRAIL_LEN * 4) % TRAIL_LEN;
        const aBase = ringBase + ia * 3;
        const bBase = ringBase + ib * 3;
        const vIdx = (segBase + k * 2) * 3;
        const tIdx = segBase + k * 2;

        if (alive) {
          this.pos[vIdx]     = this.ring[aBase];
          this.pos[vIdx + 1] = this.ring[aBase + 1];
          this.pos[vIdx + 2] = this.ring[aBase + 2];
          this.pos[vIdx + 3] = this.ring[bBase];
          this.pos[vIdx + 4] = this.ring[bBase + 1];
          this.pos[vIdx + 5] = this.ring[bBase + 2];
          this.age[tIdx]     = k / SEG_PER;
          this.age[tIdx + 1] = (k + 1) / SEG_PER;
          this.tint[vIdx]     = tint[0];
          this.tint[vIdx + 1] = tint[1];
          this.tint[vIdx + 2] = tint[2];
          this.tint[vIdx + 3] = tint[0];
          this.tint[vIdx + 4] = tint[1];
          this.tint[vIdx + 5] = tint[2];
        } else {
          this.pos[vIdx] = this.pos[vIdx + 3] = 0;
          this.pos[vIdx + 1] = this.pos[vIdx + 4] = 0;
          this.pos[vIdx + 2] = this.pos[vIdx + 5] = 0;
          this.age[tIdx] = 1.0;
          this.age[tIdx + 1] = 1.0;
        }
      }
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAge.needsUpdate = true;
    this.geo.attributes.aTint.needsUpdate = true;
  }
}
