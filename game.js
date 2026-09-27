"use strict";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

let W = 0, H = 0;
function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// Keys are stored lowercased (e.key.toLowerCase()), so arrows are "arrowup" etc.
// preventDefault on these also stops the arrow keys from scrolling the page.
const CONTROL_KEYS = new Set([
  "w", "a", "s", "d", "i", "j", "k", "l",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
]);
const keys = new Set();

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (CONTROL_KEYS.has(k)) e.preventDefault();
  keys.add(k);
  initAudio(); // browsers only allow audio after a user gesture, see the Sound section
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------
// Every sound is synthesized with the Web Audio API -- no audio files, same
// no-assets/no-build spirit as the rest of the game.
//
// Collisions draw from a library of 12 pre-rendered sounds (see
// COLLISION_RECIPES), 4 per energy tier. Each hit picks a random one from
// its tier and plays it with a little pitch/volume variation, panned to
// where it happened. The coin and parking sounds are short enough to just
// synthesize live.
//
// Browsers only allow audio after a user gesture, so the AudioContext is
// created on the first keydown (the game is keyboard-only anyway). Until
// then -- and in environments with no Web Audio at all -- every play
// function is a silent no-op.

let audio = null; // { ctx, master, library } once unlocked; library fills in asynchronously

function initAudio() {
  if (audio) {
    if (audio.ctx.state === "suspended") audio.ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);
  audio = { ctx, master, library: null };
  buildCollisionLibrary(ctx.sampleRate).then((lib) => { audio.library = lib; });
}

function audioReady() {
  return audio !== null && audio.ctx.state === "running";
}

// Left/right placement from a world x (kept away from hard-panned extremes).
function panFor(x) {
  return clamp((x / W) * 2 - 1, -1, 1) * 0.7;
}

// ---- Synthesis primitives --------------------------------------------------
// Each schedules nodes on any BaseAudioContext `c` (live or offline) into
// `dest`, starting at time t0.

function noiseBuffer(c, dur) {
  const len = Math.max(1, Math.ceil(dur * c.sampleRate));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Percussive envelope: quick attack, exponential decay to silence.
function envGain(c, t0, peak, attack, dur) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  return g;
}

// Filtered noise burst: the crunch/scrape/whoosh ingredient.
function sfxNoise(c, dest, t0, { dur, freq, q = 1, type = "bandpass", gain = 1, attack = 0.002, sweepTo }) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur);
  const f = c.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t0);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  src.connect(f).connect(envGain(c, t0, gain, attack, dur)).connect(dest);
  src.start(t0);
  src.stop(t0 + dur);
}

// Pitched tone with an optional glide: thumps (sine, falling), bleeps, notes.
function sfxTone(c, dest, t0, { freq, freqTo, dur, type = "sine", gain = 1, attack = 0.003 }) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (freqTo) o.frequency.exponentialRampToValueAtTime(freqTo, t0 + dur);
  o.connect(envGain(c, t0, gain, attack, dur)).connect(dest);
  o.start(t0);
  o.stop(t0 + dur);
}

// Body-panel "clang": a cluster of inharmonic partials, optionally bending
// down in pitch (a panel buckling).
function sfxMetal(c, dest, t0, { base, dur, gain = 1, bend = 1, ratios = [1, 1.47, 2.09, 2.76, 3.43] }) {
  ratios.forEach((r, i) => {
    sfxTone(c, dest, t0, {
      freq: base * r,
      freqTo: bend !== 1 ? base * r * bend : undefined,
      dur: dur * (1 - i * 0.12),
      type: i % 2 ? "triangle" : "sine",
      gain: gain / (1 + i * 0.6),
    });
  });
}

// Scattered tiny high pings: breaking glass / trim bits.
function sfxGlass(c, dest, t0, { count, spread, gain = 0.4 }) {
  for (let i = 0; i < count; i++) {
    const t = t0 + Math.random() * spread;
    sfxTone(c, dest, t, { freq: 2600 + Math.random() * 3800, dur: 0.05 + Math.random() * 0.08, gain: gain * (0.5 + Math.random() * 0.5) });
  }
}

// Scattered short noise ticks: debris skittering / rattling.
function sfxRattle(c, dest, t0, { count, spread, gain = 0.5, freq = 1800 }) {
  for (let i = 0; i < count; i++) {
    const t = t0 + Math.random() * spread;
    sfxNoise(c, dest, t, { dur: 0.015 + Math.random() * 0.03, freq: freq * (0.6 + Math.random() * 0.9), q: 3, gain: gain * (0.4 + Math.random() * 0.6) });
  }
}

// ---- Collision library -----------------------------------------------------
//
// Collisions are HOLLYWOOD crash sound design: not realistic (real crashes
// don't sound like what people expect) and not cartoon -- the exaggerated,
// designed "movie crash" everyone recognizes. History, so nobody repeats it:
//  1. Short pitched clicks: "like banging two pencils together" (no weight).
//  2. Realistic and heavy (rumble, ringing sheet metal, room reverb): "the
//     wrong vibe". (Movie audio itself was suggested -- it's copyrighted,
//     so that was never an option; this is synthesized in the same style.)
//  3. Cartoon foley (boings, pots and pans, slide whistle): "too cartoonish".
//  4. Now: the movie-crash recipe. Each hit layers
//     - sfxCrack:   a sharp broadband transient at impact -- the punch
//     - sfxBoom:    a deep, fast pitch-dropping impact, felt as much as heard
//     - sfxCrunch:  dense metallic grains -- crumpling bodywork
//     - sfxGroan:   twisting sheet metal (heavier hits)
//     - sfxShatter: breaking glass (heavy hits, the odd medium one)
//     - sfxDebris:  bits raining down afterwards
//     through compression + saturation (glue, punch) and a roomy tail.
//     Weight stays in the audible "body" band (see pass 1).

// Rumbling noise sweeping downward, band-limited to the "body" range
// (high-passed at 90 Hz, so it stays audible on small speakers).
function sfxWhump(c, dest, t0, { from, to, dur, gain = 1 }) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur);
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 0.9;
  lp.frequency.setValueAtTime(from, t0);
  lp.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 90;
  src.connect(lp).connect(hp).connect(envGain(c, t0, gain, 0.006, dur)).connect(dest);
  src.start(t0);
  src.stop(t0 + dur);
}

// The impact's weight: a fast pitch-dropping thump (kick-drum style punch,
// starting high enough to be heard on laptop speakers) plus a whump of
// low-mid noise. `size` 0..1 scales from a bump to a big crash.
function sfxBoom(c, dest, t0, { size, gain = 1 }) {
  sfxTone(c, dest, t0, { freq: 190 - 40 * size, freqTo: 55 - 12 * size, dur: 0.18 + 0.5 * size, gain: gain * 0.8, attack: 0.002 });
  sfxWhump(c, dest, t0, { from: 700 + 600 * size, to: 140, dur: 0.25 + 0.7 * size, gain: gain * 0.9 });
}

// The impact transient: a very short, bright noise burst -- the "crack" that
// makes a hit punchy instead of soft.
function sfxCrack(c, dest, t0, { gain = 1, bright = 1 }) {
  sfxNoise(c, dest, t0, { dur: 0.035, freq: 1400 * bright, type: "highpass", gain, attack: 0.001 });
  sfxNoise(c, dest, t0, { dur: 0.06, freq: 900 * bright, q: 0.8, gain: gain * 0.6, attack: 0.001 });
}

// Crumpling bodywork: a dense spray of tiny metallic grains (short resonant
// noise bursts and pings) over `dur`, thinning out as it goes.
function sfxCrunch(c, dest, t0, { dur, density = 60, gain = 0.6, low = 700, high = 3500 }) {
  const count = Math.round(density * dur);
  for (let i = 0; i < count; i++) {
    const t = t0 + Math.pow(Math.random(), 1.6) * dur; // front-loaded
    const f = low + Math.random() * (high - low);
    if (Math.random() < 0.7) {
      sfxNoise(c, dest, t, { dur: 0.01 + Math.random() * 0.025, freq: f, q: 6, gain: gain * (0.4 + Math.random() * 0.6), attack: 0.0005 });
    } else {
      sfxTone(c, dest, t, { freq: f, dur: 0.03 + Math.random() * 0.05, type: "triangle", gain: gain * 0.35 * Math.random(), attack: 0.0005 });
    }
  }
}

// Twisting sheet metal: an inharmonic cluster bending down in pitch with a
// slow uneven wobble -- the drawn-out "groan" of a car body deforming.
function sfxGroan(c, dest, t0, { base, dur, gain = 0.5 }) {
  const lfo = c.createOscillator();
  lfo.frequency.value = 5 + Math.random() * 4;
  const wob = c.createGain();
  wob.gain.value = base * 0.03;
  lfo.connect(wob);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = base * 2.2;
  bp.Q.value = 1.2;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + dur * 0.15);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  bp.connect(env).connect(dest);
  [1, 1.34, 1.83, 2.47].forEach((r) => {
    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(base * r, t0);
    o.frequency.exponentialRampToValueAtTime(base * r * 0.7, t0 + dur);
    wob.connect(o.frequency);
    o.connect(bp);
    o.start(t0);
    o.stop(t0 + dur);
  });
  lfo.start(t0);
  lfo.stop(t0 + dur);
}

// Breaking glass: a bright hissing burst, then a shower of pings thinning
// into a tinkle tail.
function sfxShatter(c, dest, t0, { dur = 0.6, gain = 0.5 }) {
  sfxNoise(c, dest, t0, { dur: dur * 0.5, freq: 4000, type: "highpass", gain: gain * 0.7, attack: 0.001 });
  sfxGlass(c, dest, t0, { count: Math.round(24 * dur), spread: dur * 0.4, gain: gain * 0.6 });
  sfxGlass(c, dest, t0 + dur * 0.3, { count: Math.round(10 * dur), spread: dur * 0.7, gain: gain * 0.3 });
}

// Bits of car raining down after the hit: small low-mid knocks and ticks
// scattered over `spread`, sparser later.
function sfxDebris(c, dest, t0, { count, spread, gain = 0.4 }) {
  for (let i = 0; i < count; i++) {
    const t = t0 + Math.pow(Math.random(), 1.3) * spread;
    sfxNoise(c, dest, t, { dur: 0.02 + Math.random() * 0.04, freq: 500 + Math.random() * 1500, q: 4, gain: gain * (0.3 + Math.random() * 0.7), attack: 0.001 });
    if (Math.random() < 0.3) sfxTone(c, dest, t, { freq: 160 + Math.random() * 200, freqTo: 100, dur: 0.06, gain: gain * 0.4 });
  }
}

// A hubcap rolling away and wobbling to rest -- a genuine movie-crash trope
// ("wah-wah-wah" tremolo speeding up as it settles).
function sfxHubcap(c, dest, t0, { base = 520, dur = 1.3, gain = 0.5 }) {
  const am = c.createGain();
  am.gain.value = 0.5;
  const lfo = c.createOscillator();
  lfo.frequency.setValueAtTime(4, t0);
  lfo.frequency.exponentialRampToValueAtTime(34, t0 + dur);
  const depth = c.createGain();
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(am.gain); // am.gain swings 0..1
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + 0.02);
  env.gain.setValueAtTime(gain, t0 + dur * 0.6);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  am.connect(env).connect(dest);
  [1, 1.6, 2.32].forEach((r, i) => {
    const o = c.createOscillator();
    o.frequency.setValueAtTime(base * r, t0);
    o.frequency.linearRampToValueAtTime(base * r * 1.15, t0 + dur);
    const g = c.createGain();
    g.gain.value = 1 / (1 + i);
    o.connect(g).connect(am);
    o.start(t0);
    o.stop(t0 + dur);
  });
  lfo.start(t0);
  lfo.stop(t0 + dur);
}

// 12 collision sounds, 4 per tier. Each recipe builds one sound into an
// offline context; buildCollisionLibrary renders them all once at unlock and
// normalizes them, so loudness differences come only from the tier volume
// in HIT_TIERS (and the in-tier impact speed), not from how a recipe
// happened to sum.
// drive = saturation, room = reverb wet level, ir = reverb tail length (s).
// Kept moderate: heavy saturation + a loud tail flattened the initial crack
// so heavy hits peaked 0.1-0.7s AFTER impact (on the glass/hubcap), which
// kills the punch -- the impact itself must be the loudest moment.
const COLLISION_FX = {
  light: { drive: 1.5, room: 0.15, ir: 0.6 },
  medium: { drive: 1.8, room: 0.2, ir: 0.9 },
  heavy: { drive: 2.0, room: 0.22, ir: 1.1 },
};

const COLLISION_RECIPES = {
  light: [
    { name: "thump", dur: 1.0, build: (c, o) => {
      sfxCrack(c, o, 0, { gain: 0.35, bright: 0.8 });
      sfxBoom(c, o, 0, { size: 0.22 });
      sfxCrunch(c, o, 0.005, { dur: 0.08, density: 70, gain: 0.3 });
    } },
    { name: "knock", dur: 1.0, build: (c, o) => {
      sfxCrack(c, o, 0, { gain: 0.4 });
      sfxBoom(c, o, 0, { size: 0.2, gain: 0.8 });
      sfxMetal(c, o, 0, { base: 170, dur: 0.3, gain: 0.3, bend: 0.93 }); // panel knock
    } },
    { name: "scrape", dur: 1.0, build: (c, o) => {
      sfxBoom(c, o, 0, { size: 0.15, gain: 0.8 });
      sfxNoise(c, o, 0.01, { dur: 0.3, freq: 2400, sweepTo: 900, q: 3, gain: 0.45, attack: 0.01 }); // paint on paint
      sfxCrunch(c, o, 0.02, { dur: 0.2, density: 40, gain: 0.2, low: 1200, high: 3000 });
    } },
    { name: "bumper", dur: 1.0, build: (c, o) => {
      sfxCrack(c, o, 0, { gain: 0.45, bright: 1.2 });
      sfxBoom(c, o, 0, { size: 0.2, gain: 0.85 });
      sfxCrunch(c, o, 0.005, { dur: 0.12, density: 80, gain: 0.35, low: 1200, high: 3200 }); // plastic crunch
    } },
  ],
  medium: [
    { name: "crunch", dur: 1.4, build: (c, o) => {
      sfxCrack(c, o, 0, { gain: 0.6 });
      sfxBoom(c, o, 0, { size: 0.45 });
      sfxCrunch(c, o, 0.005, { dur: 0.35, density: 80, gain: 0.45 });
      sfxDebris(c, o, 0.2, { count: 6, spread: 0.5, gain: 0.3 });
    } },
    { name: "bang", dur: 1.4, build: (c, o) => {
      sfxCrack(c, o, 0, { gain: 0.8, bright: 1.1 });
      sfxBoom(c, o, 0, { size: 0.55 });
      sfxMetal(c, o, 0.005, { base: 140, dur: 0.7, gain: 0.35, bend: 0.85 });
      sfxCrunch(c, o, 0.01, { dur: 0.2, density: 60, gain: 0.3 });
    } },
    { name: "dent", dur: 1.4, build: (c, o) => {
      sfxCrack(c, o, 0, { gain: 0.5 });
      sfxBoom(c, o, 0, { size: 0.45 });
      sfxGroan(c, o, 0.03, { base: 150, dur: 0.6, gain: 0.22 });
      sfxCrunch(c, o, 0.01, { dur: 0.25, density: 60, gain: 0.35 });
    } },
    { name: "smack", dur: 1.4, build: (c, o) => {
      sfxCrack(c, o, 0, { gain: 0.7, bright: 1.2 });
      sfxBoom(c, o, 0, { size: 0.5 });
      sfxCrunch(c, o, 0.005, { dur: 0.2, density: 70, gain: 0.35 });
      sfxShatter(c, o, 0.02, { dur: 0.4, gain: 0.25 }); // a headlight goes
    } },
  ],
  heavy: [
    { name: "crash", dur: 2.4, build: (c, o) => {
      sfxCrack(c, o, 0, { gain: 1 });
      sfxBoom(c, o, 0, { size: 1 });
      sfxCrunch(c, o, 0.005, { dur: 0.6, density: 90, gain: 0.5 });
      sfxShatter(c, o, 0.03, { dur: 0.8, gain: 0.3 });
      sfxDebris(c, o, 0.25, { count: 16, spread: 1.2, gain: 0.25 });
    } },
    { name: "wreck", dur: 2.4, build: (c, o) => {
      // two-stage: the hit, then the body folding a beat later
      sfxCrack(c, o, 0, { gain: 0.9 });
      sfxBoom(c, o, 0, { size: 0.85 });
      sfxCrunch(c, o, 0.005, { dur: 0.3, density: 80, gain: 0.45 });
      sfxCrack(c, o, 0.14, { gain: 0.45, bright: 0.8 });
      sfxBoom(c, o, 0.14, { size: 0.7, gain: 0.6 });
      sfxGroan(c, o, 0.16, { base: 110, dur: 1.0, gain: 0.28 });
      sfxDebris(c, o, 0.35, { count: 12, spread: 1.1, gain: 0.3 });
    } },
    { name: "smash", dur: 2.4, build: (c, o) => {
      sfxCrack(c, o, 0, { gain: 1, bright: 1.2 });
      sfxBoom(c, o, 0, { size: 0.95 });
      sfxShatter(c, o, 0.01, { dur: 1.0, gain: 0.35 });
      sfxCrunch(c, o, 0.005, { dur: 0.4, density: 80, gain: 0.4 });
      sfxHubcap(c, o, 0.5, { base: 430, dur: 1.4, gain: 0.1 }); // and off it rolls
    } },
    { name: "pileup", dur: 2.4, build: (c, o) => {
      // three staggered impacts, like a chain reaction
      // each later hit weaker: overlapping booms sum, and the first hit must
      // stay the loudest moment
      [[0, 1], [0.11, 0.6], [0.26, 0.45]].forEach(([t, g]) => {
        sfxCrack(c, o, t, { gain: g * 0.8 });
        sfxBoom(c, o, t, { size: 0.8, gain: g });
        sfxCrunch(c, o, t + 0.005, { dur: 0.25, density: 70, gain: g * 0.4 });
      });
      sfxGroan(c, o, 0.3, { base: 95, dur: 1.1, gain: 0.2 });
      sfxDebris(c, o, 0.4, { count: 18, spread: 1.3, gain: 0.2 });
    } },
  ],
};

// tanh soft-clip curve: `drive` > 1 pushes loud parts into saturation.
function driveCurve(drive) {
  const n = 1024, curve = new Float32Array(n), norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

// Impulse response for the reverb tail: decaying noise, low-passed so it's
// warm rather than hissy.
function roomIR(c, seconds) {
  const len = Math.ceil(seconds * c.sampleRate);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  let y = 0;
  for (let i = 0; i < len; i++) {
    y += 0.25 * ((Math.random() * 2 - 1) - y);
    d[i] = y * Math.pow(1 - i / len, 2.2);
  }
  return buf;
}

// Signal chain, movie-style: recipe -> 70 Hz highpass (sub rumble is
// inaudible on small speakers and only eats headroom) -> compressor (glues
// the layers and makes the hit punch) -> saturation -> dry + reverb tail.
function renderSfx(sampleRate, recipe, fx) {
  const oc = new OfflineAudioContext(1, Math.ceil(recipe.dur * sampleRate), sampleRate);
  const bus = oc.createGain();
  const hp = oc.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 70;
  const comp = oc.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 6;
  comp.ratio.value = 6;
  comp.attack.value = 0.004; // lets the crack through before clamping down
  comp.release.value = 0.2;
  const shaper = oc.createWaveShaper();
  shaper.curve = driveCurve(fx.drive);
  shaper.oversample = "2x";
  bus.connect(hp).connect(comp).connect(shaper);
  shaper.connect(oc.destination); // dry
  const room = oc.createConvolver();
  room.buffer = roomIR(oc, fx.ir);
  const wet = oc.createGain();
  wet.gain.value = fx.room;
  shaper.connect(room).connect(wet).connect(oc.destination);
  recipe.build(oc, bus);
  return oc.startRendering().then((buf) => {
    const d = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) for (let i = 0; i < d.length; i++) d[i] *= 0.9 / peak;
    return buf;
  });
}

