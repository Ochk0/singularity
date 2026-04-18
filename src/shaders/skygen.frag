precision highp float;
varying vec3 vDir;

// ---- hashes / noise ----
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
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
  for (int i = 0; i < 5; i++) {
    s += a * vnoise3(p);
    p *= 2.07;
    a *= 0.5;
  }
  return s;
}

// ---- stars: dense grid, Gaussian-halo rendered ----
vec3 starLayer(vec3 dir, float scale, float density, float brightMul) {
  vec3 g = dir * scale;
  vec3 gi = floor(g);
  vec3 gf = g - gi;

  vec3 col = vec3(0.0);
  for (int kz = -1; kz <= 1; kz++) {
    for (int ky = -1; ky <= 1; ky++) {
      for (int kx = -1; kx <= 1; kx++) {
        vec3 cell = gi + vec3(float(kx), float(ky), float(kz));
        vec3 rnd = hash33(cell);
        if (rnd.x < density) {
          vec3 sub = rnd;
          vec3 d3 = gf - vec3(float(kx) + sub.x, float(ky) + sub.y, float(kz) + sub.z);
          float d = length(d3);
          float core = exp(-d * d * 1100.0);
          float halo = exp(-d * 26.0) * 0.15;
          float lum  = (0.45 + pow(rnd.y, 3.0) * 18.0);
          float s = (core * 2.2 + halo) * brightMul * lum;

          // color class
          float h = fract(rnd.z * 13.1);
          vec3 c;
          if (h < 0.35)      c = vec3(0.55, 0.72, 1.25);   // hot blue
          else if (h < 0.70) c = vec3(1.00, 1.00, 0.95);   // sunlike
          else if (h < 0.92) c = vec3(1.25, 0.95, 0.60);   // amber
          else               c = vec3(1.35, 0.40, 0.28);   // red giant
          col += c * s;
        }
      }
    }
  }
  return col;
}

// ---- beacons: a handful of very bright hero stars with diffraction spikes ----
vec3 beacons(vec3 dir) {
  vec3 col = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    vec3 seed = hash33(vec3(float(i) * 7.19, float(i) * 13.3, 3.7));
    vec3 bdir = normalize(seed * 2.0 - 1.0);
    vec3 diff = dir - bdir;
    float d = length(diff);
    if (d < 0.12) {
      float core = exp(-d * d * 4500.0) * 4.5;
      // diffraction spikes: two orthogonal thin crosses
      // build a local frame around bdir
      vec3 up = abs(bdir.y) > 0.95 ? vec3(1,0,0) : vec3(0,1,0);
      vec3 right = normalize(cross(up, bdir));
      vec3 localUp = normalize(cross(bdir, right));
      float u = dot(diff, right);
      float v = dot(diff, localUp);
      float sp1 = exp(-abs(u) * 650.0) * exp(-abs(v) * 12.0);
      float sp2 = exp(-abs(v) * 650.0) * exp(-abs(u) * 12.0);
      float spikes = (sp1 + sp2) * 0.55;
      float color = fract(seed.x * 91.1);
      vec3 tint;
      if      (color < 0.4) tint = vec3(0.65, 0.80, 1.3);
      else if (color < 0.8) tint = vec3(1.05, 1.05, 0.95);
      else                  tint = vec3(1.3, 0.95, 0.55);
      col += tint * (core + spikes);
    }
  }
  return col;
}

// ---- nebulae: sparse, vivid ----
vec3 nebulae(vec3 dir) {
  float n  = fbm3(dir * 2.2);
  float mask = smoothstep(0.72, 0.95, n);
  if (mask <= 0.0) return vec3(0.0);

  float n2 = fbm3(dir * 7.0 + vec3(4.2, 1.9, 0.3));
  float n3 = fbm3(dir * 15.0 + vec3(1.1, 8.3, 5.5));

  // palette: rust / deep-purple / teal
  vec3 rust   = vec3(0.85, 0.38, 0.18);
  vec3 purple = vec3(0.35, 0.14, 0.62);
  vec3 teal   = vec3(0.18, 0.55, 0.75);

  vec3 col = mix(purple, rust, smoothstep(0.30, 0.75, n2));
  col = mix(col, teal, smoothstep(0.65, 0.95, n3) * 0.55);

  // filamentary detail
  float fil = smoothstep(0.55, 0.85, n3);
  col *= 0.6 + 0.8 * fil;

  return col * mask * 0.55;
}

// ---- faint galactic band with dust lanes ----
vec3 galacticBand(vec3 dir) {
  vec3 bandNormal = normalize(vec3(0.25, 0.92, 0.31));
  float dist = abs(dot(dir, bandNormal));
  float band = exp(-pow(dist * 7.0, 2.0));

  if (band < 0.003) return vec3(0.0);

  // dust lanes break it up
  vec3 alongDir = normalize(dir - bandNormal * dot(dir, bandNormal));
  float dust = smoothstep(0.48, 0.78, fbm3(alongDir * 9.0 + dir * 1.2));
  float transmit = 1.0 - dust * 0.7;

  vec3 bandCol = mix(vec3(0.30, 0.22, 0.45),
                     vec3(0.42, 0.30, 0.18),
                     0.5 + 0.5 * sin(dot(alongDir, vec3(4.0, 0.0, 3.0))));

  return bandCol * band * transmit * 0.15;
}

void main() {
  vec3 dir = normalize(vDir);

  vec3 col = vec3(0.0);
  col += starLayer(dir, 300.0, 0.05,  0.85);    // dense faint layer
  col += starLayer(dir, 110.0, 0.018, 2.6);     // sparse bright layer
  col += beacons(dir);
  col += nebulae(dir);
  col += galacticBand(dir);

  // deep dim background
  col += vec3(0.0015, 0.0022, 0.0038);

  gl_FragColor = vec4(col, 1.0);
}
