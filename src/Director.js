import * as THREE from 'three';

// Cinematic auto-director. Animates the camera along a lemniscate-ish orbit
// while gently zooming and looking at a target point. Any pointer input cancels.
export class Director {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.active = false;
    this.t = 0;
    this.baseTarget = new THREE.Vector3();
    this.tempVec = new THREE.Vector3();
  }

  start(target = new THREE.Vector3(0, 0, 0)) {
    if (this.active) return;
    this.active = true;
    this.t = 0;
    this.baseTarget.copy(target);
    this.controls.enabled = false;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.controls.enabled = true;
    this.controls.target.copy(this.baseTarget);
    this.controls.update();
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const T = this.t;
    // lemniscate of Gerono-ish in the xz plane, slow
    const a = 26.0;
    const x = a * Math.sin(T * 0.18);
    const z = a * Math.sin(T * 0.18) * Math.cos(T * 0.18) * 1.6;
    // gentle vertical bob
    const y = 7.5 + Math.sin(T * 0.09) * 3.2;
    // slow breathing zoom
    const zoom = 1.0 + 0.18 * Math.sin(T * 0.07);
    this.camera.position.set(x * zoom, y, z * zoom);
    this.camera.lookAt(this.baseTarget);
  }
}
