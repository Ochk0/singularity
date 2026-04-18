// Live physics HUD — updates at ~5 Hz.
export class Hud {
  constructor(el) {
    this.el = el;
    this.acc = 0;
    this.last = performance.now();
    this.frameMs = 16;
  }

  tick(dt, state) {
    // running average of frame time
    const now = performance.now();
    const thisMs = now - this.last;
    this.last = now;
    this.frameMs = this.frameMs * 0.9 + thisMs * 0.1;

    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;

    const { params, primary, extras, mode, cinema } = state;
    const rs = params.mass * primary.rs;
    const isco = 3.0 * rs;                // approx Schwarzschild ISCO in rs units
    const hawkingT = (1.0 / (8 * Math.PI * rs)).toFixed(3);  // arb units
    const jetBeta = (params.spin * 0.9 + 0.25).toFixed(2);
    const fps = (1000 / this.frameMs).toFixed(0);

    this.el.innerHTML =
      `<div><span class="k">mode</span><span class="v">${mode}${cinema ? ' • cinema' : ''}</span></div>` +
      `<div><span class="k">r<sub>s</sub></span><span class="v">${rs.toFixed(2)}</span></div>` +
      `<div><span class="k">ISCO</span><span class="v">${isco.toFixed(2)}</span></div>` +
      `<div><span class="k">T<sub>H</sub></span><span class="v">${hawkingT}</span></div>` +
      `<div><span class="k">jet β</span><span class="v">${jetBeta}</span></div>` +
      `<div><span class="k">bodies</span><span class="v">1 (+${extras.length})</span></div>` +
      `<div><span class="k">frame</span><span class="v">${this.frameMs.toFixed(1)} ms · ${fps} fps</span></div>`;
  }
}