async function buildCollisionLibrary(sampleRate) {
  const lib = {};
  for (const [tier, recipes] of Object.entries(COLLISION_RECIPES)) {
    lib[tier] = await Promise.all(recipes.map((r) => renderSfx(sampleRate, r, COLLISION_FX[tier])));
  }
  return lib;
}

// Impact speed (closing speed along the contact normal, px/s) -> tier.
// For scale: DAMAGE_THRESHOLD is 70, a hard ram is ~300.
//
// Two rules decide whether a contact makes a sound:
//  - Any car: an impact at HIT_SOUND_MIN or harder always sounds.
//  - Player cars only: the FIRST touch of any obstacle sounds, however slow
//    (a parking nudge, easing onto the curb) -- quietly, scaled by speed
//    (TOUCH_VOLUME_MIN at a dead-slow touch). Continued contact after that
//    stays silent below HIT_SOUND_MIN, so resting against the curb doesn't
//    tick every frame. Traffic keeps only the speed rule, so distant NPC
//    scrapes don't clutter the mix.
const HIT_SOUND_MIN = 45;
const HIT_TIERS = [
  { name: "light", upTo: 130, volume: 0.35 },
  { name: "medium", upTo: 260, volume: 0.6 },
  { name: "heavy", upTo: 420, volume: 0.9 }, // upTo here only caps the in-tier volume ramp
];
const TOUCH_VOLUME_MIN = 0.12;
const HIT_SOUND_COOLDOWN = 0.09; // s; per car, unless the new hit is a higher tier
// A contact counts as "new" only after the car has been clear of that
// obstacle this long -- contact flickers on/off step to step when resting
// against something, and each flicker must not count as a fresh touch.
const TOUCH_GAP = 0.25; // s

function isPlayer(car) {
  return car === car1 || car === car2;
}

// Records that `car` is touching `key` (a crate/parked-car/other-car object,
// or "wall"/"curb") this step; returns true if it's a new touch.
function isNewTouch(car, key) {
  if (!car.contacts) car.contacts = new Map();
  const last = car.contacts.get(key);
  car.contacts.set(key, gameTime);
  return last === undefined || gameTime - last > TOUCH_GAP;
}

// Called from every collision site on every step of contact, with the
// closing speed (0 for resting contact) and whether it's a new touch.
// The per-car cooldown throttles repeats: grinding contact can register a
// run of small impacts step after step, which would otherwise machine-gun.
function collisionSound(speed, x, car, newTouch) {
  if (!audioReady() || !audio.library) return;
  const soft = speed < HIT_SOUND_MIN;
  if (soft && !(newTouch && isPlayer(car))) return;
  const tierIdx = HIT_TIERS.findIndex((t) => speed < t.upTo);
  const ti = soft ? 0 : tierIdx === -1 ? HIT_TIERS.length - 1 : tierIdx;
  const tier = HIT_TIERS[ti];
  const now = audio.ctx.currentTime;
  if (car.hitSoundAt !== undefined && now - car.hitSoundAt < HIT_SOUND_COOLDOWN && ti <= car.hitSoundTier) return;
  car.hitSoundAt = now;
  car.hitSoundTier = ti;

  let volume;
  if (soft) {
    // gentle first touch: from barely-there up to where the light tier starts
    volume = TOUCH_VOLUME_MIN + (tier.volume * 0.7 - TOUCH_VOLUME_MIN) * (speed / HIT_SOUND_MIN);
  } else {
    const lo = ti === 0 ? HIT_SOUND_MIN : HIT_TIERS[ti - 1].upTo;
    volume = tier.volume * (0.7 + 0.3 * clamp((speed - lo) / (tier.upTo - lo), 0, 1));
  }
  const choices = audio.library[tier.name];
  playBuffer(choices[Math.floor(Math.random() * choices.length)], {
    volume,
    rate: 0.9 + Math.random() * 0.2,
    pan: panFor(x),
  });
}

function playBuffer(buf, { volume, rate, pan }) {
  const ac = audio.ctx;
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = ac.createGain();
  g.gain.value = volume;
  const p = ac.createStereoPanner();
  p.pan.value = pan;
  src.connect(g).connect(p).connect(audio.master);
  src.start();
}

// ---- Coin and parking sounds (synthesized live) ---------------------------

// Routes a live-synthesized sound through its own volume + pan into master.
// Volumes are balanced against the collision tiers by measured peak level:
// coin pickup (~0.37) and parking (~0.65) sit clearly above a light bump
// (~0.3), so the rewards never lose to a fender-tap; the spawn whoosh is
// quieter, as ambience.
function liveSfx(x, volume, build) {
  if (!audioReady()) return;
  const ac = audio.ctx;
  const g = ac.createGain();
  g.gain.value = volume;
  const p = ac.createStereoPanner();
  p.pan.value = panFor(x);
  g.connect(p).connect(audio.master);
  build(ac, g, ac.currentTime + 0.01);
}

// Reverse whoosh that swells over the implosion animation, then a pop right
// as the coin appears (timed to COIN_IMPLODE_TIME).
function playCoinSpawnSound(x) {
  liveSfx(x, 0.6, (c, o, t) => {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, COIN_IMPLODE_TIME);
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 4;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(3200, t + COIN_IMPLODE_TIME);
    const g = c.createGain(); // crescendo: a reversed explosion swells in, then cuts off
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.8, t + COIN_IMPLODE_TIME - 0.02);
    g.gain.linearRampToValueAtTime(0.0001, t + COIN_IMPLODE_TIME);
    src.connect(f).connect(g).connect(o);
    src.start(t);
    src.stop(t + COIN_IMPLODE_TIME);
    sfxTone(c, o, t + COIN_IMPLODE_TIME, { freq: 520, freqTo: 1250, dur: 0.12, type: "triangle", gain: 0.9 });
  });
}

// Classic two-note "ka-ching".
function playCoinPickupSound(x) {
  liveSfx(x, 1.0, (c, o, t) => {
    sfxTone(c, o, t, { freq: 988, dur: 0.09, type: "square", gain: 0.35 });
    sfxTone(c, o, t + 0.075, { freq: 1319, dur: 0.35, type: "square", gain: 0.35 });
    sfxTone(c, o, t + 0.075, { freq: 2638, dur: 0.25, gain: 0.2 }); // shimmer
  });
}

// Successful park: a rising cartoon arpeggio, then firework pops and crackle
// to go with spawnFirework's two-stage burst.
function playParkedSound(x) {
  liveSfx(x, 0.9, (c, o, t) => {
    [523, 659, 784, 1047].forEach((f, i) => {
      sfxTone(c, o, t + i * 0.08, { freq: f, dur: i === 3 ? 0.4 : 0.12, type: "triangle", gain: 0.6 });
    });
    sfxNoise(c, o, t, { dur: 0.15, freq: 900, q: 0.7, gain: 0.7 }); // the pop
    sfxTone(c, o, t, { freq: 180, freqTo: 60, dur: 0.15, gain: 0.6 });
    sfxRattle(c, o, t + 0.18, { count: 14, spread: 0.5, gain: 0.35, freq: 3000 }); // crackle
  });
}

// Garage repair, in two parts, both played by the mechanic (see
// updateMechanic): the wrench work -- a quick ratchet whir and a clank --
// when they start on the car, then a bright two-note "ta-da" as the dents
// vanish. The wrench part was turned up on request: measured peak ~0.75
// (was ~0.49 for the whole old repair sound; volume 1.0 here hit the 1.0
// clipping ceiling), about level with the parking jingle.
function playWrenchSound(x) {
  liveSfx(x, 0.75, (c, o, t) => {
    for (let i = 0; i < 9; i++) {
      // ratchet: evenly spaced clicks, rising in pitch as it tightens
      sfxNoise(c, o, t + i * 0.035, { dur: 0.022, freq: 2200 + i * 180, q: 6, gain: 1.0 });
    }
    sfxMetal(c, o, t + 0.34, { base: 620, dur: 0.3, gain: 0.8, ratios: [1, 1.52, 2.31] });
  });
}

function playRepairSound(x) {
  liveSfx(x, 0.8, (c, o, t) => {
    sfxTone(c, o, t, { freq: 784, dur: 0.12, type: "triangle", gain: 0.6 });
    sfxTone(c, o, t + 0.12, { freq: 1175, dur: 0.4, type: "triangle", gain: 0.6 });
    sfxTone(c, o, t + 0.12, { freq: 2350, dur: 0.3, gain: 0.15 }); // sparkle
  });
}

