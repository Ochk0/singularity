precision highp float;

// ---- uniforms ----
uniform vec2  uResolution;
uniform float uTime;
uniform mat4  uCameraWorld;
uniform mat4  uCameraProjInv;
uniform vec3  uCameraPos;

uniform float uMass;            // Schwarzschild radius of primary (r_s)
uniform vec3  uPrimaryPos;
uniform int   uChaosMode;
uniform float uSpin;
uniform float uDiskDensity;
uniform float uDiskTemp;
uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uJetStrength;

uniform int   uExtraCount;
uniform vec4  uExtras[3];

uniform vec3  uRipplePos;
uniform float uRippleAge;
uniform float uRippleStrength;

uniform float uTdeFlash;

uniform samplerCube uSkyBox;

varying vec2 vUv;

const float PI       = 3.14159265359;
const float EPS      = 1e-5;
const float R_ISCO   = 3.0;   // ISCO = 3·r_s for a non-spinning Schwarzschild BH
const float R_PHOTON = 1.5;   // photon sphere at 1.5·r_s

// ---- tiny fbm for jet helical density ----
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0));
  float n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1));
  float n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1));
  float n111 = hash13(i + vec3(1,1,1));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise3(p); p *= 2.07; a *= 0.5; }
  return s;
}

// ---------- sky (cubemap lookup) ----------
vec3 sampleSky(vec3 dir) {
  return textureCube(uSkyBox, dir).rgb;
}

// ---------- Schwarzschild null geodesic acceleration ----------
// For a photon at position `pos`, unit direction `dir`, in the field of a
// single Schwarzschild mass at `center` with horizon radius `rs`, the correct
// GR acceleration (leading order beyond flat space) is:
//
//   a = -1.5 · r_s · h² / r⁵ · r⃗
//
// where r⃗ = pos - center, r = |r⃗|, and h⃗ = r⃗ × dir is the photon angular
// momentum per unit speed. This reproduces the full Einstein deflection
// 4GM/(c²b) = 2 r_s / b — exactly double what a Newtonian 1/r² pull gives —
// and makes the photon sphere emerge at r = 1.5 r_s.
vec3 geodAccel1(vec3 pos, vec3 dir, vec3 center, float rs) {
  vec3 rel = pos - center;
  float r2 = dot(rel, rel);
  if (r2 < EPS) return vec3(0.0);
  float r = sqrt(r2);
  vec3 hvec = cross(rel, dir);
  float h2  = dot(hvec, hvec);
  float inv_r5 = 1.0 / (r2 * r2 * r);
  return -1.5 * rs * h2 * inv_r5 * rel;
}

// Sum of geodesic accelerations from primary + all extras. Linear
// superposition is strictly a weak-field approximation but matches the spirit
// of multi-BH sandboxes — near a single hole its contribution dominates.
vec3 geodAccel(vec3 pos, vec3 dir) {
  vec3 a = geodAccel1(pos, dir, uPrimaryPos, uMass);
  if (uExtraCount > 0) a += geodAccel1(pos, dir, uExtras[0].xyz, uExtras[0].w);
  if (uExtraCount > 1) a += geodAccel1(pos, dir, uExtras[1].xyz, uExtras[1].w);
  if (uExtraCount > 2) a += geodAccel1(pos, dir, uExtras[2].xyz, uExtras[2].w);
  return a;
}

