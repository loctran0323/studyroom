// Ambient sound, generated live with Web Audio. Nothing is streamed or downloaded.

let ctx = null;
let master = null;
let current = null; // { name, stop() }
let volume = 0.6;

export function audioContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function setVolume(v) {
  volume = v;
  if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
}

export function playing() {
  return current?.name || null;
}

export function play(name) {
  if (current?.name === name) return;
  stop();
  const ac = audioContext();
  const out = ac.createGain();
  out.gain.value = 0;
  out.gain.linearRampToValueAtTime(1, ac.currentTime + 1.2);
  out.connect(master);
  const make = { lofi, rain, fire, brown }[name];
  if (!make) return;
  const stopInner = make(ac, out);
  current = {
    name,
    stop() {
      const t = ac.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(0, t + 0.6);
      setTimeout(() => { stopInner(); out.disconnect(); }, 700);
    },
  };
}

export function stop() {
  current?.stop();
  current = null;
}

// ---------- building blocks ----------

const noiseCache = {};
function noiseBuffer(ac, kind, seconds = 4) {
  const key = kind + seconds;
  if (noiseCache[key]) return noiseCache[key];
  const len = ac.sampleRate * seconds;
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === "brown") {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else if (kind === "pink") {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        d[i] = w;
      }
    }
  }
  return (noiseCache[key] = buf);
}

function loopNoise(ac, kind) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, kind);
  src.loop = true;
  src.start();
  return src;
}

function filter(ac, type, freq, q = 0.7) {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

// ---------- brown noise ----------
function brown(ac, out) {
  const src = loopNoise(ac, "brown");
  const g = ac.createGain();
  g.gain.value = 0.55;
  chain(src, filter(ac, "lowpass", 900), g, out);
  return () => src.stop();
}

// ---------- rain ----------
function rain(ac, out) {
  const bed = loopNoise(ac, "pink");
  const bedGain = ac.createGain();
  bedGain.gain.value = 0.5;
  chain(bed, filter(ac, "highpass", 400), filter(ac, "lowpass", 5200), bedGain, out);

  // slow swells, like gusts against a window
  const lfo = ac.createOscillator();
  const lfoGain = ac.createGain();
  lfo.frequency.value = 0.07;
  lfoGain.gain.value = 0.12;
  lfo.connect(lfoGain).connect(bedGain.gain);
  lfo.start();

  const rumble = loopNoise(ac, "brown");
  const rumbleGain = ac.createGain();
  rumbleGain.gain.value = 0.25;
  chain(rumble, filter(ac, "lowpass", 300), rumbleGain, out);

  // individual drops on the sill
  const white = noiseBuffer(ac, "white", 1);
  let alive = true;
  (function drop() {
    if (!alive) return;
    const t = ac.currentTime + 0.01;
    const s = ac.createBufferSource();
    s.buffer = white;
    const bp = filter(ac, "bandpass", 2500 + Math.random() * 4000, 6);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08 + Math.random() * 0.12, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + Math.random() * 0.05);
    const pan = ac.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    chain(s, bp, g, pan, out);
    s.start(t, Math.random() * 0.9, 0.12);
    setTimeout(drop, 20 + Math.random() * 110);
  })();

  return () => { alive = false; bed.stop(); rumble.stop(); lfo.stop(); };
}

// ---------- fireplace ----------
function fire(ac, out) {
  const roar = loopNoise(ac, "brown");
  const roarGain = ac.createGain();
  roarGain.gain.value = 0.45;
  chain(roar, filter(ac, "lowpass", 500), roarGain, out);

  const hiss = loopNoise(ac, "pink");
  const hissGain = ac.createGain();
  hissGain.gain.value = 0.04;
  chain(hiss, filter(ac, "bandpass", 3000, 0.5), hissGain, out);

  const white = noiseBuffer(ac, "white", 1);
  let alive = true;
  (function crackle() {
    if (!alive) return;
    const pops = Math.random() < 0.25 ? 2 + Math.floor(Math.random() * 4) : 1;
    for (let i = 0; i < pops; i++) {
      const t = ac.currentTime + 0.01 + i * (0.01 + Math.random() * 0.04);
      const s = ac.createBufferSource();
      s.buffer = white;
      const bp = filter(ac, "bandpass", 1200 + Math.random() * 3500, 2 + Math.random() * 6);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15 + Math.random() * 0.45, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02 + Math.random() * 0.06);
      const pan = ac.createStereoPanner();
      pan.pan.value = Math.random() * 1.2 - 0.6;
      chain(s, bp, g, pan, out);
      s.start(t, Math.random() * 0.9, 0.1);
    }
    setTimeout(crackle, 60 + Math.random() * 500);
  })();

  return () => { alive = false; roar.stop(); hiss.stop(); };
}

