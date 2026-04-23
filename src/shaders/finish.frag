precision highp float;

uniform sampler2D tDiffuse;
uniform vec2  uResolution;
uniform float uTime;
uniform float uCAmount;     // chromatic aberration
uniform float uGrain;       // film grain
uniform float uVignette;

varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;

  // radial chromatic aberration: zero at screen center, grows outward so
  // the bright photon ring near center reads clean instead of rainbow-fringed.
  float r2 = dot(d, d);
  float caStrength = uCAmount * r2 * 2.0;
  vec2 dir = normalize(d + 1e-5);
  vec2 offR = dir * caStrength * 0.0015;
  vec2 offB = -dir * caStrength * 0.0015;

  float r = texture2D(tDiffuse, uv + offR).r;
  float g = texture2D(tDiffuse, uv).g;
  float b = texture2D(tDiffuse, uv + offB).b;
  vec3 col = vec3(r, g, b);

  // grain
  float n = hash(uv * uResolution + uTime * 60.0) - 0.5;
  col += n * uGrain;

  // vignette
  float v = smoothstep(0.95, 0.35, length(d));
  col *= mix(1.0, v, uVignette);

  // scanline hint
  col *= 1.0 - 0.03 * (0.5 + 0.5 * sin(uv.y * uResolution.y * 1.2));

  gl_FragColor = vec4(col, 1.0);
}
