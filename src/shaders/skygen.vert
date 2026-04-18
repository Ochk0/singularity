varying vec3 vDir;
void main() {
  // Sphere is at origin, unit-ish radius (doesn't matter, we normalize).
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
