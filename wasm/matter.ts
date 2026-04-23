// MatterStream physics + trail rebuild, AssemblyScript → WASM.
//
// Design: WASM owns all particle + trail storage. JS creates Float32Array
// views that alias the WASM linear memory (zero-copy), wires them to Three.js
// BufferAttributes, and each frame:
//   1. writes hole positions into `holes[]`
//   2. calls `update(dt, holeCount)`
//   3. drains `consumeImpacts()` / `consumeTdeFlash()` for audio/VFX
//   4. marks BufferAttributes `needsUpdate = true`

// Constants must match MatterStream.js.
const MAX: i32 = 6000;
const TRAIL_LEN: i32 = 10;
const SEG_PER: i32 = TRAIL_LEN - 1;
const MAX_HOLES: i32 = 8;

// Particle state.
const positions  = new Float32Array(MAX * 3);
const velocities = new Float32Array(MAX * 3);
const life       = new Float32Array(MAX);
const temp       = new Float32Array(MAX);
const sizeArr    = new Float32Array(MAX);
const isStar     = new Uint8Array(MAX);

// Trail ring buffer (per-particle circular buffer of recent positions).
const trailRing = new Float32Array(MAX * TRAIL_LEN * 3);
const trailHead = new Int32Array(MAX);

// Trail output (what the LineSegments geometry reads each frame).
const trailPos  = new Float32Array(MAX * SEG_PER * 2 * 3);
const trailAge  = new Float32Array(MAX * SEG_PER * 2);
const trailTemp = new Float32Array(MAX * SEG_PER * 2);

// Per-slot flag: 1 if the slot's output was drawn last frame. When a slot
// transitions alive→dead we clear its output once and flip this to 0, then
// the rebuild loop can skip it entirely on subsequent frames until it's
// alloc'd again. Matters because MAX=6000 but only a few hundred particles
// are alive at any moment.
const drawnLast = new Uint8Array(MAX);

// Default trailAge to 1.0 so the shader fully discards slots we never touch
// (alpha = pow(1-age, 2) = 0 at age=1). Without this, never-allocated slots
// would render a visible degenerate segment at world origin.
trailAge.fill(<f32>1.0);

// Hole data packed as (x, y, z, rs) × up to MAX_HOLES. JS writes before update().
const holes = new Float32Array(MAX_HOLES * 4);

// Ring-buffer slot cursor + per-frame event counters (drained by JS).
let cursor: i32 = 0;
let impactCount: i32 = 0;
let tdeFlashPending: i32 = 0;

// ---- Pointer accessors -----------------------------------------------------
// JS uses these to build `new Float32Array(wasm.memory.buffer, ptr, len)` views.

export function ptrPositions():  usize { return positions.dataStart; }
export function ptrVelocities(): usize { return velocities.dataStart; }
export function ptrLife():       usize { return life.dataStart; }
export function ptrTemp():       usize { return temp.dataStart; }
export function ptrSize():       usize { return sizeArr.dataStart; }
export function ptrIsStar():     usize { return isStar.dataStart; }
export function ptrTrailRing():  usize { return trailRing.dataStart; }
export function ptrTrailHead():  usize { return trailHead.dataStart; }
export function ptrTrailPos():   usize { return trailPos.dataStart; }
export function ptrTrailAge():   usize { return trailAge.dataStart; }
export function ptrTrailTemp():  usize { return trailTemp.dataStart; }
export function ptrHoles():      usize { return holes.dataStart; }

export function constMax():       i32 { return MAX; }
export function constTrailLen():  i32 { return TRAIL_LEN; }
export function constSegPer():    i32 { return SEG_PER; }
export function constMaxHoles():  i32 { return MAX_HOLES; }

// ---- Allocation ------------------------------------------------------------

