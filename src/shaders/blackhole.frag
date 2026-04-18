precision highp float;

// ---- uniforms ----
uniform vec2  uResolution;
uniform float uTime;
uniform mat4  uCameraWorld;
uniform mat4  uCameraProjInv;
uniform vec3  uCameraPos;

uniform float uMass;
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

const float PI = 3.14159265359;
const float EPS = 1e-5;

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

// ---------- sky (now a cubemap lookup) ----------
vec3 sampleSky(vec3 dir) {
  return textureCube(uSkyBox, dir).rgb;
}

// ---------- accretion disk ----------
vec3 diskEmission(vec3 p, vec3 rayDir, float rs) {
  float r = length(p.xy);
  if (r < uDiskInner * rs || r > uDiskOuter * rs) return vec3(0.0);
  float halfThickness = 0.08 * rs + 0.02 * r;
  if (abs(p.z) > halfThickness) return vec3(0.0);

  float rn = (r - uDiskInner * rs) / max(uDiskOuter * rs - uDiskInner * rs, EPS);
  float temp = pow(max(1.0 - rn, 0.0), 1.5);
  float hf = 1.0 - clamp(abs(p.z) / max(halfThickness, EPS), 0.0, 1.0);
  float density = temp * hf * uDiskDensity;

  float ang = atan(p.y, p.x);
  float lr  = log(max(r / rs, 0.5));
  float swirl = sin(ang * 3.0 - lr * 6.0 + uTime * 0.4);
  swirl += 0.6 * sin(ang * 7.0 - lr * 10.0 - uTime * 0.7);
  float turb = 0.55 + 0.45 * swirl;
  density *= mix(0.3, 1.1, turb);

  vec2 rHat = p.xy / max(r, EPS);
  vec2 vTan = vec2(-rHat.y, rHat.x);
  float orbitalSpeed = 0.48 / sqrt(max(r / rs, 1.5));
  vec3 velocity = vec3(vTan * orbitalSpeed, 0.0);
  float beta = dot(velocity, -rayDir);
  beta = clamp(beta, -0.7, 0.7);
  float doppler = 1.0 / max(1.0 - beta, 0.05);
  float boost = pow(doppler, 3.3);

  float t = clamp(temp * uDiskTemp * doppler * 1.2, 0.0, 2.0);
  vec3 hot  = vec3(1.0, 0.95, 0.85);
  vec3 warm = vec3(1.3, 0.7,  0.25);
  vec3 cool = vec3(0.35, 0.45, 0.95);
  vec3 col;
  if (t > 1.0) col = mix(hot, vec3(0.85, 0.92, 1.4), clamp(t - 1.0, 0.0, 1.0));
  else         col = mix(warm, hot, t);
  if (beta < 0.0) col = mix(col, cool * 0.6, clamp(-beta * 1.6, 0.0, 0.8));

  col += vec3(1.8, 2.0, 2.6) * uTdeFlash * smoothstep(uDiskOuter * rs, uDiskInner * rs, r);
  return col * density * boost * 2.0;
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

void pullTowards(inout vec3 pos, inout vec3 dir, vec3 center, float rs, float ds) {
  vec3 rel = center - pos;
  float r2 = max(dot(rel, rel), rs * rs * 0.05);
  float invR = inversesqrt(r2);
  float strength = 1.5 * rs / r2;
  dir += rel * invR * strength * ds;
}

bool isFinite3(vec3 v) { return v.x == v.x && v.y == v.y && v.z == v.z; }

Hit marchRay(vec3 origin, vec3 dir) {
  Hit h;
  h.captured = false;
  h.endDir = dir;
  h.accum = vec3(0.0);
  h.minR = 1e9;

  vec3 pos = origin;
  const int STEPS = 150;
  float stepLen = 0.7;
  int crossings = 0;
  const int MAX_CROSSINGS = 3;
  float farThresh = uDiskOuter * uMass * 1.8;
  bool chaos = uChaosMode > 0;

  for (int i = 0; i < STEPS; i++) {
    vec3 rel = pos - uPrimaryPos;
    float rPrim = length(rel);
    if (rPrim < h.minR) h.minR = rPrim;

    float ds = clamp(rPrim * 0.08, 0.22, stepLen);
    vec3 prev = pos;
    vec3 prevRel = rel;

    pullTowards(pos, dir, uPrimaryPos, uMass, ds);
    if (uExtraCount > 0) pullTowards(pos, dir, uExtras[0].xyz, uExtras[0].w, ds);
    if (uExtraCount > 1) pullTowards(pos, dir, uExtras[1].xyz, uExtras[1].w, ds);
    if (uExtraCount > 2) pullTowards(pos, dir, uExtras[2].xyz, uExtras[2].w, ds);

    float dl = length(dir);
    dir = dir / max(dl, EPS);
    pos += dir * ds;

    if (!isFinite3(pos) || !isFinite3(dir)) { h.captured = true; break; }

    // horizon checks
    if (length(pos - uPrimaryPos) < uMass * 1.02) { h.captured = true; break; }
    if (uExtraCount > 0 && length(pos - uExtras[0].xyz) < uExtras[0].w * 1.05) { h.captured = true; break; }
    if (uExtraCount > 1 && length(pos - uExtras[1].xyz) < uExtras[1].w * 1.05) { h.captured = true; break; }
    if (uExtraCount > 2 && length(pos - uExtras[2].xyz) < uExtras[2].w * 1.05) { h.captured = true; break; }

    // disk / jet only when NOT in chaos mode (disk makes no sense around a flying primary)
    if (!chaos) {
      vec3 newRel = pos - uPrimaryPos;
      if (crossings < MAX_CROSSINGS &&
          sign(prevRel.z) != sign(newRel.z) &&
          abs(newRel.z) < 0.6 * uMass + length(newRel.xy) * 0.08) {
        float denom = max(abs(prevRel.z) + abs(newRel.z), EPS);
        vec3 mid = mix(prevRel, newRel, abs(prevRel.z) / denom);
        float atten = pow(0.55, float(crossings));
        h.accum += diskEmission(mid, dir, uMass) * atten;
        crossings++;
      } else {
        h.accum += diskEmission(newRel, dir, uMass) * 0.12 * ds;
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

  // ripple
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

  // ---- photon-ring halo ----
  float bend = 1.0 - clamp(dot(normalize(h.endDir), dir), -1.0, 1.0);
  float genericRing = smoothstep(0.2, 0.9, bend) * (1.0 - float(h.captured));
  col += vec3(1.1, 0.6, 0.25) * genericRing * 0.32;

  float grazeT = 1.0 - smoothstep(1.3 * uMass, 3.2 * uMass, h.minR);
  float einstein = grazeT * (1.0 - float(h.captured)) * smoothstep(0.05, 0.35, bend);
  col += vec3(1.0, 0.85, 0.6) * einstein * 0.7;

  // tone map + gamma
  col = col / (1.0 + col * 0.65);
  col = pow(max(col, 0.0), vec3(0.92));

  gl_FragColor = vec4(col, 1.0);
}