// An NPC car horn: two detuned sawtooth tones a third apart through a
// lowpass (the classic two-note car-horn chord), with a sustained envelope.
// `pitch` varies per car so different cars sound different. A stuck car
// randomly does one long honk or a double "beep-beep"; `angry` (a player
// just crashed into it) is an indignant "beep-beep-beeeeep".
function playHornSound(x, pitch, angry = false) {
  // Peak ~0.12: well under a light bump on paper, because a sustained tone
  // sounds much louder than a short percussive hit at the same peak (and
  // was lowered again after playtesting found the honks too loud).
  liveSfx(x, 0.16, (c, o, t) => {
    const pattern = angry
      ? [[0, 0.11], [0.16, 0.11], [0.32, 0.55]]
      : Math.random() < 0.5 ? [[0, 0.42]] : [[0, 0.13], [0.2, 0.22]];
    for (const [start, len] of pattern) {
      const t0 = t + start;
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 1900;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.5, t0 + 0.015);
      g.gain.setValueAtTime(0.5, t0 + len - 0.03);
      g.gain.linearRampToValueAtTime(0.0001, t0 + len);
      f.connect(g).connect(o);
      for (const base of [370, 466]) {
        const osc = c.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = base * pitch;
        osc.connect(f);
        osc.start(t0);
        osc.stop(t0 + len + 0.01);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Car physics
// ---------------------------------------------------------------------------

const CAR = {
  length: 46,
  width: 24,
  wheelBase: 30, // distance between front and rear axle
  track: 18, // distance between the front-left/front-right tire centers (for Ackermann geometry)
  maxSteer: 0.47, // radians, the effective single-front-wheel ("bicycle model") steering lock -- kinematic min radius = wheelBase/tan(maxSteer)
  // Variable-ratio steering: full lock is maxSteer at steerMidSpeed, a bit
  // more at crawl (tighter circle for parking) and a bit less at speed (wider,
  // calmer). This shapes the *geometric* turning circle, which at crawl speed
  // only the steer angle can change; tire grip still decides when a turn
  // starts to slide. Linearly interpolated between the three speeds.
  steerLockCrawl: 1.15, // x maxSteer at or below steerCrawlSpeed
  steerLockFast: 0.8, // x maxSteer at or above steerFastSpeed
  steerCrawlSpeed: 40, // px/s
  steerMidSpeed: 120,
  steerFastSpeed: 260,
  enginePower: 340, // forward acceleration, px/s^2 -- kept gentle for parking-scale control
  brakePower: 1150, // deceleration when braking while moving forward
  reversePower: 200,
  dragCoeff: 0.62, // proportional drag
  rollResist: 55, // constant rolling resistance, px/s^2
  maxSpeed: 360,
  maxReverseSpeed: 120,
  // Per-axle tire model: lateral force = -stiffness * slipAngle, clamped to
  // the axle's max grip. Rear grip is set a little below front on purpose --
  // push a turn too hard and the *rear* breaks loose first (oversteer/drift)
  // rather than the front just plowing straight (understeer).
  // Stiffness is kept low relative to maxSteer on purpose: at the old, much
  // higher stiffness, even a small steering input reached full saturation
  // (maxGrip) almost instantly -- there was no gentle/proportional region,
  // so any "quick touch" landed the same maximum torque as holding full
  // lock, and it read as the steering being wildly oversensitive. Keeping
  // saturation a real turn away means a brief tap produces a proportionally
  // small nudge instead of an instant full-torque snap.
  corneringStiffnessFront: 1500,
  corneringStiffnessRear: 1350,
  maxGripFront: 480,
  maxGripRear: 430,
  lowSpeedGripRef: 40, // px/s; lateral grip fades in below this speed so an at-rest car doesn't jitter
  maxAngularVel: 8, // rad/s hard numerical safety cap, not a gameplay tuning knob
  spinTorqueScale: 220, // divides collision torque (r x dv) into an angularVel change -- lower = more dramatic spin from hits
  maxCollisionSpin: 9, // rad/s safety clamp on angularVel after any single collision impulse
  // Coefficient of restitution for capsule-circle collisions (see
  // resolveCircles): 0 = fully inelastic (stick together), 1 = fully
  // elastic (for equal masses head-on, ALL of the striking object's kinetic
  // energy transfers to the one it hit). Car-vs-car is kept high on purpose
  // -- ramming a stationary car should visibly send it flying, not just
  // nudge it -- while car-vs-obstacle (crates, parked cars) stays lower/more
  // damped, since those aren't meant to go rocketing off.
  carCollisionRestitution: 0.85,
  obstacleCollisionRestitution: 0.5,
  wallBounce: 0.75, // fraction of incoming speed reflected back off the arena walls
};
CAR.wallRadius = Math.hypot(CAR.length, CAR.width) / 2;
// Collision shape: a "capsule" made of two circles along the centerline,
// sized to hug the actual rectangle closely (needed for tight maneuvers
// like parallel parking, where a single fat circle would be too sloppy).
CAR.capsuleOffset = (CAR.length - CAR.width) / 2;
CAR.capsuleRadius = CAR.width / 2;
// Yaw moment of inertia of a uniform rectangular plate about its center
// (mass normalized to 1, so tire forces below are directly accelerations).
CAR.inertia = (CAR.length * CAR.length + CAR.width * CAR.width) / 12;

function createCar(x, y, angle, color, input) {
  return {
    pos: { x, y },
    vel: { x: 0, y: 0 },
    angle,
    angularVel: 0,
    steerCurrent: 0, // the actual, rate-limited steering-rack angle (see stepCar)
    seed: Math.random() * 1000, // this car's hand-drawn outline wobble, see carArt
    damage: 0, // 0..1, see applyDamage
    dents: [], // car-local {x, y, r}, drawn by drawCar
    color,
    input, // { up, down, left, right }, each an array of key names (any one of them works)
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function readInput(car) {
  if (car.drive) return car.drive; // AI-controlled traffic, see npcDrive
  if (car.autopilot) return car.ap.drive; // a player on autopilot, see updateAutopilot
  const held = (names) => (names.some((k) => keys.has(k)) ? 1 : 0);
  const throttle = held(car.input.up) - held(car.input.down);
  const steer = held(car.input.right) - held(car.input.left);
  if (throttle || steer) car.hasDriven = true; // drops the key hint from this player's HUD
  return { throttle, steer };
}

// Splits a single "effective front wheel" steering angle (the one the
// dynamics below actually use) into the two distinct road-wheel angles a
// real front axle would have, via Ackermann geometry: both wheels' axes
// extend to a common point on the rear-axle line, so the inside wheel (the
// one on the side being turned toward) carves a tighter arc than the
// outside one. This only affects what's drawn -- the dynamics use a single
// effective wheel, same as the standard "bicycle model" they're built on.
function ackermannWheelAngles(centerSteer, wheelBase, track) {
  if (Math.abs(centerSteer) < 1e-4) return { left: 0, right: 0 };
  const sign = Math.sign(centerSteer);
  const turnRadius = wheelBase / Math.tan(Math.abs(centerSteer));
  const halfTrack = track / 2;
  const innerRadius = Math.max(turnRadius - halfTrack, 0.5);
  const outerRadius = turnRadius + halfTrack;
  const innerMag = Math.atan(wheelBase / innerRadius);
  const outerMag = Math.atan(wheelBase / outerRadius);
  // steer > 0 turns the car toward its own right side, making the right
  // wheel the inner one (see the world-space derivation in capsuleOffsets'
  // sibling geometry above: local -halfTrack is "left", +halfTrack "right").
  const leftMag = sign > 0 ? outerMag : innerMag;
  const rightMag = sign > 0 ? innerMag : outerMag;
  return { left: sign * leftMag, right: sign * rightMag };
}

// Variable-ratio steering multiplier on maxSteer for a given forward speed
// (see the steerLock* constants in CAR).
function steerLockScale(speed) {
  const p = CAR;
  if (speed <= p.steerCrawlSpeed) return p.steerLockCrawl;
  if (speed <= p.steerMidSpeed) {
    const t = (speed - p.steerCrawlSpeed) / (p.steerMidSpeed - p.steerCrawlSpeed);
    return p.steerLockCrawl + (1 - p.steerLockCrawl) * t;
  }
  if (speed >= p.steerFastSpeed) return p.steerLockFast;
  const t = (speed - p.steerMidSpeed) / (p.steerFastSpeed - p.steerMidSpeed);
  return 1 + (p.steerLockFast - 1) * t;
}

// Two-axle dynamic bicycle model: front and rear tires each get a slip
// angle (the angle between where the tire is pointed and where it's
// actually moving) which produces a lateral force via a linear
// cornering-stiffness curve, clamped to that axle's max grip. Both forces
// act at their axle's offset from the center of mass, producing not just
// linear acceleration but real torque (r x F) -- so, unlike a kinematic
// model, turning rate emerges from the tires' actual grip limit rather than
// needing an artificial speed-based steering-authority taper to stay
// sane (a full-lock turn at speed naturally understeers/drifts once the
// tires saturate, instead of demanding an unrealistic turn rate).
function stepCar(car, dt) {
  const { throttle, steer } = readInput(car);
  const p = CAR;

  const forward = { x: Math.cos(car.angle), y: Math.sin(car.angle) };
  const right = { x: -forward.y, y: forward.x };

  const forwardSpeed = car.vel.x * forward.x + car.vel.y * forward.y;
  const speed = Math.hypot(car.vel.x, car.vel.y);

  // The steering rack can't snap to full lock instantly -- car.steerCurrent
  // rate-limits how fast it chases the raw input target, same as a real
  // steering system takes a moment to wind to full lock. This is what makes
  // a brief tap produce a small, proportional nudge instead of instantly
  // commanding the same torque as holding full lock (previously the physics
  // used the raw target angle directly, with only the *rendering* lagging
  // behind it for visual smoothness, so even a one-frame tap snapped the
  // front tire to a large slip angle and read as wildly oversensitive).
  // The ramp is deliberately asymmetric: winding UP toward a bigger angle is
  // slow (that's what tames a quick tap), but winding back DOWN toward
  // center is fast -- otherwise releasing the key doesn't stop the turn
  // right away, it leaves a decaying "tail" of steering angle that keeps
  // adding rotation after release and ends up producing *more* total turn
  // from a quick tap than an instant on/instant off response would.
  const steerTarget = steer * p.maxSteer * steerLockScale(Math.abs(forwardSpeed));
  const steerRate = Math.abs(steerTarget) > Math.abs(car.steerCurrent) ? 6 : 30;
  car.steerCurrent += (steerTarget - car.steerCurrent) * Math.min(1, steerRate * dt);
  const steerAngle = car.steerCurrent;

  const halfWB = p.wheelBase / 2;
  const rFront = { x: forward.x * halfWB, y: forward.y * halfWB };
  const rRear = { x: -forward.x * halfWB, y: -forward.y * halfWB };

  // Ground velocity at each axle: v_point = v_cg + angularVel * perp(r).
  const vFront = { x: car.vel.x - car.angularVel * rFront.y, y: car.vel.y + car.angularVel * rFront.x };
  const vRear = { x: car.vel.x - car.angularVel * rRear.y, y: car.vel.y + car.angularVel * rRear.x };

  const frontWheelAngle = car.angle + steerAngle;
  const frontForward = { x: Math.cos(frontWheelAngle), y: Math.sin(frontWheelAngle) };
  const frontRight = { x: -frontForward.y, y: frontForward.x };

  const slipFront = Math.atan2(
    vFront.x * frontRight.x + vFront.y * frontRight.y,
    vFront.x * frontForward.x + vFront.y * frontForward.y
  );
  const slipRear = Math.atan2(
    vRear.x * right.x + vRear.y * right.y,
    vRear.x * forward.x + vRear.y * forward.y
  );

  const gripFade = Math.min(speed / p.lowSpeedGripRef, 1);
  const lateralFront = clamp(-p.corneringStiffnessFront * slipFront, -p.maxGripFront, p.maxGripFront) * gripFade;
  const lateralRear = clamp(-p.corneringStiffnessRear * slipRear, -p.maxGripRear, p.maxGripRear) * gripFade;

  const forceFront = { x: frontRight.x * lateralFront, y: frontRight.y * lateralFront };
  const forceRear = { x: right.x * lateralRear, y: right.y * lateralRear };

  const torque =
    (rFront.x * forceFront.y - rFront.y * forceFront.x) +
    (rRear.x * forceRear.y - rRear.y * forceRear.x);
  car.angularVel = clamp(car.angularVel + (torque / p.inertia) * dt, -p.maxAngularVel, p.maxAngularVel);
  car.angle += car.angularVel * dt;

  car.vel.x += (forceFront.x + forceRear.x) * dt;
  car.vel.y += (forceFront.y + forceRear.y) * dt;

  // Engine / brake / reverse along the car's forward axis. Rear-wheel drive:
  // a force purely along the heading, applied at the rear axle (which sits
  // on that same heading line), produces zero torque either way, so it's
  // simplest to just add it straight to the CG.
  // Collision damage lowers the top speed (the clamp below) and saps the
  // engine, but only by half as much -- at full damage, cutting power as hard
  // as top speed left it below rolling resistance and the car couldn't move
  // at all. Brakes are left alone: a wrecked car should still be able to stop.
  const health = carHealth(car);
  const power = 1 - DAMAGE_POWER_LOSS * (1 - health);
  let longAccel = 0;
  if (throttle > 0) {
    longAccel = p.enginePower * power;
  } else if (throttle < 0) {
    longAccel = forwardSpeed > 1 ? -p.brakePower : -p.reversePower * power;
  }
  car.vel.x += forward.x * longAccel * dt;
  car.vel.y += forward.y * longAccel * dt;

  // Drag + rolling resistance.
  car.vel.x -= car.vel.x * p.dragCoeff * dt;
  car.vel.y -= car.vel.y * p.dragCoeff * dt;
  if (speed > 1) {
    car.vel.x -= (car.vel.x / speed) * p.rollResist * dt;
    car.vel.y -= (car.vel.y / speed) * p.rollResist * dt;
  }

  // Clamp forward/reverse top speed along the heading only -- lateral
  // (drift) speed is left alone, it's already grip-limited above.
  const fwdAfter = car.vel.x * forward.x + car.vel.y * forward.y;
  const latAfter = car.vel.x * right.x + car.vel.y * right.y;
  // Damage caps top speed, but never below a crawl, so a wreck can still park.
  const fwdClamped = clamp(fwdAfter,
    -Math.max(p.maxReverseSpeed * health, DAMAGED_MIN_REVERSE),
    Math.max(p.maxSpeed * health, DAMAGED_MIN_SPEED));
  car.vel.x = forward.x * fwdClamped + right.x * latAfter;
  car.vel.y = forward.y * fwdClamped + right.y * latAfter;

  car.pos.x += car.vel.x * dt;
  car.pos.y += car.vel.y * dt;
}

function resolveWalls(car) {
  const r = CAR.wallRadius;
  const b = CAR.wallBounce;
  if (car.pos.x - r < 0) {
    car.pos.x = r;
    boundaryHit(car, Math.max(0, -car.vel.x), { x: 0, y: car.pos.y }, "wall");
    car.vel.x = Math.abs(car.vel.x) * b;
    car.angularVel *= 0.5;
  } else if (car.pos.x + r > W) {
    car.pos.x = W - r;
    boundaryHit(car, Math.max(0, car.vel.x), { x: W, y: car.pos.y }, "wall");
    car.vel.x = -Math.abs(car.vel.x) * b;
    car.angularVel *= 0.5;
  }
  if (car.pos.y - r < 0) {
    car.pos.y = r;
    boundaryHit(car, Math.max(0, -car.vel.y), { x: car.pos.x, y: 0 }, "wall");
    car.vel.y = Math.abs(car.vel.y) * b;
    car.angularVel *= 0.5;
  } else if (car.pos.y + r > H) {
    car.pos.y = H - r;
    boundaryHit(car, Math.max(0, car.vel.y), { x: car.pos.x, y: H }, "wall");
    car.vel.y = -Math.abs(car.vel.y) * b;
    car.angularVel *= 0.5;
  }
}

// Returns -1 if the circles aren't touching at all; otherwise the closing
// speed along the contact normal (0 if touching but already separating) --
// how hard the hit was, for collision damage and sound. Callers use `>= 0`
// to mean "in contact" (contact sounds) and `> 0` to mean "an impact".
function resolveCircles(aPos, aVel, aR, bPos, bVel, bR, bStatic, restitution) {
  const dx = bPos.x - aPos.x;
  const dy = bPos.y - aPos.y;
  const dist = Math.hypot(dx, dy) || 0.001;
  const overlap = aR + bR - dist;
  if (overlap <= 0) return -1;

  const nx = dx / dist, ny = dy / dist;
  const pushA = bStatic ? overlap : overlap / 2;
  const pushB = bStatic ? 0 : overlap / 2;
  aPos.x -= nx * pushA; aPos.y -= ny * pushA;
  if (!bStatic) { bPos.x += nx * pushB; bPos.y += ny * pushB; }

  const rvx = (bStatic ? 0 : bVel.x) - aVel.x;
  const rvy = (bStatic ? 0 : bVel.y) - aVel.y;
  const velAlongNormal = rvx * nx + rvy * ny;
  if (velAlongNormal > 0) return 0;

  const impulse = (-(1 + restitution) * velAlongNormal) / (bStatic ? 1 : 2);
  aVel.x -= impulse * nx; aVel.y -= impulse * ny;
  if (!bStatic) { bVel.x += impulse * nx; bVel.y += impulse * ny; }
  return -velAlongNormal;
}

// The two capsule-circle centers as offsets from the car's own center
// (world-space, given the car's current heading) -- also doubles as the
// lever arm "r" used for collision torque below.
function capsuleOffsets(angle) {
  const fx = Math.cos(angle), fy = Math.sin(angle);
  const off = CAR.capsuleOffset;
  return [
    { x: fx * off, y: fy * off },
    { x: -fx * off, y: -fy * off },
  ];
}

function capsuleCenters(pos, angle) {
  return capsuleOffsets(angle).map((r) => ({ x: pos.x + r.x, y: pos.y + r.y }));
}

// An off-center impact should spin the car, not just push it -- torque is
// the lever arm (r, car-center to the capsule circle that got hit) crossed
// with the velocity change that circle's collision just produced.
function applyCollisionSpin(car, r, velBefore) {
  const dvx = car.vel.x - velBefore.x, dvy = car.vel.y - velBefore.y;
  if (dvx === 0 && dvy === 0) return;
  const torque = r.x * dvy - r.y * dvx;
  car.angularVel = clamp(
    car.angularVel + torque / CAR.spinTorqueScale,
    -CAR.maxCollisionSpin,
    CAR.maxCollisionSpin
  );
}

// Point on circle `from`'s rim facing `toward` -- where a collision touched.
function contactPoint(from, toward, radius) {
  const dx = toward.x - from.x, dy = toward.y - from.y;
  const d = Math.hypot(dx, dy) || 0.001;
  return { x: from.x + (dx / d) * radius, y: from.y + (dy / d) * radius };
}

// Collides a car's capsule against a single static circle (a crate, or one
// end of a parked car's capsule), feeding the resulting push/impulse back
// into the car's actual pos/vel (each capsule circle is a fixed offset from
// the car center, so a pure translation of the center moves both).
// `key` identifies the obstacle for contact-sound tracking (isNewTouch).
function resolveCarVsStaticCircle(car, obstaclePos, obstacleR, key) {
  // Both capsule circles can register the same hit; damage is taken once,
  // from the harder of the two.
  let hit = 0, hitAt = null, touched = false;
  for (const r of capsuleOffsets(car.angle)) {
    const c = { x: car.pos.x + r.x, y: car.pos.y + r.y };
    const posBefore = { x: c.x, y: c.y };
    const velBefore = { x: car.vel.x, y: car.vel.y };
    const s = resolveCircles(c, car.vel, CAR.capsuleRadius, obstaclePos, null, obstacleR, true, CAR.obstacleCollisionRestitution);
    if (s >= 0) touched = true;
    if (s > hit) { hit = s; hitAt = contactPoint(c, obstaclePos, CAR.capsuleRadius); }
    car.pos.x += c.x - posBefore.x;
    car.pos.y += c.y - posBefore.y;
    applyCollisionSpin(car, r, velBefore);
  }
  if (!touched) return;
  if (hitAt) {
    applyDamage(car, hit, hitAt);
    // A parked car (the key; crates have no dents) takes a dent where it was
    // hit. It never smokes: emitSmoke only runs for moving cars. It's drawn
    // in the static layer, so that needs a redraw to show the dent. A hit can
    // touch both ends of its capsule in one step; that's still one dent.
    if (key.dents && hit > DAMAGE_THRESHOLD && key.lastDentAt !== gameTime) {
      key.lastDentAt = gameTime;
      applyDamage(key, hit, contactPoint(obstaclePos, hitAt, obstacleR));
      staticDirty = true;
    }
  }
  collisionSound(hit, (hitAt || obstaclePos).x, car, isNewTouch(car, key));
  if (hit >= HIT_SOUND_MIN) pedestriansNotice(hitAt.x, hitAt.y, "crash", hit);
}

function resolveCarVsCar(carA, carB) {
  let hit = 0, hitAtA = null, hitAtB = null, touched = false;
  for (const rA of capsuleOffsets(carA.angle)) {
    for (const rB of capsuleOffsets(carB.angle)) {
      const a = { x: carA.pos.x + rA.x, y: carA.pos.y + rA.y };
      const b = { x: carB.pos.x + rB.x, y: carB.pos.y + rB.y };
      const posBeforeA = { x: a.x, y: a.y }, posBeforeB = { x: b.x, y: b.y };
      const velBeforeA = { x: carA.vel.x, y: carA.vel.y }, velBeforeB = { x: carB.vel.x, y: carB.vel.y };
      const s = resolveCircles(a, carA.vel, CAR.capsuleRadius, b, carB.vel, CAR.capsuleRadius, false, CAR.carCollisionRestitution);
      if (s >= 0) touched = true;
      if (s > hit) {
        hit = s;
        hitAtA = contactPoint(a, b, CAR.capsuleRadius);
        hitAtB = contactPoint(b, a, CAR.capsuleRadius);
      }
      carA.pos.x += a.x - posBeforeA.x; carA.pos.y += a.y - posBeforeA.y;
      carB.pos.x += b.x - posBeforeB.x; carB.pos.y += b.y - posBeforeB.y;
      applyCollisionSpin(carA, rA, velBeforeA);
      applyCollisionSpin(carB, rB, velBeforeB);
    }
  }
  if (!touched) return;
  if (hitAtA) {
    applyDamage(carA, hit, hitAtA);
    applyDamage(carB, hit, hitAtB);
  }
  // Track the contact on both cars, but play one sound for the pair, voiced
  // by a player if one is involved (so the player "first touch" rule applies).
  const newA = isNewTouch(carA, carB), newB = isNewTouch(carB, carA);
  const voice = isPlayer(carA) || !isPlayer(carB) ? carA : carB;
  const x = hitAtA ? hitAtA.x : (carA.pos.x + carB.pos.x) / 2;
  collisionSound(hit, x, voice, voice === carA ? newA : newB);
  if (hit >= HIT_SOUND_MIN) {
    pedestriansNotice(hitAtA.x, hitAtA.y, "crash", hit);
    // a player crashing into traffic gets honked at
    if (carA.drive && isPlayer(carB)) npcGotRammed(carA);
    if (carB.drive && isPlayer(carA)) npcGotRammed(carB);
  }
}

// A car in contact with the arena wall or the curb: same damage + sound as
// any other collision, just without a second body to push against. Called
// on every step of contact (speed 0 when not moving into it), so contact
// tracking sees resting contact as continuous.
function boundaryHit(car, speed, point, key) {
  applyDamage(car, speed, point);
  collisionSound(speed, point.x, car, isNewTouch(car, key));
  if (speed >= HIT_SOUND_MIN) pedestriansNotice(point.x, point.y, "crash", speed);
}

// ---------------------------------------------------------------------------
// Collision damage
// ---------------------------------------------------------------------------
// Any hit harder than a gentle bump adds to car.damage (0..1), leaves a dent
// on the body where it landed, and -- via the health factor in stepCar --
// saps engine power and top speed. Damaged cars smoke (emitSmoke), more
// thickly and darkly the worse it gets. Only the garage (updateGarage)
// resets it.

const DAMAGE_THRESHOLD = 70; // px/s closing speed; softer contact (parking nudges, curb scrapes) is free
const DAMAGE_PER_SPEED = 1 / 600; // damage per px/s of closing speed above the threshold (doubled from 1/1200: cars felt too robust)
const DAMAGE_SLOWDOWN = 1; // at full damage, top speed drops all the way to the crawl floors below
// Floors under the damaged top speed: parking only needs crawl speeds
// (the autopilot reverses in at ~28 px/s), so capping above them lets damage
// slow a car right down without ever making it unable to park.
const DAMAGED_MIN_SPEED = 35; // px/s forward
const DAMAGED_MIN_REVERSE = 30; // px/s reverse
// < 1 front-loads the slowdown: the first hits cost the most speed (at 0.5,
// damage 0.25 already halves top speed), and the crawl floors above keep a
// wreck able to limp to the garage and park.
const DAMAGE_SLOWDOWN_CURVE = 0.5;
// Engine/reverse power loses only this fraction of what top speed loses, so a
// wreck keeps enough power to beat rolling resistance (see stepCar).
const DAMAGE_POWER_LOSS = 0.5;
const MAX_DENTS = 14;
const SMOKE_DAMAGE_MIN = 0.12; // below this, a car is dented but not smoking yet

function applyDamage(car, impactSpeed, worldPoint) {
  const excess = impactSpeed - DAMAGE_THRESHOLD;
  if (excess <= 0) return;
  car.damage = Math.min(1, car.damage + excess * DAMAGE_PER_SPEED);

  // Record the dent in the car's own frame so it moves/rotates with the body,
  // clamped onto the body rectangle (wall contacts come from a coarser shape).
  const dx = worldPoint.x - car.pos.x, dy = worldPoint.y - car.pos.y;
  const cos = Math.cos(car.angle), sin = Math.sin(car.angle);
  car.dents.push({
    x: clamp(dx * cos + dy * sin, -CAR.length / 2, CAR.length / 2),
    y: clamp(-dx * sin + dy * cos, -CAR.width / 2, CAR.width / 2),
    r: clamp(4 + excess / 35, 4, 10),
  });
  if (car.dents.length > MAX_DENTS) car.dents.shift();
}

// Engine-power / top-speed multiplier for a car's current damage.
function carHealth(car) {
  return 1 - DAMAGE_SLOWDOWN * Math.pow(car.damage, DAMAGE_SLOWDOWN_CURVE);
}

function repairCar(car) {
  car.damage = 0;
  car.dents.length = 0;
}

// Puffs of smoke out the back of the car, at a rate and darkness that scale
// with damage. Purely cosmetic -- rides the shared particles array.
function emitSmoke(car, dt) {
  if (car.damage < SMOKE_DAMAGE_MIN) return;
  const rate = 3 + car.damage * 22; // puffs per second
  if (Math.random() > rate * dt) return;
  const tail = -CAR.length / 2 - 2; // just behind the rear bumper
  const gray = Math.round(185 - car.damage * 125);
  particles.push({
    type: "smoke",
    x: car.pos.x + Math.cos(car.angle) * tail + (Math.random() - 0.5) * 6,
    y: car.pos.y + Math.sin(car.angle) * tail + (Math.random() - 0.5) * 6,
    vx: car.vel.x * 0.25 + (Math.random() - 0.5) * 18,
    vy: car.vel.y * 0.25 + (Math.random() - 0.5) * 18,
    size: 3 + Math.random() * 2,
    growSpeed: 10 + Math.random() * 8,
    color: `rgb(${gray},${gray},${gray})`,
    alpha: 0.3 + car.damage * 0.3,
    life: 0,
    maxLife: 0.9 + Math.random() * 0.8,
  });
}

// ---------------------------------------------------------------------------
// World: cars + static crates + parking street
// ---------------------------------------------------------------------------

let car1, car2, crates, street;
let npcs = []; // AI traffic cars, see updateTraffic
let npcSpawnTimer = 0;
let gameTime = 0; // seconds of simulation since setupWorld, see updateHint
// The pre-drawn static scene (see buildStaticLayer) needs redrawing -- set
// whenever street/crates are (re)built; render() does the actual rebuild,
// since the render code's constants aren't initialized yet when setupWorld
// first runs.
let staticDirty = true;
let particles = []; // cosmetic-only firework sparks/rings, see spawnFirework

// Bright cartoon paint jobs, but none close to the players' blue/orange.
const PARKED_COLORS = ["#b9a4e0", "#8fd6b4", "#f28b82", "#f6c85f", "#9ec5d8", "#d99ad0"];

// Builds a row of parked cars along a curb, with a couple of open gaps sized
// for parallel parking practice (a roomy one and a tight one).
function buildStreet() {
  const len = CAR.length;
  const tightGap = 9; // normal bumper-to-bumper spacing between parked cars
  const segments = [
    { t: "car" }, { t: "gap", w: tightGap }, { t: "car" }, { t: "gap", w: tightGap }, { t: "car" },
    { t: "spot", w: len * 1.7, label: "easy" },
    { t: "car" }, { t: "gap", w: tightGap }, { t: "car" },
    { t: "spot", w: len * 1.3, label: "tight" },
    { t: "car" }, { t: "gap", w: tightGap }, { t: "car" },
  ];
  const totalWidth = segments.reduce((sum, s) => sum + (s.t === "car" ? len : s.w), 0);

  const curbY = H * 0.82;
  const carCenterY = curbY - CAR.width / 2 - 6;

  let x = (W - totalWidth) / 2;
  const parkedCars = [];
  const parkingSpots = [];
  for (const seg of segments) {
    if (seg.t === "car") {
      const pc = createCar(x + len / 2, carCenterY, 0, PARKED_COLORS[Math.floor(Math.random() * PARKED_COLORS.length)], null);
      pc.collisionCircles = capsuleCenters(pc.pos, pc.angle);
      parkedCars.push(pc);
      x += len;
    } else {
      if (seg.t === "spot") parkingSpots.push({ x0: x, x1: x + seg.w, label: seg.label });
      x += seg.w;
    }
  }

  const centerlineY = curbY - 90;
  const npcLaneY = centerlineY - CAR.width / 2 - 8; // traffic lane, just above the centerline

  // Sidewalk band just below the curb (kept clear for pedestrians), lawn
  // below that.
  const sidewalkBottomY = curbY + Math.min(46, (H - curbY) * 0.45);

  // Repair garage in the bottom-right corner. The building sits on the lawn
  // BELOW the sidewalk, so the sidewalk runs unbroken in front of it, and a
  // driveway (drawGarageBuilding) crosses the sidewalk from its door to a
  // lowered curb. Its service pad is the patch of road in front of that.
  const garageW = 120;
  const gx0 = W - garageW - 16, gx1 = W - 16;
  const garage = {
    x0: gx0, x1: gx1,
    padY0: curbY - 66, curbY,
    buildingY0: sidewalkBottomY + 6, bottomY: H - 8,
    doorX0: gx0 + 18, doorX1: gx1 - 18,
  };
  garage.doorH = Math.min(18, (garage.bottomY - garage.buildingY0) * 0.3); // roll-up door depth

  return { curbY, carCenterY, centerlineY, npcLaneY, sidewalkBottomY, parkedCars, parkingSpots, garage };
}

function buildCrates() {
  const crates = [];
  const cols = 4, rows = 3;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      crates.push({
        x: W * 0.5 + (i - (cols - 1) / 2) * 90,
        y: H * 0.15 + j * 70,
        r: 16,
      });
    }
  }
  return crates;
}

function setupWorld() {
  car1 = createCar(W * 0.35, H * 0.5, -Math.PI / 2, "#4fc3ff", {
    up: ["w"], down: ["s"], left: ["a"], right: ["d"],
  });
  car2 = createCar(W * 0.65, H * 0.5, Math.PI / 2, "#ffa64f", {
    up: ["i", "arrowup"], down: ["k", "arrowdown"], left: ["j", "arrowleft"], right: ["l", "arrowright"],
  });

  crates = buildCrates();
  street = buildStreet();

  car1.score = 0; car1.gameState = "seekCoin";
  car2.score = 0; car2.gameState = "seekCoin";
  car1.label = "P1"; car1.keyHint = "WASD"; car1.hasDriven = false;
  car2.label = "P2"; car2.keyHint = "IJKL / Arrows"; car2.hasDriven = false;
  particles.length = 0;
  spawnCoin(); // after clearing particles, so its spawn animation survives
  resetTraffic();
  resetPedestrians();
  mechanic = null;
  garageDoorOpen = 0;
  gameTime = 0;
  staticDirty = true;
}

// ---------------------------------------------------------------------------
// Coin-fetch / parallel-park game loop
// ---------------------------------------------------------------------------
// Each car alternates between two states: "seekCoin" (drive over the coin to
// collect it) and "mustPark" (no new coin appears until the car comes to
// rest, aligned, inside one of the marked curb spots). This forces a
// parallel-parking rep between every pair of coin fetches.

const COIN_RADIUS = 9;
const PICKUP_DIST = CAR.capsuleRadius + COIN_RADIUS + 4;
const PARK_SPEED_LIMIT = 2; // px/s, "stopped" for parking-detection purposes
const PARK_Y_TOLERANCE = 13;
const PARK_ANGLE_TOLERANCE = 0.3; // radians (~17deg), either direction along the curb
const PARK_X_MARGIN = 2; // px inset from the spot's painted edges the center must clear

// How far a coin's edge must stay from a crate's square (so the coin and its
// glow never overlap a box). Deliberately small: coins may spawn in the
// lanes BETWEEN the crates in the grid (38px+ wide, a car is 24px), which
// the old rule (56px from every crate center) ruled out almost entirely.
const COIN_CRATE_GAP = 5;

// Distance from (x, y) to the nearest point of crate c's drawn square.
function distToCrate(x, y, c) {
  const dx = Math.max(Math.abs(x - c.x) - c.r, 0);
  const dy = Math.max(Math.abs(y - c.y) - c.r, 0);
  return Math.hypot(dx, dy);
}

function randomCoinPos() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = 60 + Math.random() * (W - 120);
    const y = 60 + Math.random() * Math.max(40, street.curbY - 150 - 60);
    if (crates.every((c) => distToCrate(x, y, c) > COIN_RADIUS + COIN_CRATE_GAP)) return { x, y };
  }
  return { x: W / 2, y: H * 0.3 };
}

let coin = null; // shared: only one coin exists at a time, so both cars race for it

// A new coin doesn't just appear: sparks implode onto its spot over
// COIN_IMPLODE_TIME (a reverse explosion), then it pops in with a flash.
// It can't be collected until it has popped -- no grabbing an invisible coin.
const COIN_IMPLODE_TIME = 0.6; // seconds from spawn until the coin appears
const COIN_POP_TIME = 0.25; // seconds of the overshoot "pop" scale-in after that

function spawnCoin() {
  coin = { ...randomCoinPos(), age: 0, popped: false };
  spawnImplosion(coin.x, coin.y);
  playCoinSpawnSound(coin.x);
}

// coin.age drives both the draw (drawCoin) and collectability (updateCoinRace).
function updateCoin(dt) {
  coin.age += dt;
  if (!coin.popped && coin.age >= COIN_IMPLODE_TIME) {
    coin.popped = true;
    particles.push({ type: "flash", x: coin.x, y: coin.y, radius: 22, life: 0, maxLife: 0.2 });
    particles.push({ type: "ring", x: coin.x, y: coin.y, radius: COIN_RADIUS, growSpeed: 120, color: "#ffd54f", life: 0, maxLife: 0.3 });
  }
}

function coinCollectable() {
  return coin.age >= COIN_IMPLODE_TIME;
}

function isParked(car) {
  const speed = Math.hypot(car.vel.x, car.vel.y);
  if (speed > PARK_SPEED_LIMIT) return false;

  let a = car.angle % Math.PI;
  if (a < 0) a += Math.PI;
  const angleOff = Math.min(a, Math.PI - a);
  if (angleOff > PARK_ANGLE_TOLERANCE) return false;

  if (Math.abs(car.pos.y - street.carCenterY) > PARK_Y_TOLERANCE) return false;

  return street.parkingSpots.some((spot) => car.pos.x > spot.x0 + PARK_X_MARGIN && car.pos.x < spot.x1 - PARK_X_MARGIN);
}

// ---------------------------------------------------------------------------
// Garage
// ---------------------------------------------------------------------------
// A player that stops on the garage pad with any damage (and a coin) gets
// the mechanic: the door rolls up, they jog out, work on the car, and it's
// repaired -- and the coin charged -- when they finish. Traffic never uses
// it. See the mechanic below.

const GARAGE_SPEED_LIMIT = 15; // px/s -- come to a stop; driving through doesn't charge you
const REPAIR_COST = 1;
const GARAGE_HINT_DAMAGE = 0.3; // at this much damage the garage pad starts pulsing in the player's color

function onGaragePad(car) {
  const g = street.garage;
  return car.pos.x > g.x0 && car.pos.x < g.x1 && car.pos.y > g.padY0 && car.pos.y < g.curbY;
}

// Stopped on the pad, damaged, but broke -- drawGarage flashes the pad red.
function garageDenied(car) {
  return car.damage > 0 && car.score < REPAIR_COST && onGaragePad(car) &&
    Math.hypot(car.vel.x, car.vel.y) <= GARAGE_SPEED_LIMIT;
}

// Sends the mechanic out to the first eligible car. One car at a time: a
// second car waiting on the pad is served once the mechanic is back inside.
function updateGarage() {
  if (mechanic) return;
  for (const car of [car1, car2]) {
    if (car.damage <= 0 || !onGaragePad(car)) continue;
    if (Math.hypot(car.vel.x, car.vel.y) > GARAGE_SPEED_LIMIT) continue;
    if (car.score < REPAIR_COST) continue;
    mechanic = makeMechanic(car);
    break;
  }
}

// ---- The mechanic ---------------------------------------------------------
// States: "opening" (door rolls up) -> "walkOut" (jog to the car) ->
// "working" (wrench; the fix lands MECH_FIX_AT in) -> "walkBack" ->
// "closing" (door rolls down) -> gone (mechanic = null). The repair and the
// coin charge happen only at the fix: if the car leaves the pad before
// that, the mechanic gives up and walks back in, and nothing is charged.
// Drawn with the pedestrian renderer (overalls, red cap, a wrench in hand).

const MECH_SPEED = 90; // px/s, a brisk jog
const MECH_DOOR_TIME = 0.35; // s for the door to roll up / down
const MECH_WORK_TIME = 0.9; // s at the car
const MECH_FIX_AT = 0.5; // s into the work when the car is fixed (after the ratchet + clank)

let mechanic = null; // the mechanic while out (or opening/closing the door); null when idle inside
let garageDoorOpen = 0; // 0 closed .. 1 fully rolled up, drawn over the static door

function mechanicHome() {
  const g = street.garage;
  return { x: (g.doorX0 + g.doorX1) / 2, y: g.buildingY0 + g.doorH / 2 };
}

// Where the mechanic stands to work: on the driveway just below the curb,
// beside the car (cars can't cross the curb, so this never overlaps one).
function mechanicWorkSpot(car) {
  const g = street.garage;
  return { x: clamp(car.pos.x, g.doorX0, g.doorX1), y: g.curbY + 10 };
}

function makeMechanic(car) {
  const home = mechanicHome();
  const up = -Math.PI / 2;
  return {
    state: "opening", t: 0, car, fixed: false, nextSpark: 0,
    x: home.x, y: home.y,
    // pedestrian-renderer fields: overalls, red cap, a random face
    stride: { speed: MECH_SPEED, cadence: 3, swing: 1.2, bounce: 0.2 }, speedMul: 1, size: 1.05,
    skin: pickOf(PED_SKIN), shirt: "#2f63b8", hairStyle: "short", hairColor: pickOf(PED_HAIR),
    hat: "cap", hatColor: "#e8514a", umbrella: null, accessory: null, dog: null,
    phase: 0, speed: 0, facing: up, bodyAngle: up, headAngle: up, seed: Math.random() * 1000,
  };
}

// Jog toward a target; returns true on arrival.
function mechanicWalkTo(m, target, dt) {
  const dx = target.x - m.x, dy = target.y - m.y, d = Math.hypot(dx, dy);
  const stepLen = MECH_SPEED * dt;
  if (d <= stepLen) {
    m.x = target.x;
    m.y = target.y;
    m.speed = 0;
    return true;
  }
  const a = Math.atan2(dy, dx);
  m.x += (dx / d) * stepLen;
  m.y += (dy / d) * stepLen;
  m.speed = MECH_SPEED;
  m.bodyAngle = m.headAngle = m.facing = a;
  m.phase += (stepLen / (MECH_SPEED / m.stride.cadence)) * Math.PI * 2;
  return false;
}

function updateMechanic(dt) {
  // the door opens while the mechanic is out and rolls down once they're back
  const wantOpen = mechanic !== null && mechanic.state !== "closing";
  garageDoorOpen = clamp(garageDoorOpen + ((wantOpen ? 1 : -1) * dt) / MECH_DOOR_TIME, 0, 1);
  if (!mechanic) return;

  const m = mechanic, car = m.car;
  m.t += dt;
  const carStillThere = onGaragePad(car) && Math.hypot(car.vel.x, car.vel.y) <= GARAGE_SPEED_LIMIT * 2;

  if (m.state === "opening") {
    if (garageDoorOpen >= 1) m.state = "walkOut";
  } else if (m.state === "walkOut") {
    if (!carStillThere) m.state = "walkBack"; // they drove off: never mind
    else if (mechanicWalkTo(m, mechanicWorkSpot(car), dt)) {
      m.state = "working";
      m.t = 0;
      playWrenchSound(m.x);
    }
  } else if (m.state === "working") {
    const toCar = Math.atan2(car.pos.y - m.y, car.pos.x - m.x);
    m.bodyAngle = m.headAngle = m.facing = toCar;
    if (!m.fixed && !carStillThere) {
      m.state = "walkBack";
    } else {
      if (!m.fixed && m.t >= m.nextSpark) {
        spawnWrenchSparks(m.x + Math.cos(toCar) * 11, m.y + Math.sin(toCar) * 11);
        m.nextSpark = m.t + 0.12 + Math.random() * 0.1;
      }
      if (!m.fixed && m.t >= MECH_FIX_AT) {
        m.fixed = true;
        if (car.damage > 0 && car.score >= REPAIR_COST) {
          car.score -= REPAIR_COST;
          repairCar(car);
          playRepairSound(car.pos.x);
          spawnFirework(car.pos.x, car.pos.y, "#7dffa0");
        }
      }
      if (m.t >= MECH_WORK_TIME) m.state = "walkBack";
    }
  } else if (m.state === "walkBack") {
    if (mechanicWalkTo(m, mechanicHome(), dt)) m.state = "closing";
  } else if (m.state === "closing") {
    if (garageDoorOpen <= 0) mechanic = null;
  }
}

// A few little sparks where the wrench meets the car (cosmetic particles).
function spawnWrenchSparks(x, y) {
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * Math.PI * 2, sp = 50 + Math.random() * 90;
    particles.push({
      type: "spark", x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      size: 1 + Math.random() * 0.9,
      color: pickOf(["#ffd23f", "#ff9d5c", "#ffffff"]),
      life: 0, maxLife: 0.2 + Math.random() * 0.2,
    });
  }
}

// A single shared coin is always on the map. Only a car currently in
// "seekCoin" is eligible to collect it -- a car that just scored is parked
// in "mustPark" and can't take the next one, no matter what the other car
// does. Whichever eligible car reaches it first scores, goes to "mustPark",
// and a fresh coin immediately takes its place (so the other car, if still
// eligible, can keep going without waiting on anyone's parking job).
function updateCoinRace() {
  for (const car of [car1, car2]) {
    if (car.gameState !== "seekCoin" || !coinCollectable()) continue;
    if (Math.hypot(car.pos.x - coin.x, car.pos.y - coin.y) < PICKUP_DIST) {
      car.score++;
      car.gameState = "mustPark";
      playCoinPickupSound(car.pos.x);
      spawnCoin();
      break;
    }
  }

  for (const car of [car1, car2]) {
    if (car.gameState === "mustPark" && isParked(car)) {
      car.gameState = "seekCoin";
      spawnFirework(car.pos.x, car.pos.y, car.color);
      playParkedSound(car.pos.x);
    }
  }
}

// A proper celebration fireworks burst, fired at the moment a parking
// attempt is confirmed successful. Purely cosmetic: never touches physics
// or game state. Layers: a bright flash core, a shower of round sparks plus
// faster streaking ones, two shockwave rings at different speeds, and a
// delayed secondary "pop" (via the invisible "delayedBurst" marker below)
// for the classic multi-stage firework read rather than one flat burst.
function spawnFirework(x, y, color) {
  const sparkColors = [color, "#ffd54f", "#ffffff", "#ff9d5c"];
  const count = 42;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
    const speed = 100 + Math.random() * 190;
    const streak = Math.random() < 0.35;
    particles.push({
      type: streak ? "streak" : "spark",
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: streak ? 1.4 + Math.random() * 1.2 : 1.8 + Math.random() * 2.6,
      color: sparkColors[Math.floor(Math.random() * sparkColors.length)],
      life: 0,
      maxLife: 0.4 + Math.random() * 0.5,
    });
  }
  particles.push({ type: "flash", x, y, radius: 16, life: 0, maxLife: 0.16 });
  particles.push({ type: "ring", x, y, radius: 4, growSpeed: 260, color, life: 0, maxLife: 0.4 });
  particles.push({ type: "ring", x, y, radius: 2, growSpeed: 150, color: "#ffd54f", life: 0, maxLife: 0.55 });
  particles.push({ type: "delayedBurst", x, y, color, life: 0, maxLife: 0.16 + Math.random() * 0.08 });
}

