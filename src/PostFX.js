import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';
import finishFrag from './shaders/finish.frag?raw';

export function createPostFX(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const size = new THREE.Vector2();
  renderer.getSize(size);

  const bloom = new UnrealBloomPass(size, 1.4, 0.85, 0.78);
  composer.addPass(bloom);

  const finishPass = new ShaderPass({
    uniforms: {
      tDiffuse:    { value: null },
      uResolution: { value: size.clone() },
      uTime:       { value: 0 },
      uCAmount:    { value: 1.0 },
      uGrain:      { value: 0.035 },
      uVignette:   { value: 0.6 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: finishFrag,
  });
  composer.addPass(finishPass);

  composer.addPass(new OutputPass());

  return { composer, bloom, finishPass };
}