export function alloc(): i32 {
  const i = cursor;
  cursor = (cursor + 1) % MAX;
  // clear the slot's ring so a recycled slot doesn't drag a stale tail.
  const base = i * TRAIL_LEN * 3;
  const end = base + TRAIL_LEN * 3;
  for (let k: i32 = base; k < end; k++) unchecked(trailRing[k] = 0);
  unchecked(trailHead[i] = 0);
  unchecked(isStar[i] = 0);
  return i;
}

// Seed the ring from the particle's current position so the first rendered
// frame doesn't show a trail stretching from origin.
export function seedRing(i: i32): void {
  const base = i * TRAIL_LEN * 3;
  const i3 = i * 3;
  const px = unchecked(positions[i3]);
  const py = unchecked(positions[i3 + 1]);
  const pz = unchecked(positions[i3 + 2]);
  for (let k: i32 = 0; k < TRAIL_LEN; k++) {
    const kb = base + k * 3;
    unchecked(trailRing[kb]     = px);
    unchecked(trailRing[kb + 1] = py);
    unchecked(trailRing[kb + 2] = pz);
  }
}

export function getCursor(): i32 { return cursor; }
export function setCursor(c: i32): void { cursor = c % MAX; }
export function markStar(i: i32): void { unchecked(isStar[i] = 1); }

export function consumeImpacts():  i32 { const n = impactCount;     impactCount     = 0; return n; }
export function consumeTdeFlash(): i32 { const f = tdeFlashPending; tdeFlashPending = 0; return f; }

// Convenience for JS reset paths.
export function killAll(): void {
  for (let i: i32 = 0; i < MAX; i++) unchecked(life[i] = 0);
}

// ---- Physics ---------------------------------------------------------------

@inline
function spaghettify(starIdx: i32, cx: f32, cy: f32, cz: f32): void {
  const s3 = starIdx * 3;
  const sx = unchecked(positions[s3]);
  const sy = unchecked(positions[s3 + 1]);
  const sz = unchecked(positions[s3 + 2]);
  const svx = unchecked(velocities[s3]);
  const svy = unchecked(velocities[s3 + 1]);
  const svz = unchecked(velocities[s3 + 2]);

  let rx: f32 = sx - cx;
  let ry: f32 = sy - cy;
  let rz: f32 = sz - cz;
  const rlen = Mathf.sqrt(rx * rx + ry * ry + rz * rz);
  const inv: f32 = rlen > 0 ? <f32>1.0 / rlen : <f32>1.0;
  rx *= inv; ry *= inv; rz *= inv;

  unchecked(life[starIdx]   = 0);
  unchecked(isStar[starIdx] = 0);

  const N: i32 = 120;
  const invNm1: f32 = <f32>1.0 / <f32>(N - 1);
  for (let n: i32 = 0; n < N; n++) {
    const i = alloc();
    const t: f32 = <f32>n * invNm1 - <f32>0.5;
    const stretch: f32 = <f32>3.5 + <f32>Math.random() * <f32>1.2;
    const dx: f32 = rx * t * stretch;
    const dy: f32 = ry * t * stretch;
    const dz: f32 = rz * t * stretch;

    const jx: f32 = (<f32>Math.random() - <f32>0.5) * <f32>0.35;
    const jy: f32 = (<f32>Math.random() - <f32>0.5) * <f32>0.35;
    const jz: f32 = (<f32>Math.random() - <f32>0.5) * <f32>0.35;

    const i3 = i * 3;
    unchecked(positions[i3]     = sx + dx + jx);
    unchecked(positions[i3 + 1] = sy + dy + jy);
    unchecked(positions[i3 + 2] = sz + dz + jz);

    const vShift: f32 = -t * <f32>2.4;
    unchecked(velocities[i3]     = svx + rx * vShift + (<f32>Math.random() - <f32>0.5) * <f32>0.6);
    unchecked(velocities[i3 + 1] = svy + ry * vShift + (<f32>Math.random() - <f32>0.5) * <f32>0.6);
    unchecked(velocities[i3 + 2] = svz + rz * vShift + (<f32>Math.random() - <f32>0.5) * <f32>0.6);

    unchecked(life[i]    = 1.0);
    unchecked(temp[i]    = <f32>0.5 + <f32>Math.random() * <f32>0.35);
    unchecked(sizeArr[i] = <f32>2.8 + <f32>Math.random() * <f32>2.5);
    seedRing(i);
  }

  tdeFlashPending = 1;
}