// A smaller, quicker secondary pop -- what a "delayedBurst" marker turns
// into once its short timer runs out, at a slight offset from the original.
function spawnSecondaryPop(x, y, color) {
  const sparkColors = [color, "#ffd54f", "#ffffff"];
  const count = 16;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 50 + Math.random() * 90;
    particles.push({
      type: "spark",
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 1.4 + Math.random() * 1.8,
      color: sparkColors[Math.floor(Math.random() * sparkColors.length)],
      life: 0,
      maxLife: 0.3 + Math.random() * 0.3,
    });
  }
}

// Reverse explosion for a new coin: sparks start scattered on a wide ring
// and spiral inward, accelerating, all arriving at (x, y) exactly
// COIN_IMPLODE_TIME from now. Start times are staggered (negative initial
// life = not yet visible) so it reads as a sucking-in rather than one
// flat ring collapsing; updateCoin adds the flash when they land.
function spawnImplosion(x, y) {
  const colors = ["#ffd54f", "#ffe082", "#ffffff", "#ffb300"];
  const count = 30;
  for (let i = 0; i < count; i++) {
    const delay = Math.random() * 0.25;
    particles.push({
      type: "implode",
      tx: x, ty: y,
      angle: (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4,
      spin: 0.8 + Math.random() * 0.6, // radians of swirl over the flight
      r0: 60 + Math.random() * 50,
      size: 1.2 + Math.random() * 1.4,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: -delay,
      maxLife: COIN_IMPLODE_TIME - delay,
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.maxLife) {
      if (p.type === "delayedBurst") {
        spawnSecondaryPop(p.x + (Math.random() - 0.5) * 24, p.y + (Math.random() - 0.5) * 24, p.color);
      }
      particles.splice(i, 1);
      continue;
    }
    if (p.type === "spark" || p.type === "streak") {
      p.vx *= 1 - 2.2 * dt;
      p.vy *= 1 - 2.2 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    } else if (p.type === "ring") {
      p.radius += p.growSpeed * dt;
    } else if (p.type === "smoke") {
      p.vx *= 1 - 1.5 * dt;
      p.vy *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += p.growSpeed * dt;
    }
    // "implode" has no velocity to integrate: its position is a pure function
    // of life/maxLife, computed in drawParticles (implodePos).
    // "flash" and "delayedBurst" hold position and just decay via life/maxLife.
  }
}

// ---------------------------------------------------------------------------
// NPC traffic
// ---------------------------------------------------------------------------
// AI cars appear at random (a Poisson process averaging one every
// NPC_SPAWN_MEAN seconds), enter from the left or right edge, and drive
// across the lane just above the road centerline. They're ordinary car
// objects run through the same stepCar physics and collisions as the
// players -- only their input comes from npcDrive instead of the keyboard --
// so they can be rammed, spun and shoved like anything else. They aren't
// fenced in by the arena walls (they enter and leave through the side
// edges) and are removed once well outside the canvas.

const NPC_SPAWN_MEAN = 10; // seconds, average time between spawns
const NPC_CRUISE_SPEED = 140; // px/s
const NPC_LOOKAHEAD = 170; // px, how far along the lane the steering aims -- longer = lazier, wider corrections
const NPC_STEER_GAIN = 1.1; // steer per radian of heading error -- low on purpose, NPCs are sloppy drivers
const NPC_BRAKE_DIST = 110; // px, brake for any car this close ahead in the car's path
// NPCs are deliberately mediocre drivers once knocked out of their routine:
// a sudden jolt (a collision) leaves them dazed for a moment, and while off
// the lane or pointing the wrong way they creep along instead of snapping
// straight back to cruise.
const NPC_JOLT = 50; // px/s velocity change in one step that counts as "got hit" (driving alone never exceeds ~15)
const NPC_DAZE_MIN = 1.5, NPC_DAZE_MAX = 3.5; // seconds of coasting, wheel straight, after a jolt
const NPC_LOST_SPEED = 55; // px/s, cautious crawl while well off the lane or turned around
// Target speed eases from cruise (within NPC_LANE_ERR_OK of the lane line)
// down to NPC_LOST_SPEED (at NPC_LOST_LANE_ERR or more) -- a car that's only
// a little off-line keeps going almost normally while it drifts back.
const NPC_LANE_ERR_OK = 15; // px
const NPC_LOST_LANE_ERR = 70; // px
const NPC_COLORS = ["#ffffff", "#e8514a", "#6cc24a", "#8c6fd6", "#f2e14b", "#ea7fbf"];
// Horn: honk after being blocked by a car this long, then repeat at a
// random interval in [MIN, MAX] while still blocked.
const NPC_HONK_DELAY = 0.7; // s
const NPC_HONK_REPEAT_MIN = 2.5, NPC_HONK_REPEAT_MAX = 4.5; // s
const NPC_ANGRY_HONK_COOLDOWN = 2.5; // s; at most one "you hit me!" honk per incident

function nextNpcSpawnDelay() {
  return -Math.log(1 - Math.random()) * NPC_SPAWN_MEAN;
}

function resetTraffic() {
  npcs.length = 0;
  npcSpawnTimer = 0; // first car rolls in right away; later ones follow the random schedule
}

function spawnNpc() {
  // There's only one lane, so while any traffic is still out there, new cars
  // follow its direction rather than spawning head-on into it.
  const dir = npcs.length ? npcs[0].dir : Math.random() < 0.5 ? 1 : -1;
  const x = dir > 0 ? -CAR.length : W + CAR.length;
  const y = street.npcLaneY;
  const clear = [car1, car2, ...npcs].every((c) => Math.hypot(c.pos.x - x, c.pos.y - y) > CAR.length * 2.5);
  if (!clear) return false;

  const color = NPC_COLORS[Math.floor(Math.random() * NPC_COLORS.length)];
  const npc = createCar(x, y, dir > 0 ? 0 : Math.PI, color, null);
  npc.dir = dir;
  npc.vel.x = dir * NPC_CRUISE_SPEED;
  npc.drive = { throttle: 0, steer: 0 };
  npc.stuckTime = 0;
  npc.reverseTime = 0;
  npc.dazedTime = 0;
  npc.prevVel = { x: npc.vel.x, y: npc.vel.y };
  npc.blockedTime = 0;
  npc.nextHonkAt = NPC_HONK_DELAY;
  npc.hornPitch = 0.85 + Math.random() * 0.33; // every car's horn sounds a bit different
  npcs.push(npc);
  return true;
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// A player just crashed into this NPC: it leans on the horn a beat later
// (so the honk reads as the driver's reaction, not part of the crash
// sound). One honk per incident: a repeat within NPC_ANGRY_HONK_COOLDOWN of
// the last one -- e.g. grinding against it -- doesn't start another.
function npcGotRammed(npc) {
  if (npc.angryHonkIn > 0) return;
  if (npc.lastAngryHonk !== undefined && gameTime - npc.lastAngryHonk < NPC_ANGRY_HONK_COOLDOWN) return;
  npc.angryHonkIn = 0.35 + Math.random() * 0.4;
}

// Sets npc.drive (read by stepCar via readInput) for this step.
function npcDrive(npc, dt) {
  const forward = { x: Math.cos(npc.angle), y: Math.sin(npc.angle) };
  const forwardSpeed = npc.vel.x * forward.x + npc.vel.y * forward.y;

  // Got hit since last step? prevVel was recorded at the end of the last
  // npcDrive, so the difference is one stepCar (small) plus any collision.
  const jolt = Math.hypot(npc.vel.x - npc.prevVel.x, npc.vel.y - npc.prevVel.y);
  npc.prevVel.x = npc.vel.x;
  npc.prevVel.y = npc.vel.y;
  if (jolt > NPC_JOLT) {
    npc.dazedTime = NPC_DAZE_MIN + Math.random() * (NPC_DAZE_MAX - NPC_DAZE_MIN);
    npc.reverseTime = 0;
  }
  // A pending angry honk (see npcGotRammed). Ticks before the dazed early
  // return below -- a rammed car is almost always dazed.
  if (npc.angryHonkIn > 0) {
    npc.angryHonkIn -= dt;
    if (npc.angryHonkIn <= 0) {
      playHornSound(npc.pos.x, npc.hornPitch, true);
      pedestriansNotice(npc.pos.x, npc.pos.y, "honk");
      npc.lastAngryHonk = gameTime;
    }
  }
  if (npc.dazedTime > 0) {
    npc.dazedTime -= dt;
    npc.stuckTime = 0;
    npc.drive.throttle = 0;
    npc.drive.steer = 0;
    return;
  }

  // Steer toward a point further along the lane -- keeps the car on the lane
  // line, and also brings it back (turning around if needed) after a hit.
  const tx = npc.pos.x + npc.dir * NPC_LOOKAHEAD;
  const headingErr = wrapAngle(Math.atan2(street.npcLaneY - npc.pos.y, tx - npc.pos.x) - npc.angle);
  let steer = clamp(headingErr * NPC_STEER_GAIN, -1, 1);

  const laneErr = Math.abs(npc.pos.y - street.npcLaneY);
  const turnedAround = Math.abs(headingErr) > Math.PI / 2;
  const lost = laneErr > NPC_LANE_ERR_OK * 2 || turnedAround; // off the road enough to not queue behind things
  const offness = turnedAround ? 1 : clamp((laneErr - NPC_LANE_ERR_OK) / (NPC_LOST_LANE_ERR - NPC_LANE_ERR_OK), 0, 1);
  const targetSpeed = NPC_CRUISE_SPEED + (NPC_LOST_SPEED - NPC_CRUISE_SPEED) * offness;

  let blocked = false, blockerSide = 0;
  for (const other of [car1, car2, ...npcs]) {
    if (other === npc) continue;
    const dx = other.pos.x - npc.pos.x, dy = other.pos.y - npc.pos.y;
    const ahead = dx * forward.x + dy * forward.y;
    const side = dy * forward.x - dx * forward.y; // > 0: blocker is to our right
    if (ahead > 0 && ahead < NPC_BRAKE_DIST && Math.abs(side) < CAR.width + 6) {
      blocked = true;
      blockerSide = side;
      break;
    }
  }

  // Obstructed by a car in its path: lean on the horn after a moment, then
  // again every few seconds for as long as it stays stuck.
  if (blocked) {
    npc.blockedTime += dt;
    if (npc.blockedTime >= npc.nextHonkAt) {
      playHornSound(npc.pos.x, npc.hornPitch);
      pedestriansNotice(npc.pos.x, npc.pos.y, "honk");
      npc.nextHonkAt = npc.blockedTime + NPC_HONK_REPEAT_MIN + Math.random() * (NPC_HONK_REPEAT_MAX - NPC_HONK_REPEAT_MIN);
    }
  } else {
    npc.blockedTime = 0;
    npc.nextHonkAt = NPC_HONK_DELAY;
  }

  let throttle;
  if (npc.reverseTime > 0) {
    // Backing out of a jam: full opposite lock (reversing swings the nose the
    // other way), so the retry comes in on a genuinely different line -- the
    // lazy NPC_STEER_GAIN alone would back out nearly straight and just
    // drive back into the same spot.
    npc.reverseTime -= dt;
    throttle = -1;
    steer = headingErr >= 0 ? -1 : 1;
  } else if (blocked && lost) {
    // Off the road there's no queue to wait in, and the lane point it's
    // aiming for can sit right behind the blocker (waiting and retrying would
    // just loop) -- so creep around it instead, turning away from its side.
    steer = blockerSide >= 0 ? -1 : 1;
    throttle = forwardSpeed < NPC_LOST_SPEED * 0.6 ? 1 : 0;
  } else if (blocked) {
    throttle = forwardSpeed > 1 ? -1 : 0; // brake, but never start reversing into a queue
  } else {
    throttle = forwardSpeed < targetSpeed ? 1 : 0;
  }

  // Stopped for too long -- wedged against something (a crate, the curb), or
  // waiting on a car that isn't moving out of the way: back up for a moment,
  // then try again on a different line. Waiting behind a car gets more
  // patience than being wedged.
  const speed = Math.hypot(npc.vel.x, npc.vel.y);
  if (npc.reverseTime <= 0 && speed < 5) {
    npc.stuckTime += dt;
    if (npc.stuckTime > (blocked ? 3 : 1.5)) {
      npc.stuckTime = 0;
      npc.reverseTime = 1;
    }
  } else {
    npc.stuckTime = 0;
  }

  npc.drive.throttle = throttle;
  npc.drive.steer = steer;
}

function updateTraffic(dt) {
  npcSpawnTimer -= dt;
  if (npcSpawnTimer <= 0) npcSpawnTimer = spawnNpc() ? nextNpcSpawnDelay() : 0.5;

  const m = CAR.length * 2;
  for (let i = npcs.length - 1; i >= 0; i--) {
    const n = npcs[i];
    if (n.pos.x < -m || n.pos.x > W + m || n.pos.y < -m || n.pos.y > H + m) npcs.splice(i, 1);
  }

  for (const n of npcs) npcDrive(n, dt);
}

// ---------------------------------------------------------------------------
// Autopilot (a player car driven by a deliberately bad AI)
// ---------------------------------------------------------------------------
// Each player's HUD button toggles car.autopilot. The AI then plays the game
// for them: chases coins, parallel parks, and visits the garage when badly
// dented. It plays it BADLY on purpose:
// - it drives too fast, steers with a wobble, and brakes late
// - it doesn't always notice a crate in its path (AP_BLIND_CHANCE)
// - it picks a random parking spot, and sometimes the one the other
//   autopilot is already going for, so they fight over it
// - its parking is a scripted S-curve that works only when it doesn't
//   rush it or get knocked off line; a failed attempt pulls out and retries
// - now and then it forgets about coins and goes ramming traffic
// It drives through the same readInput -> stepCar path as a human (readInput
// returns car.ap.drive), so it obeys the same physics and collisions.

const AP_CRUISE_MIN = 170, AP_CRUISE_MAX = 250; // px/s chasing coins (rolled per activation)
const AP_STEER_GAIN = 2.4; // steer per radian of heading error
const AP_WOBBLE = 0.3; // steering wander amplitude, times the per-activation sloppiness
const AP_BLIND_CHANCE = 0.4; // chance of not seeing a crate in its path, rolled per encounter
const AP_SEEN_RESET = 2.5; // s until crates it saw (or missed) get re-rolled
const AP_HARASS_MEAN = 18; // s, average time chasing coins before it gets bored and bullies traffic
const AP_HARASS_MIN = 5, AP_HARASS_MAX = 10; // s of harassment
const AP_HARASS_SPEED = 280;
const AP_PARK_SPEED = 28; // px/s while reversing into a spot (times the per-attempt rush)
const AP_PARK_TIMEOUT = 20; // s before a stalled parking attempt starts over

function makeAutopilot() {
  return {
    drive: { throttle: 0, steer: 0 },
    goal: null,
    cruise: AP_CRUISE_MIN + Math.random() * (AP_CRUISE_MAX - AP_CRUISE_MIN),
    sloppy: 0.5 + Math.random() * 0.8,
    lateBraking: 1 + Math.random() * 0.8, // overestimates its brakes by this much
    garageAt: 0.35 + Math.random() * 0.35, // damage that sends it to the garage
    wobblePhase: Math.random() * 10,
    seen: new Map(), // crate -> did it notice this one
    seenTimer: 0,
    reverseTime: 0, reverseSteer: 0,
    stuckTime: 0,
    park: null, garage: null, harass: null,
  };
}

function toggleAutopilot(car) {
  car.autopilot = !car.autopilot;
  if (car.autopilot) car.ap = makeAutopilot();
}

function apForwardSpeed(car) {
  return car.vel.x * Math.cos(car.angle) + car.vel.y * Math.sin(car.angle);
}

// Throttle that holds a signed forward speed (negative = reverse).
function apThrottleFor(car, target) {
  const fwd = apForwardSpeed(car);
  if (target >= 0) {
    if (fwd < -4) return 1; // rolling backward: throttle brakes it
    return fwd < target ? 1 : fwd > target + 25 ? -1 : 0;
  }
  if (fwd > 4) return -1; // rolling forward: brake
  return fwd > target ? -1 : fwd < target - 25 ? 1 : 0;
}

function apStop(car) {
  const fwd = apForwardSpeed(car);
  return Math.abs(fwd) > 4 ? -Math.sign(fwd) : 0;
}

// Steering that points the nose (or, reversing, the tail) at (tx, ty).
// Reversing with the wheel turned right swings the nose left, hence the flip.
function apSteerAt(car, tx, ty, reverse = false) {
  const want = Math.atan2(ty - car.pos.y, tx - car.pos.x);
  const err = wrapAngle(want - car.angle - (reverse ? Math.PI : 0));
  return clamp(err * AP_STEER_GAIN, -1, 1) * (reverse ? -1 : 1);
}

// Swerve away from a crate or parked car dead ahead -- if it notices it.
function apAvoid(car, ap, steer) {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  const look = 60 + Math.max(0, apForwardSpeed(car)) * 0.35;
  const obstacles = [...crates, ...street.parkedCars];
  for (const o of obstacles) {
    const ox = o.pos ? o.pos.x : o.x, oy = o.pos ? o.pos.y : o.y;
    const reach = (o.pos ? CAR.length / 2 : o.r) + CAR.capsuleRadius + 4;
    const dx = ox - car.pos.x, dy = oy - car.pos.y;
    const ahead = dx * fx + dy * fy;
    const side = dy * fx - dx * fy; // > 0: to our right
    if (ahead <= 0 || ahead > look || Math.abs(side) > reach) continue;
    if (!ap.seen.has(o)) ap.seen.set(o, Math.random() > AP_BLIND_CHANCE);
    if (ap.seen.get(o)) return side >= 0 ? -1 : 1;
  }
  return steer;
}

// Drive toward (tx, ty) at up to `cruise`, optionally coming to a stop
// `stopAt` px short of it. Handles its own clumsy three-point turns and
// backing out when wedged. Returns the distance left.
function apDriveTo(car, ap, tx, ty, cruise, { stopAt = -1, avoid = true } = {}) {
  const dx = tx - car.pos.x, dy = ty - car.pos.y, dist = Math.hypot(dx, dy);
  const err = wrapAngle(Math.atan2(dy, dx) - car.angle);
  const speed = Math.hypot(car.vel.x, car.vel.y);

  if (ap.reverseTime > 0) {
    ap.drive.throttle = apThrottleFor(car, -70);
    ap.drive.steer = ap.reverseSteer;
    return dist;
  }
  // Target behind and close: back up with opposite lock to swing the nose round.
  if (Math.abs(err) > 2 && dist < 110 && speed < 60) {
    ap.reverseTime = 0.6 + Math.random() * 0.4;
    ap.reverseSteer = err > 0 ? -1 : 1;
  }

  let target = cruise * clamp(1.15 - Math.abs(err) / 1.5, 0.3, 1);
  if (stopAt >= 0) {
    // v = sqrt(2 a d), with an optimistic idea of how hard it can brake
    target = Math.min(target, Math.sqrt(2 * CAR.brakePower * 0.5 * ap.lateBraking * Math.max(0, dist - stopAt)));
  }
  let steer = clamp(err * AP_STEER_GAIN, -1, 1) + Math.sin(ap.wobblePhase) * AP_WOBBLE * ap.sloppy;
  if (avoid) steer = apAvoid(car, ap, steer);
  ap.drive.throttle = stopAt >= 0 && dist <= stopAt ? apStop(car) : apThrottleFor(car, target);
  ap.drive.steer = clamp(steer, -1, 1);
  return dist;
}

// Pushing but not moving (wedged on a crate, a wall, the other car): back
// out with opposite lock and try again on a different line.
function apCheckStuck(car, ap, dt, pushing) {
  const speed = Math.hypot(car.vel.x, car.vel.y);
  if (ap.reverseTime > 0 || !pushing || speed > 8) {
    ap.stuckTime = 0;
    return;
  }
  ap.stuckTime += dt;
  if (ap.stuckTime > 0.8) {
    ap.stuckTime = 0;
    ap.reverseTime = 0.7 + Math.random() * 0.6;
    ap.reverseSteer = ap.drive.steer >= 0 ? -1 : 1;
  }
}

function apNpcOnScreen(npc) {
  return npcs.includes(npc) && npc.pos.x > 30 && npc.pos.x < W - 30;
}

function apPickGoal(car, ap, dt) {
  if (ap.goal === "garage" && car.damage > 0 && car.score >= REPAIR_COST) return "garage";
  if (ap.goal === "harass" && ap.harass.time > 0 && apNpcOnScreen(ap.harass.npc)) return "harass";
  if (car.damage >= ap.garageAt && car.score >= REPAIR_COST) return "garage";
  if (car.gameState === "mustPark") return "park";
  // Bored of coins: go bully a passing car instead.
  const victims = npcs.filter(apNpcOnScreen);
  if (victims.length && Math.random() < dt / AP_HARASS_MEAN) {
    ap.harass = { npc: pickOf(victims), time: AP_HARASS_MIN + Math.random() * (AP_HARASS_MAX - AP_HARASS_MIN) };
    return "harass";
  }
  return "coin";
}

function updateAutopilot(car, dt) {
  const ap = car.ap;
  ap.wobblePhase += dt * (1.3 + ap.sloppy);
  ap.seenTimer -= dt;
  if (ap.seenTimer <= 0) {
    ap.seen.clear();
    ap.seenTimer = AP_SEEN_RESET;
  }
  if (ap.reverseTime > 0) ap.reverseTime -= dt;

  const goal = apPickGoal(car, ap, dt);
  if (goal !== ap.goal) {
    ap.goal = goal;
    ap.park = ap.garage = null;
    if (goal !== "harass") ap.harass = null;
  }

  if (goal === "coin") {
    apDriveTo(car, ap, coin.x, coin.y, ap.cruise);
    apCheckStuck(car, ap, dt, ap.drive.throttle !== 0);
  } else if (goal === "harass") {
    apHarass(car, ap, dt);
  } else if (goal === "garage") {
    apGarage(car, ap, dt);
  } else {
    apPark(car, ap, dt);
  }
}

// Ram the chosen NPC, back off, ram it again, until the urge passes.
function apHarass(car, ap, dt) {
  const h = ap.harass, npc = h.npc;
  h.time -= dt;
  // aim a little ahead of where it's going
  const tx = npc.pos.x + npc.vel.x * 0.35, ty = npc.pos.y + npc.vel.y * 0.35;
  apDriveTo(car, ap, tx, ty, AP_HARASS_SPEED, { avoid: false });
  if (ap.reverseTime <= 0 && Math.hypot(npc.pos.x - car.pos.x, npc.pos.y - car.pos.y) < CAR.length) {
    ap.reverseTime = 0.5 + Math.random() * 0.4; // got it -- back up for another run
    ap.reverseSteer = Math.random() < 0.5 ? -1 : 1;
  }
  apCheckStuck(car, ap, dt, ap.drive.throttle !== 0);
}

// Pull onto the garage pad along the road, stop, and wait for the mechanic.
function apGarage(car, ap, dt) {
  const g = street.garage;
  const px = (g.x0 + g.x1) / 2, py = (g.padY0 + g.curbY) / 2;
  if (!ap.garage) ap.garage = { phase: "approach" };
  const s = ap.garage;
  if (s.phase === "approach") {
    const d = apDriveTo(car, ap, g.x0 - 110, py, 180);
    if (d < 45) s.phase = "line";
    apCheckStuck(car, ap, dt, ap.drive.throttle !== 0);
  } else if (s.phase === "line") {
    // follow the pad's centerline in and stop in the middle
    apDriveTo(car, ap, Math.max(car.pos.x + 60, px), py, 120, { stopAt: 0, avoid: false });
    const dx = px - car.pos.x;
    if (dx < 8) ap.drive.throttle = apStop(car);
    if (onGaragePad(car) && Math.hypot(car.vel.x, car.vel.y) < 5) s.phase = "wait";
    if (dx < -30) s.phase = "approach"; // overshot badly
  } else {
    ap.drive.throttle = apStop(car);
    ap.drive.steer = 0;
    if (!onGaragePad(car)) s.phase = "approach"; // got shoved off
  }
}

// ---- Parallel parking -----------------------------------------------------
// A scripted S-curve, reversing in the way a driving instructor teaches it:
// 1. "approach": head for a point out on the road before the spot
// 2. "line": creep along a line parallel to the parked row (p.gap out from
//    it), stop past the spot
// 3. "swing": reverse at full lock, tail toward the curb
// 4. "counter": reverse at opposite lock until straight
// 5. "settle": shuffle forward and back, straightening up, until it's
//    straight and in the middle of the spot, then stop
// 6. "wait": if that didn't count as parked, "pullout" and try again
// dir is +1 when it drives past the spot heading right, -1 heading left.
//
// The switch from swing to counter is measured on the REAR AXLE, which
// (unlike the car's center) really does follow the arc: reversing at full
// lock, the center first swings outward before it comes in. Switching once
// the rear axle has covered AP_PARK_SWITCH of the gap lands the car on the
// parked row's line at parking speed (the counter-swing covers more than
// the swing, since the wheel takes a moment to wind across). Measured
// headlessly: sideways travel ~= gap, and backward travel ~= 50 + gap px.
// Rushing it (p.rush) overshoots into the curb -- that's the sloppiness.

const AP_PARK_SWITCH = 0.4;
const AP_PARK_TRAVEL = 50; // px backward travel of the S-curve, plus the gap

function apParkGeometry(p, spot) {
  const cx = (spot.x0 + spot.x1) / 2;
  const d = p.dir;
  return {
    cx, d,
    stageY: street.carCenterY - p.gap,
    heading: d > 0 ? 0 : Math.PI,
    entryX: clamp(cx - d * 160, 40, W - 40),
    stageX: cx + d * (AP_PARK_TRAVEL + p.gap),
    room: Math.max(3, (spot.x1 - spot.x0 - CAR.length) / 2), // how far off-center the car still fits
  };
}

function apChooseSpot(car) {
  const other = car === car1 ? car2 : car1;
  // Sometimes it goes for the same spot as the other autopilot. Fight!
  if (other.autopilot && other.ap.park && Math.random() < 0.45) return other.ap.park.spot;
  return Math.floor(Math.random() * street.parkingSpots.length);
}

function apStartPark(car, ap, tries) {
  const spot = apChooseSpot(car);
  const s = street.parkingSpots[spot];
  ap.park = {
    spot,
    dir: car.pos.x < (s.x0 + s.x1) / 2 ? 1 : -1,
    gap: 30 + Math.random() * 10, // how far out from the parked row it lines up
    rush: 1 + Math.random() * Math.random() * 2.5, // sometimes it floors it in reverse
    phase: "approach", t: 0, phaseT: 0, tries,
    rear0: 0, shuffle: 1, shuffleT: 0,
  };
}

function apRearY(car) {
  return car.pos.y - Math.sin(car.angle) * CAR.wheelBase / 2;
}

function apPark(car, ap, dt) {
  if (!ap.park || ap.park.spot >= street.parkingSpots.length) apStartPark(car, ap, 0);
  const p = ap.park;
  const spot = street.parkingSpots[p.spot];
  const geo = apParkGeometry(p, spot);
  const a = wrapAngle(car.angle - geo.heading); // heading error vs. parallel to the row
  const speed = Math.hypot(car.vel.x, car.vel.y);
  const setPhase = (phase) => { p.phase = phase; p.phaseT = 0; };
  // The timeout covers the maneuver, not the drive over: a badly damaged car
  // crawling at its minimum speed can take longer than that just to arrive.
  if (p.phase !== "approach") p.t += dt;
  p.phaseT += dt;
  if (p.t > AP_PARK_TIMEOUT) {
    apStartPark(car, ap, p.tries + 1);
    return;
  }

  if (p.phase === "approach") {
    // Arriving at the entry point pointing the wrong way, loop round through
    // a point further back and come at it again.
    const ex = p.detour ? clamp(geo.entryX - geo.d * 130, 40, W - 40) : geo.entryX;
    const d = apDriveTo(car, ap, ex, geo.stageY - 50, 160);
    apCheckStuck(car, ap, dt, ap.drive.throttle !== 0);
    if (d < 45) {
      if (p.detour) p.detour = false;
      else if (Math.abs(a) < 0.9) setPhase("line");
      else p.detour = true;
    }
  } else if (p.phase === "line") {
    // creep along the line, aiming at a point ahead on it
    const toStage = (geo.stageX - car.pos.x) * geo.d;
    const target = Math.min(70, Math.sqrt(2 * 300 * Math.max(0, toStage)));
    ap.drive.steer = apSteerAt(car, car.pos.x + geo.d * 70, geo.stageY);
    ap.drive.throttle = toStage > 2 ? apThrottleFor(car, target) : apStop(car);
    if (toStage <= 2 && speed < 3) {
      if (Math.abs(a) < 0.25 && Math.abs(car.pos.y - geo.stageY) < 12) {
        p.rear0 = apRearY(car);
        setPhase("swing");
      } else {
        setPhase("approach"); // lined up badly: go round again
      }
    }
    // pointing the wrong way, wedged, or taking forever: start over
    if (Math.abs(a) > 1.3 || (p.phaseT > 1.5 && speed < 3 && toStage > 2) || p.phaseT > 20) setPhase("approach"); // generous: a wreck creeps along at 35 px/s
  } else if (p.phase === "swing" || p.phase === "counter") {
    ap.drive.throttle = apThrottleFor(car, -AP_PARK_SPEED * p.rush);
    if (p.phase === "swing") {
      ap.drive.steer = geo.d; // reversing, this swings the tail toward the curb
      if (apRearY(car) - p.rear0 >= p.gap * AP_PARK_SWITCH || Math.abs(a) > 1.1) setPhase("counter");
    } else {
      ap.drive.steer = -geo.d;
      if (a * geo.d >= -0.03 || car.pos.y > street.carCenterY + 4) setPhase("settle");
    }
    // backed into something and stopped: see how it looks
    if ((p.phaseT > 0.5 && speed < 3) || p.phaseT > 5) setPhase("settle");
  } else if (p.phase === "settle") {
    // Shuffle forward and back within the spot, steering toward straight
    // (forward with the wheel toward the curb and backward with it away both
    // straighten the car up), until it's straight and near the middle.
    const facing = Math.cos(car.angle) >= 0 ? 1 : -1;
    const err = wrapAngle((facing > 0 ? 0 : Math.PI) - car.angle);
    const off = (car.pos.x - geo.cx) * facing; // > 0: past the middle, in the direction it faces
    if ((Math.abs(err) < 0.1 && Math.abs(off) <= geo.room + 2) || p.phaseT > 6) {
      ap.drive.throttle = apStop(car);
      ap.drive.steer = 0;
      if (speed < 1) setPhase("wait");
    } else {
      const was = p.shuffle;
      if (Math.abs(err) < 0.1) p.shuffle = off > 0 ? -1 : 1; // straight already: just center up
      else if (p.shuffle > 0 && off > geo.room) p.shuffle = -1;
      else if (p.shuffle < 0 && off < -geo.room) p.shuffle = 1;
      else if (p.shuffleT > 0.4 && speed < 2) p.shuffle = -p.shuffle; // bumped a car
      p.shuffleT = p.shuffle === was ? p.shuffleT + dt : 0;
      ap.drive.throttle = apThrottleFor(car, p.shuffle * 18);
      ap.drive.steer = clamp(err * 3, -1, 1) * p.shuffle;
    }
  } else if (p.phase === "wait") {
    ap.drive.throttle = apStop(car);
    ap.drive.steer = 0;
    // still not counted as parked (updateCoinRace would have flipped
    // gameState): pull out and have another go, maybe at another spot
    if (p.phaseT > 0.8) setPhase("pullout");
  } else if (p.phase === "pullout") {
    const facing = Math.cos(car.angle) >= 0 ? 1 : -1;
    ap.drive.throttle = apThrottleFor(car, 60);
    ap.drive.steer = apSteerAt(car, car.pos.x + facing * 80, geo.stageY - 30);
    apCheckStuck(car, ap, dt, true);
    if (p.phaseT > 1.3) apStartPark(car, ap, p.tries + 1);
  }
}

// ---------------------------------------------------------------------------
// Pedestrians (purely cosmetic easter egg)
// ---------------------------------------------------------------------------
// Randomly generated people stroll along the sidewalk band (street.curbY ..
// street.sidewalkBottomY) in both directions, entering and leaving at the
// screen edges. They have NO effect on gameplay: nothing collides with them
// and they never read or write car/game state. The one thing they react to
// is commotion -- pedestriansNotice() is called on real collisions (>=
// HIT_SOUND_MIN) and NPC honks, and anyone within earshot stops, turns to
// look for a while, then carries on.
//
// Every character is rolled by makePedestrian: skin, shirt, size, a
// hairstyle or a hat, maybe an umbrella, maybe a dog on a leash or a baby
// stroller, and a stride (speed, cadence, arm swing, bounce).

// Kept sparse on purpose (halved after playtesting): an easter egg, not a crowd.
const PED_SPAWN_MEAN = 7; // s between arrivals (Poisson)
const PED_MAX = 5;
const PED_START_COUNT = 2; // already out walking when the game starts
const PED_NOTICE_CRASH = 650; // px: how far a collision is heard
const PED_NOTICE_HONK = 380; // px: how far a honk is heard
// Drawn a bit bigger than true scale next to the cars, so the details read.
const PED_SCALE = 1.2;

const PED_SKIN = ["#ffdcc0", "#f6c9a4", "#e3a67b", "#c4855a", "#98613d", "#6b4428"];
const PED_HAIR = ["#2b2118", "#5a3825", "#a0522d", "#e8c872", "#d8d4cc", "#c0392b", "#3d6fd6"];
const PED_SHIRT = ["#e8514a", "#4f9de0", "#6cc24a", "#f2c14b", "#ea7fbf", "#8c6fd6", "#ffffff", "#ff8f3f", "#3dbfae"];
const PED_HATS = ["cap", "sunhat", "beanie", "tophat"];
const PED_HAT_COLORS = ["#e8514a", "#4f9de0", "#f2c14b", "#6cc24a", "#8c6fd6", "#f4e1b8"];
const PED_UMBRELLAS = ["#e8514a", "#4f9de0", "#f2c14b", "#ea7fbf", "#6cc24a", "#8c6fd6"];
const PED_DOGS = ["#c8874a", "#f1e6d2", "#3a3035", "#e0b76a", "#8a6a55"];
const PED_STROLLERS = ["#4f9de0", "#ea7fbf", "#6cc24a", "#8c6fd6"];
const PED_HAIRSTYLES = ["bald", "short", "short", "long", "ponytail", "bun", "mohawk", "afro", "spiky", "beehive"];
// speed px/s; cadence = steps/s at that speed; swing = arm/leg amplitude;
// bounce = body bob amount.
const PED_STRIDES = [
  { name: "stroll", speed: 26, cadence: 1.7, swing: 0.8, bounce: 0.1 },
  { name: "brisk", speed: 44, cadence: 2.4, swing: 1.0, bounce: 0.1 },
  { name: "shuffle", speed: 17, cadence: 2.3, swing: 0.3, bounce: 0.05 },
  { name: "bouncy", speed: 36, cadence: 2.0, swing: 1.2, bounce: 0.35 },
  { name: "jog", speed: 72, cadence: 3.2, swing: 1.4, bounce: 0.25 },
];

let pedestrians = [];
let pedSpawnTimer = 0;

function pickOf(a) {
  return a[Math.floor(Math.random() * a.length)];
}

// y of a random walking line within the sidewalk band.
function pedLaneY() {
  return street.curbY + 12 + Math.random() * Math.max(1, street.sidewalkBottomY - street.curbY - 22);
}

function makePedestrian(x, dir) {
  const r = Math.random;
  let stride = pickOf(PED_STRIDES);
  const accessory = r() < 0.2 ? "dog" : r() < 0.18 ? "stroller" : null;
  if (accessory === "stroller" && (stride.name === "jog" || stride.name === "bouncy")) stride = PED_STRIDES[0];
  const hat = r() < 0.3 ? pickOf(PED_HATS) : null;
  const facing = dir > 0 ? 0 : Math.PI;
  const p = {
    x, y: pedLaneY(), dir,
    stride, speedMul: 0.85 + r() * 0.3,
    size: 0.85 + r() * 0.3,
    skin: pickOf(PED_SKIN),
    shirt: pickOf(PED_SHIRT),
    hairStyle: hat ? "short" : pickOf(PED_HAIRSTYLES),
    hairColor: pickOf(PED_HAIR),
    hat, hatColor: pickOf(PED_HAT_COLORS),
    umbrella: !hat && accessory !== "stroller" && r() < 0.14 ? pickOf(PED_UMBRELLAS) : null,
    accessory,
    strollerColor: pickOf(PED_STROLLERS),
    phase: r() * Math.PI * 2,
    speed: 0,
    facing, bodyAngle: facing, headAngle: facing,
    look: null, // { x, y } being stared at
    lookTimer: 0, reactDelay: 0, pendingLook: 0,
    seed: r() * 1000,
  };
  p.speed = p.stride.speed * p.speedMul;
  if (accessory === "dog") {
    p.dog = {
      x: x + dir * 18, y: p.y + (r() < 0.5 ? -7 : 7),
      side: r() < 0.5 ? -7 : 7,
      color: pickOf(PED_DOGS), size: 0.8 + r() * 0.45,
      angle: facing, phase: r() * 6, tail: r() * 6,
    };
  }
  return p;
}

function resetPedestrians() {
  pedestrians = [];
  for (let i = 0; i < PED_START_COUNT; i++) {
    const p = makePedestrian(40 + Math.random() * (W - 80), Math.random() < 0.5 ? 1 : -1);
    if (p.dog) p.dog.x = p.x + p.dir * 18;
    pedestrians.push(p);
  }
  pedSpawnTimer = -Math.log(1 - Math.random()) * PED_SPAWN_MEAN;
}

// Commotion at (x, y): everyone within earshot stops and stares for a while,
// each reacting after a small random delay (plus a hint of distance) so the
// crowd doesn't turn in perfect unison. `kind` is "crash" or "honk"; for a
// crash, `speed` (closing speed) makes a bigger hit hold attention longer.
function pedestriansNotice(x, y, kind, speed = 0) {
  const radius = kind === "honk" ? PED_NOTICE_HONK : PED_NOTICE_CRASH;
  const dur = kind === "honk" ? 1.4 + Math.random() : 2.2 + Math.min(2.5, speed / 150) + Math.random();
  for (const p of pedestrians) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d > radius) continue;
    if (p.lookTimer > 0) {
      // already staring: turn to the new thing, keep looking a bit longer
      p.look = { x, y };
      p.lookTimer = Math.max(p.lookTimer, dur);
    } else if (p.reactDelay <= 0) {
      p.look = { x, y };
      p.reactDelay = 0.08 + Math.random() * 0.35 + d / 2500;
      p.pendingLook = dur;
    }
  }
}

// Turn `from` toward `to` by at most `rate * dt` radians.
function turnToward(from, to, rate, dt) {
  const diff = wrapAngle(to - from);
  const maxStep = rate * dt;
  return from + clamp(diff, -maxStep, maxStep);
}

function updatePedestrians(dt) {
  pedSpawnTimer -= dt;
  if (pedSpawnTimer <= 0) {
    if (pedestrians.length < PED_MAX) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      pedestrians.push(makePedestrian(dir > 0 ? -30 : W + 30, dir));
    }
    pedSpawnTimer = -Math.log(1 - Math.random()) * PED_SPAWN_MEAN;
  }

  for (let i = pedestrians.length - 1; i >= 0; i--) {
    const p = pedestrians[i];

    if (p.reactDelay > 0) {
      p.reactDelay -= dt;
      if (p.reactDelay <= 0) p.lookTimer = p.pendingLook;
    }
    if (p.lookTimer > 0) p.lookTimer -= dt;

    const staring = p.lookTimer > 0 && p.look;
    const cruise = p.stride.speed * p.speedMul;
    const target = staring ? 0 : cruise;
    p.speed += clamp(target - p.speed, -90 * dt, 60 * dt); // stop quicker than restart

    // Head swings fully toward whatever they're staring at; the body turns
    // partway. Back to facing the way they're walking afterwards.
    if (staring) {
      const toLook = Math.atan2(p.look.y - p.y, p.look.x - p.x);
      p.headAngle = turnToward(p.headAngle, toLook, 7, dt);
      // A parent with a stroller keeps hold of it: body turns only a little,
      // head does the looking.
      const maxTurn = p.accessory === "stroller" ? 0.45 : 0.9;
      p.bodyAngle = turnToward(p.bodyAngle, p.facing + clamp(wrapAngle(toLook - p.facing), -maxTurn, maxTurn), 3, dt);
    } else {
      p.headAngle = turnToward(p.headAngle, p.facing, 4, dt);
      p.bodyAngle = turnToward(p.bodyAngle, p.facing, 3, dt);
    }

    p.x += p.dir * p.speed * dt;
    // walk cycle advances with distance covered, so a stopping walker's legs
    // settle instead of moonwalking
    const strideLen = p.stride.speed / p.stride.cadence;
    p.phase += ((p.speed * dt) / strideLen) * Math.PI * 2;

    if (p.dog) updateDog(p, staring, dt);

    if ((p.dir > 0 && p.x > W + 40) || (p.dir < 0 && p.x < -40)) pedestrians.splice(i, 1);
  }
}