// ---------- lo-fi beat ----------
// A slow loop: jazzy seventh chords on a soft electric piano, round bass,
// dusty drums with swing, a sparse pentatonic melody, and vinyl crackle.
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const PROGRESSIONS = [
  // Dm9 – G13 – Cmaj9 – Am9
  [[50, 53, 57, 60, 64], [43, 53, 57, 59, 64], [48, 52, 55, 59, 62], [45, 55, 60, 64, 67]],
  // Fmaj7 – Em7 – Dm7 – Cmaj7
  [[41, 57, 60, 64, 65], [40, 55, 59, 62, 64], [38, 57, 60, 62, 65], [36, 55, 59, 60, 64]],
  // Ebmaj7 – Dm7 – Cm9 – Bb6
  [[39, 55, 58, 62, 63], [38, 53, 57, 60, 62], [36, 55, 58, 62, 63], [46, 53, 58, 62, 67]],
];
const PENTA = [72, 74, 76, 79, 81, 84];

function lofi(ac, out) {
  const bus = ac.createGain();
  bus.gain.value = 0.9;
  const tone = filter(ac, "lowpass", 3200);
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 3;
  chain(bus, tone, comp, out);

  // gentle tape wobble on the keys
  const keys = ac.createGain();
  keys.gain.value = 0.22;
  const keysLp = filter(ac, "lowpass", 1700);
  chain(keys, keysLp, bus);
  const wobble = ac.createOscillator();
  wobble.frequency.value = 0.35;
  const wobbleDepth = ac.createGain();
  wobbleDepth.gain.value = 6; // cents
  wobble.connect(wobbleDepth);
  wobble.start();

  // vinyl bed
  const vinyl = loopNoise(ac, "pink");
  const vinylGain = ac.createGain();
  vinylGain.gain.value = 0.03;
  chain(vinyl, filter(ac, "bandpass", 1800, 0.4), vinylGain, bus);
  const white = noiseBuffer(ac, "white", 1);

  const bpm = 72 + Math.floor(Math.random() * 10);
  const sixteenth = 60 / bpm / 4;
  let prog = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
  let step = 0;
  let nextTime = ac.currentTime + 0.1;
  let alive = true;

  function epiano(note, t, dur, vel) {
    const f = midi(note);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.015);
    g.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(keys);
    for (const [type, mult, detune, amp] of [["sine", 1, 0, 1], ["triangle", 1, 7, 0.35], ["sine", 2, -5, 0.12]]) {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      o.detune.value = detune;
      wobbleDepth.connect(o.detune);
      const a = ac.createGain();
      a.gain.value = amp;
      o.connect(a).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  function bass(note, t, dur) {
    const o = ac.createOscillator();
    o.type = "sine";
    o.frequency.value = midi(note);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    chain(o, g, filter(ac, "lowpass", 400), bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function kick(t) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    chain(o, g, bus);
    o.start(t);
    o.stop(t + 0.4);
  }

  function hit(t, freq, q, peak, decay, type = "bandpass") {
    const s = ac.createBufferSource();
    s.buffer = white;
    const g = ac.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    chain(s, filter(ac, type, freq, q), g, bus);
    s.start(t, Math.random() * 0.8, decay + 0.05);
  }

  function schedule(s, t) {
    const bar = Math.floor(s / 16) % 4;
    const pos = s % 16;
    const chord = prog[bar];
    const swing = pos % 2 === 1 ? sixteenth * 0.18 : 0;
    t += swing + (Math.random() - 0.5) * 0.008;

    if (pos === 0) {
      chord.slice(1).forEach((n, i) => epiano(n, t + i * 0.018, sixteenth * 15, 0.16 + Math.random() * 0.04));
      bass(chord[0] - 12 < 28 ? chord[0] : chord[0] - 12, t, sixteenth * 5);
    }
    if (pos === 10 && Math.random() < 0.7) bass(chord[0] - 12 < 28 ? chord[0] : chord[0] - 12, t, sixteenth * 3);
    if (pos === 8 && Math.random() < 0.35) chord.slice(2).forEach((n, i) => epiano(n, t + i * 0.02, sixteenth * 6, 0.08));

    if (pos === 0 || pos === 10 || (pos === 7 && Math.random() < 0.3)) kick(t);
    if (pos === 4 || pos === 12) hit(t, 1600, 0.8, 0.22, 0.18);
    if (pos % 2 === 0) hit(t, 8000, 0.7, pos % 4 === 2 ? 0.06 : 0.035, 0.05, "highpass");

    if (pos % 4 === 2 && Math.random() < 0.22) {
      const n = PENTA[Math.floor(Math.random() * PENTA.length)];
      epiano(n, t, sixteenth * (2 + Math.floor(Math.random() * 4)), 0.1);
    }
    if (Math.random() < 0.08) hit(t, 3000 + Math.random() * 3000, 3, 0.05, 0.015);

    if (s % 64 === 63 && Math.random() < 0.4) {
      prog = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
    }
  }

  const timer = setInterval(() => {
    if (!alive) return;
    while (nextTime < ac.currentTime + 0.2) {
      schedule(step, nextTime);
      nextTime += sixteenth;
      step++;
    }
  }, 40);

  return () => {
    alive = false;
    clearInterval(timer);
    vinyl.stop();
    wobble.stop();
  };
}

// ---------- chime for the end of a session ----------
export function chime() {
  const ac = audioContext();
  const t = ac.currentTime + 0.05;
  [[659.25, 0], [880, 0.22], [1318.5, 0.44]].forEach(([f, d]) => {
    const o = ac.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t + d);
    g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 1.8);
    o.connect(g).connect(ac.destination);
    o.start(t + d);
    o.stop(t + d + 2);
  });
}
