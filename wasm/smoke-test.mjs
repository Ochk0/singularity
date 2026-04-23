// Node smoke test: instantiate matter.wasm, spawn some particles + a star,
// step the simulation a bit, and print invariants.  This is a sanity check that
// the WASM module exports match what MatterStream.js expects.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(here, '../src/wasm/matter.wasm'));

const envImports = {
  abort(_msg, _file, line, column) { throw new Error(`abort ${line}:${column}`); },
  seed()  { return Date.now() * Math.random(); },
};
const { instance } = await WebAssembly.instantiate(wasmBytes, { env: envImports });
const ex = instance.exports;
const mem = ex.memory.buffer;

const MAX       = ex.constMax();
const TRAIL_LEN = ex.constTrailLen();
const SEG_PER   = ex.constSegPer();
const MAX_HOLES = ex.constMaxHoles();

console.log('constants:', { MAX, TRAIL_LEN, SEG_PER, MAX_HOLES });

const positions  = new Float32Array(mem, ex.ptrPositions(),  MAX * 3);
const velocities = new Float32Array(mem, ex.ptrVelocities(), MAX * 3);
const life       = new Float32Array(mem, ex.ptrLife(),       MAX);
const temp       = new Float32Array(mem, ex.ptrTemp(),       MAX);
const size       = new Float32Array(mem, ex.ptrSize(),       MAX);
const isStar     = new Uint8Array  (mem, ex.ptrIsStar(),     MAX);
const holes      = new Float32Array(mem, ex.ptrHoles(),      MAX_HOLES * 4);
const trailPos   = new Float32Array(mem, ex.ptrTrailPos(),   MAX * SEG_PER * 2 * 3);

// ---- spawn 500 matter particles into a single direction ----
for (let n = 0; n < 500; n++) {
  const i = ex.alloc();
  positions[i*3]   = -20 + Math.random() * 2;
  positions[i*3+1] = (Math.random() - 0.5) * 2;
  positions[i*3+2] = (Math.random() - 0.5) * 2;
  velocities[i*3]   = 4 + Math.random();
  velocities[i*3+1] = 0;
  velocities[i*3+2] = 0;
  life[i] = 1.0;
  temp[i] = 0.1;
  size[i] = 2.5;
  ex.seedRing(i);
}

// ---- spawn one star aimed at the primary ----
const starIdx = ex.alloc();
positions[starIdx*3]   = -18;
positions[starIdx*3+1] = 0;
positions[starIdx*3+2] = 0;
velocities[starIdx*3]   = 4.0;
velocities[starIdx*3+1] = 0;
velocities[starIdx*3+2] = 0;
life[starIdx] = 1.0;
temp[starIdx] = 0.3;
size[starIdx] = 22;
ex.markStar(starIdx);
ex.seedRing(starIdx);

// Place primary at origin, rs=1.0.
holes[0] = 0; holes[1] = 0; holes[2] = 0; holes[3] = 1.0;

let totalImpacts = 0;
let totalTde = 0;

const dt = 1 / 60;
const frames = 600;  // 10 seconds of sim
const t0 = process.hrtime.bigint();

for (let f = 0; f < frames; f++) {
  ex.update(dt, 1);
  totalImpacts += ex.consumeImpacts();
  totalTde     += ex.consumeTdeFlash();
}

const t1 = process.hrtime.bigint();
const ms = Number(t1 - t0) / 1e6;

// Count alive particles
let alive = 0;
for (let i = 0; i < MAX; i++) if (life[i] > 0) alive++;

console.log(`ran ${frames} frames in ${ms.toFixed(2)} ms (${(ms/frames).toFixed(3)} ms/frame)`);
console.log(`alive=${alive}  impacts=${totalImpacts}  tdeFlashes=${totalTde}`);

// Inspect a few trail segments to make sure they're non-zero for live particles.
const live = [];
for (let i = 0; i < MAX && live.length < 3; i++) if (life[i] > 0) live.push(i);
for (const i of live) {
  const segBase = i * SEG_PER * 2 * 3;
  const firstA = trailPos.subarray(segBase, segBase + 3);
  console.log(`  trail[${i}] seg0 A = ${Array.from(firstA).map(v => v.toFixed(2)).join(', ')}`);
}

if (totalImpacts === 0 && totalTde === 0) {
  console.error('FAIL: no captures or disruptions fired in 10s of sim');
  process.exit(1);
}
console.log('OK');