// The dog trots ahead of its walker on a springy leash, lagging a little,
// and stops (and stares) when they do.
function updateDog(p, staring, dt) {
  const d = p.dog;
  const tx = p.x + p.dir * 18, ty = p.y + d.side;
  const px = d.x, py = d.y;
  d.x += (tx - d.x) * Math.min(1, 5 * dt);
  d.y += (ty - d.y) * Math.min(1, 5 * dt);
  const moved = Math.hypot(d.x - px, d.y - py);
  d.phase += moved * 0.9;
  d.tail += dt * (staring ? 9 : 14);
  const wantAngle = staring ? Math.atan2(p.look.y - d.y, p.look.x - d.x) : p.facing;
  d.angle = turnToward(d.angle, wantAngle, 5, dt);
}

// ---- Drawing (top-down, same ink-outline cartoon style as the cars) -------

function drawPedestrians() {
  for (const p of pedestrians) drawPedestrian(p);
}

function inkCircle(x, y, r, fill, lw = 1.2) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (lw) { ctx.strokeStyle = INK; ctx.lineWidth = lw; ctx.stroke(); }
}

function inkEllipse(x, y, rx, ry, fill, lw = 1.2) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (lw) { ctx.strokeStyle = INK; ctx.lineWidth = lw; ctx.stroke(); }
}

