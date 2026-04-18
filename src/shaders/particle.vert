attribute float aLife;      // 0..1 (1 = just born)
attribute float aTemp;      // 0..1 visual temp
attribute float aSize;

varying float vLife;
varying float vTemp;

void main() {
  vLife = aLife;
  vTemp = aTemp;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // size attenuation
  float dist = -mv.z;
  gl_PointSize = aSize * (300.0 / max(dist, 0.1));
}