// ---------- accretion disk ----------
// Novikov–Thorne (Page–Thorne) thin-disk temperature:
//   T(r)⁴ ∝ (1 - sqrt(r_ISCO/r)) / r³
// zero at ISCO, peaks near r ≈ 4.08 r_s, falls off outward.
//
// Observed brightness = emission × (Doppler · gravitational_redshift)⁴
// with g = sqrt(1 - r_s/r). This gives the characteristic bright crescent on
// the approaching side of the disk and darkening down to zero at the horizon.
//
// Geometry: disk lies in the XZ plane with Y as its rotation axis, matching
// the Y-up world convention and the particle-physics presets (which place
// binaries at e.g. (14, 0, 0) with velocity (0, 0, 1.05)).
vec3 diskEmission(vec3 p, vec3 rayDir, float rs) {
  float r = length(p.xz);
  if (r > uDiskOuter * rs) return vec3(0.0);

  // Two-layer geometry: a thin optically-thick plane, plus a puffy corona
  // that extends ~5× higher with a soft falloff. The corona gives clear 3D
  // volume instead of the disk reading as a flat decal.
  float thinHalf   = 0.14 * rs + 0.035 * r;   // thicker plane
  float coronaHalf = thinHalf * 5.0;
  if (abs(p.y) > coronaHalf) return vec3(0.0);

  float r_n  = r / rs;
  // user can push inner radius out (but never inside ISCO)
  float r_in = max(uDiskInner, R_ISCO);
  if (r_n < r_in) return vec3(0.0);

  // Novikov-Thorne emitter temperature (relative units; *3.2 puts the
  // r ≈ 4.08 r_s peak near 0.7 — gives the disk headroom under bloom).
  float f  = max(1.0 - sqrt(r_in / r_n), 0.0);
  float T4 = f / (r_n * r_n * r_n);
  float T  = pow(max(T4, 0.0), 0.25) * 3.2;

  // Soft outer fade into the user-set outer radius.
  T *= smoothstep(uDiskOuter * rs, uDiskOuter * rs * 0.88, r);

  // Vertical envelope: bright thin-plane core + visibly luminous corona.
  float thinEnv   = 1.0 - clamp(abs(p.y) / max(thinHalf, EPS), 0.0, 1.0);
  float coronaEnv = pow(1.0 - clamp(abs(p.y) / coronaHalf, 0.0, 1.0), 1.3);
  float hf        = max(thinEnv, coronaEnv * 0.45);

  // MHD-turbulent density. Rotate the sample position by the local
  // Keplerian angular rate before sampling noise — features naturally
  // stretch into differentially-wound filaments without us having to
  // draw a spiral by hand. Three noise octaves stack: coarse structure,
  // mid-scale detail, and a fine grain that resolves on zoom-in.
  float omega = 1.0 / pow(max(r_n, 1.0), 1.5);            // Keplerian Ω ∝ r^-3/2
  float twist = uTime * 0.55 * omega;
  float cs = cos(twist), sn = sin(twist);
  vec3 twistedP = vec3(cs * p.x - sn * p.z, p.y, sn * p.x + cs * p.z);

  vec3 nIn1 = twistedP * (0.55 / rs);
  vec3 nIn2 = twistedP * (2.1  / rs) + vec3(0.0, 0.0, uTime * 0.25);
  vec3 nIn3 = twistedP * (6.5  / rs) + vec3(uTime * 0.45, 0.0, 0.0);
  float n1 = fbm3(nIn1);
  float n2 = fbm3(nIn2);
  float n3 = fbm3(nIn3);
  float n  = clamp(n1 * 0.70 + n2 * 0.40 + n3 * 0.22, 0.0, 1.0);
  n = pow(n, 1.5);                                         // sharpen contrast

  // Rare bright clumps (MRI-like hotspots), threshold-gated.
  float hotspot = smoothstep(0.62, 0.92, n2) * 0.7;

  // Density ranges roughly 0.1 (dark lanes) to ~2.3 (hot filaments) —
  // broad enough that bloom has something to bite onto instead of
  // smearing a uniform glow.
  float density = T * hf * uDiskDensity * (0.1 + n * 1.55 + hotspot);

  // Keplerian speed v_K = sqrt(M/r) = sqrt(r_s/(2r)), in units of c.
  // Tangent direction in the XZ plane (Y is the axis), capped at 0.7 c.
  vec2  rHat = p.xz / max(r, EPS);                  // (x_hat, z_hat)
  vec2  vTan = vec2(-rHat.y, rHat.x);               // 90° in the XZ plane
  float vK   = min(sqrt(0.5 / max(r_n, 1.0)), 0.7);
  vec3  velocity = vec3(vTan.x * vK, 0.0, vTan.y * vK);

  // β = v·(−rayDir): sign positive when fluid moves toward camera.
  float beta    = clamp(dot(velocity, -rayDir), -0.75, 0.75);
  float doppler = 1.0 / max(1.0 - beta, 0.05);            // special-rel factor
  float g       = sqrt(max(1.0 - 1.0 / r_n, 0.0));        // gravitational redshift

  // Observed flux: special-relativistic Doppler boost × gravitational
  // brightness attenuation. The strict bolometric expression is D⁴ with
  // D = doppler·g, but that overshoots visually under the bloom pass —
  // doppler^3.3 · g² reaches the correct "bright crescent, dark near horizon"
  // character at a more reasonable amplitude.
  float boost  = pow(doppler, 3.3) * g * g;
  float colorT = clamp(T * uDiskTemp * doppler * g, 0.0, 2.0);

  vec3 hot     = vec3(1.0,  0.95, 0.85);
  vec3 warm    = vec3(1.3,  0.7,  0.25);
  vec3 bluish  = vec3(0.75, 0.88, 1.45);   // blueshift tail (above colorT=1)
  vec3 deepRed = vec3(0.70, 0.20, 0.05);   // redshift destination on β<0
  vec3 col;
  if (colorT > 1.0) col = mix(hot, bluish, clamp(colorT - 1.0, 0.0, 1.0));
  else              col = mix(warm, hot, colorT);
  // Explicit redshift on the receding side: colorT already dimmed it via
  // Doppler, now deepen the hue toward dark red. (The approaching side
  // gets its blueshift through colorT > 1 above.)
  if (beta < 0.0) col = mix(col, deepRed, clamp(-beta * 1.3, 0.0, 0.6));

  col += vec3(1.8, 2.0, 2.6) * uTdeFlash * smoothstep(uDiskOuter * rs, r_in * rs, r);
  return col * density * boost * 1.1;
}

