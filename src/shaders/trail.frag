precision highp float;
varying float vAge;
varying float vTemp;

void main() {
  float alpha = pow(1.0 - vAge, 2.0);
  if (alpha < 0.01) discard;

  vec3 warm = vec3(1.4, 0.75, 0.35);
  vec3 hot  = vec3(1.1, 1.1, 0.95);
  vec3 blue = vec3(0.7, 0.9, 1.5);
  vec3 col;
  if (vTemp < 0.5) col = mix(warm, hot, vTemp * 2.0);
  else             col = mix(hot, blue, (vTemp - 0.5) * 2.0);

  gl_FragColor = vec4(col * alpha * 0.9, alpha);
}
