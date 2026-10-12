/* Melt Timer — app */
(() => {
'use strict';

/* =========================================================================
   Helpers
   ========================================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const rgba = (r, g, b, a) => 'rgba(' + r + ',' + g + ',' + b + ',' + clamp(a, 0, 1).toFixed(3) + ')';
const DEBUG = /(^|[?&#])debug\b/.test(location.search + location.hash);
let timeOffset = 0;                       // only used by the debug hooks
const now = () => Date.now() + timeOffset;
function rng(seed) {                      // small deterministic PRNG (xorshift32)
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const mqRM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
let REDUCED = !!(mqRM && mqRM.matches);
if (mqRM) {
  const f = e => { REDUCED = e.matches; };
  if (mqRM.addEventListener) mqRM.addEventListener('change', f); else if (mqRM.addListener) mqRM.addListener(f);
}

/* =========================================================================
   Storage & settings
   ========================================================================= */
const store = {
  get(k, d) { try { const v = localStorage.getItem('meltTimer.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('meltTimer.' + k, JSON.stringify(v)); } catch (e) {} }
};

const PRESETS = [15, 25, 45, 60, 90];
const SOUND_DEFS = [
  { id: 'crackle', name: 'Candle crackle', hint: 'pairs with the candle' },
  { id: 'rain',    name: 'Rain' },
  { id: 'brown',   name: 'Brown noise' },
  { id: 'white',   name: 'White noise' },
  { id: 'wind',    name: 'Soft wind' },
  { id: 'drip',    name: 'Dripping water', hint: 'pairs with the ice cube' }
];
const DEFAULTS = {
  mode: 'candle', duration: 25, custom: false,
  pomodoro: false, shortBreak: 5, longBreak: 15, autoFocus: false,
  wake: true,
  master: 70, muted: false, chime: 70,
  sounds: {
    crackle: { on: false, vol: 55 }, rain: { on: false, vol: 50 }, brown: { on: false, vol: 45 },
    white: { on: false, vol: 35 }, wind: { on: false, vol: 45 }, drip: { on: false, vol: 50 }
  },
  haptics: { on: true, intensity: 'medium', interval: 10 },
  task: ''
};
function merge(def, val) {
  if (def === null || typeof def !== 'object') return (val === undefined || val === null || typeof val !== typeof def) ? def : val;
  const out = {};
  for (const k in def) out[k] = merge(def[k], val && typeof val === 'object' ? val[k] : undefined);
  return out;
}
const S = merge(DEFAULTS, store.get('settings', {}));
S.duration = clamp(Math.round(+S.duration) || 25, 1, 180);
S.custom = !PRESETS.includes(S.duration);
if (S.mode !== 'candle' && S.mode !== 'ice') S.mode = 'candle';
S.shortBreak = clamp(Math.round(+S.shortBreak) || 5, 1, 30);
S.longBreak = clamp(Math.round(+S.longBreak) || 15, 1, 60);
S.master = clamp(+S.master, 0, 100); S.chime = clamp(+S.chime, 0, 100);
for (const d of SOUND_DEFS) S.sounds[d.id].vol = clamp(+S.sounds[d.id].vol, 0, 100);
if (![0, 5, 10, 15, 20, 30].includes(+S.haptics.interval)) S.haptics.interval = 10;
S.haptics.interval = +S.haptics.interval;
if (!['light', 'medium', 'strong'].includes(S.haptics.intensity)) S.haptics.intensity = 'medium';
document.documentElement.dataset.mode = S.mode;

let saveTimer = 0;
function saveSettings() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('settings', S), 120); }
window.addEventListener('pagehide', () => store.set('settings', S));

/* =========================================================================
   Session log (localStorage)
   ========================================================================= */
const Log = {
  items: (() => { const v = store.get('log', []); return Array.isArray(v) ? v.filter(e => e && e.end && e.min) : []; })(),
  add(entry) {
    this.items.push(entry);
    const cutoff = now() - 60 * 864e5;            // keep ~2 months
    this.items = this.items.filter(e => e.end > cutoff);
    store.set('log', this.items);
  },
  dayKey(t) { return new Date(t).toDateString(); },
  today() { const k = this.dayKey(now()); return this.items.filter(e => this.dayKey(e.end) === k); },
  clearToday() { const k = this.dayKey(now()); this.items = this.items.filter(e => this.dayKey(e.end) !== k); store.set('log', this.items); }
};

/* =========================================================================
   Haptics (Vibration API)
   ========================================================================= */
const Haptics = {
  supported: typeof navigator.vibrate === 'function',
  unit() { return { light: 22, medium: 55, strong: 110 }[S.haptics.intensity] || 55; },
  play(kind, force) {
    if (!this.supported || (!S.haptics.on && !force)) return;
    const u = this.unit();
    const P = {
      start:    [u],
      reminder: [u, 90, u],
      warn:     [u, 110, u, 110, u],
      end:      [u * 3, 140, u, 140, u, 140, u * 5],
      breakEnd: [u * 2, 200, u * 2]
    };
    try { navigator.vibrate(P[kind] || [u]); } catch (e) {}
  }
};

/* =========================================================================
   Audio engine (Web Audio API, everything synthesised)
   ========================================================================= */
const AudioEngine = (() => {
  let ctx = null, master = null, chimeBus = null, revIn = null, bank = null, unlocked = false;
  const live = {};
  // per-channel loudness trims (calibrated so defaults sit at similar loudness)
  const SCALE = { crackle: 1.0, rain: 1.4, brown: 0.82, white: 0.72, wind: 1.6, drip: 1.3 };
  const curve = v => Math.pow(clamp(v, 0, 100) / 100, 1.4);

  /* ---- buffer generation ---- */
  function loopBuffer(c, seconds, nch, fill, xf) {
    const sr = c.sampleRate, L = Math.floor(seconds * sr), F = Math.floor((xf || 0.25) * sr);
    const buf = c.createBuffer(nch, L, sr);
    for (let ch = 0; ch < nch; ch++) {
      const tmp = new Float32Array(L + F);
      fill(tmp, sr, ch);
      const out = buf.getChannelData(ch);
      out.set(tmp.subarray(0, L));
      for (let i = 0; i < F; i++) { const a = i / F; out[i] = tmp[i] * Math.sqrt(a) + tmp[L + i] * Math.sqrt(1 - a); } // seamless loop
    }
    return buf;
  }
  function normalize(buf, targetRms, peakMax) {
    let sum = 0, n = 0, peak = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) { const v = d[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
      n += d.length;
    }
    const rms = Math.sqrt(sum / n) || 1;
    let gn = targetRms / rms;
    if (peak * gn > (peakMax || 0.98)) gn = (peakMax || 0.98) / peak;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= gn; }
    return buf;
  }
  const panL = p => Math.cos(p * Math.PI / 2) * 1.414, panR = p => Math.sin(p * Math.PI / 2) * 1.414;

  function genRain(c) {
    const r = rng(777), seconds = 13, total = seconds + 0.3, ev = [];
    let t = 0;
    while (t < total) {
      t += -Math.log(1 - r()) / 62;
      ev.push({ t, amp: 0.05 + 0.6 * Math.pow(r(), 3), dur: 0.0012 + 0.005 * r(), pan: r(), plink: r() < 0.06, f: 1800 + 3400 * r(), seed: (r() * 4e9) >>> 0 });
    }
    return loopBuffer(c, seconds, 2, (tmp, sr, ch) => {
      for (const e of ev) {
        const g = e.amp * (ch ? panR(e.pan) : panL(e.pan));
        const start = Math.floor(e.t * sr); if (start >= tmp.length) continue;
        const tau = e.dur * sr, n = Math.min(Math.floor(tau * 6) + 2, tmp.length - start);
        const rr = rng(e.seed); let prev = 0;
        for (let i = 0; i < n; i++) { const w = rr() * 2 - 1; tmp[start + i] += (w - prev) * 0.5 * g * Math.exp(-i / tau); prev = w; }
        if (e.plink) {
          const tau2 = (0.008 + 0.018 * rr()) * sr, n2 = Math.min(Math.floor(tau2 * 5), tmp.length - start), w0 = 2 * Math.PI * e.f / sr;
          for (let i = 0; i < n2; i++) tmp[start + i] += Math.sin(w0 * i) * g * 0.45 * Math.exp(-i / tau2);
        }
      }
    }, 0.3);
  }
  function genCrackle(c) {
    const r = rng(4242), seconds = 17, total = seconds + 0.3, ev = [];
    let t = 0, rate = 4;
    while (t < total) {
      rate = clamp(rate + (r() - 0.5) * 2.6, 1.4, 10);
      t += -Math.log(1 - r()) / rate;
      const big = r() < 0.05, clicks = 1 + Math.floor(r() * r() * 5);
      for (let k = 0; k < clicks; k++) ev.push({
        t: t + k * (0.002 + r() * 0.012), amp: big ? 0.6 + 0.4 * r() : 0.07 + 0.42 * r() * r(),
        dur: 0.00025 + 0.0012 * r(), pan: 0.38 + 0.24 * r(), seed: (r() * 4e9) >>> 0, thump: big && k === 0
      });
    }
    return loopBuffer(c, seconds, 2, (tmp, sr, ch) => {
      for (const e of ev) {
        const g = e.amp * (ch ? panR(e.pan) : panL(e.pan));
        const start = Math.floor(e.t * sr); if (start >= tmp.length) continue;
        const tau = Math.max(1, e.dur * sr), n = Math.min(Math.floor(tau * 7) + 2, tmp.length - start);
        const rr = rng(e.seed); let prev = 0;
        for (let i = 0; i < n; i++) { const w = rr() * 2 - 1; tmp[start + i] += (w - prev) * 0.5 * g * Math.exp(-i / tau); prev = w; }
        if (e.thump) {
          const f = 90 + 120 * rr(), tau2 = 0.022 * sr, n2 = Math.min(Math.floor(tau2 * 5), tmp.length - start);
          for (let i = 0; i < n2; i++) tmp[start + i] += Math.sin(2 * Math.PI * f * i / sr) * g * 0.3 * Math.exp(-i / tau2);
        }
      }
    }, 0.2);
  }
  function genDrip(c) {
    const r = rng(9001), seconds = 19, total = seconds + 0.3, ev = [];
    let t = 0.25;
    while (t < total) {
      ev.push({ t, f: 520 + 900 * r(), amp: 0.35 + 0.55 * r(), tau: 0.035 + 0.05 * r(), pan: 0.25 + 0.5 * r(), rise: 1.4 + 1.2 * r() });
      if (r() < 0.12) ev.push({ t: t + 0.17 + 0.1 * r(), f: 600 + 800 * r(), amp: 0.2 + 0.25 * r(), tau: 0.03 + 0.03 * r(), pan: 0.3 + 0.4 * r(), rise: 1.3 + r() });
      t += 0.55 + 1.9 * r();
    }
    const taps = [[0, 1, 0], [0.071, 0.26, -0.4], [0.137, 0.16, 0.35], [0.229, 0.09, -0.2]]; // baked room echo
    return loopBuffer(c, seconds, 2, (tmp, sr, ch) => {
      for (const e of ev) for (const [dt, tg, tp] of taps) {
        const pan = clamp(e.pan + tp, 0, 1), g = e.amp * tg * (ch ? panR(pan) : panL(pan));
        const start = Math.floor((e.t + dt) * sr); if (start >= tmp.length) continue;
        const tau = e.tau * sr, n = Math.min(Math.floor(tau * 6), tmp.length - start), atk = 0.0008 * sr;
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const f = e.f * (1 + (e.rise - 1) * (1 - Math.exp(-i / (0.012 * sr))));
          ph += 2 * Math.PI * f / sr;
          const env = (1 - Math.exp(-i / atk)) * Math.exp(-i / tau);
          tmp[start + i] += (Math.sin(ph) + 0.18 * Math.sin(2.7 * ph)) * env * g;
        }
      }
    }, 0.3);
  }
  function makeIR(c, sec) {
    const sr = c.sampleRate, L = Math.floor(sec * sr), b = c.createBuffer(2, L, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch), r = rng(ch ? 31 : 17); let lp = 0;
      for (let i = 0; i < L; i++) {
        const t = i / L; lp += ((r() * 2 - 1) - lp) * 0.35;
        d[i] = lp * Math.pow(1 - t, 2.4) * (i < sr * 0.004 ? i / (sr * 0.004) : 1);
      }
    }
    return b;
  }
  function makeBank(c) {
    const cache = {};
    const gen = {
      white: () => loopBuffer(c, 8, 1, d => { const r = rng(11); for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1; }, 0.05),
      pink: () => normalize(loopBuffer(c, 7, 1, d => {
        const r = rng(23); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < d.length; i++) {
          const w = r() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
        }
      }, 0.3), 0.2),
      brown: () => normalize(loopBuffer(c, 9, 1, d => {
        const r = rng(37); let last = 0;
        for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (r() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
      }, 0.5), 0.24),
      rain: () => normalize(genRain(c), 0.1, 0.9),
      crackle: () => normalize(genCrackle(c), 0.06, 0.9),
      drip: () => normalize(genDrip(c), 0.08, 0.85)
    };
    return name => cache[name] || (cache[name] = gen[name]());
  }

  /* ---- node helpers ---- */
  function src(c, buf) { const s = c.createBufferSource(); s.buffer = buf; s.loop = true; s.start(c.currentTime, Math.random() * buf.duration); return s; }
  function osc(c, f) { const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.start(c.currentTime); return o; }
  function biq(c, type, f, Q) { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; if (Q != null) b.Q.value = Q; return b; }
  function gain(c, v) { const g = c.createGain(); g.gain.value = v; return g; }

  /* ---- ambient channel graphs (continuous movement comes from oscillator LFOs on the audio thread,
         so nothing depends on JS timers and the sound keeps going in background tabs) ---- */
  const BUILD = {
    white(c, out, B) {
      const s = src(c, B('white')); const lp = biq(c, 'lowpass', 7500, 0.5); const g = gain(c, 0.3);
      s.connect(lp).connect(g).connect(out); return [s];
    },
    brown(c, out, B) {
      const s = src(c, B('brown')); const lp = biq(c, 'lowpass', 900, 0.5); const g = gain(c, 1);
      s.connect(lp).connect(g).connect(out); return [s];
    },
    rain(c, out, B) {
      const bed = src(c, B('pink')); const hp = biq(c, 'highpass', 350, 0.6); const lp = biq(c, 'lowpass', 5200, 0.5); const g = gain(c, 0.55);
      bed.connect(hp).connect(lp).connect(g).connect(out);
      const l1 = osc(c, 0.07), lg = gain(c, 0.12); l1.connect(lg).connect(g.gain);
      const hiss = src(c, B('white')); const bp = biq(c, 'bandpass', 4200, 0.6); const hg = gain(c, 0.05);
      hiss.connect(bp).connect(hg).connect(out);
      const drops = src(c, B('rain')); const dg = gain(c, 0.9); drops.connect(dg).connect(out);
      return [bed, l1, hiss, drops];
    },
    crackle(c, out, B) {
      const cr = src(c, B('crackle')); const cg = gain(c, 1); cr.connect(cg).connect(out);
      const bed = src(c, B('brown')); const lp = biq(c, 'lowpass', 260, 0.7); const bg = gain(c, 0.1);
      bed.connect(lp).connect(bg).connect(out);
      const l = osc(c, 0.31), lg = gain(c, 0.04); l.connect(lg).connect(bg.gain);
      return [cr, bed, l];
    },
    wind(c, out, B) {
      const nodes = [];
      const s = src(c, B('pink')); const bp = biq(c, 'bandpass', 520, 0.9); const amp = gain(c, 0.6);
      s.connect(bp).connect(amp);
      const pan = c.createStereoPanner ? c.createStereoPanner() : null;
      if (pan) amp.connect(pan).connect(out); else amp.connect(out);
      const l1 = osc(c, 0.061), g1 = gain(c, 260); l1.connect(g1).connect(bp.frequency);
      const l2 = osc(c, 0.137), g2 = gain(c, 120); l2.connect(g2).connect(bp.frequency);
      const l3 = osc(c, 0.043), g3 = gain(c, 0.3); l3.connect(g3).connect(amp.gain);
      const l4 = osc(c, 0.17), g4 = gain(c, 0.1); l4.connect(g4).connect(amp.gain);
      nodes.push(s, l1, l2, l3, l4);
      if (pan) { const l5 = osc(c, 0.029), g5 = gain(c, 0.45); l5.connect(g5).connect(pan.pan); nodes.push(l5); }
      const w = src(c, B('pink')); const wb = biq(c, 'bandpass', 880, 7); const wg = gain(c, 0.25);
      w.connect(wb).connect(wg).connect(out);
      const l6 = osc(c, 0.09), g6 = gain(c, 180); l6.connect(g6).connect(wb.frequency);
      const l7 = osc(c, 0.053), g7 = gain(c, 0.2); l7.connect(g7).connect(wg.gain);
      const rb = src(c, B('brown')); const rl = biq(c, 'lowpass', 160, 0.7); const rg = gain(c, 0.35);
      rb.connect(rl).connect(rg).connect(out);
      nodes.push(w, l6, l7, rb);
      return nodes;
    },
    drip(c, out, B, rev) {
      const s = src(c, B('drip')); s.connect(out);
      if (rev) { const sg = gain(c, 0.45); out.connect(sg); sg.connect(rev); }
      return [s];
    }
  };

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return null; } }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.3;
    master = gain(ctx, 0); master.connect(comp); comp.connect(ctx.destination);
    const conv = ctx.createConvolver(); conv.buffer = makeIR(ctx, 2.8);
    revIn = gain(ctx, 1); const revOut = gain(ctx, 0.5);
    revIn.connect(conv); conv.connect(revOut); revOut.connect(master);
    chimeBus = gain(ctx, curve(S.chime)); chimeBus.connect(master);
    bank = makeBank(ctx);
    applyMaster(true);
    return ctx;
  }
  function unlock() {
    const c = ensure(); if (!c) return;
    if (c.state !== 'running') { try { const p = c.resume(); if (p && p.then) p.then(() => { sync(); UI.ready && UI.renderAudioNote(); }, () => {}); } catch (e) {} }
    if (!unlocked) {
      try { const b = c.createBuffer(1, 1, 22050), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch (e) {}
      unlocked = true;
    }
    sync();
  }
  function isRunning() { return !!ctx && unlocked && ctx.state === 'running'; }
  function applyMaster(instant) {
    if (!ctx) return;
    const v = S.muted ? 0 : curve(S.master), t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    if (instant) master.gain.setValueAtTime(v, t); else master.gain.setTargetAtTime(v, t, 0.08);
  }
  function applyChime() { if (ctx) chimeBus.gain.setTargetAtTime(curve(S.chime), ctx.currentTime, 0.05); }
  const chanGain = id => curve(S.sounds[id].vol) * SCALE[id];
  function startChannel(id) {
    if (!ctx || live[id]) return;
    const out = gain(ctx, 0); out.connect(master);
    let nodes = [];
    try { nodes = BUILD[id](ctx, out, bank, revIn); } catch (e) { console.warn('sound', id, e); }
    out.gain.setTargetAtTime(chanGain(id), ctx.currentTime, 0.35);   // gentle fade-in
    live[id] = { out, nodes };
  }
  function stopChannel(id) {
    const ch = live[id]; if (!ch) return;
    delete live[id];
    const t = ctx.currentTime;
    ch.out.gain.cancelScheduledValues(t);
    ch.out.gain.setValueAtTime(ch.out.gain.value, t);
    ch.out.gain.linearRampToValueAtTime(0, t + 0.6);
    ch.nodes.forEach(n => { try { n.stop(t + 0.7); } catch (e) {} });
    setTimeout(() => { try { ch.out.disconnect(); } catch (e) {} }, 1000);
  }
  function sync() {
    if (!ctx || !unlocked) return;
    for (const d of SOUND_DEFS) {
      const on = S.sounds[d.id].on;
      if (on && !live[d.id]) startChannel(d.id);
      else if (!on && live[d.id]) stopChannel(d.id);
      else if (on) live[d.id].out.gain.setTargetAtTime(chanGain(d.id), ctx.currentTime, 0.1);
    }
  }

  /* ---- chimes ---- */
  function note(c, t, f, amp, decay, dest, partials, attack) {
    partials.forEach(([ratio, pa, dm], i) => {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f * ratio;
      const g = c.createGain(), end = t + decay * dm;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * pa), t + attack + i * 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      o.connect(g); g.connect(dest); o.start(t); o.stop(end + 0.05);
    });
  }
  function playChime(c, out, rev, kind, t) {
    const dest = gain(c, 1); dest.connect(out);
    let send = null;
    if (rev) { send = gain(c, 0.55); dest.connect(send); send.connect(rev); }
    if (kind === 'break') {
      // softer: two low, round notes with a slow attack
      const P = [[1, 1, 1], [2, 0.16, 0.5], [3, 0.04, 0.3]];
      note(c, t, 587.33, 0.13, 2.4, dest, P, 0.05);
      note(c, t + 0.5, 440, 0.12, 2.8, dest, P, 0.06);
    } else {
      // warm bell arpeggio
      const P = [[1, 1, 1], [2.0, 0.34, 0.6], [2.76, 0.2, 0.45], [4.07, 0.09, 0.3], [5.4, 0.04, 0.22]];
      [[523.25, 0, 0.2], [659.25, 0.32, 0.18], [783.99, 0.64, 0.18], [1046.5, 1.02, 0.11]]
        .forEach(([f, dt, a]) => note(c, t + dt, f, a, 3.8, dest, P, 0.006));
    }
    return [dest, send];
  }
  function chime(kind) {
    if (!ctx || !unlocked) return;
    if (ctx.state !== 'running') { try { ctx.resume(); } catch (e) {} }
    const nodes = playChime(ctx, chimeBus, revIn, kind, ctx.currentTime + 0.06);
    setTimeout(() => nodes.forEach(n => { try { n && n.disconnect(); } catch (e) {} }), 8000);
  }

  /* ---- offline rendering: any ambient channel or chime, same synthesis as live ---- */
  function render(kind, seconds, sampleRate) {
    const sr = sampleRate || 44100, oc = new OfflineAudioContext(2, Math.round(sr * seconds), sr);
    const out = oc.createGain(); out.connect(oc.destination);
    const conv = oc.createConvolver(); conv.buffer = makeIR(oc, 2.8);
    const rev = gain(oc, 1), revOut = gain(oc, 0.5); rev.connect(conv); conv.connect(revOut); revOut.connect(out);
    if (kind === 'session' || kind === 'break') playChime(oc, out, rev, kind, 0.02);
    else { out.gain.value = SCALE[kind]; BUILD[kind](oc, out, makeBank(oc), rev); }
    return oc.startRendering();
  }

  /* ---- offline loudness probe (debug only) ---- */
  async function probe(id, seconds) {
    const sr = 44100, buf = await render(id, seconds || 6, sr);
    let sum = 0, peak = 0, n = 0;
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = sr; i < d.length; i++) { sum += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); n++; } }
    const rms = Math.sqrt(sum / n);
    return { id, rmsDb: +(20 * Math.log10(rms)).toFixed(1), peakDb: +(20 * Math.log10(peak)).toFixed(1) };
  }

  return { unlock, sync, applyMaster, applyChime, chime, render, isRunning, get unlocked() { return unlocked; }, get ctx() { return ctx; }, probe, SCALE };
})();