function drawPedestrian(p) {
  const s = p.size * PED_SCALE;
  const moving = clamp(p.speed / (p.stride.speed * p.speedMul), 0, 1);
  const step = Math.sin(p.phase) * p.stride.swing * 3 * moving;
  const bob = 1 + Math.abs(Math.sin(p.phase)) * p.stride.bounce * 0.12 * moving;

  if (p.dog) drawDog(p.dog);

  // soft shadow (world space, offset like every other shadow)
  ctx.fillStyle = PAL.shadow;
  ctx.beginPath();
  ctx.ellipse(p.x + 2, p.y + 3, 7.5 * s, 7.5 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // The stroller, and the hands on its handle, stay aligned with the walking
  // direction (p.facing) -- NOT the body -- so when the parent turns to stare
  // at a crash, the stroller stays put instead of swinging around with them.
  const strollerFrame = () => {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.facing);
    ctx.scale(s, s);
  };
  if (p.accessory === "stroller") {
    strollerFrame();
    drawStroller(p);
    ctx.restore();
  }

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.bodyAngle);
  ctx.scale(s * bob, s * bob);

  // feet, stepping out front and back of the body (the visible walk cycle)
  inkEllipse(step * 1.7, -3, 2.5, 1.6, "#3a3035", 1);
  inkEllipse(-step * 1.7, 3, 2.5, 1.6, "#3a3035", 1);

  // shoulders/torso: about twice as wide as the head, as seen from above
  inkEllipse(0, 0, 4.8, 8.6, p.shirt, 1.4);

  // hands: holding a leash / umbrella, or swinging (stroller hands below)
  if (p.accessory !== "stroller") {
    inkCircle(-step * 1.1, -9.2, 1.6, p.skin, 1);
    inkCircle(p.umbrella ? 3 : p.rightHandX ?? step * 1.1, 9.2, 1.6, p.skin, 1); // rightHandX: the mechanic reaching out with a wrench
  }
  ctx.restore();

  if (p.accessory === "stroller") {
    strollerFrame(); // hands stay on the handle
    inkCircle(7, -3.8, 1.5, p.skin, 1);
    inkCircle(7, 3.8, 1.5, p.skin, 1);
    ctx.restore();
  }

  // head, in its own rotation (they look around independently of the body)
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.bodyAngle);
  ctx.scale(s * bob, s * bob);
  ctx.translate(0.6, 0);
  ctx.rotate(p.headAngle - p.bodyAngle);
  ctx.scale(0.88, 0.88); // head a little smaller than the shoulders
  drawPedHead(p);
  ctx.restore();

  // leash: from the walker's hand to the dog's collar
  if (p.dog) {
    const ha = p.bodyAngle, hx = p.x + (Math.cos(ha) * -step * 1.1 - Math.sin(ha) * -9.2) * s;
    const hy = p.y + (Math.sin(ha) * -step * 1.1 + Math.cos(ha) * -9.2) * s;
    const d = p.dog, cx = d.x + Math.cos(d.angle) * 5 * d.size, cy = d.y + Math.sin(d.angle) * 5 * d.size;
    ctx.strokeStyle = "#c0392b";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.quadraticCurveTo((hx + cx) / 2, (hy + cy) / 2 + 3, cx, cy); // a little slack
    ctx.stroke();
  }

  if (p.umbrella) drawUmbrella(p);
}

