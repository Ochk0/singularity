precision highp float;
varying float vLife;
varying float vTemp;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.0, d);
  float halo = smoothstep(0.5, 0.18, d);

  // temperature color: warm -> white-blue as temp rises
  vec3 warm  = vec3(1.4, 0.75, 0.35);
  vec3 hot   = vec3(1.2, 1.1, 0.95);
  vec3 blue  = vec3(0.7, 0.85, 1.4);
  vec3 col;
  if (vTemp < 0.5) col = mix(warm, hot, vTemp * 2.0);
  else             col = mix(hot, blue, (vTemp - 0.5) * 2.0);

  float alpha = (core * 1.0 + halo * 0.25) * vLife;
  gl_FragColor = vec4(col * (0.4 + 1.6 * core), alpha);
}