/* =========================================================================
   Screen Wake Lock
   ========================================================================= */
const Wake = {
  supported: 'wakeLock' in navigator,
  lock: null, pending: false,
  async acquire() {
    if (!this.supported || !S.wake || this.lock || this.pending || document.visibilityState !== 'visible') return;
    this.pending = true;
    try {
      const l = await navigator.wakeLock.request('screen');
      if (!Timer.isRunning() || !S.wake) l.release().catch(() => {});
      else {
        this.lock = l;
        l.addEventListener('release', () => { if (this.lock === l) { this.lock = null; if (UI.ready) UI.renderWake(); } });
      }
    } catch (e) { /* denied (battery saver, iframe policy…) — the timer still works */ }
    this.pending = false;
    if (UI.ready) UI.renderWake();
  },
  release() { const l = this.lock; this.lock = null; if (l) l.release().catch(() => {}); if (UI.ready) UI.renderWake(); }
};

/* =========================================================================
   Timer — everything is derived from timestamps, never from counting ticks
   ========================================================================= */
const Timer = {
  phase: 'focus',       // focus | short | long
  status: 'idle',       // idle | running | paused | done
  durMs: 0, acc: 0, runStart: 0,
  cycle: 0,             // focus sessions completed in the current pomodoro cycle
  sid: 0,               // bumps whenever a new phase begins (the scene uses it)
  remindIdx: 0, remindIv: 0, warned: false, _endT: 0,

  focusMs() { return S.duration * 60000; },
  elapsed(t) { if (t === undefined) t = now(); return this.acc + (this.status === 'running' ? Math.max(0, t - this.runStart) : 0); },
  remaining(t) { return Math.max(0, this.durMs - this.elapsed(t)); },
  progress(t) { return this.durMs > 0 ? clamp(this.elapsed(t) / this.durMs, 0, 1) : 0; },
  isRunning() { return this.status === 'running'; },
  isActive() { return this.status === 'running' || this.status === 'paused'; },
  lit() { return this.phase === 'focus' && this.status !== 'done'; },
  melting() { return this.phase === 'focus' && this.status === 'running'; },
  /* 0 = whole object, 1 = fully melted. Breaks re-form the object for the next round. */
  visual(t) {
    if (this.phase === 'focus') {
      if (this.status === 'idle') return 0;
      if (this.status === 'done') return 1;
      return this.progress(t);
    }
    return 1 - this.progress(t);
  },

  beginPhase(phase, ms, startAt) {
    this.phase = phase; this.durMs = ms; this.acc = 0; this.runStart = startAt; this.status = 'running';
    this.remindIdx = 0; this.remindIv = S.haptics.interval; this.warned = false; this.sid++;
  },
  start() { this.beginPhase('focus', this.focusMs(), now()); this.changed(); },
  pause() {
    if (this.status !== 'running') return;
    this.acc = Math.min(this.durMs, this.acc + (now() - this.runStart));
    this.status = 'paused'; this.changed();
  },
  resume() { if (this.status !== 'paused') return; this.runStart = now(); this.status = 'running'; this.changed(); },
  reset() {
    this.phase = 'focus'; this.status = 'idle'; this.durMs = this.focusMs(); this.acc = 0; this.runStart = 0;
    this.warned = false; this.sid++; this.changed();
  },
  skipBreak() {
    if (this.phase === 'focus') return;
    this.finishBreak(now()); this.changed();
  },
  finishFocus(endAt) {
    Log.add({ end: endAt, min: Math.round(this.durMs / 60000), task: (S.task || '').trim().slice(0, 80) });
    if (S.pomodoro) {
      this.cycle = Math.min(4, this.cycle + 1);
      const long = this.cycle >= 4;
      this.beginPhase(long ? 'long' : 'short', (long ? S.longBreak : S.shortBreak) * 60000, endAt);
    } else {
      this.status = 'done'; this.acc = this.durMs;
    }
  },
  finishBreak(endAt) {
    if (this.phase === 'long') this.cycle = 0;
    if (S.autoFocus) this.beginPhase('focus', this.focusMs(), endAt);
    else { this.phase = 'focus'; this.status = 'idle'; this.durMs = this.focusMs(); this.acc = 0; this.sid++; }
  },
  /* Called every frame, every second, from an exact end-time timeout and on tab focus.
     Catches up correctly even after the tab slept for a long time. */
  check(t, silent) {
    if (t === undefined) t = now();
    const events = []; let guard = 0;
    while (this.status === 'running' && this.durMs - this.elapsed(t) <= 0 && guard++ < 64) {
      const endAt = this.runStart + (this.durMs - this.acc);   // exact end, even if we notice late
      if (this.phase === 'focus') { this.finishFocus(endAt); events.push('focusEnd'); }
      else { this.finishBreak(endAt); events.push('breakEnd'); }
    }
    if (events.length) { this.changed(); UI.onTransition(events, !!silent); return; }
    if (this.status === 'running' && !silent) this.hapticChecks(t);
  },
  hapticChecks(t) {
    const el = this.elapsed(t), rem = this.durMs - el, ivMin = +S.haptics.interval;
    if (this.phase === 'focus' && ivMin > 0) {
      const iv = ivMin * 60000, idx = Math.floor(el / iv);
      if (this.remindIv !== ivMin) { this.remindIv = ivMin; this.remindIdx = idx; }
      else if (idx > this.remindIdx) { this.remindIdx = idx; if (rem > 45000) Haptics.play('reminder'); }
    }
    if (!this.warned && rem <= 60000) { this.warned = true; if (this.durMs > 90000 && rem > 2000) Haptics.play('warn'); }
  },
  changed() {
    this.persist(); this.scheduleEnd();
    if (UI.ready) UI.render();
    if (this.isRunning()) Wake.acquire(); else Wake.release();
  },
  scheduleEnd() {
    clearTimeout(this._endT);
    if (this.status === 'running') this._endT = setTimeout(() => this.check(), Math.min(this.remaining() + 40, 2147483000));
  },
  persist() {
    store.set('timer', { phase: this.phase, status: this.status, durMs: this.durMs, acc: this.acc, runStart: this.runStart, cycle: this.cycle, saved: Date.now() });
  },
  restore() {
    this.durMs = this.focusMs();
    const d = store.get('timer', null);
    if (!d || typeof d !== 'object') return;
    this.cycle = clamp(d.cycle | 0, 0, 4);
    if (!['focus', 'short', 'long'].includes(d.phase) || !['running', 'paused', 'done'].includes(d.status) || !(d.durMs > 0)) return;
    if (d.status === 'done' && Date.now() - (d.saved || 0) > 6 * 3600e3) return;
    this.phase = d.phase; this.status = d.status; this.durMs = +d.durMs;
    this.acc = clamp(+d.acc || 0, 0, this.durMs); this.runStart = +d.runStart || now();
    const el = this.elapsed(), iv = S.haptics.interval * 60000;
    this.remindIv = S.haptics.interval; this.remindIdx = iv ? Math.floor(el / iv) : 0; this.warned = this.durMs - el <= 60000;
    this.check(now(), true);
  }
};