// ---------- polar jets ----------
vec3 jetAxis() {
  float tilt = uSpin * 0.18;
  return normalize(vec3(sin(tilt), cos(tilt), 0.0));
}

vec3 jetEmission(vec3 p, vec3 rayDir, float rs) {
  if (uJetStrength <= 0.01) return vec3(0.0);
  float lenScale = mix(20.0, 55.0, uSpin);
  float rTot = length(p);
  if (rTot > lenScale * rs * 2.0) return vec3(0.0);
  if (rTot < rs * 1.1) return vec3(0.0);

  vec3 axis = jetAxis();
  float along = dot(p, axis);
  vec3 radialVec = p - axis * along;
  float rPerp = length(radialVec);

  float coneK = mix(0.12, 0.035, uSpin);
  float coneR = coneK * abs(along) + rs * 0.35;
  if (rPerp > coneR * 2.0) return vec3(0.0);

  float cone = smoothstep(coneR * 2.0, 0.0, rPerp);
  if (cone * uJetStrength < 0.005) return vec3(0.0);

  float falloff = exp(-abs(along) / (lenScale * rs));
  float ang = atan(radialVec.y, max(abs(radialVec.x) + abs(radialVec.z), EPS))
            + sign(radialVec.z) * 1.5708;
  float h = fbm3(vec3(along * 0.2 / rs, ang * 1.2, uTime * 0.4));
  float density = cone * falloff * (0.55 + 0.9 * h) * uJetStrength;

  float lobeSign = sign(along);
  vec3 vBulk = axis * lobeSign * 0.9;
  float beta = dot(vBulk, -rayDir);
  beta = clamp(beta, -0.85, 0.85);
  float doppler = 1.0 / max(1.0 - beta, 0.05);
  float boost = pow(doppler, 2.0);

  float t = clamp(abs(along) / (lenScale * rs), 0.0, 1.0);
  vec3 core = mix(vec3(1.2, 0.9, 0.7), vec3(0.7, 1.2, 1.6), t);
  vec3 halo = vec3(0.45, 0.2, 0.7);
  vec3 col = mix(halo, core, cone);
  return col * density * boost * 1.1;
}

// ---------- ray march ----------
struct Hit {
  bool  captured;
  vec3  endDir;
  vec3  accum;
  float minR;
};

bool isFinite3(vec3 v) { return v.x == v.x && v.y == v.y && v.z == v.z; }

