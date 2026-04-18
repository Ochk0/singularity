// Minimal WebAudio soundscape. Starts on first user gesture (splash click).

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.drone = null;
    this.droneOsc = null;
    this.droneGain = null;
    this.enabled = true;
  }

  start() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);

    // Drone: two detuned sawtooth + low pass
    const d1 = this.ctx.createOscillator(); d1.type = 'sawtooth'; d1.frequency.value = 58;
    const d2 = this.ctx.createOscillator(); d2.type = 'sawtooth'; d2.frequency.value = 87;
    const d3 = this.ctx.createOscillator(); d3.type = 'sine';     d3.frequency.value = 29;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 4;
    const g = this.ctx.createGain(); g.gain.value = 0.0;
    d1.connect(lp); d2.connect(lp); d3.connect(lp);
    lp.connect(g).connect(this.master);
    d1.start(); d2.start(); d3.start();
    // fade in
    g.gain.linearRampToValueAtTime(0.5, this.ctx.currentTime + 3.0);

    this.droneOsc = [d1, d2, d3];
    this.droneFilter = lp;
    this.droneGain = g;
  }

  setProximity(t) {
    // t in [0,1] where 1 = very close to horizon. Bends pitch down, opens filter.
    if (!this.ctx) return;
    const base = [58, 87, 29];
    const bend = 1.0 - 0.35 * t;
    this.droneOsc.forEach((o, i) => {
      o.frequency.setTargetAtTime(base[i] * bend, this.ctx.currentTime, 0.6);
    });
    this.droneFilter.frequency.setTargetAtTime(420 + 600 * t, this.ctx.currentTime, 0.4);
  }

  chime() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const f = 520 + Math.random() * 240;
    o.frequency.setValueAtTime(f, now);
    o.frequency.exponentialRampToValueAtTime(f * 0.5, now + 0.35);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0, now);
    g.gain.linearRampToValueAtTime(0.08, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 0.45);
  }

  merger() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // sub thump
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(110, now);
    o.frequency.exponentialRampToValueAtTime(24, now + 1.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.9, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, now + 1.6);
    o.connect(g).connect(this.master);
    o.start(now); o.stop(now + 1.65);

    // white noise burst
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.8, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (this.ctx.sampleRate * 0.15));
    const src = this.ctx.createBufferSource(); src.buffer = buffer;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 380; bp.Q.value = 1;
    const ng = this.ctx.createGain(); ng.gain.value = 0.22;
    src.connect(bp).connect(ng).connect(this.master);
    src.start(now);
  }
}