// Head seen from above: face toward +x (a nose peeks out the front), hair or
// hat covering the rest.
function drawPedHead(p) {
  const hr = 4.6, hc = p.hairColor;
  if (p.hairStyle === "long") inkEllipse(-4.2, 0, 4.2, 4.8, hc, 1.2); // falls over the shoulders
  if (p.hairStyle === "ponytail") { inkEllipse(-6.2, 0, 2.4, 1.7, hc, 1); inkCircle(-4.4, 0, 0.8, "#e8514a", 0.6); }
  inkCircle(0, 0, hr, p.skin, 1.3);
  inkCircle(4.1, 0, 1, p.skin, 0.8); // nose

  switch (p.hairStyle) {
    case "bald":
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(-0.8, 0, 2.6, Math.PI * 0.9, Math.PI * 1.4);
      ctx.stroke();
      break;
    case "short": case "long": case "ponytail":
      inkCircle(-1.1, 0, 4.3, hc, 1.1);
      break;
    case "bun":
      inkCircle(-1.1, 0, 4.3, hc, 1.1);
      inkCircle(-2.4, 0, 2.3, hc, 1.1);
      break;
    case "mohawk":
      ctx.beginPath();
      ctx.roundRect(-4.6, -1.1, 8, 2.2, 1);
      ctx.fillStyle = hc;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.9;
      ctx.stroke();
      break;
    case "afro":
      inkCircle(-0.9, 0, 6.3, hc, 1.2);
      break;
    case "spiky":
      for (let a = Math.PI * 0.55; a <= Math.PI * 1.46; a += Math.PI * 0.15) {
        ctx.beginPath();
        ctx.moveTo(-1.1 + Math.cos(a - 0.22) * 3.6, Math.sin(a - 0.22) * 3.6);
        ctx.lineTo(-1.1 + Math.cos(a) * 6.4, Math.sin(a) * 6.4);
        ctx.lineTo(-1.1 + Math.cos(a + 0.22) * 3.6, Math.sin(a + 0.22) * 3.6);
        ctx.closePath();
        ctx.fillStyle = hc;
        ctx.fill();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
      inkCircle(-1.1, 0, 4.1, hc, 1.1);
      break;
    case "beehive":
      // a tall 'do, seen from above: a big swirl
      inkCircle(-1.2, 0, 5.4, hc, 1.2);
      ctx.strokeStyle = "rgba(35,31,46,0.45)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(-1.2, 0, 3.4, 0.3, Math.PI * 1.7);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-1.2, 0, 1.6, 2, Math.PI * 2 + 1);
      ctx.stroke();
      break;
  }

  switch (p.hat) {
    case "cap":
      inkEllipse(3.8, 0, 3.1, 3.7, p.hatColor, 1.1); // brim, facing forward
      inkCircle(-0.5, 0, 4.4, p.hatColor, 1.2);
      inkCircle(-0.5, 0, 0.8, INK, 0);
      break;
    case "sunhat":
      inkCircle(0, 0, 7.8, p.hatColor, 1.2);
      inkCircle(0, 0, 4.2, p.hatColor, 1.1);
      ctx.strokeStyle = "#e8514a";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, 4.2, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "beanie":
      inkCircle(-0.4, 0, 4.8, p.hatColor, 1.2);
      ctx.strokeStyle = "rgba(35,31,46,0.35)";
      ctx.lineWidth = 0.7;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        ctx.beginPath();
        ctx.moveTo(-0.4 + Math.cos(a) * 1.8, Math.sin(a) * 1.8);
        ctx.lineTo(-0.4 + Math.cos(a) * 4.6, Math.sin(a) * 4.6);
        ctx.stroke();
      }
      inkCircle(-0.4, 0, 1.7, "#ffffff", 1); // pompom
      break;
    case "tophat":
      inkCircle(0, 0, 6.4, "#2a2530", 1.2);
      inkCircle(0, 0, 4.1, "#3a3442", 1.2);
      break;
  }
}

// A baby stroller, pushed ahead (walker-local coordinates, x forward).
function drawStroller(p) {
  for (const [wx, wy] of [[10, -6], [10, 6], [21, -6], [21, 6]]) inkCircle(wx, wy, 1.6, "#2c2833", 0.8);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(7.5, -5);
  ctx.lineTo(7.5, 5); // handle bar
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(8.5, -5.5, 14, 11, 3);
  ctx.fillStyle = p.strollerColor;
  ctx.fill();
  ctx.lineWidth = 1.3;
  ctx.stroke();
  inkCircle(13.5, 0, 2.4, p.skin, 0.9); // the baby
  ctx.beginPath(); // canopy over the front half
  ctx.moveTo(16, -5.5);
  ctx.quadraticCurveTo(25, 0, 16, 5.5);
  ctx.closePath();
  ctx.fillStyle = "rgba(35,31,46,0.25)";
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.1;
  ctx.stroke();
}

// Two-tone umbrella canopy, drawn over the walker.
function drawUmbrella(p) {
  const r = 12.5 * p.size * PED_SCALE, n = 8;
  const cx = p.x + Math.cos(p.bodyAngle) * 1.5, cy = p.y + Math.sin(p.bodyAngle) * 1.5;
  const spin = p.bodyAngle + p.seed;
  for (let i = 0; i < n; i++) {
    const a0 = spin + (i / n) * Math.PI * 2, a1 = spin + ((i + 1) / n) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
    ctx.lineTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
    ctx.closePath();
    ctx.fillStyle = i % 2 ? "#ffffff" : p.umbrella;
    ctx.fill();
  }
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = spin + (i / n) * Math.PI * 2;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  inkCircle(cx, cy, 1.3, "#3a3035", 0.8); // tip
}

function drawDog(d) {
  const s = d.size;
  ctx.fillStyle = PAL.shadow;
  ctx.beginPath();
  ctx.ellipse(d.x + 2, d.y + 2.5, 7 * s, 4.5 * s, d.angle, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.rotate(d.angle);
  ctx.scale(s, s);
  const trot = Math.sin(d.phase) * 1.6;
  for (const [px, py, k] of [[3.5, -3, 1], [3.5, 3, -1], [-3.5, -3, -1], [-3.5, 3, 1]]) {
    inkCircle(px + trot * k, py, 1.2, "#3a3035", 0.6); // paws
  }
  // tail, wagging
  const wag = Math.sin(d.tail) * 0.7;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-5.5, 0);
  ctx.lineTo(-5.5 - Math.cos(wag) * 4, Math.sin(wag) * 4);
  ctx.stroke();
  ctx.strokeStyle = d.color;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.lineCap = "butt";
  inkEllipse(0, 0, 6, 3.6, d.color, 1.2); // body
  inkEllipse(5.8, -2.8, 1.4, 1, d.color, 0.9); // ears
  inkEllipse(5.8, 2.8, 1.4, 1, d.color, 0.9);
  inkCircle(6.2, 0, 2.9, d.color, 1.1); // head
  inkCircle(8.8, 0, 0.9, INK, 0); // nose
  ctx.restore();
}

setupWorld();

// Crates/street are laid out relative to W/H at build time; left stale after
// a resize, street.curbY (and therefore the coin's spawn range, the curb
// collision limit, and the drawn sidewalk position) would drift away from
// the actual canvas size -- most visibly, coins could spawn below the new
// canvas bottom on a resize that shrinks the window. Rebuild both (and
// re-clamp the active coin) once resizing settles; debounced so a window
// drag doesn't reshuffle the parked-car colors on every intermediate frame.
let rebuildTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    crates = buildCrates();
    const oldLaneY = street.npcLaneY, oldCurbY = street.curbY;
    street = buildStreet();
    staticDirty = true;
    mechanic = null; // the garage moved: call off any repair in progress (nothing was charged yet); the door rolls shut

    // Carry traffic along with its lane, and pedestrians along with the
    // sidewalk; anything now past the new right edge walks/drives off.
    for (const n of npcs) n.pos.y += street.npcLaneY - oldLaneY;
    for (const p of pedestrians) {
      p.y += street.curbY - oldCurbY;
      if (p.dog) p.dog.y += street.curbY - oldCurbY;
    }

    car1.pos.x = clamp(car1.pos.x, CAR.wallRadius, W - CAR.wallRadius);
    car1.pos.y = clamp(car1.pos.y, CAR.wallRadius, street.curbY - CAR.wallRadius);
    car2.pos.x = clamp(car2.pos.x, CAR.wallRadius, W - CAR.wallRadius);
    car2.pos.y = clamp(car2.pos.y, CAR.wallRadius, street.curbY - CAR.wallRadius);

    if (coin) {
      coin.x = clamp(coin.x, 40, W - 40);
      coin.y = clamp(coin.y, 40, street.curbY - 40);
    }
  }, 200);
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

function resolveCurb(car) {
  // The sidewalk beyond the curb is off-limits, same style as the outer
  // arena walls -- otherwise you could just drive over the curb to "cheat"
  // a parallel parking attempt. Uses the capsule radius (half the car's
  // width), not the coarser wallRadius, so the player can actually snug up
  // to the curb as close as the parked cars themselves sit.
  const limit = street.curbY - CAR.capsuleRadius;
  if (car.pos.y > limit) {
    car.pos.y = limit;
    boundaryHit(car, Math.max(0, car.vel.y), { x: car.pos.x, y: street.curbY }, "curb");
    car.vel.y = -Math.abs(car.vel.y) * 0.4;
    car.angularVel *= 0.5;
  }
}

function update(dt) {
  gameTime += dt;
  updateTraffic(dt);
  for (const car of [car1, car2]) if (car.autopilot) updateAutopilot(car, dt);

  const movers = [car1, car2, ...npcs];
  for (const car of movers) stepCar(car, dt);

  // Only the players are fenced in by the arena walls -- traffic enters and
  // leaves through the side edges (see updateTraffic).
  resolveWalls(car1);
  resolveWalls(car2);

  for (const car of movers) {
    resolveCurb(car);
    for (const c of crates) resolveCarVsStaticCircle(car, { x: c.x, y: c.y }, c.r, c);
    for (const pc of street.parkedCars) {
      // both ends of a parked car share one contact key: touching it is one touch
      for (const cc of pc.collisionCircles) resolveCarVsStaticCircle(car, cc, CAR.capsuleRadius, pc);
    }
  }
  for (let i = 0; i < movers.length; i++) {
    for (let j = i + 1; j < movers.length; j++) resolveCarVsCar(movers[i], movers[j]);
  }

  updateCoin(dt);
  updateCoinRace();
  updateGarage();
  updateMechanic(dt);
  for (const car of movers) emitSmoke(car, dt);
  updateParticles(dt);
  updatePedestrians(dt);
}

// ---------------------------------------------------------------------------
// Render: hand-drawn cartoon style
// ---------------------------------------------------------------------------
// The look: flat, bright colors with thick dark "ink" outlines that wobble
// slightly, as if inked by hand. The wobble is seeded per object and stable
// from frame to frame (no "line boil" shimmer while you drive).
//
// Everything that never moves -- ground, street, sidewalk, lawn, the garage
// building, crates, parked cars -- is drawn once into `staticLayer` by
// buildStaticLayer() and blitted each frame. It MUST be rebuilt whenever
// street/crates are rebuilt (setupWorld and the resize handler), or the
// picture drifts away from the collision geometry.

const INK = "#231f2e";
const PAL = {
  lot: "#e8dfc6",
  road: "#9491a8",
  lane: "#ffd23f",
  curb: "#dcd9e6",
  sidewalk: "#f5ddb6",
  sidewalkSeam: "#d6b58a",
  driveway: "#e6dccb",
  lawn: "#86d152",
  lawnDark: "#5fae36",
  garageWall: "#f29bc4",
  garageRoof: "#d377a6",
  garageDoor: "#aac6e2",
  crate: "#dd9a4e",
  crateDark: "#a4652b",
  glass: "#b3e6ff",
  headlight: "#fff3a6",
  taillight: "#ff5a4f",
  tire: "#2c2833",
  hub: "#d7dae0",
  coin: "#ffd23f",
  coinRing: "#e3a414",
  shadow: "rgba(35,31,46,0.2)",
};

// Deterministic 0..1 noise from a number -- seeds the per-object wobble.
function hash01(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// A rounded rectangle's outline as a clockwise list of points, with the
// straight edges subdivided every `step` px so wobble() has something to bend.
function roundRectPoints(x, y, w, h, r, step = 6) {
  const pts = [];
  const corners = [
    [x + w - r, y + r, -Math.PI / 2],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ];
  for (let i = 0; i < 4; i++) {
    const [cx, cy, a0] = corners[i];
    for (let k = 0; k <= 4; k++) {
      const a = a0 + (k / 4) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    const [nx, ny, na0] = corners[(i + 1) % 4];
    const last = pts[pts.length - 1];
    const ex = nx + Math.cos(na0) * r, ey = ny + Math.sin(na0) * r;
    const n = Math.max(1, Math.floor(Math.hypot(ex - last.x, ey - last.y) / step));
    for (let k = 1; k < n; k++) pts.push({ x: last.x + ((ex - last.x) * k) / n, y: last.y + ((ey - last.y) * k) / n });
  }
  return pts;
}

// Nudges each outline point along its normal by a smooth, seeded amount --
// the "inked by hand" wobble. Low-frequency on purpose: gentle bends, not fuzz.
function wobble(pts, seed, amp) {
  const n = pts.length;
  const ph1 = hash01(seed) * Math.PI * 2, ph2 = hash01(seed + 7.3) * Math.PI * 2;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    let nx = b.y - a.y, ny = a.x - b.x;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const s = (i / n) * Math.PI * 2;
    const o = amp * (0.6 * Math.sin(s * 3 + ph1) + 0.4 * Math.sin(s * 7 + ph2));
    return { x: p.x + nx * o, y: p.y + ny * o };
  });
}

// Closed smooth path through the points (quadratic curves via midpoints).
function tracePath(c, pts) {
  const n = pts.length;
  c.beginPath();
  c.moveTo((pts[n - 1].x + pts[0].x) / 2, (pts[n - 1].y + pts[0].y) / 2);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    c.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
  }
  c.closePath();
}

// The workhorse: fill a shape flat, then ink its outline.
function inkShape(c, pts, fill, lw = 2.5, stroke = INK) {
  tracePath(c, pts);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (lw) { c.strokeStyle = stroke; c.lineWidth = lw; c.lineJoin = "round"; c.stroke(); }
}

// A hand-drawn line: pinned at both ends, gently bowed in between.
function inkLine(c, x0, y0, x1, y1, seed, lw = 2, color = INK, amp = 0.8) {
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const n = Math.max(2, Math.ceil(len / 10));
  const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
  const ph = hash01(seed) * Math.PI * 2;
  const waves = 1 + Math.floor(len / 120); // long lines get a few bends, short ones one
  c.beginPath();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const o = amp * Math.sin(t * Math.PI * 2 * waves + ph) * Math.sin(t * Math.PI);
    const x = x0 + (x1 - x0) * t + nx * o, y = y0 + (y1 - y0) * t + ny * o;
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  }
  c.strokeStyle = color;
  c.lineWidth = lw;
  c.lineCap = "round";
  c.stroke();
  c.lineCap = "butt";
}

