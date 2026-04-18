import * as THREE from 'three';

// Preset scenes.
// Note: threeBody / figure-eight / n-body flip the physics to real Newtonian
// N-body with softening + velocity-Verlet. Disk/jets auto-hide in that mode. Each fn mutates the live state references.
export function applyPreset(name, ctx) {
  const { params, primary, extras, matter, tde, guiRefs, holeTrails } = ctx;

  // reset core state
  extras.length = 0;
  primary.rs = 1.0;
  primary.pos.set(0, 0, 0);
  primary.vel.set(0, 0, 0);
  tde.stop();
  params.chaos = false;
  if (holeTrails) holeTrails.reset();

  switch (name) {
    case 'solo':
      params.mass = 1.0;
      params.spin = 0.5;
      params.diskDensity = 1.0;
      params.diskTemp = 1.0;
      params.bloom = 0.85;
      params.timeScale = 1.0;
      break;

    case 'binary':
      params.mass = 1.1;
      params.spin = 0.7;
      params.diskDensity = 1.1;
      params.diskTemp = 1.1;
      params.bloom = 1.0;
      params.timeScale = 1.0;
      extras.push({
        pos: new THREE.Vector3(14, 0, 0),
        vel: new THREE.Vector3(0, 0, 1.05),
        rs: 0.45,
        age: 0,
      });
      break;

    case 'tidal':
      params.mass = 1.1;
      params.spin = 0.6;
      params.diskDensity = 0.9;
      params.diskTemp = 1.2;
      params.bloom = 0.85;
      params.timeScale = 1.0;
      tde.start(matter, primary, 3.0, 20.0);
      break;

    case 'void':
      params.mass = 0.9;
      params.spin = 0.1;
      params.diskDensity = 0.05;
      params.diskTemp = 0.6;
      params.bloom = 0.4;
      params.timeScale = 0.4;
      break;

    // -- chaotic physics presets --

    case 'three-body': {
      // Three equal-mass holes in a triangle, no initial velocity.
      // Classic chaotic-collapse seed.
      params.chaos = true;
      params.mass = 1.0;
      params.bloom = 1.0;
      params.timeScale = 1.0;
      const R = 10.0;
      primary.rs = 0.9;
      primary.pos.set(R * Math.cos(Math.PI / 2),       0, R * Math.sin(Math.PI / 2));
      primary.vel.set(0, 0, 0);
      extras.push({
        pos: new THREE.Vector3(R * Math.cos(7 * Math.PI / 6), 0, R * Math.sin(7 * Math.PI / 6)),
        vel: new THREE.Vector3(),
        rs: 0.9,
        age: 0,
      });
      extras.push({
        pos: new THREE.Vector3(R * Math.cos(11 * Math.PI / 6), 0, R * Math.sin(11 * Math.PI / 6)),
        vel: new THREE.Vector3(),
        rs: 0.9,
        age: 0,
      });
      break;
    }

    case 'figure-eight': {
      // Chenciner-Montgomery figure-eight: three equal masses on a stable
      // choreographic orbit.  Known positions/velocities (scaled for our units).
      params.chaos = true;
      params.mass = 1.0;
      params.bloom = 1.0;
      params.timeScale = 1.0;
      const s = 7.0;
      const vs = 1.25;
      primary.rs = 0.7;
      primary.pos.set( 0.97000436 * s, 0, -0.24308753 * s);
      primary.vel.set(-0.466203685 * vs * 0.5, 0, -0.43236573 * vs * 0.5);
      extras.push({
        pos: new THREE.Vector3(-0.97000436 * s, 0,  0.24308753 * s),
        vel: new THREE.Vector3(-0.466203685 * vs * 0.5, 0, -0.43236573 * vs * 0.5),
        rs: 0.7, age: 0,
      });
      extras.push({
        pos: new THREE.Vector3(0, 0, 0),
        vel: new THREE.Vector3(0.93240737 * vs * 0.5, 0, 0.86473146 * vs * 0.5),
        rs: 0.7, age: 0,
      });
      break;
    }

    case 'n-body': {
      // 4 bodies with randomized tangential velocities — always chaotic.
      params.chaos = true;
      params.mass = 1.0;
      params.bloom = 1.1;
      params.timeScale = 1.0;
      primary.rs = 0.85;
      primary.pos.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 8);
      primary.vel.set((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4);
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2 + Math.random() * 0.6;
        const r = 9 + Math.random() * 4;
        const pos = new THREE.Vector3(
          Math.cos(angle) * r,
          (Math.random() - 0.5) * 4,
          Math.sin(angle) * r,
        );
        // gentle tangential kick around origin
        const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
        const speed = 0.55 + Math.random() * 0.45;
        extras.push({
          pos,
          vel: tangent.multiplyScalar(speed).add(new THREE.Vector3(
            (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.2
          )),
          rs: 0.55 + Math.random() * 0.4,
          age: 0,
        });
      }
      break;
    }
  }
  if (guiRefs && guiRefs.gui) guiRefs.gui.controllersRecursive().forEach(c => c.updateDisplay());
}

// Simple scheduler for "tidal feast" that spawns stars on a cadence.
export function makeTdeScheduler() {
  let running = false;
  let acc = 0;
  let remaining = 0;
  let interval = 3.0;
  let target = null;
  let matterRef = null;

  return {
    start(matter, primary, intervalSec, durationSec) {
      running = true;
      acc = 0;
      interval = intervalSec;
      remaining = durationSec;
      matterRef = matter;
      target = primary;
    },
    stop() { running = false; },
    update(dt) {
      if (!running) return;
      acc += dt;
      remaining -= dt;
      if (remaining <= 0) { running = false; return; }
      if (acc >= interval) {
        acc = 0;
        const angle = Math.random() * Math.PI * 2;
        const dist = 28 + Math.random() * 10;
        const origin = new THREE.Vector3(
          Math.cos(angle) * dist,
          (Math.random() - 0.5) * 3,
          Math.sin(angle) * dist
        );
        matterRef.spawnStar(origin, target.pos);
      }
    },
    isRunning() { return running; },
  };
}