/* =========================================================================
   Scene — canvas rendering of the candle and the ice cube
   ========================================================================= */
const Scene = (() => {
  const cv = $('#scene'), g = cv.getContext('2d'), stageEl = $('#stage');
  let W = 0, H = 0, DPR = 1, rect = null, rectT = null;
  let K = 1, CX = 0, OY = 0, SA = 1;          // scale, scene centre x, scene top y, scene alpha
  let time = 0, modeT = S.mode === 'ice' ? 1 : 0, disp = Timer.visual(now()), lastSid = Timer.sid;
  const X = d => CX + d * K, Y = d => OY + d * K;   // design space (300 × ~350) → pixels

  /* ---------- sizing ---------- */
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxPx = 4.2e6;
    if (W * H * dpr * dpr > maxPx) dpr = Math.max(1, Math.sqrt(maxPx / (W * H)));
    DPR = dpr;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    measure(!rect);
  }
  function measure(snap) {
    const r = stageEl.getBoundingClientRect();
    rectT = { x: r.left, y: r.top, w: Math.max(60, r.width), h: Math.max(60, r.height) };
    if (!rect || snap) rect = Object.assign({}, rectT);
  }

  /* ---------- small drawing helpers ---------- */
  function radialG(x, y, r, stops) {
    const gr = g.createRadialGradient(x, y, 0, x, y, Math.max(0.01, r));
    for (const [o, c] of stops) gr.addColorStop(o, c);
    return gr;
  }
  function glowEllipse(x, y, rx, ry, stops) {
    if (rx <= 0 || ry <= 0) return;
    g.save(); g.translate(x, y); g.scale(1, ry / rx);
    g.fillStyle = radialG(0, 0, rx, stops);
    g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  function lumpy(x, y, rx, ry, seed, amp) {
    g.beginPath();
    const N = 56;
    for (let i = 0; i <= N; i++) {
      const t = i / N * Math.PI * 2;
      const m = 1 + amp * (0.6 * Math.sin(3 * t + seed) + 0.35 * Math.sin(5 * t + seed * 2.1) + 0.2 * Math.sin(9 * t + seed * 0.7));
      const px = x + Math.cos(t) * rx * m, py = y + Math.sin(t) * ry * m;
      if (i) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.closePath();
  }
  /* Rounded polygon where `t` is the tangent distance (how far from each corner the rounding starts).
     Using a tangent distance instead of a radius keeps acute and obtuse corners consistent, so the
     cube's faces line up exactly with its rounded silhouette. */
  function roundPoly(pts, t, mul) {
    const n = pts.length;
    g.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2);
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
      const ax = p0[0] - p1[0], ay = p0[1] - p1[1], bx = p2[0] - p1[0], by = p2[1] - p1[1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      const cos = la && lb ? clamp((ax * bx + ay * by) / (la * lb), -1, 1) : -1;
      if (1 + cos < 1e-6 || la < 1e-6 || lb < 1e-6) { g.lineTo(p1[0], p1[1]); continue; }
      const tt = Math.min(t * (mul ? mul[i] : 1), la * 0.5, lb * 0.5);
      g.arcTo(p1[0], p1[1], p2[0], p2[1], Math.max(0, tt * Math.sqrt(1 - cos * cos) / (1 + cos)));
    }
    g.closePath();
  }
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  const mix = (a, b, t) => [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];

  /* ---------- smooth noise for the flame ---------- */
  function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
  function vnoise(t, seed) { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return lerp(hash(i + seed * 57.3), hash(i + 1 + seed * 57.3), u) * 2 - 1; }
  function fbm(t, seed) { return vnoise(t, seed) * 0.6 + vnoise(t * 2.17 + 3.1, seed + 9) * 0.3 + vnoise(t * 4.63 + 7.7, seed + 19) * 0.1; }

  const fl = { h: 1, w: 1, sway: 0, bright: 1, gust: 0, gustV: 0 };
  function updateFlicker(dt) {
    const amt = REDUCED ? 0.22 : 1, tt = time * (REDUCED ? 0.45 : 1);
    const n1 = fbm(tt * 2.3, 1), n2 = fbm(tt * 7.9, 2), n3 = fbm(tt * 1.15, 3), n4 = fbm(tt * 4.1, 4);
    if (!REDUCED && Math.random() < dt * 0.13) fl.gustV = (Math.random() * 2 - 1) * (0.6 + Math.random() * 0.8);
    fl.gust += (fl.gustV - fl.gust) * Math.min(1, dt * 7);
    fl.gustV *= Math.exp(-dt * 2.6);
    const ag = Math.abs(fl.gust);
    fl.h = 1 + amt * (0.075 * n1 + 0.04 * n2) - ag * 0.13;
    fl.w = 1 + amt * 0.05 * n2 + ag * 0.05;
    fl.sway = amt * (0.35 * n3 + 0.16 * n4) + fl.gust * 0.85;
    fl.bright = 1 + amt * (0.06 * n1 + 0.045 * n2) - ag * 0.12;
  }

  /* ---------- candle state ---------- */
  let flameLvl = Timer.lit() ? 1 : 0, flameUp = true, ember = 0, smokeLeft = 0, smokeAcc = 0, wasLit = flameLvl > 0;
  const wickTipD = () => { const top = 346.5 - 205 * (1 - disp); return [1.3 + fl.sway * 0.7, top - 8.5 + clamp(disp * 25, 0, 1) * 1.4]; };
  const smoke = [], drips = [];
  let nextDrip = 3 + Math.random() * 4, poolBonus = 0;

  function updateFlame(dt, target) {
    const regrown = Math.abs(disp - target) < 0.04;
    const want = Timer.lit() && (flameLvl > 0.02 || regrown);
    if (want) { flameUp = true; flameLvl = Math.min(1, flameLvl + dt / 1.1); }
    else { flameUp = false; flameLvl = Math.max(0, flameLvl - dt / 0.45); }
    if (wasLit && !want) {
      smokeLeft = 3.2; ember = 1;
      if (Math.abs(disp - target) > 0.05) disp = target;   // finished while hidden: don't smoke along a sliding wick
    }
    wasLit = want;
    ember = Math.max(0, ember - dt / 3.4);
  }
  function updateSmoke(dt) {
    if (smokeLeft > 0) {
      smokeLeft -= dt;
      smokeAcc += dt * (REDUCED ? 14 : 38) * Math.sqrt(Math.max(0, smokeLeft) / 3.2);
      const n = Math.floor(smokeAcc);
      const w = wickTipD();
      for (let j = 0; j < n; j++) {   // spread a frame's particles along the path so low frame rates don't make beads
        const age = (j / n) * dt, vy = -(19 + Math.random() * 7);
        smoke.push({ x: w[0], y: w[1] - 1 + vy * age, x0: w[0], y0: w[1], vy, age, life: 3.4 + Math.random() * 1.6, dr: (Math.random() - 0.5) * 3 });
      }
      smokeAcc -= n;
    }
    for (const s of smoke) {
      s.age += dt; s.y += s.vy * dt; s.vy *= Math.pow(0.86, dt);
      const hgt = s.y0 - s.y;
      s.x = s.x0 + Math.sin(hgt * 0.085 - time * 1.4) * Math.min(14, hgt * 0.16) + s.dr * s.age;
    }
    for (let i = smoke.length - 1; i >= 0; i--) if (smoke[i].age > smoke[i].life) smoke.splice(i, 1);
  }
  function spawnDrip(hD) {
    const toBase = Math.random() < 0.3, a0 = hD - 0.6;
    drips.push({
      u: (Math.random() * 2 - 1) * 0.97, a0, len: 0,
      max: toBase ? a0 : Math.min(a0, 10 + Math.pow(Math.random(), 1.5) * 85),
      toBase, speed: 2 + Math.random() * 3.6, w: 3.6 + Math.random() * 3.2, wob: (Math.random() * 2 - 1), fade: 1, dying: false, pooled: false
    });
    if (drips.length > 40) drips.shift();
  }
  function updateDrips(simDt, dt) {
    const keep = Timer.phase === 'focus' && Timer.status !== 'idle';
    const hD = 205 * (1 - disp);
    for (const d of drips) if (d.dying || !keep) d.fade = Math.max(0, d.fade - dt * 1.4);
    if (!keep) poolBonus = Math.max(0, poolBonus - dt * 6);
    if (simDt > 0 && hD > 16) {
      nextDrip -= simDt;
      if (nextDrip <= 0) {
        nextDrip = REDUCED ? 30 + Math.random() * 30 : 11 + Math.random() * 18;
        const visible = drips.filter(d => !d.dying && d.a0 - d.len < hD).length;
        if (visible < 7) spawnDrip(hD);
      }
    }
    if (simDt > 0) for (const d of drips) {
      if (d.len >= d.max) continue;
      const f = 1 - d.len / d.max;
      d.len = Math.min(d.max, d.len + d.speed * simDt * (REDUCED ? 0.6 : 1) * (0.2 + 0.8 * Math.sqrt(f)));
      if (d.len >= d.max - 0.01 && d.toBase && !d.pooled) { d.pooled = true; poolBonus = Math.min(14, poolBonus + 1.1); }
    }
    for (let i = drips.length - 1; i >= 0; i--) { const d = drips[i]; if (d.fade <= 0 || d.a0 - d.len > hD + 3) drips.splice(i, 1); }
  }

  /* ---------- ice state ---------- */
  const drops = [], ripples = [];
  let nextDrop = 2, nextRun = 3, doneRip = 0, wasDone = false;
  function iceGeom(p) {
    const q = Math.max(0, 1 - p), s = 150 * Math.pow(q, 0.8), dx = s * 0.42, dy = -s * 0.3, gy = 325;
    return { q, s, dx, dy, gy, by: gy - dy / 2, x0: -(s + dx) / 2 };
  }
  function addRipple(x, y, rMax, life, a, delay) {
    ripples.push({ x, y, rMax, life, a, t: -(delay || 0) });
    if (ripples.length > 32) ripples.shift();
  }
  function updateIce(simDt, dt) {
    const G = iceGeom(disp);
    const keep = Timer.phase === 'focus' && Timer.status !== 'idle';
    for (const d of drops) {
      if (!keep || G.s < 18) d.dead = true;
      d.a = d.dead ? Math.max(0, d.a - dt * 2.5) : Math.min(1, d.a + dt * 3);
    }
    if (simDt > 0 && G.s > 24) {
      nextDrop -= simDt;
      if (nextDrop <= 0) {
        nextDrop = REDUCED ? 6 + Math.random() * 8 : 1 + Math.random() * 2.4;
        const v = 0.04 + Math.random() * 0.3;
        drops.push({ face: Math.random() < 0.6 ? 0 : 1, u: 0.14 + Math.random() * 0.72, v, v0: v, sz: 1.6 + Math.random() * 1.7, st: 0.3 + Math.random() * 1.2, sp: 0, acc: 0.12 + Math.random() * 0.25, a: 0, sliding: false, dead: false });
        if (drops.length > 24) drops.shift();
      }
      nextRun -= simDt;
      if (nextRun <= 0) {   // water running off the base into the puddle
        nextRun = REDUCED ? 7 + Math.random() * 8 : 2.2 + Math.random() * 3.8;
        const u = Math.random(), front = Math.random() < 0.6;
        addRipple(front ? G.x0 + u * G.s : G.x0 + G.s + u * G.dx, front ? G.by : G.by + u * G.dy, 8 + Math.random() * 10, 1.8 + Math.random() * 0.8, 0.32);
      }
    }
    if (simDt > 0) for (const d of drops) {
      if (d.dead) continue;
      if (d.st > 0) { d.st -= simDt; d.sliding = false; if (d.st <= 0) d.sp = 0.02; continue; }
      d.sliding = true;
      d.sp = Math.min(REDUCED ? 0.25 : 0.55, d.sp + d.acc * simDt);
      d.v += d.sp * simDt;
      if (Math.random() < simDt * 0.25 && d.v < 0.8) d.st = 0.3 + Math.random() * 0.9;   // stick-slip
      if (d.v >= 0.985) {
        d.dead = true; d.a = 0;
        addRipple(d.face === 0 ? G.x0 + d.u * G.s : G.x0 + G.s + d.u * G.dx, d.face === 0 ? G.by : G.by + d.u * G.dy, 10 + Math.random() * 8, 2, 0.4);
      }
    }
    for (let i = drops.length - 1; i >= 0; i--) if (drops[i].dead && drops[i].a <= 0) drops.splice(i, 1);

    const done = Timer.phase === 'focus' && Timer.status === 'done' && disp > 0.999;
    if (done && !wasDone) {
      addRipple(0, G.gy + 1, 95, 3.4, 0.34, 0.1); addRipple(0, G.gy + 1, 135, 3.6, 0.28, 0.75); addRipple(0, G.gy + 1, 170, 3.8, 0.2, 1.4);
      doneRip = 6;
    }
    if (done && !REDUCED) {
      doneRip -= dt;
      if (doneRip <= 0) { doneRip = 5 + Math.random() * 4; addRipple((Math.random() - 0.5) * 60, G.gy + (Math.random() - 0.5) * 8, 70 + Math.random() * 60, 3.6, 0.2); }
    }
    wasDone = done;
    for (const r of ripples) r.t += dt;
    for (let i = ripples.length - 1; i >= 0; i--) if (ripples[i].t > ripples[i].life) ripples.splice(i, 1);
  }

  /* ---------- candle drawing ---------- */
  function drawFlame(bx, by) {
    const lvl = flameLvl; if (lvl <= 0.002) return;
    const c1 = 1.70158, c3 = c1 + 1, x = lvl - 1;
    const grow = flameUp ? 1 + c3 * x * x * x + c1 * x * x : Math.pow(lvl, 0.7);   // ease-out-back when lighting
    const k = K, fh = 50 * k * fl.h * grow, fw = 12.5 * k * fl.w * (0.55 + 0.45 * grow), sw = fl.sway * 7 * k * grow;
    const flamePath = (w, h, s, oy) => {
      const y = by + oy;
      g.beginPath();
      g.moveTo(bx, y + w * 0.3);
      g.bezierCurveTo(bx - w * 1.1, y + w * 0.15, bx - w * 0.9 + s * 0.3, y - h * 0.45, bx + s, y - h);
      g.bezierCurveTo(bx + w * 0.9 + s * 0.3, y - h * 0.45, bx + w * 1.1, y + w * 0.15, bx, y + w * 0.3);
      g.closePath();
    };
    g.save();
    g.globalCompositeOperation = 'lighter';
    const hx = bx + sw * 0.3, hy = by - fh * 0.42, hr = 60 * k;
    g.fillStyle = radialG(hx, hy, hr, [[0, rgba(255, 200, 120, 0.34 * lvl)], [0.35, rgba(255, 160, 70, 0.12 * lvl)], [1, 'rgba(255,140,60,0)']]);
    g.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
    flamePath(fw, fh, sw, 0);
    const lg = g.createLinearGradient(0, by + fw * 0.3, 0, by - fh);
    lg.addColorStop(0, 'rgba(255,110,30,0)');
    lg.addColorStop(0.1, rgba(255, 130, 40, 0.55 * lvl));
    lg.addColorStop(0.36, rgba(255, 186, 82, 0.92 * lvl));
    lg.addColorStop(0.72, rgba(255, 150, 55, 0.7 * lvl));
    lg.addColorStop(1, 'rgba(255,90,30,0)');
    g.fillStyle = lg; g.fill();
    flamePath(fw * 0.52, fh * 0.56, sw * 0.55, -fh * 0.04);
    const cg = g.createLinearGradient(0, by + fw * 0.2, 0, by - fh * 0.6);
    cg.addColorStop(0, 'rgba(90,130,255,0)');
    cg.addColorStop(0.12, rgba(110, 150, 255, 0.5 * lvl));
    cg.addColorStop(0.3, rgba(255, 250, 235, 0.95 * lvl));
    cg.addColorStop(0.76, rgba(255, 238, 200, 0.6 * lvl));
    cg.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = cg; g.fill();
    g.restore();
  }

  function drawCandle(p) {
    const k = K, cx = CX;
    const groundY = Y(352), baseY = Y(346.5);
    const hw = 37 * k, ery = 12.5 * k;
    const h = 205 * k * (1 - p), topY = baseY - h;
    const I = flameLvl * fl.bright;
    const rimAmt = clamp(p * 25, 0, 1);
    const lip = t => rimAmt * k * (1.3 + 0.8 * Math.sin(t * 2 + 0.8) + 0.5 * Math.sin(t * 5 + 2.2));
    const rim = t => [cx + Math.cos(t) * hw, topY + Math.sin(t) * ery - lip(t)];
    const sw = fl.sway, lc = clamp(0.5 + sw * 0.06, 0.38, 0.62);
    const wickTip = [cx + (1.3 + sw * 0.7) * k, topY - 8.5 * k + rimAmt * 1.4 * k];
    const flameBase = [wickTip[0], wickTip[1] + 3.5 * k];
    const fh = 50 * k * fl.h;

    // warm light on the room
    if (I > 0.003) {
      const gx = flameBase[0] + sw * 3 * k, gy = flameBase[1] - fh * 0.4;
      g.fillStyle = radialG(gx, gy, Math.max(W, H) * 0.8, [[0, rgba(255, 176, 96, 0.2 * I)], [0.1, rgba(255, 150, 70, 0.11 * I)], [0.35, rgba(200, 105, 45, 0.045 * I)], [1, 'rgba(120,60,20,0)']]);
      g.fillRect(0, 0, W, H);
      glowEllipse(cx + sw * 4 * k, groundY, 250 * k, 48 * k, [[0, rgba(255, 175, 100, 0.17 * I)], [0.5, rgba(255, 150, 80, 0.06 * I)], [1, 'rgba(255,150,80,0)']]);
    }
    glowEllipse(cx, groundY + 4 * k, 104 * k, 21 * k, [[0, 'rgba(0,0,0,0.45)'], [1, 'rgba(0,0,0,0)']]);

    // dish
    g.fillStyle = '#12141b'; g.beginPath(); g.ellipse(cx, groundY + 4 * k, 86 * k, 18 * k, 0, 0, Math.PI * 2); g.fill();
    const dg = g.createLinearGradient(0, groundY - 18 * k, 0, groundY + 18 * k);
    dg.addColorStop(0, '#2d303a'); dg.addColorStop(1, '#191b23');
    g.fillStyle = dg; g.beginPath(); g.ellipse(cx, groundY, 86 * k, 17.5 * k, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.beginPath(); g.ellipse(cx, groundY + k, 74 * k, 13.5 * k, 0, 0, Math.PI * 2); g.fill();
    g.lineWidth = Math.max(1, 1.2 * k);
    g.strokeStyle = rgba(255, 190, 120, 0.06 + 0.3 * I);
    g.beginPath(); g.ellipse(cx, groundY, 86 * k, 17.5 * k, 0, Math.PI * 1.04, Math.PI * 1.96); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.beginPath(); g.ellipse(cx, groundY, 86 * k, 17.5 * k, 0, 0.1, Math.PI - 0.1); g.stroke();

    // wax pooled on the dish
    const pr = Math.min(80 * k, hw + (5 + 46 * Math.pow(p, 0.85) + poolBonus) * k), pcy = baseY + 1.5 * k;
    const lumpAmt = 0.035 * clamp(p * 6, 0, 1);
    lumpy(cx, pcy, pr, pr * 0.2, 1.7, lumpAmt);
    const wg = g.createLinearGradient(0, pcy - pr * 0.2, 0, pcy + pr * 0.2);
    wg.addColorStop(0, '#efe0c4'); wg.addColorStop(1, '#c9b08b');
    g.fillStyle = wg; g.fill();
    g.strokeStyle = 'rgba(255,245,225,0.28)'; g.lineWidth = Math.max(0.8, 0.9 * k); g.stroke();
    g.save(); g.clip();
    if (I > 0) glowEllipse(cx, pcy, pr, pr * 0.2, [[0, rgba(255, 190, 110, 0.38 * I)], [1, 'rgba(255,190,110,0)']]);
    if (I < 1) { g.fillStyle = rgba(10, 8, 14, 0.32 * (1 - I)); g.fillRect(cx - pr - 2, pcy - pr, pr * 2 + 4, pr * 2); }
    g.restore();

    if (h > 0.8 * k) {
      // body
      g.beginPath();
      g.moveTo(cx - hw, rim(Math.PI)[1]);
      g.lineTo(cx - hw, baseY);
      g.ellipse(cx, baseY, hw, ery, 0, Math.PI, 0, true);
      g.lineTo(cx + hw, rim(0)[1]);
      for (let i = 0; i <= 28; i++) { const q = rim(i / 28 * Math.PI); g.lineTo(q[0], q[1]); }
      g.closePath();
      const bg = g.createLinearGradient(cx - hw, 0, cx + hw, 0);
      bg.addColorStop(0, '#8e7558'); bg.addColorStop(0.16, '#c7ae8b'); bg.addColorStop(lc - 0.12, '#e9dcc4');
      bg.addColorStop(lc, '#f6eddc'); bg.addColorStop(lc + 0.16, '#e2d0b2'); bg.addColorStop(0.86, '#b89d79'); bg.addColorStop(1, '#836a4e');
      g.fillStyle = bg; g.fill();
      g.save(); g.clip();
      const bx0 = cx - hw - 2, bw = hw * 2 + 4;
      if (I < 1) { g.fillStyle = rgba(10, 8, 14, 0.36 * (1 - I)); g.fillRect(bx0, topY - 20 * k, bw, h + 40 * k); }
      if (I > 0) {   // wax glows near the flame
        const sg = g.createLinearGradient(0, topY - 4 * k, 0, topY + 75 * k);
        sg.addColorStop(0, rgba(255, 168, 80, 0.5 * I)); sg.addColorStop(0.45, rgba(255, 150, 70, 0.14 * I)); sg.addColorStop(1, 'rgba(255,140,60,0)');
        g.fillStyle = sg; g.fillRect(bx0, topY - 20 * k, bw, Math.min(h + 40 * k, 120 * k));
      }
      const ao = g.createLinearGradient(0, baseY - 30 * k, 0, baseY + ery);
      ao.addColorStop(0, 'rgba(30,18,8,0)'); ao.addColorStop(1, 'rgba(30,18,8,0.32)');
      g.fillStyle = ao; g.fillRect(bx0, baseY - 30 * k, bw, 30 * k + ery + 2);
      g.restore();

      // drips running down the sides (same wax as the body, catching a little more light)
      const stops = [[0, [142, 117, 88]], [0.16, [199, 174, 139]], [lc - 0.12, [233, 220, 196]], [lc, [246, 237, 220]], [lc + 0.16, [226, 208, 178]], [0.86, [184, 157, 121]], [1, [131, 106, 78]]];
      const bodyCol = f => { for (let n = 1; n < stops.length; n++) if (f <= stops[n][0]) { const a = stops[n - 1], b = stops[n]; return mix(a[1], b[1], (f - a[0]) / Math.max(1e-6, b[0] - a[0])); } return stops[stops.length - 1][1]; };
      const shade = (c, f) => 'rgb(' + c.map(v => Math.round(clamp(v * f, 0, 255))).join(',') + ')';
      for (const d of drips) {
        const sq = Math.sqrt(Math.max(0, 1 - d.u * d.u));
        const x = cx + d.u * hw;
        const startY = baseY - d.a0 * k + ery * sq;
        const rimY = topY + ery * sq - lip(Math.acos(clamp(d.u, -1, 1)));
        const y1 = Math.max(startY, rimY - k), y2 = startY + Math.max(d.len, 0.5) * k;
        if (y2 <= y1 + 0.5 * k || d.fade <= 0) continue;
        const L = y2 - y1;
        const wd = d.w * k * (0.7 + 0.3 * Math.min(1, d.len / 8)), br = wd * 0.55;
        const xb = x + d.wob * wd * 0.6 * Math.min(1, d.len / 30);
        const flare = Math.max(wd * 0.32, Math.min(wd * 0.95, L * 0.5));   // widens where it leaves the rim
        let col = bodyCol(clamp((d.u + 1) / 2, 0, 1));
        if (I < 1) col = mix(col, [70, 58, 50], 0.3 * (1 - I));
        g.globalAlpha = SA * d.fade;
        // soft cast shadow on the body
        g.strokeStyle = 'rgba(60,40,20,0.12)'; g.lineWidth = wd * 0.5; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x + wd * 0.45, y1 + wd); g.quadraticCurveTo(lerp(x, xb, 0.6) + wd * 0.55, lerp(y1, y2, 0.6), xb + br * 0.9, y2 - br * 0.6); g.stroke();
        g.beginPath();
        g.moveTo(x - flare, y1);
        g.quadraticCurveTo(x - wd * 0.3, y1, x - wd * 0.3, Math.min(y1 + wd * 1.2, lerp(y1, y2, 0.3)));
        g.bezierCurveTo(x - wd * 0.3, lerp(y1, y2, 0.6), xb - wd * 0.38, lerp(y1, y2, 0.82), xb - br, y2 - br);
        g.arc(xb, y2 - br, br, Math.PI, 0, true);
        g.bezierCurveTo(xb + wd * 0.38, lerp(y1, y2, 0.82), x + wd * 0.3, lerp(y1, y2, 0.6), x + wd * 0.3, Math.min(y1 + wd * 1.2, lerp(y1, y2, 0.3)));
        g.quadraticCurveTo(x + wd * 0.3, y1, x + flare, y1);
        g.closePath();
        const dgr = g.createLinearGradient(xb - br, 0, xb + br, 0);
        dgr.addColorStop(0, shade(col, 0.98)); dgr.addColorStop(0.38, shade(col, 1.05)); dgr.addColorStop(1, shade(col, 0.86));
        g.fillStyle = dgr; g.fill();
        g.strokeStyle = 'rgba(255,251,242,0.3)'; g.lineWidth = Math.max(0.6, wd * 0.1);
        g.beginPath(); g.moveTo(x - wd * 0.1, y1 + 2 * k); g.quadraticCurveTo(lerp(x, xb, 0.6) - wd * 0.12, lerp(y1, y2, 0.6), xb - br * 0.35, y2 - br * 1.1); g.stroke();
        if (I > 0) { g.fillStyle = rgba(255, 252, 244, d.len < d.max ? 0.5 : 0.28); g.beginPath(); g.arc(xb - br * 0.32, y2 - br * 1.15, br * 0.24, 0, Math.PI * 2); g.fill(); }
        g.globalAlpha = SA;
      }
      g.lineCap = 'butt';

      // top surface + molten pool
      g.beginPath();
      for (let i = 0; i <= 44; i++) { const q = rim(i / 44 * Math.PI * 2); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }
      g.closePath();
      const tg = g.createLinearGradient(cx - hw, 0, cx + hw, 0);
      tg.addColorStop(0, '#cdb894'); tg.addColorStop(lc, '#f8f0e1'); tg.addColorStop(1, '#c4ab86');
      g.fillStyle = tg; g.fill();
      if (I < 1) { g.fillStyle = rgba(10, 8, 14, 0.3 * (1 - I)); g.fill(); }
      const poolR = hw * (0.34 + 0.48 * clamp(p * 30, 0, 1)), pry = poolR * (ery / hw) * 0.95, pcy2 = topY + 1.2 * k * rimAmt;
      g.beginPath(); g.ellipse(cx, pcy2, poolR, pry, 0, 0, Math.PI * 2);
      g.fillStyle = '#e7d6b8'; g.fill();
      if (I > 0) {
        g.save(); g.clip();
        glowEllipse(cx, pcy2, poolR * 1.05, pry * 1.05, [[0, rgba(255, 196, 110, 0.85 * I)], [0.55, rgba(255, 175, 95, 0.45 * I)], [1, rgba(255, 170, 90, 0.08 * I)]]);
        g.restore();
      } else { g.fillStyle = 'rgba(10,8,14,0.25)'; g.fill(); }
      g.beginPath(); g.ellipse(cx, pcy2, poolR, pry, 0, 0, Math.PI * 2);
      g.strokeStyle = rgba(255, 244, 222, 0.42); g.lineWidth = Math.max(0.6, 0.8 * k); g.stroke();
    } else if (I > 0) {
      glowEllipse(cx, baseY, hw * 0.9, ery * 0.9, [[0, rgba(255, 196, 110, 0.6 * I)], [1, 'rgba(255,170,90,0)']]);
    }

    // wick
    g.strokeStyle = '#2a1c13'; g.lineWidth = Math.max(1, 1.7 * k); g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx, topY + 1.2 * k); g.quadraticCurveTo(cx - 0.6 * k, topY - 4.5 * k, wickTip[0], wickTip[1]); g.stroke();
    const em = Math.max(ember, flameLvl * 0.9);
    if (em > 0.01) {
      g.save(); g.globalCompositeOperation = 'lighter';
      const er = 3.4 * k;
      g.fillStyle = radialG(wickTip[0], wickTip[1], er, [[0, rgba(255, 150, 60, 0.95 * em)], [0.5, rgba(255, 90, 30, 0.5 * em)], [1, 'rgba(255,80,20,0)']]);
      g.fillRect(wickTip[0] - er, wickTip[1] - er, er * 2, er * 2);
      g.restore();
    }
    drawFlame(flameBase[0], flameBase[1]);

    // smoke wisp — drawn as a ribbon through consecutive particles so it stays continuous
    if (smoke.length > 1) {
      g.lineCap = 'round';
      for (let i = 1; i < smoke.length; i++) {
        const s0 = smoke[i - 1], s1 = smoke[i], u = s1.age / s1.life;
        if (Math.abs(s0.y - s1.y) > 25 || Math.abs(s0.x - s1.x) > 25) continue;
        const a = 0.15 * Math.pow(Math.max(0, 1 - u), 1.5) * Math.min(1, s1.age * 5);
        if (a <= 0.002) continue;
        g.strokeStyle = rgba(205, 205, 214, a);
        g.lineWidth = (1.2 + s1.age * 3.2) * k;
        g.beginPath(); g.moveTo(X(s0.x), Y(s0.y)); g.lineTo(X(s1.x), Y(s1.y)); g.stroke();
      }
      g.lineCap = 'butt';
    }
  }

  /* ---------- ice drawing ---------- */
  function sparkle(x, y, r, a) {
    if (a <= 0.01 || r <= 0.5) return;
    g.fillStyle = rgba(255, 255, 255, a);
    g.beginPath(); g.ellipse(x, y, r, r * 0.12, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(x, y, r * 0.12, r, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = radialG(x, y, r * 0.6, [[0, rgba(255, 255, 255, a)], [1, 'rgba(255,255,255,0)']]);
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const BUBBLES = (() => { const r = rng(2024), out = []; for (let i = 0; i < 16; i++) out.push({ u: 0.15 + r() * 0.7, v: 0.15 + r() * 0.7, w: 0.1 + r() * 0.8, r: 0.6 + r() * 1.7 }); return out; })();

  function drawIce(p) {
    const k = K, cx = CX, G = iceGeom(p);
    const s = G.s * k, dx = G.dx * k, dy = G.dy * k, by = Y(G.by), x0 = X(G.x0), gy = Y(G.gy);
    const cubeA = clamp(G.q / 0.035, 0, 1);
    const r = s * (0.055 + 0.3 * Math.pow(p, 0.85));          // corner rounding grows as it melts
    const edgeA = 1 - 0.75 * smooth(clamp(p, 0, 1));
    const breathe = REDUCED ? 1 : 1 + 0.05 * Math.sin(time * 0.4);

    const FLb = [x0, by], FRb = [x0 + s, by], FRt = [x0 + s, by - s], FLt = [x0, by - s];
    const BRb = [x0 + s + dx, by + dy], BRt = [x0 + s + dx, by - s + dy], BLt = [x0 + dx, by - s + dy], BLb = [x0 + dx, by + dy];
    const sil = [FLb, FRb, BRb, BRt, BLt, FLt], front = [FLb, FRb, FRt, FLt], right = [FRb, BRb, BRt, FRt], top = [FLt, FRt, BRt, BLt];

    // cool ambient light
    g.fillStyle = radialG(cx, gy - 100 * k, Math.max(W, H) * 0.7, [[0, rgba(120, 180, 255, 0.12 * breathe)], [0.25, rgba(80, 140, 230, 0.05)], [1, 'rgba(40,80,160,0)']]);
    g.fillRect(0, 0, W, H);
    glowEllipse(cx, gy + 4 * k, 240 * k, 46 * k, [[0, rgba(140, 195, 255, 0.1)], [1, 'rgba(140,195,255,0)']]);
    if (cubeA > 0) {
      glowEllipse(cx, gy + 2 * k, (s + dx) * 0.62 + 6 * k, s * 0.21 + 4 * k, [[0, rgba(0, 8, 20, 0.5 * cubeA)], [1, 'rgba(0,8,20,0)']]);
      // light refracted through the ice onto the surface
      glowEllipse(cx + (s + dx) * 0.42, gy + s * 0.1, s * 0.5, s * 0.1, [[0, rgba(175, 225, 255, 0.16 * cubeA)], [1, 'rgba(175,225,255,0)']]);
    }

    // puddle
    const pa = clamp(p * 12, 0, 1);
    if (pa > 0.001) {
      const prx = Math.min((22 + 152 * Math.pow(p, 0.72)) * k, W * 0.47), pry = prx * 0.27, pcy = gy + 1.5 * k;
      const wob = REDUCED ? 0 : Math.sin(time * 0.35) * 0.25;
      g.save(); g.globalAlpha = SA * pa;
      lumpy(cx, pcy, prx, pry, 0.7 + wob, 0.03);
      const pg = g.createLinearGradient(0, pcy - pry, 0, pcy + pry);
      pg.addColorStop(0, rgba(80, 135, 200, 0.3)); pg.addColorStop(1, rgba(25, 55, 105, 0.46));
      g.fillStyle = pg; g.fill();
      g.save(); g.clip();
      glowEllipse(cx - prx * 0.2, pcy - pry * 0.25, prx * 0.7, pry * 0.7, [[0, rgba(170, 215, 255, 0.2)], [1, 'rgba(170,215,255,0)']]);
      if (cubeA > 0.01 && s > 2) {   // reflection of the cube
        g.save(); g.translate(0, 2 * by); g.scale(1, -1);
        g.beginPath(); roundPoly(sil, r);
        const rg = g.createLinearGradient(0, by, 0, by - s * 0.6);
        rg.addColorStop(0, rgba(175, 222, 255, 0.2 * cubeA)); rg.addColorStop(1, 'rgba(175,222,255,0)');
        g.fillStyle = rg; g.fill();
        g.restore();
      }
      glowEllipse(cx + prx * 0.22, pcy + pry * 0.2, prx * 0.35, pry * 0.45, [[0, rgba(190, 235, 255, 0.16)], [1, 'rgba(190,235,255,0)']]);
      for (const rp of ripples) {
        const u = rp.t / rp.life; if (u < 0 || u >= 1) continue;
        const rr = rp.rMax * (1 - Math.pow(1 - u, 2.2)) * k, a = rp.a * Math.pow(1 - u, 1.6);
        g.strokeStyle = rgba(205, 238, 255, a); g.lineWidth = Math.max(0.6, (1.3 - u) * k);
        g.beginPath(); g.ellipse(X(rp.x), Y(rp.y), Math.max(0.1, rr), Math.max(0.1, rr * 0.27), 0, 0, Math.PI * 2); g.stroke();
        if (u > 0.15) {
          const r2 = rr * 0.6; g.strokeStyle = rgba(205, 238, 255, a * 0.55);
          g.beginPath(); g.ellipse(X(rp.x), Y(rp.y), r2, r2 * 0.27, 0, 0, Math.PI * 2); g.stroke();
        }
      }
      g.restore();
      lumpy(cx, pcy, prx, pry, 0.7 + wob, 0.03);
      g.strokeStyle = rgba(195, 232, 255, 0.34); g.lineWidth = Math.max(1, 1.1 * k); g.stroke();
      g.restore();
    }

    if (cubeA <= 0.001 || s < 1.5) return;
    g.save(); g.globalAlpha = SA * cubeA;
    g.beginPath(); roundPoly(sil, r);
    const bgr = g.createLinearGradient(x0, by - s + dy, x0 + s + dx, by);
    bgr.addColorStop(0, rgba(205, 238, 255, 0.22)); bgr.addColorStop(1, rgba(110, 170, 235, 0.16));
    g.fillStyle = bgr; g.fill();
    g.save(); g.clip();
    // back edges seen through the ice
    g.strokeStyle = rgba(200, 235, 255, 0.12 * edgeA); g.lineWidth = Math.max(0.8, k);
    g.beginPath(); g.moveTo(BLb[0], BLb[1]); g.lineTo(BLt[0], BLt[1]); g.moveTo(BLb[0], BLb[1]); g.lineTo(FLb[0], FLb[1]); g.moveTo(BLb[0], BLb[1]); g.lineTo(BRb[0], BRb[1]); g.stroke();
    // cloudy core
    const ccx = x0 + s / 2 + dx / 2, ccy = by - s / 2 + dy / 2;
    g.fillStyle = radialG(ccx, ccy, s * 0.55, [[0, rgba(238, 249, 255, 0.34)], [0.5, rgba(215, 238, 255, 0.12)], [1, 'rgba(200,230,255,0)']]);
    g.fillRect(x0 - 2, by - s + dy - 2, s + dx + 4, s - dy + 4);
    // trapped bubbles and a hairline crack
    const bs = Math.max(0.3, Math.sqrt(G.s / 150));
    for (const b of BUBBLES) {
      const bx = x0 + b.u * s + b.w * dx, byy = by - b.v * s + b.w * dy, br = b.r * k * bs;
      g.strokeStyle = rgba(232, 248, 255, 0.32); g.lineWidth = Math.max(0.5, 0.5 * k);
      g.fillStyle = rgba(255, 255, 255, 0.07);
      g.beginPath(); g.arc(bx, byy, br, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = rgba(255, 255, 255, 0.55); g.beginPath(); g.arc(bx - br * 0.35, byy - br * 0.35, br * 0.3, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = rgba(230, 246, 255, 0.11); g.lineWidth = Math.max(0.6, 0.7 * k);
    g.beginPath(); g.moveTo(x0 + s * 0.3 + dx * 0.4, by - s * 0.7 + dy * 0.4);
    g.quadraticCurveTo(x0 + s * 0.5 + dx * 0.5, by - s * 0.48 + dy * 0.5, x0 + s * 0.42 + dx * 0.6, by - s * 0.25 + dy * 0.6);
    g.moveTo(x0 + s * 0.5 + dx * 0.5, by - s * 0.48 + dy * 0.5); g.lineTo(x0 + s * 0.68 + dx * 0.45, by - s * 0.42 + dy * 0.45); g.stroke();
    // faces
    const inner = 0.3 + 0.7 * smooth(clamp(p * 1.4, 0, 1));   // the corner where three faces meet stays crisper
    const mF = [1, 1, inner, 1], mR = [1, 1, 1, inner], mT = [1, inner, 1, 1];
    g.beginPath(); roundPoly(front, r, mF);
    const fg = g.createLinearGradient(0, by - s, 0, by);
    fg.addColorStop(0, rgba(185, 228, 255, 0.1)); fg.addColorStop(1, rgba(120, 180, 240, 0.2));
    g.fillStyle = fg; g.fill();
    g.beginPath(); roundPoly(right, r, mR);
    const rgd = g.createLinearGradient(x0 + s, 0, x0 + s + dx, 0);
    rgd.addColorStop(0, rgba(90, 150, 220, 0.24)); rgd.addColorStop(1, rgba(50, 100, 170, 0.32));
    g.fillStyle = rgd; g.fill();
    g.beginPath(); roundPoly(top, r, mT);
    const tgd = g.createLinearGradient(BLt[0], BLt[1], FRt[0], FRt[1]);
    tgd.addColorStop(0, rgba(240, 252, 255, 0.36)); tgd.addColorStop(1, rgba(190, 230, 255, 0.16));
    g.fillStyle = tgd; g.fill();
    // refraction bands across the front
    g.save(); g.beginPath(); roundPoly(front, r, mF); g.clip();
    for (const [b, a] of [[0.3, 0.1], [0.66, 0.07]]) {
      g.save(); g.translate(x0 + b * s, by - s / 2); g.rotate(-0.35);
      const band = g.createLinearGradient(-s * 0.05, 0, s * 0.05, 0);
      band.addColorStop(0, 'rgba(255,255,255,0)'); band.addColorStop(0.5, rgba(235, 250, 255, a)); band.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = band; g.fillRect(-s * 0.05, -s, s * 0.1, s * 2);
      g.restore();
    }
    g.restore();
    // frosted, milky edges (internal reflection) — a wide stroke clipped to the inside
    g.beginPath(); roundPoly(sil, r); g.strokeStyle = rgba(235, 248, 255, 0.09); g.lineWidth = s * 0.16; g.stroke();
    g.lineWidth = s * 0.05; g.strokeStyle = rgba(240, 250, 255, 0.08); g.stroke();
    g.beginPath(); roundPoly(top, r, mT); g.strokeStyle = rgba(240, 250, 255, 0.07 * edgeA); g.lineWidth = s * 0.06; g.stroke();
    // slow shimmer sweeping across
    if (!REDUCED) {
      const ph = (time % 9) / 9;
      if (ph < 0.45) {
        const u = ph / 0.45, sx = lerp(x0 - s * 0.4, x0 + s + dx + s * 0.4, u);
        g.save(); g.globalCompositeOperation = 'lighter'; g.translate(sx, by - s / 2); g.rotate(-0.5);
        const sh = g.createLinearGradient(-s * 0.12, 0, s * 0.12, 0);
        sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, rgba(220, 245, 255, 0.11 * Math.sin(Math.PI * u))); sh.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = sh; g.fillRect(-s * 0.12, -s * 1.5, s * 0.24, s * 3);
        g.restore();
      }
    }
    // water film at the bottom where it sits in the puddle
    if (pa > 0.01) {
      const wf = g.createLinearGradient(0, by - 10 * k, 0, by + 2 * k);
      wf.addColorStop(0, 'rgba(160,215,255,0)'); wf.addColorStop(1, rgba(160, 215, 255, 0.22 * pa));
      g.fillStyle = wf; g.fillRect(x0 - 2, by - 10 * k, s + dx + 4, 12 * k);
    }
    g.restore();

    // edges
    g.lineJoin = 'round';
    g.beginPath(); roundPoly(sil, r); g.strokeStyle = rgba(215, 242, 255, 0.5); g.lineWidth = Math.max(1, 1.2 * k); g.stroke();
    const inner2 = 0.3 + 0.7 * smooth(clamp(p * 1.4, 0, 1)), mT2 = [1, inner2, 1, 1], mF2 = [1, 1, inner2, 1];
    g.beginPath(); roundPoly(top, r, mT2); g.strokeStyle = rgba(240, 252, 255, 0.5 * edgeA); g.lineWidth = Math.max(0.8, k); g.stroke();
    g.beginPath(); roundPoly(front, r, mF2); g.strokeStyle = rgba(225, 245, 255, 0.2 * edgeA); g.stroke();

    // speculars
    g.save(); g.globalCompositeOperation = 'lighter';
    const tx = lerp(FLt[0], BRt[0], 0.3), ty = lerp(FLt[1], BRt[1], 0.3);
    g.fillStyle = radialG(tx, ty, s * 0.22, [[0, rgba(255, 255, 255, 0.36)], [1, 'rgba(255,255,255,0)']]);
    g.fillRect(tx - s * 0.25, ty - s * 0.25, s * 0.5, s * 0.5);
    const sy1 = by - s * 0.86, sy2 = by - s * 0.38;
    const sg = g.createLinearGradient(0, sy1, 0, sy2);
    sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.35, rgba(255, 255, 255, 0.16 * edgeA + 0.06)); sg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sg; roundRect(x0 + s * 0.12, sy1, s * 0.045, sy2 - sy1, s * 0.022); g.fill();
    g.strokeStyle = rgba(255, 255, 255, 0.3 * edgeA); g.lineWidth = Math.max(0.8, k);
    g.beginPath(); g.moveTo(FRt[0] - 1.2 * k, FRt[1] + r + 2 * k); g.lineTo(FRb[0] - 1.2 * k, FRb[1] - r - 2 * k); g.stroke();
    if (!REDUCED) { const tw = 0.5 + 0.5 * Math.sin(time * 1.1); sparkle(FRt[0] - r * 0.25, FRt[1] + r * 0.25, s * 0.06 * (0.6 + 0.4 * tw), 0.4 * tw * edgeA); }
    g.restore();

    // droplets sliding down the faces
    if (drops.length) {
      g.save(); g.beginPath(); roundPoly(sil, r); g.clip();
      const pt = (d, v) => d.face === 0 ? [x0 + d.u * s, by - s + v * s] : [x0 + s + d.u * dx, by - s + d.u * dy + v * s];
      for (const d of drops) {
        if (d.a <= 0.01) continue;
        const [x, y] = pt(d, d.v), y0 = pt(d, d.v0)[1];
        const rr = Math.max(0.9, d.sz * k * (0.55 + 0.45 * Math.sqrt(G.s / 150)));
        if (y - y0 > 2) {
          const tg = g.createLinearGradient(0, y0, 0, y);
          tg.addColorStop(0, 'rgba(210,240,255,0)'); tg.addColorStop(1, rgba(210, 240, 255, 0.22 * d.a));
          g.strokeStyle = tg; g.lineWidth = rr * 0.7; g.lineCap = 'round';
          g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y - rr * 0.5); g.stroke();
        }
        g.fillStyle = radialG(x - rr * 0.25, y - rr * 0.3, rr * 1.3, [[0, rgba(255, 255, 255, 0.55 * d.a)], [0.45, rgba(200, 235, 255, 0.22 * d.a)], [1, rgba(120, 180, 230, 0.35 * d.a)]]);
        g.beginPath(); g.ellipse(x, y, rr * 0.85, rr * (d.sliding ? 1.2 : 1.05), 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = rgba(20, 50, 90, 0.35 * d.a); g.lineWidth = Math.max(0.5, rr * 0.18);
        g.beginPath(); g.ellipse(x, y, rr * 0.85, rr * 1.1, 0, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
        g.fillStyle = rgba(255, 255, 255, 0.85 * d.a);
        g.beginPath(); g.arc(x - rr * 0.3, y - rr * 0.38, rr * 0.22, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }
    // meniscus line where ice meets water
    if (pa > 0.01) {
      g.strokeStyle = rgba(205, 240, 255, 0.4 * pa); g.lineWidth = Math.max(1, 1.3 * k);
      g.beginPath(); g.moveTo(FLb[0] + r * 0.9, by - 0.6 * k); g.lineTo(FRb[0] - r * 0.6, by - 0.6 * k); g.stroke();
    }
    g.restore();
  }

  /* ---------- per-frame ---------- */
  function frame(dt, t) {
    time += dt;
    if (rectT) {
      const f = 1 - Math.exp(-dt * 9);
      rect.x += (rectT.x - rect.x) * f; rect.y += (rectT.y - rect.y) * f;
      rect.w += (rectT.w - rect.w) * f; rect.h += (rectT.h - rect.h) * f;
    }
    K = Math.min(rect.w / 300, rect.h / 350); CX = rect.x + rect.w / 2; OY = rect.y + rect.h / 2 - 205 * K;

    const mt = S.mode === 'ice' ? 1 : 0;
    modeT += (mt - modeT) * (1 - Math.exp(-dt * 4.5));
    if (Math.abs(mt - modeT) < 0.002) modeT = mt;

    if (Timer.sid !== lastSid) {   // a new phase began: let old drips/droplets fade away
      lastSid = Timer.sid;
      for (const d of drips) d.dying = true;
      for (const d of drops) d.dead = true;
      poolBonus = Timer.phase === 'focus' ? 0 : poolBonus;
    }
    const target = Timer.visual(t), diff = target - disp;
    if (Math.abs(diff) > 0.003) disp += diff * (1 - Math.exp(-dt * 4.2));   // ease only after big jumps (reset, waking up)
    else disp = target;                                                       // otherwise exact and continuous

    const simDt = Timer.melting() ? dt : 0;
    updateFlicker(dt); updateFlame(dt, target); updateSmoke(dt); updateDrips(simDt, dt); updateIce(simDt, dt);

    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);
    g.lineCap = 'butt'; g.lineJoin = 'miter';
    if (modeT < 0.999) { SA = 1 - modeT; g.globalAlpha = SA; drawCandle(disp); }
    if (modeT > 0.001) { SA = modeT; g.globalAlpha = SA; g.lineCap = 'butt'; drawIce(disp); }
    g.globalAlpha = 1;
  }

  function simulate(seconds) {   // debug: fast-forward particle simulation
    const step = 1 / 30;
    for (let s = 0; s < seconds; s += step) { time += step; const simDt = Timer.melting() ? step : 0; updateFlicker(step); updateFlame(step, Timer.visual(now())); updateSmoke(step); updateDrips(simDt, step); updateIce(simDt, step); }
  }

  return {
    frame, resize, measure,
    snap() { disp = Timer.visual(now()); modeT = S.mode === 'ice' ? 1 : 0; rect = Object.assign({}, rectT); },
    simulate,
    get disp() { return disp; },
    get counts() { return { drips: drips.length, drops: drops.length, ripples: ripples.length, smoke: smoke.length, flame: flameLvl }; }
  };
})();

/* =========================================================================
   UI
   ========================================================================= */
const fmt = secs => { secs = Math.max(0, secs); const m = Math.floor(secs / 60), s = secs % 60; return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'); };

const UI = {
  ready: false, lastSecs: -1, lastTitle: '', dayKey: '', toastT: 0, panelOpen: false, exitT: 0, lastFocusEl: null,

  init() {
    const e = this.els = {
      mainBtn: $('#mainBtn'), resetBtn: $('#resetBtn'), muteBtn: $('#muteBtn'), muteBtn2: $('#muteBtn2'),
      clock: $('#clock'), phase: $('#phase'), skipBtn: $('#skipBtn'), dots: $('#dots'),
      presets: $('#presets'), custom: $('#customMin'), customChip: $('#customChip'), task: $('#task'),
      today: $('#todayLine'), panel: $('#panel'), scrim: $('#scrim'), toast: $('#toast'),
      settingsBtn: $('#settingsBtn'), closePanel: $('#closePanel'), focusBtn: $('#focusBtn'), focusExit: $('#focusExit'),
      pomo: $('#pomo'), pomoOpts: $('#pomoOpts'), shortBreak: $('#shortBreak'), longBreak: $('#longBreak'), autoFocus: $('#autoFocus'),
      wake: $('#wake'), wakeNote: $('#wakeNote'), master: $('#master'), masterVal: $('#masterVal'), chime: $('#chime'),
      audioNote: $('#audioNote'), sounds: $('#sounds'), hapBody: $('#hapBody'), hapNote: $('#hapNote'), hapOn: $('#hapOn'),
      hapInt: $('#hapInt'), hapIv: $('#hapIv'), logList: $('#logList'), sumSessions: $('#sumSessions'), sumMinutes: $('#sumMinutes')
    };
    e.panel.inert = true;

    // mode
    $$('.seg [data-mode]').forEach(b => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    // timer controls
    e.mainBtn.addEventListener('click', () => this.primary());
    e.resetBtn.addEventListener('click', () => this.reset());
    e.skipBtn.addEventListener('click', () => { Timer.skipBreak(); this.toast('Break skipped'); });
    e.muteBtn.addEventListener('click', () => this.toggleMute());
    e.muteBtn2.addEventListener('click', () => this.toggleMute());
    // presets
    $$('#presets .chip[data-min]').forEach(b => b.addEventListener('click', () => this.setDuration(+b.dataset.min)));
    const applyCustom = () => {
      const v = parseInt(e.custom.value, 10);
      if (!Number.isFinite(v)) { this.render(); return; }
      this.setDuration(clamp(v, 1, 180));
    };
    e.custom.addEventListener('change', applyCustom);
    e.custom.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); applyCustom(); e.custom.blur(); } });
    // task
    e.task.value = S.task;
    e.task.addEventListener('input', () => { S.task = e.task.value; saveSettings(); });
    e.task.addEventListener('keydown', ev => { if (ev.key === 'Enter') e.task.blur(); });
    // panel
    e.settingsBtn.addEventListener('click', () => this.openPanel());
    e.closePanel.addEventListener('click', () => this.closePanel());
    e.scrim.addEventListener('click', () => this.closePanel());
    // focus mode
    e.focusBtn.addEventListener('click', () => this.toggleFocus());
    e.focusExit.addEventListener('click', () => this.exitFocus());
    const poke = () => {
      if (!document.body.classList.contains('focus-mode')) return;
      document.body.classList.add('show-exit');
      clearTimeout(this.exitT);
      this.exitT = setTimeout(() => document.body.classList.remove('show-exit'), 2600);
    };
    window.addEventListener('pointermove', poke, { passive: true });
    window.addEventListener('pointerdown', poke, { passive: true });
    const fsChange = () => { if (!(document.fullscreenElement || document.webkitFullscreenElement) && document.body.classList.contains('focus-mode') && this.fsUsed) this.exitFocus(); };
    document.addEventListener('fullscreenchange', fsChange);
    document.addEventListener('webkitfullscreenchange', fsChange);

    this.buildSettings();
    this.bindKeys();
    this.ready = true;
    this.render(); this.renderToday(); this.renderWake(); this.renderAudioNote();
  },

  /* ---------- actions ---------- */
  primary() {
    AudioEngine.unlock();
    const st = Timer.status;
    if (st === 'running') Timer.pause();
    else if (st === 'paused') Timer.resume();
    else { Timer.start(); Haptics.play('start'); }
  },
  reset() {
    if (Timer.phase === 'focus' && Timer.status === 'idle') return;
    Timer.reset();
  },
  setMode(m) {
    if (m !== 'candle' && m !== 'ice') return;
    S.mode = m; saveSettings();
    document.documentElement.dataset.mode = m;
    $$('.seg [data-mode]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
  },
  setDuration(min) {
    if (Timer.isActive() || Timer.phase !== 'focus') { this.toast('Reset the timer to change its length'); this.render(); return; }
    S.duration = min; S.custom = !PRESETS.includes(min); saveSettings();
    if (Timer.status === 'done') Timer.reset();
    else { Timer.durMs = Timer.focusMs(); Timer.persist(); this.render(); }
  },
  toggleMute() {
    AudioEngine.unlock();
    S.muted = !S.muted; saveSettings();
    AudioEngine.applyMaster();
    this.renderMute();
    this.toast(S.muted ? 'Sound muted' : 'Sound on');
  },

  /* ---------- focus mode ---------- */
  toggleFocus() { if (document.body.classList.contains('focus-mode')) this.exitFocus(); else this.enterFocus(); },
  enterFocus() {
    this.closePanel();
    document.body.classList.add('focus-mode');
    this.fsUsed = false;
    const el = document.documentElement;
    try {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req && !(document.fullscreenElement || document.webkitFullscreenElement)) {
        const p = req.call(el, { navigationUI: 'hide' });
        this.fsUsed = true;
        if (p && p.catch) p.catch(() => { this.fsUsed = false; });
      }
    } catch (err) { this.fsUsed = false; }
    document.body.classList.add('show-exit');
    clearTimeout(this.exitT);
    this.exitT = setTimeout(() => document.body.classList.remove('show-exit'), 2600);
    requestAnimationFrame(() => Scene.measure(false));
  },
  exitFocus() {
    document.body.classList.remove('focus-mode', 'show-exit');
    try { if (document.fullscreenElement) document.exitFullscreen(); else if (document.webkitFullscreenElement) document.webkitExitFullscreen(); } catch (err) {}
    this.fsUsed = false;
    requestAnimationFrame(() => Scene.measure(false));
  },

  /* ---------- panel ---------- */
  openPanel() {
    if (this.panelOpen) return;
    this.panelOpen = true; this.lastFocusEl = document.activeElement;
    const e = this.els;
    e.panel.classList.add('open'); e.scrim.classList.add('show');
    e.panel.inert = false; e.panel.setAttribute('aria-hidden', 'false'); e.settingsBtn.setAttribute('aria-expanded', 'true');
    this.renderToday(); this.renderAudioNote();
    setTimeout(() => e.closePanel.focus({ preventScroll: true }), 60);
  },
  closePanel() {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    const e = this.els;
    e.panel.classList.remove('open'); e.scrim.classList.remove('show');
    e.panel.inert = true; e.panel.setAttribute('aria-hidden', 'true'); e.settingsBtn.setAttribute('aria-expanded', 'false');
    if (this.lastFocusEl && this.lastFocusEl.focus) this.lastFocusEl.focus({ preventScroll: true });
  },

  buildSettings() {
    const e = this.els;
    const fill = r => r.style.setProperty('--fill', r.value + '%');
    // session
    e.pomo.checked = S.pomodoro;
    e.shortBreak.value = S.shortBreak; e.longBreak.value = S.longBreak; e.autoFocus.checked = S.autoFocus;
    e.pomoOpts.classList.toggle('off', !S.pomodoro);
    e.pomo.addEventListener('change', () => {
      S.pomodoro = e.pomo.checked; Timer.cycle = 0; saveSettings();
      e.pomoOpts.classList.toggle('off', !S.pomodoro); Timer.persist(); this.render();
    });
    const numBind = (el, key, max) => el.addEventListener('change', () => {
      const v = clamp(parseInt(el.value, 10) || S[key], 1, max); S[key] = v; el.value = v; saveSettings();
    });
    numBind(e.shortBreak, 'shortBreak', 30); numBind(e.longBreak, 'longBreak', 60);
    e.autoFocus.addEventListener('change', () => { S.autoFocus = e.autoFocus.checked; saveSettings(); });
    e.wake.checked = S.wake;
    if (!Wake.supported) e.wake.disabled = true;
    e.wake.addEventListener('change', () => {
      S.wake = e.wake.checked; saveSettings();
      if (S.wake && Timer.isRunning()) Wake.acquire(); else Wake.release();
      this.renderWake();
    });

    // sound
    e.master.value = S.master; e.masterVal.textContent = S.master; fill(e.master);
    e.master.addEventListener('input', () => {
      S.master = +e.master.value; e.masterVal.textContent = S.master; fill(e.master); saveSettings();
      AudioEngine.unlock();
      if (S.muted && S.master > 0) { S.muted = false; this.renderMute(); }
      AudioEngine.applyMaster();
    });
    e.chime.value = S.chime; fill(e.chime);
    e.chime.addEventListener('input', () => { S.chime = +e.chime.value; fill(e.chime); saveSettings(); AudioEngine.applyChime(); });
    $('#testChime').addEventListener('click', () => { AudioEngine.unlock(); setTimeout(() => AudioEngine.chime('session'), 30); });

    for (const d of SOUND_DEFS) {
      const st = S.sounds[d.id];
      const row = document.createElement('div');
      row.className = 'sound' + (st.on ? '' : ' off');
      const sw = document.createElement('label'); sw.className = 'switch';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = st.on; cb.setAttribute('aria-label', d.name);
      sw.append(cb, document.createElement('span'));
      const nm = document.createElement('div'); nm.className = 'sname'; nm.textContent = d.name;
      if (d.hint) { const sm = document.createElement('small'); sm.textContent = d.hint; nm.append(sm); }
      const rg = document.createElement('input'); rg.type = 'range'; rg.min = 0; rg.max = 100; rg.step = 1; rg.value = st.vol;
      rg.setAttribute('aria-label', d.name + ' volume'); fill(rg);
      cb.addEventListener('change', () => {
        st.on = cb.checked; row.classList.toggle('off', !st.on); saveSettings();
        AudioEngine.unlock(); AudioEngine.sync(); this.renderAudioNote();
        if (st.on && S.muted) this.toast('Sound is muted — press M to unmute');
      });
      rg.addEventListener('input', () => {
        st.vol = +rg.value; fill(rg); saveSettings();
        if (!st.on) { st.on = true; cb.checked = true; row.classList.remove('off'); }
        AudioEngine.unlock(); AudioEngine.sync(); this.renderAudioNote();
      });
      row.append(sw, nm, rg);
      e.sounds.append(row);
    }

    // haptics
    if (!Haptics.supported) {
      e.hapBody.classList.add('disabled');
      $$('input,select,button', e.hapBody).forEach(x => { x.disabled = true; });
      e.hapNote.className = 'note alert';
      e.hapNote.textContent = 'Vibration isn’t available in this browser. It works on Android phones in Chrome — iPhone and iPad browsers don’t support web vibration.';
    } else {
      e.hapNote.textContent = 'Needs a device with a vibration motor, such as an Android phone in Chrome. Laptops will stay silent.';
    }
    e.hapOn.checked = S.haptics.on;
    e.hapOn.addEventListener('change', () => { S.haptics.on = e.hapOn.checked; saveSettings(); if (S.haptics.on) Haptics.play('start'); });
    const setInt = v => { S.haptics.intensity = v; $$('button', e.hapInt).forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === v))); };
    setInt(S.haptics.intensity);
    $$('button', e.hapInt).forEach(b => b.addEventListener('click', () => { setInt(b.dataset.v); saveSettings(); Haptics.play('reminder', true); }));
    e.hapIv.value = String(S.haptics.interval);
    e.hapIv.addEventListener('change', () => { S.haptics.interval = +e.hapIv.value; saveSettings(); });
    $('#testHap').addEventListener('click', () => Haptics.play('end', true));

    // today
    $('#clearToday').addEventListener('click', () => {
      if (!Log.today().length) return;
      if (confirm('Clear today’s session log?')) { Log.clearToday(); this.renderToday(); }
    });
    this.renderMute();
  },

  bindKeys() {
    document.addEventListener('keydown', ev => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const t = ev.target, tag = t && t.tagName;
      const isField = tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable) ||
        (tag === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|color)$/i.test(t.type));
      if (ev.key === 'Escape') {
        if (this.panelOpen) { this.closePanel(); ev.preventDefault(); }
        else if (document.body.classList.contains('focus-mode')) this.exitFocus();
        else if (isField) t.blur();
        return;
      }
      if (isField) return;
      if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && t && t.closest && t.closest('.seg')) {   // radio-group arrows
        ev.preventDefault();
        const m = S.mode === 'candle' ? 'ice' : 'candle';
        this.setMode(m); const btn = $('.seg [data-mode="' + m + '"]'); if (btn) btn.focus();
        return;
      }
      const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      if (key === ' ' || key === 'Spacebar') {
        if (tag === 'INPUT') return;                 // let checkboxes toggle natively
        ev.preventDefault();
        if (!ev.repeat) this.primary();
        return;
      }
      if (ev.repeat) return;
      switch (key) {
        case 'r': this.reset(); break;
        case 'm': this.toggleMute(); break;
        case 'c': this.setMode('candle'); break;
        case 'i': this.setMode('ice'); break;
        case 'f': this.toggleFocus(); break;
        default: return;
      }
      ev.preventDefault();
    });
    // stop a focused button from also "clicking" when Space is released
    document.addEventListener('keyup', ev => { if (ev.key === ' ' && ev.target && ev.target.tagName === 'BUTTON') ev.preventDefault(); });
  },

  /* ---------- rendering ---------- */
  phaseLabel() {
    const T = Timer, sess = 'Session ' + Math.min(T.cycle + 1, 4) + ' of 4';
    if (T.phase === 'focus') {
      if (T.status === 'idle') return S.pomodoro ? sess + ' · Ready' : 'Ready';
      if (T.status === 'running') return S.pomodoro ? 'Focus · ' + sess : 'Focus';
      if (T.status === 'paused') return 'Paused';
      return 'Complete · ' + Math.round(T.durMs / 60000) + ' min';
    }
    const name = T.phase === 'long' ? 'Long break' : 'Short break';
    return T.status === 'paused' ? name + ' · paused' : name;
  },
  render() {
    if (!this.ready) return;
    const e = this.els, T = Timer, st = T.status, ph = T.phase;
    document.body.dataset.state = st; document.body.dataset.phase = ph;
    const label = st === 'running' ? 'Pause' : st === 'paused' ? 'Resume' : st === 'done' ? 'Start again' : 'Start';
    e.mainBtn.textContent = label;
    e.mainBtn.setAttribute('aria-label', label + ' (Space)');
    e.resetBtn.disabled = st === 'idle' && ph === 'focus';
    e.skipBtn.hidden = ph === 'focus';
    e.phase.textContent = this.phaseLabel();
    const locked = T.isActive() || ph !== 'focus';
    e.presets.classList.toggle('locked', locked);
    $$('#presets .chip[data-min]').forEach(b => { b.disabled = locked; b.setAttribute('aria-pressed', String(!S.custom && +b.dataset.min === S.duration)); });
    e.custom.disabled = locked;
    e.customChip.classList.toggle('active', S.custom);
    if (document.activeElement !== e.custom) e.custom.value = S.custom ? S.duration : '';
    e.dots.hidden = !S.pomodoro;
    if (S.pomodoro) $$('i', e.dots).forEach((d, i) => {
      d.classList.toggle('on', i < T.cycle);
      d.classList.toggle('now', i === T.cycle && ph === 'focus' && st !== 'idle');
    });
    this.lastSecs = -1; this.tick(now());
  },
  renderMute() {
    const e = this.els, icon = S.muted ? '#i-mute' : '#i-vol';
    for (const b of [e.muteBtn, e.muteBtn2]) {
      b.setAttribute('aria-pressed', String(S.muted));
      b.querySelector('use').setAttribute('href', icon);
    }
    e.muteBtn.setAttribute('aria-label', S.muted ? 'Unmute (M)' : 'Mute (M)');
    e.muteBtn.title = S.muted ? 'Unmute (M)' : 'Mute (M)';
  },
  renderAudioNote() {
    if (!this.ready) return;
    const anyOn = SOUND_DEFS.some(d => S.sounds[d.id].on);
    this.els.audioNote.hidden = !(anyOn && !AudioEngine.isRunning());
  },
  renderWake() {
    if (!this.ready) return;
    const n = this.els.wakeNote;
    if (!Wake.supported) n.textContent = 'Not supported in this browser.';
    else if (Wake.lock) n.textContent = 'Active now — your screen will stay on.';
    else n.textContent = 'While a session is running.';
  },
  renderToday() {
    if (!this.ready) return;
    const e = this.els, items = Log.today(), mins = items.reduce((a, b) => a + (+b.min || 0), 0);
    this.dayKey = Log.dayKey(now());
    e.today.innerHTML = '';
    if (!items.length) e.today.textContent = 'No sessions yet today';
    else {
      const b1 = document.createElement('b'); b1.textContent = items.length;
      const b2 = document.createElement('b'); b2.textContent = mins;
      e.today.append('Today · ', b1, items.length === 1 ? ' session · ' : ' sessions · ', b2, ' min focused');
    }
    e.sumSessions.textContent = items.length; e.sumMinutes.textContent = mins;
    e.logList.innerHTML = '';
    if (!items.length) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Completed sessions will appear here.'; e.logList.append(li);
    } else {
      for (const it of items.slice().reverse()) {
        const li = document.createElement('li');
        const t = document.createElement('span'); t.className = 't';
        t.textContent = new Date(it.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const m = document.createElement('span'); m.textContent = it.min + ' min';
        const tk = document.createElement('span'); tk.className = 'task-name'; tk.textContent = it.task || '—';
        li.append(t, m, tk); e.logList.append(li);
      }
    }
  },
  tick(t) {
    if (!this.ready) return;
    const T = Timer;
    let ms;
    if (T.phase === 'focus' && T.status === 'idle') ms = T.focusMs();
    else if (T.status === 'done') ms = 0;
    else ms = T.remaining(t);
    const secs = Math.ceil(ms / 1000 - 1e-6);
    if (secs !== this.lastSecs) {
      this.lastSecs = secs;
      const txt = fmt(secs);
      this.els.clock.textContent = txt;
      let title = 'Melt Timer';
      if (T.status === 'running') title = txt + ' · ' + (T.phase === 'focus' ? 'Focus' : 'Break') + ' — Melt';
      else if (T.status === 'paused') title = '❚❚ ' + txt + ' — Melt';
      else if (T.status === 'done') title = '✓ Session complete — Melt';
      if (title !== this.lastTitle) { document.title = title; this.lastTitle = title; }
    }
    if (this.dayKey && Log.dayKey(t) !== this.dayKey) this.renderToday();   // past midnight
  },
  onTransition(events, silent) {
    if (!this.ready) return;
    this.renderToday();
    if (silent) return;
    const last = events[events.length - 1];
    if (last === 'focusEnd') {
      AudioEngine.chime('session'); Haptics.play('end');
      if (Timer.phase !== 'focus') this.toast('Session complete · ' + (Timer.phase === 'long' ? 'long break, ' : 'break, ') + Math.round(Timer.durMs / 60000) + ' min');
      else this.toast('Session complete — nicely done');
    } else {
      AudioEngine.chime('break'); Haptics.play('breakEnd');
      this.toast(Timer.isRunning() ? 'Break over — back to focus' : 'Break over — ready when you are');
    }
  },
  toast(msg) {
    const el = this.els.toast;
    el.textContent = msg; el.classList.add('show');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => el.classList.remove('show'), 2800);
  }
};