// Text with a thick ink outline, cartoon-sign style.
function inkText(c, text, x, y, size, fill) {
  c.font = `900 ${size}px "Trebuchet MS", "Segoe UI", sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.lineJoin = "round";
  c.strokeStyle = INK;
  c.lineWidth = Math.max(3, size * 0.22);
  c.strokeText(text, x, y);
  c.fillStyle = fill;
  c.fillText(text, x, y);
  c.textBaseline = "alphabetic";
}

// ---- Static layer ---------------------------------------------------------

const staticLayer = document.createElement("canvas");

function buildStaticLayer() {
  // Re-creating the canvas is most of a rebuild's cost, so only do it when
  // the size changed -- a dent on a parked car redraws in place (drawGround
  // paints over the whole canvas first).
  if (staticLayer.width !== W || staticLayer.height !== H) {
    staticLayer.width = W;
    staticLayer.height = H;
  }
  const c = staticLayer.getContext("2d");
  drawGround(c);
  drawStreetArt(c);
  drawGarageBuilding(c);
  for (const cr of crates) drawCrate(c, cr);
  for (const pc of street.parkedCars) drawCar(c, pc);
  drawPaperGrain(c);
}

// The open lot: warm, sun-bleached concrete with a few cracks and oil stains.
function drawGround(c) {
  c.fillStyle = PAL.lot;
  c.fillRect(0, 0, W, H);
  const roadTop = street.npcLaneY - CAR.width / 2 - 16;
  for (let i = 0; i < Math.round((W * roadTop) / 60000); i++) {
    const x = hash01(i * 3.1) * W, y = hash01(i * 5.7 + 1) * (roadTop - 20);
    if (i % 3 === 0) {
      // oil stain
      const pts = wobble(roundRectPoints(x - 9, y - 6, 18, 12, 6, 4), i, 1.5);
      tracePath(c, pts);
      c.fillStyle = "rgba(120,105,80,0.18)";
      c.fill();
    } else {
      // hairline crack: two short joined segments
      const a = hash01(i * 9.1) * Math.PI;
      const x1 = x + Math.cos(a) * 14, y1 = y + Math.sin(a) * 14;
      inkLine(c, x, y, x1, y1, i, 1.2, "rgba(120,105,80,0.45)", 1);
      inkLine(c, x1, y1, x1 + Math.cos(a + 0.8) * 9, y1 + Math.sin(a + 0.8) * 9, i + 0.5, 1.2, "rgba(120,105,80,0.45)", 0.6);
    }
  }
}

function drawStreetArt(c) {
  const { curbY, centerlineY, npcLaneY, parkingSpots } = street;

  // road surface, inked along its top edge
  const roadTop = npcLaneY - CAR.width / 2 - 16;
  c.fillStyle = PAL.road;
  c.fillRect(0, roadTop, W, curbY - roadTop);
  inkLine(c, -5, roadTop, W + 5, roadTop, 11, 3);

  // centerline: chunky painted dashes
  for (let x = 12; x < W; x += 46) {
    inkShape(c, wobble(roundRectPoints(x, centerlineY - 3.5, 26, 7, 3.5, 5), x, 0.5), PAL.lane, 1.5);
  }

  // sidewalk, then a strip of lawn below it
  const swH = street.sidewalkBottomY - curbY;
  c.fillStyle = PAL.sidewalk;
  c.fillRect(0, curbY, W, swH);
  for (let x = 40; x < W; x += 64) inkLine(c, x, curbY + 5, x, curbY + swH - 3, x * 0.37, 1.5, PAL.sidewalkSeam, 0.6);
  c.fillStyle = PAL.lawn;
  c.fillRect(0, curbY + swH, W, H - curbY - swH);
  for (let i = 0; i < W / 14; i++) {
    const x = hash01(i * 2.3) * W, y = curbY + swH + 8 + hash01(i * 4.1) * (H - curbY - swH - 12);
    inkLine(c, x - 3, y + 3, x - 1, y - 2, i, 1.4, PAL.lawnDark, 0.3);
    inkLine(c, x + 1, y + 3, x + 3, y - 3, i + 0.3, 1.4, PAL.lawnDark, 0.3);
  }
  inkLine(c, -5, curbY + swH, W + 5, curbY + swH, 23, 2.5);

  // curb: a pale band with inked edges
  c.fillStyle = PAL.curb;
  c.fillRect(0, curbY - 3, W, 7);
  inkLine(c, -5, curbY - 3, W + 5, curbY - 3, 31, 2.5);
  inkLine(c, -5, curbY + 4, W + 5, curbY + 4, 37, 2);

  // parking spots: painted end marks and a big "P"
  for (const s of parkingSpots) {
    for (const x of [s.x0, s.x1]) inkShape(c, roundRectPoints(x - 2, curbY - 15, 4, 13, 2, 4), "#ffffff", 1.5);
    inkText(c, "P", (s.x0 + s.x1) / 2, street.carCenterY, 17, "#ffffff");
  }
}

// A polygon's outline as points, edges subdivided every `step` px -- so
// tracePath's midpoint smoothing only softens the corners slightly instead
// of turning a 4-point shape into a blob.
function polygonPoints(verts, step = 6) {
  const pts = [];
  verts.forEach((a, i) => {
    const b = verts[(i + 1) % verts.length];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  });
  return pts;
}

// Pink cartoon garage on the lawn, below the sidewalk, with a driveway
// crossing the sidewalk to a lowered curb -- the sidewalk itself stays
// continuous, so pedestrians can walk straight past.
function drawGarageBuilding(c) {
  const g = street.garage;
  const w = g.x1 - g.x0, by0 = g.buildingY0, h = g.bottomY - by0;

  // driveway apron: concrete from the door out to the curb, flaring toward
  // the street like a real one, over a lowered (cut) curb
  const top = g.curbY - 1, bottom = by0 + 3;
  inkShape(c, polygonPoints([
    { x: g.doorX0 - 16, y: top }, { x: g.doorX1 + 16, y: top },
    { x: g.doorX1 + 6, y: bottom }, { x: g.doorX0 - 6, y: bottom },
  ]), PAL.driveway, 0);
  inkLine(c, g.doorX0 - 16, top + 1, g.doorX0 - 6, bottom, 91, 2);
  inkLine(c, g.doorX1 + 16, top + 1, g.doorX1 + 6, bottom, 92, 2);
  for (const x of [g.doorX0 - 16, g.doorX1 + 16]) inkLine(c, x, g.curbY - 3, x, g.curbY + 4, x, 2); // curb-cut edges
  inkLine(c, g.doorX0 - 12, g.curbY + 5, g.doorX1 + 12, g.curbY + 5, 93, 1.2, PAL.sidewalkSeam, 0.3); // lowered-curb lip
  inkLine(c, g.doorX0 - 8, street.sidewalkBottomY, g.doorX1 + 8, street.sidewalkBottomY, 94, 1.2, PAL.sidewalkSeam, 0.3); // sidewalk edge

  // building
  tracePath(c, roundRectPoints(g.x0 + 5, by0 + 6, w, h, 5, 10));
  c.fillStyle = PAL.shadow;
  c.fill();
  inkShape(c, wobble(roundRectPoints(g.x0, by0, w, h, 5, 8), 77, 1), PAL.garageWall, 3);
  // roll-up door with slats, on the edge facing the driveway
  const doorH = g.doorH, dw = g.doorX1 - g.doorX0;
  // flat roof inset (below the door) with a vent, when there's room for it
  const roofY = by0 + doorH + 6, roofH = h - (doorH + 6) - 8;
  if (roofH > 14) {
    inkShape(c, wobble(roundRectPoints(g.x0 + 10, roofY, w - 20, roofH, 4, 8), 78, 0.8), PAL.garageRoof, 2);
    if (roofH > 26) inkShape(c, wobble(roundRectPoints(g.x1 - 34, roofY + 6, 14, 14, 7, 4), 79, 0.4), "#e9e4f2", 1.8);
  }
  inkShape(c, roundRectPoints(g.doorX0, by0 - 2, dw, doorH, 2, 6), PAL.garageDoor, 2.2);
  for (let y = by0 + 3; y < by0 + doorH - 3; y += 4.5) inkLine(c, g.doorX0 + 3, y, g.doorX1 - 3, y, y, 1, "rgba(35,31,46,0.45)", 0.3);
}

function drawCrate(c, cr) {
  const s = cr.r, x0 = cr.x - s, y0 = cr.y - s, seed = cr.x * 0.37 + cr.y * 1.3;
  tracePath(c, roundRectPoints(x0 + 3, y0 + 4, s * 2, s * 2, 3, 6));
  c.fillStyle = PAL.shadow;
  c.fill();
  inkShape(c, wobble(roundRectPoints(x0, y0, s * 2, s * 2, 3, 5), seed, 0.8), PAL.crate, 2.5);
  inkShape(c, wobble(roundRectPoints(x0 + 4, y0 + 4, s * 2 - 8, s * 2 - 8, 2, 5), seed + 1, 0.5), null, 1.5, PAL.crateDark);
  inkLine(c, x0 + 5, y0 + s * 2 - 5, x0 + s * 2 - 5, y0 + 5, seed, 2.2, PAL.crateDark, 0.6);
  inkLine(c, x0 + 4, y0 + 3, x0 + s, y0 + 3, seed + 2, 1.5, "rgba(255,255,255,0.55)", 0.3);
}

// Scattered ink specks and a soft vignette over the whole static scene --
// the "printed on paper" feel.
function drawPaperGrain(c) {
  for (let i = 0; i < (W * H) / 700; i++) {
    c.fillStyle = i % 2 ? "rgba(35,31,46,0.05)" : "rgba(255,255,255,0.08)";
    c.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
  }
  const v = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, "rgba(35,31,46,0)");
  v.addColorStop(1, "rgba(35,31,46,0.16)");
  c.fillStyle = v;
  c.fillRect(0, 0, W, H);
}

// ---- Cars -----------------------------------------------------------------

// A car's outline shapes, in its own local frame (x forward), wobbled with
// its own seed. They never change, so they're built once and cached.
function carArt(car) {
  if (car.art) return car.art;
  const L = CAR.length, Wd = CAR.width, s = car.seed;
  car.art = {
    body: wobble(roundRectPoints(-L / 2, -Wd / 2, L, Wd, 8, 5), s, 0.7),
    cabin: wobble(roundRectPoints(-L * 0.28, -Wd / 2 + 3.5, L * 0.52, Wd - 7, 5, 5), s + 1, 0.4),
    windshield: wobble(roundRectPoints(L * 0.05, -Wd / 2 + 4.5, L * 0.17, Wd - 9, 3, 4), s + 2, 0.3),
    rearWindow: wobble(roundRectPoints(-L * 0.26, -Wd / 2 + 5, L * 0.1, Wd - 10, 2, 4), s + 3, 0.3),
  };
  return car.art;
}

function drawWheel(c, x, y, angle) {
  const wLen = 14, wWid = 7;
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  c.beginPath();
  c.roundRect(-wLen / 2, -wWid / 2, wLen, wWid, 2.5);
  c.fillStyle = PAL.tire;
  c.fill();
  c.strokeStyle = INK;
  c.lineWidth = 1.5;
  c.stroke();
  // light stripe along the tire, so steering direction stays legible at a glance
  c.strokeStyle = PAL.hub;
  c.lineWidth = 1.6;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(-wLen / 2 + 3, 0);
  c.lineTo(wLen / 2 - 3, 0);
  c.stroke();
  c.lineCap = "butt";
  c.restore();
}

function drawCar(c, car) {
  const L = CAR.length, Wd = CAR.width;
  const halfWB = CAR.wheelBase / 2, halfTrack = Wd / 2;
  const art = carArt(car);

  // drop shadow, offset in world space (the sun doesn't turn with the car)
  c.save();
  c.translate(car.pos.x + 3, car.pos.y + 4);
  c.rotate(car.angle);
  tracePath(c, art.body);
  c.fillStyle = PAL.shadow;
  c.fill();
  c.restore();

  c.save();
  c.translate(car.pos.x, car.pos.y);
  c.rotate(car.angle);

  // wheels first so the body sits on top; the two fronts get distinct
  // Ackermann angles (the inner one visibly turns sharper)
  const wa = ackermannWheelAngles(car.steerCurrent, CAR.wheelBase, CAR.track);
  drawWheel(c, halfWB, -halfTrack, wa.left);
  drawWheel(c, halfWB, halfTrack, wa.right);
  drawWheel(c, -halfWB, -halfTrack, 0);
  drawWheel(c, -halfWB, halfTrack, 0);

  inkShape(c, art.body, car.color, 2.5);
  inkShape(c, art.cabin, null, 1.5);
  inkShape(c, art.windshield, PAL.glass, 1.5);
  inkShape(c, art.rearWindow, PAL.glass, 1.2);
  inkLine(c, L * 0.09, -Wd / 2 + 7, L * 0.09, -Wd / 2 + 11, car.seed, 1.6, "#ffffff", 0); // windshield glint

  // headlights (front corners), taillights (rear corners)
  for (const side of [-1, 1]) {
    c.beginPath();
    c.arc(L / 2 - 3.5, side * (Wd / 2 - 4.5), 2.4, 0, Math.PI * 2);
    c.fillStyle = PAL.headlight;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = 1.2;
    c.stroke();
    c.beginPath();
    c.roundRect(-L / 2 + 1.2, side * (Wd / 2 - 5) - 2, 2.6, 4, 1);
    c.fillStyle = PAL.taillight;
    c.fill();
    c.stroke();
  }

  // collision dents: a dark bruise with ink crack lines, clipped to the body
  if (car.dents.length) {
    c.save();
    tracePath(c, art.body);
    c.clip();
    for (const d of car.dents) {
      const seed = d.x * 13.1 + d.y * 7.7;
      tracePath(c, wobble(roundRectPoints(d.x - d.r, d.y - d.r, d.r * 2, d.r * 2, d.r, 3), seed, d.r * 0.15));
      c.fillStyle = "rgba(35,31,46,0.28)";
      c.fill();
      for (let k = 0; k < 3; k++) {
        const a = hash01(seed + k) * Math.PI * 2, len = d.r * (0.7 + 0.5 * hash01(seed + k + 9));
        inkLine(c, d.x, d.y, d.x + Math.cos(a) * len, d.y + Math.sin(a) * len, seed + k, 1.2, INK, 0.4);
      }
    }
    c.restore();
  }

  c.restore();
}

// ---- Dynamic scene elements ------------------------------------------------

// The in-world "now go park" cue (there's no status text): while a player is
// in "mustPark", every open spot pulses in that player's color. With both
// players waiting to park, the two pulses run half a cycle apart, so the
// spots alternate between their colors.
function drawParkingTargets() {
  const waiting = [car1, car2].filter((c) => c.gameState === "mustPark");
  const y0 = street.carCenterY - CAR.width / 2 - 5;
  const h = street.curbY - 1 - y0;
  drawTargetPulse(waiting, street.parkingSpots.map((s) => ({ x: s.x0, y: y0, w: s.x1 - s.x0, h })));
}

// The shared "go here" cue: each rect pulses (tinted fill + outline) in the
// color of every car in `cars`. With two cars, their pulses run half a cycle
// apart so the colors alternate. Used for the parking spots and the garage.
function drawTargetPulse(cars, rects) {
  if (!cars.length) return;
  const now = performance.now() / 1000;
  cars.forEach((car, i) => {
    const pulse = 0.5 + 0.5 * Math.sin(now * 5 + i * Math.PI); // 0..1
    ctx.fillStyle = car.color;
    ctx.strokeStyle = car.color;
    ctx.lineWidth = 3;
    for (const r of rects) {
      ctx.globalAlpha = 0.1 + 0.25 * pulse;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 0.4 + 0.6 * pulse;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
    }
  });
  ctx.globalAlpha = 1;
}

// easeOutBack: 0 -> 1 with a small overshoot past 1 before settling -- the "pop".
function popScale(u) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
}

function drawCoin(coin) {
  if (coin.age < COIN_IMPLODE_TIME) return; // still imploding, see spawnImplosion
  const u = Math.min(1, (coin.age - COIN_IMPLODE_TIME) / COIN_POP_TIME);
  const pulse = 1 + 0.08 * Math.sin(performance.now() / 250);
  const r = COIN_RADIUS * pulse * popScale(u);

  ctx.save();
  ctx.translate(coin.x, coin.y);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.arc(0, 0, r + 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = PAL.coin;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
  ctx.strokeStyle = PAL.coinRing;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.beginPath(); // shine
  ctx.arc(0, 0, r * 0.62, Math.PI * 1.05, Math.PI * 1.45);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.restore();
}

// The garage's service pad (the building itself is in the static layer).
function drawGaragePad() {
  const g = street.garage;
  const w = g.x1 - g.x0, h = g.curbY - g.padY0;

  // No text anywhere on the garage -- the wrench + coin on the pad says
  // "repairs cost a coin", and the border flashes red at a damaged player
  // who's stopped on it without one.
  const denied = garageDenied(car1) || garageDenied(car2);
  const flashOn = denied && Math.floor(performance.now() / 180) % 2 === 0;
  ctx.fillStyle = "rgba(35,31,46,0.16)";
  ctx.fillRect(g.x0, g.padY0, w, h);
  // Badly damaged players see the pad pulse in their color -- same "go here"
  // cue as the parking spots. Grown a few px past the pad so the pulsing
  // outline frames the hazard border instead of hiding underneath it.
  const busted = [car1, car2].filter((c) => c.damage >= GARAGE_HINT_DAMAGE);
  const m = 4;
  drawTargetPulse(busted, [{ x: g.x0 - m, y: g.padY0 - m, w: w + 2 * m, h: h + m }]);
  ctx.save();
  ctx.lineWidth = 4;
  ctx.setLineDash([11, 7]);
  ctx.strokeStyle = flashOn ? "#ff4b3e" : PAL.lane;
  ctx.strokeRect(g.x0 + 3, g.padY0 + 3, w - 6, h - 6);
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(g.x0, g.padY0, w, h);

  const cx = (g.x0 + g.x1) / 2, cy = g.padY0 + h / 2;
  drawWrench(cx - 11, cy, flashOn ? "#ff4b3e" : "#dfe3ea");
  ctx.beginPath();
  ctx.arc(cx + 13, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = PAL.coin;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// The roll-up door, animated over the static one while the mechanic is out:
// a dark interior shows as the slatted door rolls away into the building.
function drawGarageDoor() {
  if (garageDoorOpen <= 0) return;
  const g = street.garage, y0 = g.buildingY0 - 2, dw = g.doorX1 - g.doorX0;
  ctx.beginPath();
  ctx.roundRect(g.doorX0, y0, dw, g.doorH, 2);
  ctx.fillStyle = "#2c2833";
  ctx.fill();
  const rolled = g.doorH * (1 - garageDoorOpen); // what's left of the door, at the inner edge
  if (rolled > 1) {
    ctx.fillStyle = PAL.garageDoor;
    ctx.fillRect(g.doorX0 + 1, y0 + g.doorH - rolled, dw - 2, rolled - 1);
    ctx.strokeStyle = "rgba(35,31,46,0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = y0 + g.doorH - rolled + 3; y < y0 + g.doorH - 2; y += 4.5) {
      ctx.moveTo(g.doorX0 + 3, y);
      ctx.lineTo(g.doorX1 - 3, y);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.roundRect(g.doorX0, y0, dw, g.doorH, 2);
  ctx.stroke();
}

// The mechanic (only while outside), with a wrench in their right hand that
// swings while they work.
function drawMechanic() {
  const m = mechanic;
  if (!m || (m.state !== "walkOut" && m.state !== "working" && m.state !== "walkBack")) return;
  const working = m.state === "working" && !m.fixed;
  const hx = working ? 7 : 0, hy = 9.2; // right hand, body-local (reaching toward the car while working)
  m.rightHandX = hx;
  drawPedestrian(m);
  const s = m.size * PED_SCALE, a = m.bodyAngle;
  const wx = m.x + (Math.cos(a) * hx - Math.sin(a) * hy) * s;
  const wy = m.y + (Math.sin(a) * hx + Math.cos(a) * hy) * s;
  const swing = working ? Math.sin(m.t * 26) * 0.7 : 0;
  ctx.save();
  ctx.translate(wx, wy);
  ctx.rotate(a + Math.PI / 4 + swing); // drawWrench tilts -45deg itself; this points it along the arm
  ctx.scale(0.5, 0.5);
  drawWrench(0, 0, "#dfe3ea");
  ctx.restore();
  if (working) inkCircle(wx, wy, 1.6 * s, m.skin, 1); // the hand, over the wrench handle
}

// A simple open-end wrench, ~24px long, centered on (x, y), tilted 45deg.
// Drawn twice -- a fat ink pass, then the color on top -- for an outline.
function drawWrench(x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 4);
  ctx.lineCap = "round";
  for (const [stroke, extra] of [[INK, 3], [color, 0]]) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 5 + extra; // handle
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(4, 0);
    ctx.stroke();
    ctx.lineWidth = 4 + extra; // head: a thick "C", open to the right for the jaw
    ctx.beginPath();
    ctx.arc(8, 0, 4.5, Math.PI * 0.3, Math.PI * 1.7);
    ctx.stroke();
  }
  ctx.restore();
}

// The HUD is deliberately minimal: each player's badge is just their label
// and coin count. The key hint shows only until that player first drives,
// and the bottom hint line fades out after HINT_SECONDS or the first coin
// pickup. Game state is shown in the world instead (drawParkingTargets, the
// garage pad flash) -- keep it that way rather than adding status text back.
const titleEl1 = document.getElementById("p1-title");
const titleEl2 = document.getElementById("p2-title");
const scoreEl1 = document.getElementById("p1-score");
const scoreEl2 = document.getElementById("p2-score");
const autoBtn1 = document.getElementById("p1-auto");
const autoBtn2 = document.getElementById("p2-auto");
const hintEl = document.getElementById("hint");
const HINT_SECONDS = 10;

for (const [btn, getCar] of [[autoBtn1, () => car1], [autoBtn2, () => car2]]) {
  // Don't take keyboard focus: Space/Enter would then toggle it mid-game.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    initAudio(); // a click counts as the gesture that unlocks audio, too
    toggleAutopilot(getCar());
  });
}

function updateHud(car, titleEl, scoreEl, autoBtn) {
  const title = car.hasDriven ? car.label : `${car.label} — ${car.keyHint}`;
  if (titleEl.textContent !== title) titleEl.textContent = title;
  const score = String(car.score);
  if (scoreEl.textContent !== score) scoreEl.textContent = score;
  const on = !!car.autopilot;
  if (autoBtn.classList.contains("on") !== on) {
    autoBtn.classList.toggle("on", on);
    autoBtn.setAttribute("aria-pressed", String(on));
  }
}

function updateHint() {
  if (hintEl.classList.contains("faded")) return;
  const anyPickup = [car1, car2].some((c) => c.score > 0 || c.gameState === "mustPark");
  if (gameTime > HINT_SECONDS || anyPickup) hintEl.classList.add("faded");
}

// Where an "implode" particle is at flight fraction t (0..1): radius shrinks
// with an accelerating t^2 ease, and the angle swirls as it falls in.
function implodePos(p, t) {
  const r = p.r0 * (1 - t * t);
  const a = p.angle + p.spin * t;
  return { x: p.tx + Math.cos(a) * r, y: p.ty + Math.sin(a) * r };
}

// Strokes the current path twice -- a fat ink pass, then the color on top --
// so thin particle lines keep a cartoon outline and stay visible on the
// light ground.
function inkedStroke(color, width) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = width + 2.2;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawParticles() {
  ctx.lineCap = "round";
  for (const p of particles) {
    if (p.life < 0) continue; // staggered start, not launched yet
    const t = p.life / p.maxLife;
    if (p.type === "implode") {
      // A short streak trailing back along the path it came from, fading in
      // as it speeds up toward the center.
      const head = implodePos(p, t);
      const tail = implodePos(p, Math.max(0, t - 0.08));
      ctx.globalAlpha = Math.min(1, 0.2 + t * 1.2);
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(head.x, head.y);
      inkedStroke(p.color, p.size + 0.4);
    } else if (p.type === "spark") {
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1 - t * 0.4) + 0.4, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.1;
      ctx.stroke();
    } else if (p.type === "streak") {
      ctx.globalAlpha = 1 - t;
      const speed = Math.hypot(p.vx, p.vy);
      const len = Math.min(speed * 0.045, 16);
      const dx = speed > 0.01 ? (p.vx / speed) * len : 0;
      const dy = speed > 0.01 ? (p.vy / speed) * len : 0;
      ctx.beginPath();
      ctx.moveTo(p.x - dx, p.y - dy);
      ctx.lineTo(p.x, p.y);
      inkedStroke(p.color, p.size + 0.4);
    } else if (p.type === "ring") {
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      inkedStroke(p.color, 2.2);
    } else if (p.type === "smoke") {
      // cartoon puff: flat fill with a faint ink outline
      const a = p.alpha * (1 - t);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = a * 0.6;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    } else if (p.type === "flash") {
      // warm yellow rather than white, so it reads on the light ground
      ctx.globalAlpha = (1 - t) * 0.95;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
      grad.addColorStop(0, "rgba(255,248,200,1)");
      grad.addColorStop(0.45, "rgba(255,214,70,0.85)");
      grad.addColorStop(1, "rgba(255,190,40,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    // "delayedBurst" is an invisible timer -- nothing to draw.
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = "butt";
}

function render() {
  if (staticDirty) {
    buildStaticLayer();
    staticDirty = false;
  }
  ctx.drawImage(staticLayer, 0, 0); // ground, street, garage building, crates, parked cars
  drawParkingTargets();
  drawGaragePad();
  drawGarageDoor();
  drawPedestrians();
  drawMechanic();
  for (const n of npcs) drawCar(ctx, n);
  if (coin) drawCoin(coin);
  drawCar(ctx, car1);
  drawCar(ctx, car2);
  drawParticles();

  updateHud(car1, titleEl1, scoreEl1, autoBtn1);
  updateHud(car2, titleEl2, scoreEl2, autoBtn2);
  updateHint();
}

// ---------------------------------------------------------------------------
// Main loop (fixed-step physics, variable-rate render)
// ---------------------------------------------------------------------------

const FIXED_DT = 1 / 120;
let lastTime = performance.now();
let accumulator = 0;

function frame(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  accumulator += dt;

  while (accumulator >= FIXED_DT) {
    update(FIXED_DT);
    accumulator -= FIXED_DT;
  }

  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
