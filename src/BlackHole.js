import * as THREE from 'three';
import fullscreenVert from './shaders/fullscreen.vert?raw';
import blackholeFrag from './shaders/blackhole.frag?raw';

export function createBlackHoleMaterial({ camera, resolution }) {
  const uniforms = {
    uResolution:    { value: resolution.clone() },
    uTime:          { value: 0 },
    uCameraWorld:   { value: camera.matrixWorld.clone() },
    uCameraProjInv: { value: camera.projectionMatrixInverse.clone() },
    uCameraPos:     { value: camera.position.clone() },

    uMass:          { value: 1.0 },
    uPrimaryPos:    { value: new THREE.Vector3() },
    uChaosMode:     { value: 0 },
    uSpin:          { value: 0.5 },
    uDiskDensity:   { value: 1.0 },
    uDiskTemp:      { value: 1.0 },
    uDiskInner:     { value: 3.0 },
    uDiskOuter:     { value: 14.0 },
    uJetStrength:   { value: 0.6 },
    uTdeFlash:      { value: 0.0 },

    uExtraCount:    { value: 0 },
    uExtras:        { value: [
      new THREE.Vector4(0, 0, 0, 0),
      new THREE.Vector4(0, 0, 0, 0),
      new THREE.Vector4(0, 0, 0, 0),
    ] },

    uRipplePos:      { value: new THREE.Vector3() },
    uRippleAge:      { value: -1 },
    uRippleStrength: { value: 1 },

    uSkyBox:         { value: null },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert,
    fragmentShader: blackholeFrag,
    uniforms,
    depthWrite: false,
    depthTest: false,
  });

  return material;
}

export function createBlackHoleMesh(material) {
  const geo = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}
