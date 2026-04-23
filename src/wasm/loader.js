// Load the compiled matter.wasm module and return its raw exports along with
// typed-array views that alias its linear memory. Callers (MatterStream) wire
// those views directly into Three.js BufferAttributes — zero per-frame copies.

import wasmUrl from './matter.wasm?url';

const envImports = {
  // AS inserts this on bounds/overflow/etc. With --noAssert (release) it's
  // unreachable in practice; we still provide a sensible impl for safety.
  abort(_msg, _file, line, column) {
    throw new Error(`wasm aborted at ${line}:${column}`);
  },
  // AS uses this to seed Math.random() at module init.
  seed() {
    return Date.now() * Math.random();
  },
};

export async function loadMatterWasm() {
  const response = await fetch(wasmUrl);
  const { instance } = await WebAssembly.instantiateStreaming(response, { env: envImports });
  const exports = instance.exports;
  const mem = exports.memory.buffer;

  const MAX       = exports.constMax();
  const TRAIL_LEN = exports.constTrailLen();
  const SEG_PER   = exports.constSegPer();
  const MAX_HOLES = exports.constMaxHoles();
  const SEG_VERTS = MAX * SEG_PER * 2;

  // Views into WASM linear memory. Safe to cache — we compiled with
  // initialMemory == maximumMemory so the buffer never detaches.
  return {
    exports,
    sizes: { MAX, TRAIL_LEN, SEG_PER, MAX_HOLES, SEG_VERTS },

    positions:  new Float32Array(mem, exports.ptrPositions(),  MAX * 3),
    velocities: new Float32Array(mem, exports.ptrVelocities(), MAX * 3),
    life:       new Float32Array(mem, exports.ptrLife(),       MAX),
    temp:       new Float32Array(mem, exports.ptrTemp(),       MAX),
    size:       new Float32Array(mem, exports.ptrSize(),       MAX),
    isStar:     new Uint8Array  (mem, exports.ptrIsStar(),     MAX),

    trailPos:  new Float32Array(mem, exports.ptrTrailPos(),  SEG_VERTS * 3),
    trailAge:  new Float32Array(mem, exports.ptrTrailAge(),  SEG_VERTS),
    trailTemp: new Float32Array(mem, exports.ptrTrailTemp(), SEG_VERTS),

    holes: new Float32Array(mem, exports.ptrHoles(), MAX_HOLES * 4),
  };
}