export function update(dt: f32, holeCount: i32): void {
  let dt2: f32 = dt;
  if (dt2 > <f32>0.04) dt2 = <f32>0.04;
  if (holeCount > MAX_HOLES) holeCount = MAX_HOLES;

  const primaryX  = unchecked(holes[0]);
  const primaryY  = unchecked(holes[1]);
  const primaryZ  = unchecked(holes[2]);
  const primaryRs = unchecked(holes[3]);
  const primaryTdeR = primaryRs * <f32>3.0;
  const primaryTdeR2 = primaryTdeR * primaryTdeR;

  for (let i: i32 = 0; i < MAX; i++) {
    if (unchecked(life[i]) <= <f32>0.0) continue;

    const i3 = i * 3;
    const px = unchecked(positions[i3]);
    const py = unchecked(positions[i3 + 1]);
    const pz = unchecked(positions[i3 + 2]);
    let vx = unchecked(velocities[i3]);
    let vy = unchecked(velocities[i3 + 1]);
    let vz = unchecked(velocities[i3 + 2]);

    let tempRaise: f32 = 0.0;
    let captured: bool = false;

    for (let h: i32 = 0; h < holeCount; h++) {
      const hb = h * 4;
      const hx = unchecked(holes[hb]);
      const hy = unchecked(holes[hb + 1]);
      const hz = unchecked(holes[hb + 2]);
      const rs = unchecked(holes[hb + 3]);
      const dx: f32 = hx - px;
      const dy: f32 = hy - py;
      const dz: f32 = hz - pz;
      const r2: f32 = dx * dx + dy * dy + dz * dz;
      const r: f32 = Mathf.sqrt(r2);
      if (r < rs * <f32>1.1) {
        captured = true;
        impactCount++;
        break;
      }
      const M: f32 = rs * rs * <f32>3.0;
      const invR3: f32 = <f32>1.0 / (r2 * r + <f32>1e-3);
      const f: f32 = M * invR3;
      vx += dx * f * dt2;
      vy += dy * f * dt2;
      vz += dz * f * dt2;
      const tr: f32 = rs * <f32>4.0 - r;
      if (tr > <f32>0.0) tempRaise += tr * <f32>0.04;
    }

    if (captured) { unchecked(life[i] = 0); continue; }

    const npx: f32 = px + vx * dt2;
    const npy: f32 = py + vy * dt2;
    const npz: f32 = pz + vz * dt2;
    unchecked(positions[i3]     = npx);
    unchecked(positions[i3 + 1] = npy);
    unchecked(positions[i3 + 2] = npz);
    unchecked(velocities[i3]     = vx);
    unchecked(velocities[i3 + 1] = vy);
    unchecked(velocities[i3 + 2] = vz);

    let t: f32 = unchecked(temp[i]) + tempRaise * dt2;
    if (t > <f32>1.0) t = <f32>1.0;
    unchecked(temp[i] = t);

    // Tidal disruption (stars only). Fires when a star enters 3·rs of primary.
    if (unchecked(isStar[i]) != 0) {
      const dxp: f32 = primaryX - npx;
      const dyp: f32 = primaryY - npy;
      const dzp: f32 = primaryZ - npz;
      const d2: f32 = dxp * dxp + dyp * dyp + dzp * dzp;
      if (d2 < primaryTdeR2) {
        spaghettify(i, primaryX, primaryY, primaryZ);
        continue;
      }
    }

    // Bounds + slow life decay.
    const origD2: f32 = npx * npx + npy * npy + npz * npz;
    if (origD2 > <f32>(140.0 * 140.0)) {
      unchecked(life[i] = 0);
    } else {
      let l: f32 = unchecked(life[i]) - dt2 * <f32>0.02;
      if (l < <f32>0.0) l = 0;
      unchecked(life[i] = l);
    }
  }

  advanceTrails();
}

