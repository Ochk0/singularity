import * as THREE from 'three';
import skygenVert from './shaders/skygen.vert?raw';
import skygenFrag from './shaders/skygen.frag?raw';

// Generate a rich space cubemap once at startup. Returns a CubeTexture
// (via WebGLCubeRenderTarget.texture) suitable for samplerCube.
export function buildSkyBox(renderer, size = 1024) {
  const rt = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const mat = new THREE.ShaderMaterial({
    vertexShader:   skygenVert,
    fragmentShader: skygenFrag,
    side: THREE.BackSide,   // we render from inside the sphere
    depthWrite: false,
    depthTest: false,
  });

  // Large sphere so we're definitively inside; radius irrelevant since we normalize in shader.
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), mat);
  const skyScene = new THREE.Scene();
  skyScene.add(sphere);

  const cam = new THREE.CubeCamera(0.1, 500, rt);
  cam.position.set(0, 0, 0);

  // Preserve renderer state.
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevAutoClearColor = renderer.autoClearColor;
  renderer.autoClear = true;
  renderer.autoClearColor = true;

  cam.update(renderer, skyScene);

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.autoClearColor = prevAutoClearColor;

  // Clean up the throw-away scene
  sphere.geometry.dispose();
  mat.dispose();

  return rt.texture;
}