// Integrate the null geodesic with velocity-Verlet (2nd-order, symplectic):
//   a₁ = accel(x,  v)
//   v½ = normalize(v + ½ ds · a₁)
//   x' = x + ds · v½
//   a₂ = accel(x', v½)
//   v' = normalize(v½ + ½ ds · a₂)
// Adaptive step ds scales with the distance to the NEAREST horizon, so zooms
// into the photon sphere get dense sampling while distant sky rays stride fast.
Hit marchRay(vec3 origin, vec3 dir) {
  Hit h;
  h.captured = false;
  h.endDir   = dir;
  h.accum    = vec3(0.0);
  h.minR     = 1e9;

  vec3 pos = origin;
  const int STEPS = 220;
  int crossings = 0;
  const int MAX_CROSSINGS = 3;
  float farThresh = uDiskOuter * uMass * 1.8;
  bool chaos = uChaosMode > 0;

  for (int i = 0; i < STEPS; i++) {
    vec3 rel = pos - uPrimaryPos;
    float rPrim = length(rel);
    if (rPrim < h.minR) h.minR = rPrim;

    // --- adaptive step: shrink near ANY horizon, stride in open space ---
    float rmin = rPrim;
    float rsMin = uMass;
    if (uExtraCount > 0) { rmin = min(rmin, length(pos - uExtras[0].xyz)); rsMin = min(rsMin, uExtras[0].w); }
    if (uExtraCount > 1) { rmin = min(rmin, length(pos - uExtras[1].xyz)); rsMin = min(rsMin, uExtras[1].w); }
    if (uExtraCount > 2) { rmin = min(rmin, length(pos - uExtras[2].xyz)); rsMin = min(rsMin, uExtras[2].w); }
    float ds = clamp(0.06 * rmin, 0.025 * rsMin, 1.2);

    // --- velocity-Verlet integration of the null geodesic ---
    vec3 a1      = geodAccel(pos, dir);
    vec3 dirHalf = normalize(dir + 0.5 * ds * a1);
    vec3 posNew  = pos + ds * dirHalf;
    vec3 a2      = geodAccel(posNew, dirHalf);
    vec3 dirNew  = normalize(dirHalf + 0.5 * ds * a2);

    vec3 prevRel = rel;
    pos = posNew;
    dir = dirNew;

    if (!isFinite3(pos) || !isFinite3(dir)) { h.captured = true; break; }

    // horizon captures (1.02 r_s gives a small numerical margin above r_s)
    if (length(pos - uPrimaryPos) < uMass * 1.02) { h.captured = true; break; }
    if (uExtraCount > 0 && length(pos - uExtras[0].xyz) < uExtras[0].w * 1.02) { h.captured = true; break; }
    if (uExtraCount > 1 && length(pos - uExtras[1].xyz) < uExtras[1].w * 1.02) { h.captured = true; break; }
    if (uExtraCount > 2 && length(pos - uExtras[2].xyz) < uExtras[2].w * 1.02) { h.captured = true; break; }

    // Disk/jet only in non-chaos mode (they make no sense around a flying primary).
    if (!chaos) {
      vec3 newRel = pos - uPrimaryPos;
      // Disk lives in the XZ plane; Y is the rotation axis. Detect disk
      // crossing by sign-flip of y and re-sample emission at the midpoint.
      if (crossings < MAX_CROSSINGS &&
          sign(prevRel.y) != sign(newRel.y) &&
          abs(newRel.y) < 0.6 * uMass + length(newRel.xz) * 0.08) {
        float denom = max(abs(prevRel.y) + abs(newRel.y), EPS);
        vec3 mid = mix(prevRel, newRel, abs(prevRel.y) / denom);
        // Optical depth: each crossing attenuates later ones more heavily,
        // so the front of the disk occludes its own back side instead of
        // letting the two sum additively through a ghostly translucent sheet.
        float atten = pow(0.32, float(crossings));
        h.accum += diskEmission(mid, dir, uMass) * atten;
        crossings++;
      } else {
        // Per-step volumetric sampling of the thick corona region. Higher
        // weight than before so the corona actually contributes visibly.
        h.accum += diskEmission(newRel, dir, uMass) * 0.18 * ds * pow(0.5, float(crossings));
      }
    }

    if (rPrim > farThresh && dot(dir, rel) > 0.995 * rPrim) break;
    if (rPrim > 180.0) break;
  }
  h.endDir = dir;
  return h;
}

// ---------- main ----------
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 clip = vec4(ndc, -1.0, 1.0);
  vec4 view = uCameraProjInv * clip;
  view = view / view.w;
  vec3 worldNear = (uCameraWorld * view).xyz;
  vec3 dir = normalize(worldNear - uCameraPos);

  // gravitational-wave ripple (artistic)
  if (uRippleAge >= 0.0) {
    vec3 toR = uRipplePos - uCameraPos;
    float rd = length(toR);
    if (rd > EPS) {
      vec3 tt = toR / rd;
      vec3 fallback = abs(tt.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
      vec3 side = cross(tt, fallback);
      float sl = length(side);
      if (sl > EPS) {
        side /= sl;
        float wave = sin(uRippleAge * 12.0 - rd * 0.7) * exp(-uRippleAge * 1.4);
        dir = normalize(dir + side * wave * 0.012 * uRippleStrength);
      }
    }
  }

  Hit h = marchRay(uCameraPos, dir);

  vec3 col;
  if (h.captured) {
    col = vec3(0.0);
  } else {
    col = sampleSky(normalize(h.endDir));
  }
  col += h.accum;

  // ---- photon-ring / Einstein-ring enhancement ----
  // The Verlet integrator already produces the bright ring around the shadow
  // for rays that graze the photon sphere. These additive terms just boost
  // visibility at finite step counts — a Gaussian centered on minR = 1.5 r_s.
  float bend = 1.0 - clamp(dot(normalize(h.endDir), dir), -1.0, 1.0);
  float genericRing = smoothstep(0.2, 0.9, bend) * (1.0 - float(h.captured));
  col += vec3(1.1, 0.6, 0.25) * genericRing * 0.22;

  float d = (h.minR - R_PHOTON * uMass) / (0.6 * uMass);
  float photonRing = exp(-d * d * 2.2) * (1.0 - float(h.captured))
                   * smoothstep(0.02, 0.25, bend);
  col += vec3(1.0, 0.85, 0.6) * photonRing * 0.55;

  // tone map + gamma
  col = col / (1.0 + col * 0.65);
  col = pow(max(col, 0.0), vec3(0.92));

  gl_FragColor = vec4(col, 1.0);
}
