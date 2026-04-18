attribute float aAge;   // 0 = head, 1 = tail
attribute float aTemp;  // owner particle's temp at sample time

varying float vAge;
varying float vTemp;

void main() {
  vAge = aAge;
  vTemp = aTemp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
