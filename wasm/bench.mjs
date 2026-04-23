// Benchmark: 6000 particles × 4 holes, 600 frames each.
//   (A) WASM build  — wasm/matter.ts compiled
//   (B) JS baseline — a line-for-line port of MatterStream.update that ran
//       before the WASM rewrite (mirrors the original semantics)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(here, '../src/wasm/matter.wasm'));
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  env: {
    abort(_m,_f,l,c){ throw new Error(`abort ${l}:${c}`); },
    seed(){ return Date.now() * Math.random(); },
  },
});
const ex = instance.exports;
const mem = ex.memory.buffer;
const MAX       = ex.constMax();
const TRAIL_LEN = ex.constTrailLen();
const SEG_PER   = ex.constSegPer();
const MAX_HOLES = ex.constMaxHoles();

const wasmPositions  = new Float32Array(mem, ex.ptrPositions(),  MAX * 3);
const wasmVelocities = new Float32Array(mem, ex.ptrVelocities(), MAX * 3);
const wasmLife       = new Float32Array(mem, ex.ptrLife(),       MAX);
const wasmTemp       = new Float32Array(mem, ex.ptrTemp(),       MAX);
const wasmSize       = new Float32Array(mem, ex.ptrSize(),       MAX);
const wasmHoles      = new Float32Array(mem, ex.ptrHoles(),      MAX_HOLES * 4);

// --- seed the WASM-side sim ---
function seedWasm(PARTICLES) {
  ex.setCursor(0);
  for (let i = 0; i < MAX; i++) wasmLife[i] = 0;  // clear all
  for (let n = 0; n < PARTICLES; n++) {
    const i = ex.alloc();
    const a  = Math.random() * Math.PI * 2;
    const r  = 15 + Math.random() * 20;
    wasmPositions[i*3]   = Math.cos(a) * r;
    wasmPositions[i*3+1] = (Math.random() - 0.5) * 4;
    wasmPositions[i*3+2] = Math.sin(a) * r;
    wasmVelocities[i*3]   = -Math.sin(a) * (1 + Math.random());
    wasmVelocities[i*3+1] = 0;
    wasmVelocities[i*3+2] =  Math.cos(a) * (1 + Math.random());
    wasmLife[i] = 1.0;
    wasmTemp[i] = 0.1;
    wasmSize[i] = 2.5;
    ex.seedRing(i);
  }
  // 4 holes (primary + 3 extras)
  const hp = [[0,0,0,1.0],[14,0,0,0.6],[-10,0,8,0.55],[6,0,-12,0.5]];
  for (let h = 0; h < 4; h++) {
    wasmHoles[h*4]   = hp[h][0];
    wasmHoles[h*4+1] = hp[h][1];
    wasmHoles[h*4+2] = hp[h][2];
    wasmHoles[h*4+3] = hp[h][3];
  }
}

