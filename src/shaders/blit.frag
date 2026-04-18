precision highp float;
uniform sampler2D tBH;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tBH, vUv);
}
