# Singularity

Interactive black-hole sandbox. Real-time gravitational lensing, a Doppler-shifted accretion disk, matter you can fling into the hole, and a proper chaotic N-body mode for three-body fans.

Built with vanilla Three.js + custom GLSL. No backend, no assets — everything is procedural or generated on load.

## Run it

```sh
npm install
npm run dev
```

Then open http://127.0.0.1:5173/.

```sh
npm run build      # static bundle into dist/
```

## Controls

- **V / Esc** — view mode (plain camera, drag orbits)
- **1 / 2 / 3** — Matter / Hole / Star spawn modes
- **C** — cinematic auto-director
- Drag in a spawn mode to aim; release to launch
- Scroll to zoom

Preset buttons at the top: Solo, Binary, Tidal Feast, Quiet Void, 3-Body, Figure-8, N-Body.

## What's inside

- Ray-marched Schwarzschild-like lensing in a full-screen fragment shader
- Accretion disk with Keplerian Doppler beaming and up to three plane crossings (the Interstellar arc)
- One-time-generated 1024³ sky cubemap with Voronoi-ish stars, beacon stars with diffraction spikes, sparse vivid nebulae, and a tilted galactic band
- Additive-blended matter particles with fading trails, tidal disruption of stars
- Chaotic N-body mode: velocity-Verlet integrator, softening length, momentum-conserving merges, per-body trails
- Post-processing: UnrealBloom + chromatic aberration + film grain + vignette

## Tech

- [three](https://threejs.org) (r171)
- [lil-gui](https://lil-gui.georgealways.com)
- [Vite](https://vitejs.dev)

## License

MIT — see [LICENSE](LICENSE).