// --- JS reference, mirrors MatterStream.js from before this change ---
function makeJsSim() {
  const positions  = new Float32Array(MAX * 3);
  const velocities = new Float32Array(MAX * 3);
  const life       = new Float32Array(MAX);
  const temp       = new Float32Array(MAX);
  const sizeArr    = new Float32Array(MAX);
  const isStar     = new Uint8Array(MAX);
  const trailRing  = new Float32Array(MAX * TRAIL_LEN * 3);
  const trailHead  = new Int32Array(MAX);
  const trailPos   = new Float32Array(MAX * SEG_PER * 2 * 3);
  const trailAge   = new Float32Array(MAX * SEG_PER * 2);
  const trailTemp  = new Float32Array(MAX * SEG_PER * 2);
  let cursor = 0;

  function alloc() {
    const i = cursor;
    cursor = (cursor + 1) % MAX;
    const base = i * TRAIL_LEN * 3;
    for (let k = 0; k < TRAIL_LEN * 3; k++) trailRing[base + k] = 0;
    trailHead[i] = 0;
    isStar[i] = 0;
    return i;
  }
  function seedRing(i) {
    const base = i * TRAIL_LEN * 3;
    const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
    for (let k = 0; k < TRAIL_LEN; k++) {
      trailRing[base + k*3]     = px;
      trailRing[base + k*3 + 1] = py;
      trailRing[base + k*3 + 2] = pz;
    }
  }

  function update(dt, holes) {
    const dt2 = Math.min(dt, 0.04);
    const G = 1.0;
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) continue;
      const px = positions[i*3], py = positions[i*3+1], pz = positions[i*3+2];
      let vx = velocities[i*3], vy = velocities[i*3+1], vz = velocities[i*3+2];
      let tempRaise = 0, captured = false;
      for (let h = 0; h < holes.length; h++) {
        const H = holes[h];
        const dx = H.x - px, dy = H.y - py, dz = H.z - pz;
        const r2 = dx*dx + dy*dy + dz*dz;
        const r = Math.sqrt(r2);
        if (r < H.rs * 1.1) { captured = true; break; }
        const M = H.rs * H.rs * 3.0;
        const invR3 = 1 / (r2 * r + 1e-3);
        const f = G * M * invR3;
        vx += dx * f * dt2;
        vy += dy * f * dt2;
        vz += dz * f * dt2;
        tempRaise += Math.max(0, H.rs * 4.0 - r) * 0.04;
      }
      if (captured) { life[i] = 0; continue; }
      positions[i*3]   = px + vx * dt2;
      positions[i*3+1] = py + vy * dt2;
      positions[i*3+2] = pz + vz * dt2;
      velocities[i*3]   = vx;
      velocities[i*3+1] = vy;
      velocities[i*3+2] = vz;
      temp[i] = Math.min(1.0, temp[i] + tempRaise * dt2);
      const dist = Math.hypot(positions[i*3], positions[i*3+1], positions[i*3+2]);
      if (dist > 140.0) life[i] = 0;
      life[i] -= dt2 * 0.02;
      if (life[i] < 0) life[i] = 0;
    }
    // advance rings
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) continue;
      const head = (trailHead[i] + 1) % TRAIL_LEN;
      trailHead[i] = head;
      const b = i * TRAIL_LEN * 3 + head * 3;
      trailRing[b]   = positions[i*3];
      trailRing[b+1] = positions[i*3+1];
      trailRing[b+2] = positions[i*3+2];
    }
    // rebuild segments
    for (let i = 0; i < MAX; i++) {
      const alive = life[i] > 0;
      const head  = trailHead[i];
      const ringBase = i * TRAIL_LEN * 3;
      const segBase  = i * SEG_PER * 2;
      for (let k = 0; k < SEG_PER; k++) {
        const ia = ((head - k) + TRAIL_LEN * 4) % TRAIL_LEN;
        const ib = ((head - k - 1) + TRAIL_LEN * 4) % TRAIL_LEN;
        const aBase = ringBase + ia * 3;
        const bBase = ringBase + ib * 3;
        const vIdx = (segBase + k * 2) * 3;
        if (alive) {
          trailPos[vIdx]   = trailRing[aBase];
          trailPos[vIdx+1] = trailRing[aBase+1];
          trailPos[vIdx+2] = trailRing[aBase+2];
          trailPos[vIdx+3] = trailRing[bBase];
          trailPos[vIdx+4] = trailRing[bBase+1];
          trailPos[vIdx+5] = trailRing[bBase+2];
          const ageA = k / SEG_PER;
          const ageB = (k + 1) / SEG_PER;
          trailAge[segBase + k*2]     = ageA;
          trailAge[segBase + k*2 + 1] = ageB;
          trailTemp[segBase + k*2]     = temp[i];
          trailTemp[segBase + k*2 + 1] = temp[i];
        } else {
          trailPos[vIdx] = trailPos[vIdx+3] = 0;
          trailPos[vIdx+1] = trailPos[vIdx+4] = 0;
          trailPos[vIdx+2] = trailPos[vIdx+5] = 0;
          trailAge[segBase + k*2] = 1.0;
          trailAge[segBase + k*2 + 1] = 1.0;
          trailTemp[segBase + k*2] = 0;
          trailTemp[segBase + k*2 + 1] = 0;
        }
      }
    }
  }

  return { positions, velocities, life, temp, sizeArr, isStar, alloc, seedRing, update };
}

function seedJs(js, PARTICLES) {
  for (let n = 0; n < PARTICLES; n++) {
    const i = js.alloc();
    const a = Math.random() * Math.PI * 2;
    const r = 15 + Math.random() * 20;
    js.positions[i*3]   = Math.cos(a) * r;
    js.positions[i*3+1] = (Math.random() - 0.5) * 4;
    js.positions[i*3+2] = Math.sin(a) * r;
    js.velocities[i*3]   = -Math.sin(a) * (1 + Math.random());
    js.velocities[i*3+1] = 0;
    js.velocities[i*3+2] =  Math.cos(a) * (1 + Math.random());
    js.life[i] = 1.0;
    js.temp[i] = 0.1;
    js.sizeArr[i] = 2.5;
    js.seedRing(i);
  }
}

function bench(name, steps, fn) {
  // warm up
  for (let i = 0; i < 30; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < steps; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log(`${name}: ${ms.toFixed(1)} ms total, ${(ms/steps).toFixed(3)} ms/frame`);
  return ms;
}

const FRAMES = 300;
const dt = 1/60;
const jsHoles = [
  { x:0,y:0,z:0,rs:1.0 },
  { x:14,y:0,z:0,rs:0.6 },
  { x:-10,y:0,z:8,rs:0.55 },
  { x:6,y:0,z:-12,rs:0.5 },
];

function run(label, particles) {
  seedWasm(particles);
  const wasmMs = bench(`  wasm`, FRAMES, () => { ex.update(dt, 4); });
  const js = makeJsSim();
  seedJs(js, particles);
  const jsMs = bench(`  js  `, FRAMES, () => { js.update(dt, jsHoles); });
  console.log(`  ${label}: ${(jsMs/wasmMs).toFixed(2)}x speedup\n`);
}

console.log('## workload: 300 alive particles (typical mid-sim)');
run('300-alive', 300);
console.log('## workload: 1500 alive particles (after a few clicks)');
run('1500-alive', 1500);
console.log('## workload: 6000 alive particles (stress / all slots busy)');
run('6000-alive', 6000);