/* =========================================================================
   Boot
   ========================================================================= */
Timer.restore();
UI.init();
$$('.seg [data-mode]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === S.mode)));
Scene.resize();
window.addEventListener('resize', () => Scene.resize());
if (window.ResizeObserver) new ResizeObserver(() => Scene.measure(false)).observe($('#stage'));
$('#app').addEventListener('scroll', () => Scene.measure(true), { passive: true });

// Audio may only start after a user gesture (autoplay rules)
const gesture = () => {
  if (AudioEngine.isRunning()) return;
  const anyOn = SOUND_DEFS.some(d => S.sounds[d.id].on);
  if (anyOn || AudioEngine.unlocked) { AudioEngine.unlock(); setTimeout(() => UI.renderAudioNote(), 200); }
};
['pointerdown', 'keydown', 'touchend'].forEach(evt => window.addEventListener(evt, gesture, { capture: true, passive: true }));
if (SOUND_DEFS.some(d => S.sounds[d.id].on)) setTimeout(() => UI.toast('Tap anywhere to start your sounds'), 700);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  Timer.check();
  if (Timer.isRunning()) Wake.acquire();
  UI.render(); UI.renderToday();
});
setInterval(() => { Timer.check(); UI.tick(now()); }, 1000);   // keeps working (throttled) in background tabs

let lastTs = performance.now();
function loop(ts) {
  const dt = clamp((ts - lastTs) / 1000, 0, 0.1); lastTs = ts;
  const t = now();
  Timer.check(t);
  Scene.frame(dt, t);
  UI.tick(t);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if (DEBUG) {
  window.__melt = {
    Timer, Scene, AudioEngine, Haptics, S, Log, Wake, UI,
    advance(ms) { timeOffset += ms; Timer.check(); UI.render(); },
    get offset() { return timeOffset; }
  };
}
})();

/* =========================================================================
   Offline support + installable app (only when served over http/https)
   ========================================================================= */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