@inline
function advanceTrails(): void {
  // Push latest position into each alive particle's ring.
  for (let i: i32 = 0; i < MAX; i++) {
    if (unchecked(life[i]) <= <f32>0.0) continue;
    const h = (unchecked(trailHead[i]) + 1) % TRAIL_LEN;
    unchecked(trailHead[i] = h);
    const b = i * TRAIL_LEN * 3 + h * 3;
    const i3 = i * 3;
    unchecked(trailRing[b]     = unchecked(positions[i3]));
    unchecked(trailRing[b + 1] = unchecked(positions[i3 + 1]));
    unchecked(trailRing[b + 2] = unchecked(positions[i3 + 2]));
  }

  // Rebuild LineSegments vertex data: each segment k pairs ring[head-k] with
  // ring[head-k-1]. A slot that's been dead for >1 frame needs no work —
  // its output is already all zeros from the transition frame.
  const invSegPer: f32 = <f32>1.0 / <f32>SEG_PER;
  for (let i: i32 = 0; i < MAX; i++) {
    const alive: bool = unchecked(life[i]) > <f32>0.0;
    const wasDrawn: bool = unchecked(drawnLast[i]) != 0;
    if (!alive && !wasDrawn) continue;  // stayed dead — skip entirely

    const head = unchecked(trailHead[i]);
    const ringBase = i * TRAIL_LEN * 3;
    const segBase = i * SEG_PER * 2;
    const curTemp = unchecked(temp[i]);

    for (let k: i32 = 0; k < SEG_PER; k++) {
      const ia = ((head - k) + TRAIL_LEN * 4) % TRAIL_LEN;
      const ib = ((head - k - 1) + TRAIL_LEN * 4) % TRAIL_LEN;
      const aBase = ringBase + ia * 3;
      const bBase = ringBase + ib * 3;
      const vIdx = (segBase + k * 2) * 3;
      const tIdx = segBase + k * 2;

      if (alive) {
        unchecked(trailPos[vIdx]     = unchecked(trailRing[aBase]));
        unchecked(trailPos[vIdx + 1] = unchecked(trailRing[aBase + 1]));
        unchecked(trailPos[vIdx + 2] = unchecked(trailRing[aBase + 2]));
        unchecked(trailPos[vIdx + 3] = unchecked(trailRing[bBase]));
        unchecked(trailPos[vIdx + 4] = unchecked(trailRing[bBase + 1]));
        unchecked(trailPos[vIdx + 5] = unchecked(trailRing[bBase + 2]));
        unchecked(trailAge[tIdx]     = <f32>k * invSegPer);
        unchecked(trailAge[tIdx + 1] = <f32>(k + 1) * invSegPer);
        unchecked(trailTemp[tIdx]     = curTemp);
        unchecked(trailTemp[tIdx + 1] = curTemp);
      } else {
        unchecked(trailPos[vIdx]     = 0);
        unchecked(trailPos[vIdx + 1] = 0);
        unchecked(trailPos[vIdx + 2] = 0);
        unchecked(trailPos[vIdx + 3] = 0);
        unchecked(trailPos[vIdx + 4] = 0);
        unchecked(trailPos[vIdx + 5] = 0);
        unchecked(trailAge[tIdx]     = <f32>1.0);
        unchecked(trailAge[tIdx + 1] = <f32>1.0);
        unchecked(trailTemp[tIdx]     = 0);
        unchecked(trailTemp[tIdx + 1] = 0);
      }
    }
    unchecked(drawnLast[i] = alive ? 1 : 0);
  }
}
