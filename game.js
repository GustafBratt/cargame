"use strict";

// Rådhusgatan Rumble -- a top-down 2-player car game. See CLAUDE.md.

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

// Records that `car` is touching `key` (a campsite rig or another car,
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

// Countdown beeps: a short blip per number, a higher, longer one for "go".
function playCountdownBeep(go) {
  liveSfx(W / 2, 0.5, (c, o, t) => {
    sfxTone(c, o, t, { freq: go ? 1320 : 660, dur: go ? 0.32 : 0.12, type: "square", gain: 0.35 });
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
  // nudge it -- while car-vs-obstacle (the campsite's rigs, parked cars) stays lower/more
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

function speedOf(car) {
  return Math.hypot(car.vel.x, car.vel.y);
}

function readInput(car) {
  if (car.drive) return car.drive; // AI-controlled traffic, see npcDrive
  if (countdown > 0) return { throttle: 0, steer: 0 }; // the players wait out the countdown
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
  const speed = speedOf(car);

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
  const tow = car.caravan ? CARAVAN_POWER : 1; // towing a caravan: the engine has more to pull
  const power = (1 - DAMAGE_POWER_LOSS * (1 - health)) * tow;
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
  // A parked car's handbrake: a shove slides it a little, then it stops dead.
  if (car.handbrake) {
    const v = Math.hypot(car.vel.x, car.vel.y);
    const keep = v > 0 ? Math.max(0, v - HANDBRAKE_DECEL * dt) / v : 0;
    car.vel.x *= keep;
    car.vel.y *= keep;
    car.angularVel *= Math.max(0, 1 - 8 * dt);
  }

  // Clamp forward/reverse top speed along the heading only -- lateral
  // (drift) speed is left alone, it's already grip-limited above.
  const fwdAfter = car.vel.x * forward.x + car.vel.y * forward.y;
  const latAfter = car.vel.x * right.x + car.vel.y * right.y;
  // Damage caps top speed, but never below a crawl, so a wreck can still park.
  const fwdClamped = clamp(fwdAfter,
    -Math.max(p.maxReverseSpeed * health * (car.caravan ? CARAVAN_TOP_SPEED : 1), DAMAGED_MIN_REVERSE),
    Math.max(p.maxSpeed * health * (car.caravan ? CARAVAN_TOP_SPEED : 1), DAMAGED_MIN_SPEED));
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

// Collides a car's capsule against a single static circle (one of a
// campsite rig's circles), feeding the resulting push/impulse back
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
  if (hitAt) applyDamage(car, hit, hitAt);
  collisionSound(hit, (hitAt || obstaclePos).x, car, isNewTouch(car, key));
  if (hit >= HIT_SOUND_MIN) pedestriansNotice(hitAt.x, hitAt.y, "crash", hit);
}

function resolveCarVsCar(carA, carB) {
  // A parked car takes a hit more like an obstacle than a rolling car: the
  // damped restitution, so it gets shoved rather than sent flying. Below
  // DAMAGE_THRESHOLD it doesn't budge at all (handbrake on, it's anchored
  // like scenery): otherwise every parking nudge, and every neighbor pulling
  // out, would slowly twist the row out of line.
  const restitution = carA.handbrake || carB.handbrake ? CAR.obstacleCollisionRestitution : CAR.carCollisionRestitution;
  const gentle = Math.hypot(carA.vel.x - carB.vel.x, carA.vel.y - carB.vel.y) < DAMAGE_THRESHOLD;
  const anchoredA = gentle && carA.handbrake && !carB.handbrake;
  const anchoredB = gentle && carB.handbrake && !carA.handbrake;
  let hit = 0, hitAtA = null, hitAtB = null, touched = false;
  for (const rA of capsuleOffsets(carA.angle)) {
    for (const rB of capsuleOffsets(carB.angle)) {
      const a = { x: carA.pos.x + rA.x, y: carA.pos.y + rA.y };
      const b = { x: carB.pos.x + rB.x, y: carB.pos.y + rB.y };
      const posBeforeA = { x: a.x, y: a.y }, posBeforeB = { x: b.x, y: b.y };
      const velBeforeA = { x: carA.vel.x, y: carA.vel.y }, velBeforeB = { x: carB.vel.x, y: carB.vel.y };
      const R = CAR.capsuleRadius;
      const s = anchoredA ? resolveCircles(b, carB.vel, R, a, null, R, true, restitution)
        : resolveCircles(a, carA.vel, R, b, carB.vel, R, anchoredB, restitution);
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
  if (car.caravan) car.caravan.dents.length = 0; // the mechanic fixes the whole rig
}

// Puffs of smoke out the back of the car, at a rate and darkness that scale
// with damage. Purely cosmetic -- rides the shared particles array.
function emitSmoke(car, dt) {
  if (car.damage < SMOKE_DAMAGE_MIN || car.handbrake) return; // parked cars never smoke
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
// World: cars + the campsite + parking street
// ---------------------------------------------------------------------------

let car1, car2, campsite, street;
let npcs = []; // AI traffic cars, see updateTraffic
let npcSpawnTimer = 0;
let gameTime = 0; // seconds of simulation since setupWorld, see updateHint
// The pre-drawn static scene (see buildStaticLayer) needs redrawing -- set
// whenever street/campsite are (re)built or a parked car gets a dent; render()
// does the actual rebuild, since the render code's constants aren't
// initialized yet when setupWorld first runs.
let staticDirty = true;
let particles = []; // cosmetic-only firework sparks/rings, see spawnFirework

// Bright cartoon paint jobs, but none close to the players' blue/orange.
const PARKED_COLORS = ["#b9a4e0", "#8fd6b4", "#f28b82", "#f6c85f", "#9ec5d8", "#d99ad0"];

// The parking row is a line of painted bays along the curb. Parked cars
// (see "Parked cars" below) sit centered in bays, so the space a free bay
// leaves between the bumpers of the cars either side is its own length plus
// half of each neighbor's slack (its length minus CAR.length). With every
// bay the same size, that averages out to "medium" -- but the fun is in the
// choice between fighting for the roomy spot and squeezing into the tight
// one. So bays come in two sizes: mostly tight, plus about one in
// ROOMY_EVERY roomy, never two roomy side by side. Between tight neighbors:
// - a free tight bay leaves 53 + 3.5 + 3.5 = 60 px (1.3 car lengths)
// - a free roomy bay leaves 71 + 3.5 + 3.5 = 78 px (1.7 car lengths)
// (a tight bay next to a parked-in roomy one gets its slack: ~70 px).
// The planner in updateParkers tries to keep one of each free.
//
// The bays at each end of the row always stay parked in (bay.end): a free end
// bay has no car on its open side, so "parking" there is just driving in.
const BAY_TIGHT = 53, BAY_ROOMY = 71; // px
const ROOMY_EVERY = 4;
// How many bays: the row aims to fill PARK_ROW_SHARE of the width, but its
// right end stays PARK_ROW_GARAGE_GAP clear of the garage pad, so parking
// maneuvers (which line up past the bay) don't end on the pad.
const PARK_ROW_SHARE = 0.45;
const PARK_ROW_GARAGE_GAP = 110; // px
const PARK_BAYS_MIN = 4;

function buildParkingBays(garageX0) {
  const avg = (BAY_TIGHT * (ROOMY_EVERY - 1) + BAY_ROOMY) / ROOMY_EVERY;
  const room = Math.min(W * PARK_ROW_SHARE, 2 * (garageX0 - PARK_ROW_GARAGE_GAP - W / 2));
  const n = Math.max(PARK_BAYS_MIN, Math.floor(room / avg));

  // Scatter the roomy bays, never next to each other and never at an end.
  const roomy = new Array(n).fill(false);
  const want = Math.max(1, Math.round(n / ROOMY_EVERY));
  const order = [...roomy.keys()].slice(1, -1).sort(() => Math.random() - 0.5);
  let placed = 0;
  for (const i of order) {
    if (placed >= want) break;
    if (roomy[i - 1] || roomy[i + 1]) continue;
    roomy[i] = true;
    placed++;
  }

  const widths = roomy.map((r) => (r ? BAY_ROOMY : BAY_TIGHT));
  let x = (W - widths.reduce((sum, w) => sum + w, 0)) / 2; // the row is centered
  return widths.map((w, i) => {
    const bay = { x0: x, x1: x + w, roomy: roomy[i], end: i === 0 || i === n - 1 };
    x += w;
    return bay;
  });
}

function buildStreet() {
  const curbY = H * 0.82;
  const carCenterY = curbY - CAR.width / 2 - 6;
  const centerlineY = curbY - 90;
  const npcLaneY = centerlineY - CAR.width / 2 - 8; // traffic lane, just above the centerline
  // Parked cars arrive and leave along this lane, just below the centerline
  // (and clear of the garage pad).
  const parkLaneY = centerlineY + CAR.width / 2 + 8;

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
  const bays = buildParkingBays(garage.x0);

  return { curbY, carCenterY, centerlineY, npcLaneY, parkLaneY, sidewalkBottomY, bays, garage };
}

// ---- The campsite ---------------------------------------------------------
// Along the top of the lot: a strip of grass with a row of camping pitches
// (gravel pads) opening downward onto the open lot. Every pitch but
// CAMP_FREE holds a static car + caravan rig, parked the way campers do:
// caravan backed in at the back, car in front facing out. The free pitches
// always have rigs either side (never at the ends, never next to each
// other). In game phase 4 players must park in one after every coin -- and
// the only way to end up facing out, caravan in the back, is to reverse in.
// The rigs are scenery: they never move, and collide as static circles
// (campsite.circles: both capsule circles of the car, both caravan circles),
// the same way the crates that used to stand here did.
// A bush closes off the back of every pitch (also in campsite.circles). With
// the back open, a rig could drive in forward from above and end up facing
// out without ever reversing. Neighboring bushes leave a gap narrower than a
// car, and the bush stops just short of a backed-in caravan.
const CAMP_PITCH_W = 56; // px: a caravan is 26 wide, so ~43 px to spare between the neighbors' caravans
const CAMP_PITCH_D = 140; // px: the rig is ~120 long, car front to caravan back
const CAMP_FREE = 2;
// px from the top of the canvas to the back of the pitches: below the HUD
// badges, and far enough down that a car can still drive round above the
// bushes (at 78, cars scraped along the top wall there)
const CAMP_TOP = 112;
const CAMP_SHARE = 0.5; // of the width the row of pitches aims to fill
const CAMP_BUSH_R = 17; // px: two bushes leave 56 - 34 = 22 px between them, under a car's 24
const CAMP_BUSH_Y = -6; // px from the back of the pitches to the bushes' centers
const CAMP_COLORS = ["#f28b82", "#8fd6b4", "#b9a4e0", "#f6c85f", "#9ec5d8", "#d99ad0", "#ffffff"];

function buildCampsite() {
  const n = clamp(Math.floor((W * CAMP_SHARE) / CAMP_PITCH_W), 5, 14);
  const x0 = (W - n * CAMP_PITCH_W) / 2;
  const y0 = CAMP_TOP, y1 = CAMP_TOP + CAMP_PITCH_D;
  const pitches = [];
  for (let i = 0; i < n; i++) pitches.push({ x0: x0 + i * CAMP_PITCH_W, x1: x0 + (i + 1) * CAMP_PITCH_W, y0, y1, free: false });

  // the free ones: inner pitches, not next to each other
  const order = pitches.map((_, i) => i).slice(1, -1).sort(() => Math.random() - 0.5);
  let freed = 0;
  for (const i of order) {
    if (freed >= CAMP_FREE) break;
    if (pitches[i - 1].free || pitches[i + 1].free) continue;
    pitches[i].free = true;
    freed++;
  }

  const rigs = [], circles = [];
  for (const p of pitches) {
    if (p.free) continue;
    // car in front facing out (down), its front bumper a little inside the pitch
    const rig = createCar((p.x0 + p.x1) / 2, y1 - 6 - CAR.length / 2, Math.PI / 2, pickOf(CAMP_COLORS), null);
    attachCaravan(rig); // straight behind: up into the pitch
    rigs.push(rig);
    for (const o of capsuleOffsets(rig.angle)) circles.push({ x: rig.pos.x + o.x, y: rig.pos.y + o.y, r: CAR.capsuleRadius, key: rig });
    for (const cs of CARAVAN.circles) circles.push({ ...caravanPoint(rig, cs), r: CARAVAN.radius, key: rig });
  }
  // a bush at the back of every pitch, so nobody drives in from above
  const bushes = pitches.map((p) => ({ x: (p.x0 + p.x1) / 2, y: y0 + CAMP_BUSH_Y, r: CAMP_BUSH_R }));
  for (const b of bushes) circles.push({ ...b, key: b });
  // the grass strip the pitches sit on (drawCampsite), also kept clear of coins
  const area = { x0: x0 - 18, x1: x0 + n * CAMP_PITCH_W + 18, y0: y0 + CAMP_BUSH_Y - CAMP_BUSH_R - 4, y1: y1 + 6 };
  return { pitches, rigs, bushes, circles, area };
}

function freePitches() {
  return campsite.pitches.filter((p) => p.free);
}

// ---------------------------------------------------------------------------
// Tractors (game phase 5)
// ---------------------------------------------------------------------------
// When the first player reaches game phase 5, two tractors drive in along the
// aisle below the campsite and park across the front of the two free
// pitches, one each, TRACTOR_GAP below the opening. That blocks backing
// straight in from below: the rig has to come along the passage between
// the tractor and the parked rigs, and reverse round a curve into the pitch.
// TRACTOR_GAP was measured: a steered reverse round a 70 px quarter circle
// (the caravan's axle) sweeps at most ~64 px below the opening within 30 px
// of the pitch's middle, and the autopilot's scripted one ~55 px; out to the
// side, where the car swings, ~77 px, but the tractor isn't there.
// They collide as static circles in campsite.circles (key: the tractor), so
// everything that already handles the campsite's rigs -- collisions,
// sounds, dents, the autopilot's swerving -- handles them too. While driving
// in, their circles move with them, and they wait (and honk) for anyone in
// their way.
const TRACTOR = { length: 52, width: 32 };
const TRACTOR_CIRCLES = [{ at: -10, r: 16 }, { at: 14, r: 12 }]; // along its length, from its center: the cab over the big rear wheels, the hood
const TRACTOR_GAP = 70; // px from a pitch's opening to the parked tractor's top edge
const TRACTOR_SPEED = 80; // px/s
const TRACTOR_STAGGER = 2.5; // s between the two setting off
const TRACTOR_COLORS = ["#6cbf4a", "#e2574c"];
let tractors = [];

function tractorParkY(pitch) {
  return pitch.y1 + TRACTOR_GAP + TRACTOR.width / 2;
}

// The lowest edge of the campsite, tractors included.
function campBottom() {
  return tractors.reduce((y, t) => Math.max(y, t.y + TRACTOR.width / 2), campsite.area.y1);
}

function setTractorCircles(t) {
  for (const [i, tc] of TRACTOR_CIRCLES.entries()) {
    t.circles[i].x = t.x + Math.cos(t.angle) * tc.at;
    t.circles[i].y = t.y + Math.sin(t.angle) * tc.at;
  }
}

function makeTractor(pitch, i, parked) {
  // the left one comes from the left edge, the right one from the right, so
  // neither drives past the other one's spot
  const fromLeft = i === 0;
  const targetX = (pitch.x0 + pitch.x1) / 2;
  const t = {
    pitch, targetX, y: tractorParkY(pitch),
    x: parked ? targetX : fromLeft ? -TRACTOR.length : W + TRACTOR.length,
    angle: fromLeft ? 0 : Math.PI,
    delay: parked ? 0 : i * TRACTOR_STAGGER,
    parked, blockedTime: 0, honkAt: 0.7,
    color: TRACTOR_COLORS[i % TRACTOR_COLORS.length], seed: 300 + i * 17,
    circles: TRACTOR_CIRCLES.map((tc) => ({ x: 0, y: 0, r: tc.r })),
  };
  for (const c of t.circles) c.key = t;
  setTractorCircles(t);
  campsite.circles.push(...t.circles);
  return t;
}

// Phase 5 has begun: the tractors come (once).
function callTractors() {
  if (tractors.length) return;
  tractors = freePitches().sort((a, b) => a.x0 - b.x0).map((p, i) => makeTractor(p, i, false));
}

// After a resize rebuilt the campsite: tractors that were called are simply
// there, parked at the new free pitches.
function replaceTractors() {
  if (!tractors.length) return;
  tractors = freePitches().sort((a, b) => a.x0 - b.x0).map((p, i) => makeTractor(p, i, true));
}

function updateTractors(dt) {
  for (const t of tractors) {
    if (t.parked) continue;
    if (t.delay > 0) {
      t.delay -= dt;
      continue;
    }
    const dir = Math.sign(t.targetX - t.x), left = Math.abs(t.targetX - t.x);
    // anyone just ahead: wait for them, honking now and then
    const blocked = trafficPoints(null).some((p) => {
      const ahead = (p.x - t.x) * dir, side = Math.abs(p.y - t.y);
      return ahead > 0 && ahead < TRACTOR.length / 2 + 26 && side < TRACTOR.width / 2 + 14;
    });
    if (blocked) {
      t.blockedTime += dt;
      if (t.blockedTime > t.honkAt) {
        playHornSound(t.x, 0.6);
        t.honkAt = t.blockedTime + 2.5 + Math.random() * 2;
      }
    } else {
      t.blockedTime = 0;
      t.honkAt = 0.7;
      t.x += dir * Math.min(left, Math.min(TRACTOR_SPEED, 15 + left * 1.5) * dt);
      if (Math.random() < dt * 6) {
        // a puff from the exhaust stack
        const ex = t.x + Math.cos(t.angle) * 8, ey = t.y + Math.sin(t.angle) * 8 - 4;
        particles.push({ type: "smoke", x: ex, y: ey, vx: (Math.random() - 0.5) * 10, vy: -12 - Math.random() * 8, size: 3, growSpeed: 9, color: "rgb(120,120,120)", alpha: 0.35, life: 0, maxLife: 1 });
      }
    }
    setTractorCircles(t);
    if (Math.abs(t.targetX - t.x) < 0.5) {
      t.x = t.targetX;
      t.parked = true;
      setTractorCircles(t);
      if (coin && Math.abs(coin.x - t.x) < TRACTOR.length && Math.abs(coin.y - t.y) < TRACTOR.width) spawnCoin(); // it parked on the coin
    }
  }
}

function setupWorld() {
  car1 = createCar(W * 0.35, H * 0.5, Math.PI / 2, "#4fc3ff", {
    up: ["w"], down: ["s"], left: ["a"], right: ["d"],
  });
  car2 = createCar(W * 0.65, H * 0.5, Math.PI / 2, "#ffa64f", {
    up: ["i", "arrowup"], down: ["k", "arrowdown"], left: ["j", "arrowleft"], right: ["l", "arrowright"],
  });

  campsite = buildCampsite();
  tractors = [];
  street = buildStreet();
  resetParkers();

  for (const car of [car1, car2]) {
    car.score = 0;
    car.gameState = "seekCoin";
    car.gamePhase = 1; // the game phases, see coinCaught
    car.phaseCoins = 0;
    car.caravanDue = false; // see caravanAppears
    car.hasDriven = false;
  }
  particles.length = 0;
  coin = null; // the first coin comes when the countdown ends, see updateCountdown
  countdown = COUNTDOWN_FROM;
  countdownShown = 0;
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

// Coins keep this far clear of the campsite's grass strip: nobody should
// have to thread a caravan between the parked rigs for a coin.
const COIN_CAMP_GAP = 30;

function randomCoinPos() {
  const a = campsite.area;
  for (let attempt = 0; attempt < 40; attempt++) {
    const x = 60 + Math.random() * (W - 120);
    const y = 60 + Math.random() * Math.max(40, street.curbY - 150 - 60);
    const inCamp = x > a.x0 - COIN_CAMP_GAP && x < a.x1 + COIN_CAMP_GAP && y < campBottom() + COIN_CAMP_GAP;
    if (!inCamp) return { x, y };
  }
  return { x: W / 2, y: (campBottom() + street.curbY - 150) / 2 };
}

let coin = null; // shared: only one coin exists at a time, so both cars race for it

// The game opens with a countdown in the middle of the lot: "3", "2", "1",
// then "Now find a coin!" as the first coin spawns. The players can't move
// until it's over (readInput); the rest of the world is already going.
// (Before, the first coin waited until both players had driven or switched
// on their autopilot.)
const COUNTDOWN_FROM = 3; // s, one per number
let countdown = 0; // s left
let countdownShown = 0; // the number on screen

function updateCountdown(dt) {
  if (countdown <= 0) return;
  countdown -= dt;
  if (countdown <= 0) {
    spawnCoin();
    callout(null, "Now find a coin!", { size: CALLOUT_SIZE * 1.3, time: 1.5 });
    playCountdownBeep(true);
    return;
  }
  const n = Math.ceil(countdown);
  if (n !== countdownShown) {
    countdownShown = n;
    callout(null, String(n), { size: CALLOUT_SIZE * 2.2, time: 0.9 });
    playCountdownBeep(false);
  }
}

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
// There's no coin during the opening countdown (updateCountdown).
function updateCoin(dt) {
  if (!coin) return;
  coin.age += dt;
  if (!coin.popped && coin.age >= COIN_IMPLODE_TIME) {
    coin.popped = true;
    particles.push({ type: "flash", x: coin.x, y: coin.y, radius: 22, life: 0, maxLife: 0.2 });
    particles.push({ type: "ring", x: coin.x, y: coin.y, radius: COIN_RADIUS, growSpeed: 120, color: "#ffd54f", life: 0, maxLife: 0.3 });
  }
}

function coinCollectable() {
  return coin !== null && coin.age >= COIN_IMPLODE_TIME;
}

function isParked(car) {
  const speed = speedOf(car);
  if (speed > PARK_SPEED_LIMIT) return false;

  let a = car.angle % Math.PI;
  if (a < 0) a += Math.PI;
  const angleOff = Math.min(a, Math.PI - a);
  if (angleOff > PARK_ANGLE_TOLERANCE) return false;

  if (Math.abs(car.pos.y - street.carCenterY) > PARK_Y_TOLERANCE) return false;

  return street.bays.some((bay) => car.pos.x > bay.x0 + PARK_X_MARGIN && car.pos.x < bay.x1 - PARK_X_MARGIN);
}

// Is a car in this bay? It counts if its center is between the bay's marks
// and it's down in the parking lane, not just driving past. `cars` narrows
// who counts; the planner ignores the players, see updateParkers.
function bayOccupied(bay, except = null, cars = [car1, car2, ...parkers]) {
  return cars.some((c) => c !== except &&
    c.pos.x > bay.x0 && c.pos.x < bay.x1 && c.pos.y > street.carCenterY - PARK_Y_TOLERANCE - 6);
}

// The bays open to park in: no car in them. End bays never count (see
// buildParkingBays). A bay an arriving parked car is heading for is still
// free -- it keeps its "P", and players can race the car for it.
function freeBays() {
  return street.bays.filter((bay) => !bay.end && !bayOccupied(bay));
}

// The free bays no arriving parked car has claimed (bay.reservedBy): what
// the parked-car planner works with, so two cars never head for one bay and
// a car on its way counts as already there.
function unclaimedBays() {
  return freeBays().filter((bay) => !bay.reservedBy && !bay.caravanSpace);
}

// ---- The caravan space ----------------------------------------------------
// While any player tows a caravan (game phase 3), the parked cars keep one
// run of adjacent bays clear that a car plus caravan fits into with
// CARAVAN_SPACE_MARGIN to spare. A car + caravan is ~120 px, and two tight
// bays leave only ~113, so it's usually three bays. Its bays are marked
// bay.caravanSpace: they still show a "P" and anyone can use them, but the
// planner doesn't count them, no arriving car heads for them, and any
// parked car in them is sent away first.
const CARAVAN_SPACE_MARGIN = 40; // px of gap beyond the rig's length

function rigLength() {
  return CAR.length / 2 + CARAVAN.hitchBack + CARAVAN.tongue + CARAVAN.length;
}

// The bumper-to-bumper gap bays i..j leave when free, with cars parked
// centered in the bays either side.
function runGap(i, j) {
  const b = street.bays;
  let gap = 0;
  for (let k = i; k <= j; k++) gap += b[k].x1 - b[k].x0;
  for (const n of [b[i - 1], b[j + 1]]) if (n) gap += (n.x1 - n.x0 - CAR.length) / 2;
  return gap;
}

// Picks the run to keep clear: the shortest one that fits the rig (the
// longest there is, on a window too narrow for any to fit), preferring the
// fewest parked cars to send away.
function chooseCaravanSpace() {
  const b = street.bays, need = rigLength() + CARAVAN_SPACE_MARGIN;
  // not in, or next to, a caravan space there already is
  const taken = (i) => [b[i - 1], b[i], b[i + 1]].some((bay) => bay && bay.caravanSpace);
  const inner = b.map((_, i) => i).filter((i) => !b[i].end && !taken(i));
  let best = null;
  for (let len = 1; len <= inner.length && !best; len++) {
    const runs = [];
    for (let i = inner[0]; i + len - 1 <= inner[inner.length - 1]; i++) {
      let open = true;
      for (let k = i; k < i + len; k++) if (!inner.includes(k)) open = false;
      if (!open) continue;
      if (len < inner.length && runGap(i, i + len - 1) < need) continue;
      const cars = parkers.filter((c) => c.state === "parked" && c.pos.x > b[i].x0 && c.pos.x < b[i + len - 1].x1).length;
      runs.push({ i, j: i + len - 1, cars });
    }
    if (runs.length) {
      const fewest = Math.min(...runs.map((r) => r.cars));
      best = pickOf(runs.filter((r) => r.cars === fewest));
    }
  }
  return best;
}

// One caravan space per phase-3 player with a caravan (from phase 4 on,
// they park at the campsite). Each space's bays share an id in
// bay.caravanSpace (1 or 2). With just one space, two rigs going for it
// jammed each other for good: both stuck at 3:3 for a whole 15-minute game.
function updateCaravanSpace() {
  const wanted = [car1, car2].filter((c) => (c.caravan || c.caravanDue) && c.gamePhase === 3).length;
  const ids = [...new Set(street.bays.map((bay) => bay.caravanSpace).filter(Boolean))];
  if (ids.length > wanted) {
    const drop = Math.max(...ids);
    for (const bay of street.bays) if (bay.caravanSpace === drop) bay.caravanSpace = 0;
    return;
  }
  if (ids.length === wanted) return;
  const run = chooseCaravanSpace();
  if (!run) return; // no room for another: they share
  const id = ids.includes(1) ? 2 : 1;
  for (let k = run.i; k <= run.j; k++) street.bays[k].caravanSpace = id;
}

// A parked car standing in the caravan space, if any: they're sent away
// first, and without waiting out PARK_EVENT_GAP.
function parkerInCaravanSpace() {
  return parkers.find((c) => {
    const bay = bayAt(c.pos.x);
    return c.state === "parked" && bay && bay.caravanSpace;
  }) || null;
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
    speedOf(car) <= GARAGE_SPEED_LIMIT;
}

// Sends the mechanic out to the first eligible car. One car at a time: a
// second car waiting on the pad is served once the mechanic is back inside.
function updateGarage() {
  if (mechanic) return;
  for (const car of [car1, car2]) {
    if (car.damage <= 0 || !onGaragePad(car)) continue;
    if (speedOf(car) > GARAGE_SPEED_LIMIT) continue;
    if (car.score < REPAIR_COST) continue;
    mechanic = makeMechanic(car);
    break;
  }
}

// ---- The mechanic ---------------------------------------------------------
// States: "opening" (door rolls up) -> "walkOut" (jog round to the front of
// the car) -> "hoodUp" (lifts the hood) -> "working" (wrench over the
// engine; the fix lands MECH_FIX_AT in) -> "hoodDown" -> "walkBack" ->
// "closing" (door rolls down) -> gone (mechanic = null). The repair and the
// coin charge happen only at the fix: if the car leaves the pad before
// that, the mechanic gives up and walks back in, and nothing is charged (the
// hood drops shut on its own: car.hoodOpen follows the mechanic, see
// updateMechanic). Drawn with the pedestrian renderer (overalls, red cap, a
// wrench in hand). They used to work from the driveway, beside the car; going
// to the front and opening the hood first was asked for.

const MECH_SPEED = 90; // px/s, a brisk jog
const MECH_DOOR_TIME = 0.35; // s for the door to roll up / down
const MECH_HOOD_TIME = 0.4; // s to lift the hood (shutting it is quicker)
const MECH_WORK_TIME = 1.0; // s at the engine
const MECH_FIX_AT = 0.5; // s into the work when the car is fixed (after the ratchet + clank)

let mechanic = null; // the mechanic while out (or opening/closing the door); null when idle inside
let garageDoorOpen = 0; // 0 closed .. 1 fully rolled up, drawn over the static door

function mechanicHome() {
  const g = street.garage;
  return { x: (g.doorX0 + g.doorX1) / 2, y: g.buildingY0 + g.doorH / 2 };
}

// The way from the driveway to the front of the car, where the mechanic
// works: along the sidewalk below the curb to the nose, then up beside it.
// A car parked on end (rare on the pad) is walked round by its side. The
// mechanic is drawn under the cars, so walking through one would look like
// vanishing beneath it.
function mechanicPathOut(car) {
  const g = street.garage;
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  const front = {
    x: clamp(car.pos.x + fx * (CAR.length / 2 + 12), 8, W - 8),
    y: car.pos.y + fy * (CAR.length / 2 + 12),
  };
  const low = g.curbY + 10;
  if (Math.abs(fx) > 0.5) return [{ x: front.x, y: low }, front];
  const sx = clamp(car.pos.x + CAR.length / 2 + 14, 8, W - 8);
  return [{ x: sx, y: low }, { x: sx, y: front.y }, front];
}

function makeMechanic(car) {
  const home = mechanicHome();
  const up = -Math.PI / 2;
  return {
    state: "opening", t: 0, car, fixed: false, nextSpark: 0, path: [],
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

// Walk the waypoints in m.path; returns true once at the last one.
function mechanicFollow(m, dt) {
  while (m.path.length && mechanicWalkTo(m, m.path[0], dt)) m.path.shift();
  return !m.path.length;
}

function updateMechanic(dt) {
  // the door opens while the mechanic is out and rolls down once they're back
  const wantOpen = mechanic !== null && mechanic.state !== "closing";
  garageDoorOpen = clamp(garageDoorOpen + ((wantOpen ? 1 : -1) * dt) / MECH_DOOR_TIME, 0, 1);
  // a car's hood is up while the mechanic is under it, and drops shut otherwise
  for (const c of [car1, car2]) {
    const up = mechanic && mechanic.car === c && (mechanic.state === "hoodUp" || mechanic.state === "working");
    c.hoodOpen = clamp((c.hoodOpen || 0) + (up ? dt / MECH_HOOD_TIME : -dt / 0.25), 0, 1);
  }
  if (!mechanic) return;

  const m = mechanic, car = m.car;
  m.t += dt;
  const carStillThere = onGaragePad(car) && speedOf(car) <= GARAGE_SPEED_LIMIT * 2;
  const giveUp = () => {
    m.state = "walkBack";
    m.path = [{ x: m.x, y: street.garage.curbY + 10 }, mechanicHome()];
  };
  const faceCar = () => {
    const toCar = Math.atan2(car.pos.y - m.y, car.pos.x - m.x);
    m.bodyAngle = m.headAngle = m.facing = toCar;
    return toCar;
  };

  if (m.state === "opening") {
    if (garageDoorOpen >= 1) {
      m.state = "walkOut";
      m.path = mechanicPathOut(car);
    }
  } else if (m.state === "walkOut") {
    if (!carStillThere) giveUp(); // they drove off: never mind
    else if (mechanicFollow(m, dt)) {
      m.state = "hoodUp";
      m.t = 0;
    }
  } else if (m.state === "hoodUp") {
    faceCar();
    if (!carStillThere) giveUp();
    else if (car.hoodOpen >= 1) {
      m.state = "working";
      m.t = 0;
      playWrenchSound(m.x);
    }
  } else if (m.state === "hoodDown") {
    faceCar();
    if (car.hoodOpen <= 0 || !carStillThere) giveUp();
  } else if (m.state === "working") {
    faceCar();
    if (!m.fixed && !carStillThere) {
      giveUp();
    } else {
      if (!m.fixed && m.t >= m.nextSpark) {
        // over the engine: just past the hood's hinge, inside the car's nose
        const ex = car.pos.x + Math.cos(car.angle) * CAR.length * 0.33 + (Math.random() - 0.5) * 8;
        const ey = car.pos.y + Math.sin(car.angle) * CAR.length * 0.33 + (Math.random() - 0.5) * 8;
        spawnWrenchSparks(ex, ey);
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
      if (m.t >= MECH_WORK_TIME) m.state = "hoodDown";
    }
  } else if (m.state === "walkBack") {
    if (mechanicFollow(m, dt)) m.state = "closing";
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
      playCoinPickupSound(car.pos.x);
      spawnCoin();
      coinCaught(car);
      // phase 1 just collects; from phase 2 on, every coin needs a park
      if (car.gamePhase >= 2) {
        car.gameState = "mustPark";
        callout(car, car.gamePhase >= 4 ? "Now camp!" : "Now park!");
      }
      break;
    }
  }

  for (const car of [car1, car2]) {
    if (car.gameState === "mustPark" && parkedForPhase(car)) {
      car.gameState = "seekCoin";
      spawnFirework(car.pos.x, car.pos.y, car.color);
      playParkedSound(car.pos.x);
      campDone(car);
      callout(car, "Now find a coin!");
    }
  }
}

// ---- Game phases ----------------------------------------------------------
// Each player moves through the phases on their own, COINS_PER_PHASE coins
// per phase:
// 1. just fetch coins
// 2. parallel park after every coin
// 3. a caravan appears, and every coin needs car AND caravan parked; the
//    parked cars keep a long enough space free for it (see updateParkers)
// Progress counts coins as they're caught: the 3rd coin of a phase moves the
// player on, and that coin's task already follows the new phase (the 3rd
// phase-1 coin needs a park; the caravan appears on the 3rd phase-2 coin,
// and that coin is parked with it). The counter is separate from car.score
// (the coins in hand), so paying the garage doesn't set anyone back.
// 4. the campsite: every coin needs the rig reversed into a free pitch
// 5. the same, but tractors park in front of the free pitches (callTractors),
//    and the reverse has to curve in through the passage they leave
// Except: phase 4 ends on its 3rd successful camp, not on a coin (asked for:
// "not when I take the coin but when I successfully park at the camp the
// third time"). Its camps follow the 3rd phase-3 coin and phase-4 coins 1
// and 2, so phase 4 takes just two coins, and phase 5 begins as the third
// camp lands (campDone).
// LAST_PHASE is the last one built.
const COINS_PER_PHASE = 3;
const LAST_PHASE = 5;

function coinCaught(car) {
  car.phaseCoins++;
  if (car.phaseCoins < COINS_PER_PHASE || car.gamePhase >= LAST_PHASE || car.gamePhase === 4) return;
  nextPhase(car);
}

// A park counted. In phase 4, the third camp moves the player on.
function campDone(car) {
  if (car.gamePhase === 4 && car.phaseCoins >= COINS_PER_PHASE - 1) nextPhase(car);
}

function nextPhase(car) {
  car.gamePhase++;
  car.phaseCoins = 0;
  // a bigger celebration than a park: a burst on the car and one each side
  for (const dx of [-40, 0, 40]) spawnFirework(car.pos.x + dx, car.pos.y - Math.abs(dx) * 0.5, car.color);
  playRepairSound(car.pos.x);
  if (car.gamePhase >= 3 && !car.caravan && !caravanAppears(car)) car.caravanDue = true;
  if (car.gamePhase >= 5) callTractors();
}

// The caravan pops in behind the car, right where the coin was caught, with
// the coin's implosion, a flash and a ring in the player's color. Straight
// behind is blocked? Then it appears folded to whichever side is clear. And
// if nowhere is (with the old crate grid, a coin caught between the crates:
// spawned there, it wedged between two of them, pushed equally both ways
// along its length and never freed), it's due (car.caravanDue) and appears
// the moment there's room --
// usually a second later, once the player has driven on.
const CARAVAN_APPEAR_FOLDS = [0, 0.4, -0.4, 0.8, -0.8, 1.1, -1.1]; // rad, tried in order

function updateCaravanDue() {
  for (const car of [car1, car2]) {
    if (car.caravanDue && caravanAppears(car)) car.caravanDue = false;
  }
}

// Returns whether it appeared.
function caravanAppears(car) {
  attachCaravan(car);
  const r = CARAVAN.radius + 3;
  const others = [car1, car2, ...npcs, ...parkers].filter((c) => c !== car);
  const clear = () => CARAVAN.circles.every((s) => {
    const p = caravanPoint(car, s);
    return p.x > r && p.x < W - r && p.y > r && p.y < street.curbY - r &&
      campsite.circles.every((cr) => Math.hypot(p.x - cr.x, p.y - cr.y) > r + cr.r) &&
      others.every((o) => capsuleOffsets(o.angle).every((q) => Math.hypot(p.x - o.pos.x - q.x, p.y - o.pos.y - q.y) > r + CAR.capsuleRadius));
  });
  const fold = CARAVAN_APPEAR_FOLDS.find((f) => {
    car.caravan.angle = car.angle + f;
    return clear();
  });
  if (fold === undefined) {
    car.caravan = null;
    return false;
  }
  car.caravan.angle = car.angle + fold;
  placeCaravanAxle(car);
  const mid = caravanPoint(car, CARAVAN.tongue + CARAVAN.length / 2);
  spawnImplosion(mid.x, mid.y);
  particles.push({ type: "flash", x: mid.x, y: mid.y, radius: 34, life: 0, maxLife: 0.25 });
  particles.push({ type: "ring", x: mid.x, y: mid.y, radius: 10, growSpeed: 160, color: car.color, life: 0, maxLife: 0.4 });
  playCoinSpawnSound(mid.x);
  return true;
}

// Parked in a free campsite pitch (game phase 4): stopped, car and caravan
// both straight and facing out (down, toward the open lot), the caravan's
// middle inside the pitch and the car at most a little out of it. Facing out
// with the caravan in the back is only possible by reversing in: a pitch has
// no room to turn round in.
// A pitch's gravel pad, as drawn: the rig has to be on it.
function pitchPad(p) {
  return { x0: p.x0 + 4, x1: p.x1 - 4, y0: p.y0 + 2, y1: p.y1 + 4 };
}

// Are all four corners of a box (center, heading, half length and width) inside rect?
function boxInRect(cx, cy, angle, hl, hw, r) {
  const fx = Math.cos(angle), fy = Math.sin(angle);
  for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const x = cx + fx * hl * a - fy * hw * b, y = cy + fy * hl * a + fx * hw * b;
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return false;
  }
  return true;
}

// Camped: stopped, car and caravan both facing out, and both bodies wholly
// on a free pitch's gravel, nothing on the grass. (The first rule only
// wanted the caravan's middle in the pitch and the car's center near it,
// which the user found "way too forgiving".) The pad is 48 x 142 px, the
// rig 26 x 120: ~11 px to spare either side, 22 px lengthwise.
function parkedInCamp(car) {
  if (!car.caravan || speedOf(car) > PARK_SPEED_LIMIT) return false;
  const out = Math.PI / 2;
  if (Math.abs(wrapAngle(car.angle - out)) > PARK_ANGLE_TOLERANCE) return false;
  if (Math.abs(wrapAngle(car.caravan.angle - out)) > PARK_ANGLE_TOLERANCE) return false;
  const mid = caravanPoint(car, CARAVAN.tongue + CARAVAN.length / 2);
  return freePitches().some((p) => {
    const pad = pitchPad(p);
    return boxInRect(car.pos.x, car.pos.y, car.angle, CAR.length / 2, CAR.width / 2, pad) &&
      boxInRect(mid.x, mid.y, car.caravan.angle, CARAVAN.length / 2, CARAVAN.width / 2, pad);
  });
}

// Parked, for this player's phase: in phase 4, in a campsite pitch (above).
// Before that, at the curb -- and with a caravan, it has to be straight,
// down in the parking lane and within the row too.
function parkedForPhase(car) {
  if (car.gamePhase >= 4) return parkedInCamp(car);
  if (!isParked(car) || car.caravanDue) return false;
  if (!car.caravan) return true;
  let a = car.caravan.angle % Math.PI;
  if (a < 0) a += Math.PI;
  if (Math.min(a, Math.PI - a) > PARK_ANGLE_TOLERANCE) return false;
  const mid = caravanPoint(car, CARAVAN.tongue + CARAVAN.length / 2);
  const bays = street.bays;
  return Math.abs(mid.y - street.carCenterY) <= PARK_Y_TOLERANCE && mid.x > bays[0].x0 && mid.x < bays[bays.length - 1].x1;
}

// A proper celebration fireworks burst, fired at the moment a parking
// attempt is confirmed successful. Purely cosmetic: never touches physics
// or game state. Layers: a bright flash core, a shower of round sparks plus
// faster streaking ones, two shockwave rings at different speeds, and a
// delayed secondary "pop" (via the invisible "delayedBurst" marker below)
// for the classic multi-stage firework read rather than one flat burst.
// "Now park!": what to do next, popped up over the player's car the moment
// it changes, fighting-game style -- big, in the player's color with an ink
// outline, a bit see-through; it pops in with an overshoot, keeps growing
// as it drifts up, and fades out quickly. Asked for because new players
// didn't know what to do next; the HUD still says it too ("Next: Park").
// (Making the parking bays flash in the player's colors was tried before,
// and "just didn't have the correct vibe".) A new one replaces any still
// showing for the same car. Drawn by drawParticles, on top of everything.
const CALLOUT_TIME = 1.1; // s
const CALLOUT_SIZE = 44; // px, the font size once popped in

// With no car (the countdown), it's gold and centered on the open lot.
function callout(car, text, { size = CALLOUT_SIZE, time = CALLOUT_TIME } = {}) {
  for (const p of particles) if (p.type === "callout" && p.car === car) p.life = p.maxLife; // gone next update
  particles.push({
    type: "callout", text, car, size, color: car ? car.color : "#ffd23f",
    x: car ? car.pos.x : 0, y: car ? car.pos.y : 0, life: 0, maxLife: time,
  });
}

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
  const clear = trafficPoints(null).every((p) => Math.hypot(p.x - x, p.y - y) > CAR.length * 2.5);
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

// Counts down a pending angry honk (see npcGotRammed) and sounds it.
function tickAngryHonk(npc, dt) {
  if (!(npc.angryHonkIn > 0)) return;
  npc.angryHonkIn -= dt;
  if (npc.angryHonkIn <= 0) {
    playHornSound(npc.pos.x, npc.hornPitch, true);
    pedestriansNotice(npc.pos.x, npc.pos.y, "honk");
    npc.lastAngryHonk = gameTime;
  }
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
  // Ticks before the dazed early return below -- a rammed car is almost
  // always dazed.
  tickAngryHonk(npc, dt);
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
  for (const p of trafficPoints(npc)) {
    const dx = p.x - npc.pos.x, dy = p.y - npc.pos.y;
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

  // Stopped for too long -- wedged against something (a campsite rig, the curb), or
  // waiting on a car that isn't moving out of the way: back up for a moment,
  // then try again on a different line. Waiting behind a car gets more
  // patience than being wedged.
  const speed = speedOf(npc);
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
// Caravans (a physics playground: on this branch every player tows one)
// ---------------------------------------------------------------------------
// The caravan's only wheels are one axle, which rolls along the caravan but
// not sideways, so the caravan simply follows its hitch: each step the axle
// is pulled (or, reversing, pushed) along the line toward the hitch's new
// position, keeping its distance (updateCaravan). That one rule gives both
// behaviors for free:
// - forward, the caravan trails behind and straightens itself out
// - reversing, any angle between car and caravan GROWS -- the famous
//   instability, so you have to steer the "wrong" way to aim the caravan
// Past CARAVAN.jackknife the car's rear corner meets the drawbar: the angle
// stops there (with a crunch), and the caravan gets dragged round with it.
//
// Collisions (resolveCaravanCollisions): the caravan's two circles collide
// with walls, the curb, the campsite's rigs and every other car. A push along the drawbar
// shoves the whole rig (car included, and it stops the car's motion into the
// obstacle); a push across it swivels the caravan about the hitch.
//
// The caravan adds load: less power and a lower top speed (stepCar).

const CARAVAN = {
  hitchBack: CAR.length / 2 + 4, // the hitch ball sits this far behind the car's center
  tongue: 18, // drawbar: hitch to the front of the body
  length: 52,
  width: 26, // a bit wider than the car, like the real thing
  axleBack: 48, // hitch to axle: a little behind the body's middle (44), for nose weight
  radius: 13, // collision circles (two, filling the body)
  // The most the caravan can swing relative to the car: ~69 deg, where the
  // body's front corner meets the car's rear corner (with this drawbar).
  jackknife: 1.2,
  unjamSteer: 0.5, // fraction of full lock, turned the right way, that lets a jackknifed rig reverse
};
CARAVAN.circles = [CARAVAN.tongue + CARAVAN.radius, CARAVAN.tongue + CARAVAN.length - CARAVAN.radius]; // px behind the hitch
const CARAVAN_POWER = 0.75; // engine and reverse power while towing
const CARAVAN_TOP_SPEED = 0.8; // top speed while towing

// Everything a driver should brake for, as points: every car's center,
// plus both circles of any caravan (traffic used to see only cars, and drove
// straight into caravans). `except` is the driver itself.
function trafficPoints(except) {
  const pts = [];
  for (const c of [car1, car2, ...npcs, ...parkers]) {
    if (c === except) continue;
    pts.push(c.pos);
    if (c.caravan) for (const s of CARAVAN.circles) pts.push(caravanPoint(c, s));
  }
  return pts;
}

function hitchPoint(car) {
  return { x: car.pos.x - Math.cos(car.angle) * CARAVAN.hitchBack, y: car.pos.y - Math.sin(car.angle) * CARAVAN.hitchBack };
}

// The point `s` px behind the hitch, along the caravan.
function caravanPoint(car, s) {
  const h = hitchPoint(car), a = car.caravan.angle;
  return { x: h.x - Math.cos(a) * s, y: h.y - Math.sin(a) * s };
}

function attachCaravan(car) {
  car.caravan = { angle: car.angle, axle: null, seed: Math.random() * 1000, jackknifed: false, dents: [] };
  placeCaravanAxle(car);
}

// Puts the axle where the caravan's angle says it is (after the angle was
// set directly, or the whole rig was moved).
function placeCaravanAxle(car) {
  car.caravan.axle = caravanPoint(car, CARAVAN.axleBack);
}

function updateCaravan(car) {
  const cv = car.caravan;
  const aim = () => {
    const h = hitchPoint(car);
    return Math.atan2(h.y - cv.axle.y, h.x - cv.axle.x);
  };
  cv.angle = aim();
  // Jammed: folded to the limit and reversing deeper into it. The car's rear
  // corner is against the drawbar and the caravan's wheels can't slide
  // sideways, so the rig locks up -- undo this step's move and stop the car.
  // Driving forward gets out, and so does reversing with the front wheels
  // turned well over the right way: at the limit, full lock swings the car
  // round toward the caravan just faster than reversing folds it, so a real
  // rig creeps out of the fold. (The bicycle model can't show that by itself
  // from a standstill: its tires barely grip sideways at crawl speed, see
  // lowSpeedGripRef, so the car slides straight back instead of swinging.
  // Hence the explicit rule.) Clamping alone, with no jam, let the car
  // reverse on regardless, dragging the caravan sideways.
  const hitchAngle = wrapAngle(cv.angle - car.angle);
  const reversing = car.vel.x * Math.cos(car.angle) + car.vel.y * Math.sin(car.angle) < 0;
  // reversing, the car swings toward the caravan's side when the wheels turn
  // away from it: steer opposite in sign to the hitch angle
  const steeringOut = car.steerCurrent * Math.sign(hitchAngle) < -CARAVAN.unjamSteer * CAR.maxSteer;
  if (reversing && !steeringOut && Math.abs(hitchAngle) > CARAVAN.jackknife && car.prevPos) {
    car.pos.x = car.prevPos.x;
    car.pos.y = car.prevPos.y;
    car.angle = car.prevAngle;
    car.vel.x = car.vel.y = 0;
    car.angularVel = 0;
    cv.angle = aim();
    // keep the contact "touching" while jammed, so the crunch plays once
    collisionSound(0, hitchPoint(car).x, car, isNewTouch(car, "jackknife"));
  }
  clampJackknife(car);
  placeCaravanAxle(car);
}

// The car's rear corner meets the drawbar: the hitch angle can't go further.
function clampJackknife(car) {
  const cv = car.caravan;
  const hitchAngle = wrapAngle(cv.angle - car.angle);
  const over = Math.abs(hitchAngle) > CARAVAN.jackknife;
  if (over) {
    cv.angle = car.angle + Math.sign(hitchAngle) * CARAVAN.jackknife;
    if (!cv.jackknifed) {
      const h = hitchPoint(car);
      collisionSound(Math.max(HIT_SOUND_MIN, speedOf(car)), h.x, car, isNewTouch(car, "jackknife"));
    }
  }
  cv.jackknifed = over;
}

// Applies a push `p` (world px) that a collision gave the caravan circle `s`
// px behind the hitch. The part across the caravan swivels it about the
// hitch; the part along it moves the whole rig. `dv` is the velocity change
// the collision gave the circle: its along-the-caravan part goes to the car.
function pushCaravan(car, s, p, dv) {
  const cv = car.caravan;
  const tx = Math.cos(cv.angle), ty = Math.sin(cv.angle);
  const along = p.x * tx + p.y * ty;
  // d(point)/d(angle) for a point s behind the hitch is s * (sin a, -cos a)
  cv.angle += (p.x * ty - p.y * tx) / s;
  car.pos.x += tx * along;
  car.pos.y += ty * along;
  const dvAlong = dv.x * tx + dv.y * ty;
  car.vel.x += tx * dvAlong;
  car.vel.y += ty * dvAlong;
  clampJackknife(car);
  placeCaravanAxle(car);
}

function resolveCaravanCollisions(car) {
  const r = CARAVAN.radius;
  for (const s of CARAVAN.circles) {
    // walls and curb: clamp the circle inside, bounce what was going out
    const c = caravanPoint(car, s);
    const push = { x: 0, y: 0 };
    if (c.x - r < 0) push.x = r - c.x;
    else if (c.x + r > W) push.x = W - r - c.x;
    if (c.y - r < 0) push.y = r - c.y;
    else if (c.y + r > street.curbY) push.y = street.curbY - r - c.y;
    if (push.x || push.y) {
      const n = Math.hypot(push.x, push.y), nx = push.x / n, ny = push.y / n;
      const vn = car.vel.x * nx + car.vel.y * ny; // < 0: heading into it
      const dv = vn < 0 ? { x: -1.4 * vn * nx, y: -1.4 * vn * ny } : { x: 0, y: 0 };
      pushCaravan(car, s, push, dv);
      const at = { x: c.x - nx * r, y: c.y - ny * r };
      dentCaravan(car, Math.max(0, -vn), at);
      caravanHitSound(car, Math.max(0, -vn), at, push.y < 0 ? "curb" : "wall");
    }

    // the campsite's parked rigs: static circles
    for (const cr of campsite.circles) {
      const cc = caravanPoint(car, s), before = { x: cc.x, y: cc.y };
      const v = { x: car.vel.x, y: car.vel.y };
      const hit = resolveCircles(cc, v, r, { x: cr.x, y: cr.y }, null, cr.r, true, CAR.obstacleCollisionRestitution);
      if (hit < 0) continue;
      pushCaravan(car, s, { x: cc.x - before.x, y: cc.y - before.y }, { x: v.x - car.vel.x, y: v.y - car.vel.y });
      dentCaravan(car, hit, contactPoint(cc, cr, r));
      caravanHitSound(car, hit, cc, cr.key);
    }

    // every other car's capsule, and the other player's caravan
    for (const other of [car1, car2, ...npcs, ...parkers]) {
      if (other === car) continue;
      const targets = capsuleOffsets(other.angle).map((o) => ({ x: other.pos.x + o.x, y: other.pos.y + o.y, r: CAR.capsuleRadius, s: null }));
      if (other.caravan) for (const os of CARAVAN.circles) targets.push({ ...caravanPoint(other, os), r, s: os });
      for (const t of targets) {
        const cc = caravanPoint(car, s), before = { x: cc.x, y: cc.y };
        const tb = { x: t.x, y: t.y };
        const v = { x: car.vel.x, y: car.vel.y };
        const ov = { x: other.vel.x, y: other.vel.y };
        // a parked car doesn't budge for a gentle bump (see resolveCarVsCar)
        const anchored = other.handbrake && Math.hypot(v.x - ov.x, v.y - ov.y) < DAMAGE_THRESHOLD;
        const hit = resolveCircles(cc, v, r, tb, ov, t.r, anchored, CAR.obstacleCollisionRestitution);
        if (hit < 0) continue;
        pushCaravan(car, s, { x: cc.x - before.x, y: cc.y - before.y }, { x: v.x - car.vel.x, y: v.y - car.vel.y });
        if (!anchored) {
          const op = { x: tb.x - t.x, y: tb.y - t.y }, odv = { x: ov.x - other.vel.x, y: ov.y - other.vel.y };
          if (t.s !== null) pushCaravan(other, t.s, op, odv);
          else {
            other.pos.x += op.x; other.pos.y += op.y;
            other.vel.x += odv.x; other.vel.y += odv.y;
          }
        }
        // both sides of the hit get a dent: this caravan, and the other car or caravan
        dentCaravan(car, hit, contactPoint(cc, tb, r));
        if (t.s !== null) dentCaravan(other, hit, contactPoint(tb, cc, t.r));
        else applyDamage(other, hit, contactPoint(tb, cc, t.r));
        caravanHitSound(car, hit, cc, other);
        if (hit >= HIT_SOUND_MIN && other.drive && !other.handbrake) npcGotRammed(other);
      }
    }
  }
}

// A hit on the caravan above DAMAGE_THRESHOLD leaves a dent where it landed,
// like applyDamage does on cars: stored in the caravan's own frame (centered
// on the body, +x toward the hitch) so it moves with it, clamped onto the
// body, bigger for harder hits. Looks only: the caravan has no health.
function dentCaravan(car, speed, at) {
  const excess = speed - DAMAGE_THRESHOLD;
  if (excess <= 0) return;
  const cv = car.caravan, L = CARAVAN.length, Wd = CARAVAN.width;
  const mid = caravanPoint(car, CARAVAN.tongue + L / 2);
  const dx = at.x - mid.x, dy = at.y - mid.y, cos = Math.cos(cv.angle), sin = Math.sin(cv.angle);
  cv.dents.push({
    x: clamp(dx * cos + dy * sin, -L / 2, L / 2),
    y: clamp(-dx * sin + dy * cos, -Wd / 2, Wd / 2),
    r: clamp(4 + excess / 35, 4, 10),
  });
  if (cv.dents.length > MAX_DENTS) cv.dents.shift();
}

function caravanHitSound(car, speed, at, key) {
  collisionSound(speed, at.x, car, isNewTouch(car, key));
  if (speed >= HIT_SOUND_MIN) pedestriansNotice(at.x, at.y, "crash", speed);
}

// ---------------------------------------------------------------------------
// Parked cars (NPCs that come and go)
// ---------------------------------------------------------------------------
// The cars along the curb are real cars (`parkers`), not scenery: they run
// through stepCar and every collision like any other car, so they can be
// shoved out of place. Each is in one of three states:
// - "parked": handbrake on (stepCar bleeds off any push quickly), no input,
//   and no smoke however dented (emitSmoke skips handbraked cars)
// - "leaving": backs up a touch, pulls out into street.parkLaneY and drives
//   off the right edge
// - "arriving": rolls in from the left along parkLaneY, then parallel parks
//   into its reserved bay with the autopilot's parking routine (apPark), so
//   it's exactly as clumsy at it as an autopilot player
// Traffic on parkLaneY only ever flows right, the way the parked cars face.
//
// The planner (updateParkers) keeps PARK_MIN_FREE..PARK_MAX_FREE bays free
// (empty of parked cars -- players only stop briefly), and otherwise churns
// the row now and then: a car leaves, or a new one arrives. At most one car
// is leaving and one arriving at a time, so the lane never jams.

const PARK_MIN_FREE = 1, PARK_MAX_FREE = 3;
const PARK_START_FREE = 2; // free bays when the game starts (one roomy, one tight)
const PARK_EVENT_MEAN = 45; // s between random comings and goings (Poisson); it was 12, which kept a car moving in the row most of the time
const PARK_EVENT_GAP = 10; // s, at least this long between any two events
const PARKER_CRUISE = 130; // px/s along the lane
const PARKER_ARRIVE_TIMEOUT = 60; // s to get parked before giving up and driving off
const HANDBRAKE_DECEL = 900; // px/s^2, how fast a parked car stops sliding after a shove

let parkers = [];
let parkEventTimer = 0; // counts down to the next random coming or going
let parkSinceEvent = 0; // s since the last one, see PARK_EVENT_GAP

function makeParker(x, y) {
  const car = createCar(x, y, 0, pickOf(PARKED_COLORS), null);
  car.ap = makeAutopilot();
  car.drive = car.ap.drive; // readInput returns car.drive, which apPark etc. fill in
  car.hornPitch = 0.85 + Math.random() * 0.33;
  car.blockedTime = 0;
  car.nextHonkAt = NPC_HONK_DELAY;
  car.state = "parked";
  car.handbrake = true;
  car.phase = null;
  car.phaseT = 0;
  car.t = 0;
  car.bay = null;
  return car;
}

// Two free bays side by side merge into one long gap, which is no choice at
// all -- so bays next to a free one are the last resort for freeing up.
function nextToFree(bay, free) {
  const i = street.bays.indexOf(bay);
  return [street.bays[i - 1], street.bays[i + 1]].some((b) => b && free.includes(b));
}

// Fills the row, leaving PARK_START_FREE bays free: a roomy one and a tight
// one apart from it, if there are both, so the very first park is already a
// choice.
function resetParkers() {
  parkers.length = 0;
  const free = [];
  const inner = street.bays.filter((b) => !b.end);
  const pick = (bays) => {
    const apart = bays.filter((b) => !free.includes(b) && !nextToFree(b, free));
    const open = bays.filter((b) => !free.includes(b));
    if (open.length) free.push(pickOf(apart.length ? apart : open));
  };
  pick(inner.filter((b) => b.roomy));
  pick(inner.filter((b) => !b.roomy));
  while (free.length < Math.min(PARK_START_FREE, inner.length)) pick(inner);
  for (const bay of street.bays) {
    bay.reservedBy = null;
    if (!free.includes(bay)) parkers.push(makeParker((bay.x0 + bay.x1) / 2, street.carCenterY));
  }
  parkEventTimer = Math.random() * PARK_EVENT_MEAN;
  parkSinceEvent = 0;
}

function parkerSetState(car, state, phase) {
  car.state = state;
  car.phase = phase;
  car.phaseT = 0;
  car.t = 0;
  car.handbrake = state === "parked";
  car.drive.throttle = car.drive.steer = 0;
  if (state !== "arriving" && car.bay) {
    if (car.bay.reservedBy === car) car.bay.reservedBy = null;
    car.bay = null;
  }
}

// The kind of bay (true = roomy) there's no free one of right now, or null
// if there's a choice of both. Comings and goings lean toward fixing that.
function missingFreeKind() {
  const free = unclaimedBays();
  if (!free.some((b) => b.roomy)) return true;
  if (!free.some((b) => !b.roomy)) return false;
  return null;
}

function bayAt(x) {
  return street.bays.find((b) => x > b.x0 && x < b.x1) || null;
}

// A parked car pulls out and drives off. Cars in the end bays stay put.
// Preferably one from the missing kind of bay (if any), and not next to a
// free bay; each preference is dropped if nobody fits it.
function parkerDepart() {
  const parked = parkers.filter((c) => {
    const bay = bayAt(c.pos.x);
    return c.state === "parked" && !(bay && bay.end);
  });
  if (!parked.length) return false;
  const kind = missingFreeKind(), free = unclaimedBays();
  let pool = parked;
  const narrow = (keep) => {
    const kept = pool.filter((c) => {
      const bay = bayAt(c.pos.x);
      return bay && keep(bay);
    });
    if (kept.length) pool = kept;
  };
  if (kind !== null) narrow((bay) => bay.roomy === kind);
  narrow((bay) => !nextToFree(bay, free));
  parkerSetState(pickOf(pool), "leaving", "backup");
  return true;
}

// Where an arriving car heads: a free bay of whichever kind has more free,
// so it doesn't take the last roomy (or last tight) one when it can help it.
function parkerPickBay(bays) {
  const roomy = bays.filter((b) => b.roomy), tight = bays.filter((b) => !b.roomy);
  if (roomy.length > tight.length) return pickOf(roomy);
  if (tight.length > roomy.length) return pickOf(tight);
  return pickOf(bays);
}

// A new car rolls in from the left edge, heading for a free bay.
function parkerArrive() {
  const bays = unclaimedBays();
  const x = -CAR.length, y = street.parkLaneY;
  const clear = trafficPoints(null).every((p) => Math.hypot(p.x - x, p.y - y) > CAR.length * 2.5);
  if (!bays.length || !clear) return false;
  const car = makeParker(x, y);
  car.vel.x = PARKER_CRUISE;
  parkerSetState(car, "arriving", "cruise");
  car.bay = parkerPickBay(bays);
  car.bay.reservedBy = car;
  parkers.push(car);
  return true;
}

function updateParkers(dt) {
  // The planner. First, the caravan space: clearing it comes before
  // anything else, one car at a time.
  parkEventTimer -= dt;
  parkSinceEvent += dt;
  updateCaravanSpace();
  const blocker = parkerInCaravanSpace();
  if (blocker && !parkers.some((c) => c.state === "leaving")) {
    parkerSetState(blocker, "leaving", "backup");
    parkSinceEvent = 0;
  }
  // Then keep the free-bay count in range, and churn it now and then.
  // Players don't count here: they park for a moment and drive off again, so
  // sending a car away every time one takes the last free bay just churned
  // the row (a parked car stayed only ~1 minute with autopilot players).
  const free = street.bays.filter((bay) => !bay.end && !bay.caravanSpace && !bay.reservedBy && !bayOccupied(bay, null, parkers)).length;
  let want = null;
  if (free < PARK_MIN_FREE) want = "leave";
  else if (free > PARK_MAX_FREE) want = "arrive";
  else if (parkEventTimer <= 0) {
    const canLeave = free + 1 <= PARK_MAX_FREE;
    // An arrival mustn't take the last free bay of a kind (one roomy + one
    // tight free): the planner would just send a car away again to restore it.
    const openBays = unclaimedBays();
    const spare = openBays.filter((b) => b.roomy).length >= 2 || openBays.filter((b) => !b.roomy).length >= 2;
    const canArrive = free - 1 >= PARK_MIN_FREE && (spare || missingFreeKind() !== null);
    // no roomy (or no tight) bay free: a car leaving can bring the choice back
    const leaveFirst = canLeave && missingFreeKind() !== null;
    want = leaveFirst ? "leave" : canLeave && canArrive ? pickOf(["leave", "arrive"]) : canLeave ? "leave" : canArrive ? "arrive" : null;
    if (!want) parkEventTimer = PARK_EVENT_MEAN; // nothing fits right now; roll again later
  }
  if (want && parkSinceEvent >= PARK_EVENT_GAP) {
    const busy = parkers.some((c) => c.state === (want === "leave" ? "leaving" : "arriving"));
    if (!busy && (want === "leave" ? parkerDepart() : parkerArrive())) {
      parkSinceEvent = 0;
      parkEventTimer = -Math.log(1 - Math.random()) * PARK_EVENT_MEAN;
    }
  }

  for (let i = parkers.length - 1; i >= 0; i--) {
    const car = parkers[i];
    const off = car.pos.x < -CAR.length * 3 || car.pos.x > W + CAR.length * 2 || car.pos.y < -CAR.length || car.pos.y > H + CAR.length;
    if (off && car.state !== "arriving") {
      parkerSetState(car, "gone", null);
      parkers.splice(i, 1);
      continue;
    }
    car.phaseT += dt;
    car.t += dt;
    tickAngryHonk(car, dt);
    if (car.state === "arriving") parkerArriving(car, dt);
    else if (car.state === "leaving") parkerLeaving(car, dt);
    else car.angryHonkIn = 0; // nobody's in a parked car to honk
  }
}

function parkerArriving(car, dt) {
  const ap = car.ap;
  ap.wobblePhase += dt * (1.3 + ap.sloppy);
  if (ap.reverseTime > 0) ap.reverseTime -= dt;

  // Someone else took the bay (or the street was rebuilt): pick another free
  // one, or give up and drive off.
  if (!street.bays.includes(car.bay) || bayOccupied(car.bay, car) || car.bay.caravanSpace || car.t > PARKER_ARRIVE_TIMEOUT) {
    if (car.bay && car.bay.reservedBy === car) car.bay.reservedBy = null;
    const bays = car.t > PARKER_ARRIVE_TIMEOUT ? [] : unclaimedBays();
    if (!bays.length) {
      parkerSetState(car, "leaving", "drive");
      return;
    }
    car.bay = parkerPickBay(bays);
    car.bay.reservedBy = car;
    ap.park = null;
    car.phase = "cruise";
  }

  if (car.phase === "cruise") {
    // roll along the lane until level with the spot, then park like the autopilot
    parkerDriveLane(car, PARKER_CRUISE, dt);
    if (car.pos.x > car.bay.x0 - 220) {
      apStartPark(car, ap, car.bay, "line");
      car.phase = "park";
    }
  } else {
    apPark(car, ap, dt);
    if (isParked(car)) parkerSetState(car, "parked", null);
  }
}

function parkerLeaving(car, dt) {
  const speed = speedOf(car);
  if (car.phase === "backup") {
    // back up a touch to get room to swing out
    car.drive.throttle = apThrottleFor(car, -15);
    car.drive.steer = 0;
    if (car.phaseT > 0.8 || (car.phaseT > 0.3 && speed < 2)) {
      car.phase = "pullout";
      car.phaseT = 0;
    }
  } else if (car.phase === "pullout") {
    car.drive.throttle = apThrottleFor(car, 35);
    car.drive.steer = apSteerAt(car, car.pos.x + 70, street.parkLaneY);
    if (car.pos.y < street.parkLaneY + 10) {
      car.phase = "drive";
      car.phaseT = 0;
    } else if (car.phaseT > 1.5 && speed < 3) {
      car.phase = "backup"; // wedged against the car in front: back up and try again
      car.phaseT = 0;
    }
  } else {
    parkerDriveLane(car, PARKER_CRUISE, dt);
  }
}

// Follow parkLaneY rightward at `speed`, braking (and honking) for anything
// in the way.
function parkerDriveLane(car, speed, dt) {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  const blocked = trafficPoints(car).some((p) => {
    const dx = p.x - car.pos.x, dy = p.y - car.pos.y;
    const ahead = dx * fx + dy * fy;
    return ahead > 0 && ahead < 70 && Math.abs(dy * fx - dx * fy) < CAR.width + 4;
  });
  car.drive.steer = apSteerAt(car, car.pos.x + 90, street.parkLaneY);
  car.drive.throttle = blocked ? apStop(car) : apThrottleFor(car, speed);
  // same horn habits as traffic: after NPC_HONK_DELAY, then every few seconds
  if (!blocked) {
    car.blockedTime = 0;
    car.nextHonkAt = NPC_HONK_DELAY;
    return;
  }
  car.blockedTime += dt;
  if (car.blockedTime >= car.nextHonkAt) {
    playHornSound(car.pos.x, car.hornPitch);
    pedestriansNotice(car.pos.x, car.pos.y, "honk");
    car.nextHonkAt = car.blockedTime + NPC_HONK_REPEAT_MIN + Math.random() * (NPC_HONK_REPEAT_MAX - NPC_HONK_REPEAT_MIN);
  }
}

// ---------------------------------------------------------------------------
// Autopilot (a player car driven by a deliberately bad AI)
// ---------------------------------------------------------------------------
// Each player's HUD button toggles car.autopilot. The AI then plays the game
// for them: chases coins, parallel parks, and visits the garage when badly
// dented. It plays it BADLY on purpose:
// - it drives too fast and steers with a wobble
// - it doesn't always notice a campsite rig or parked car in its path (AP_BLIND_CHANCE)
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
const AP_BLIND_CHANCE = 0.4; // chance of not seeing a campsite rig or parked car in its path, rolled per encounter
const AP_SEEN_RESET = 2.5; // s until obstacles it saw (or missed) get re-rolled
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
    garageAt: 0.35 + Math.random() * 0.35, // damage that sends it to the garage
    wobblePhase: Math.random() * 10,
    seen: new Map(), // obstacle -> did it notice this one
    seenTimer: 0,
    reverseTime: 0, reverseSteer: 0,
    stuckTime: 0, stuckStreak: 0, lastStuckAt: -99,
    park: null, garage: null, harass: null,
  };
}

function toggleAutopilot(car) {
  car.autopilot = !car.autopilot;
  if (car.autopilot) car.ap = makeAutopilot();
  else if (car.towedBack) apEndTow(car); // switched off mid-reverse: back to normal driving
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

// Swerve away from a campsite rig or parked car dead ahead -- if it notices it.
function apAvoid(car, ap, steer) {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  const look = 60 + Math.max(0, apForwardSpeed(car)) * 0.35;
  const obstacles = [...campsite.circles, ...parkers];
  for (const o of obstacles) {
    const ox = o.pos ? o.pos.x : o.x, oy = o.pos ? o.pos.y : o.y;
    // towing, it gives obstacles more room: the caravan cuts inside the turn
    const reach = (o.pos ? CAR.length / 2 : o.r) + CAR.capsuleRadius + (car.caravan ? 14 : 4);
    const dx = ox - car.pos.x, dy = oy - car.pos.y;
    const ahead = dx * fx + dy * fy;
    const side = dy * fx - dx * fy; // > 0: to our right
    if (ahead <= 0 || ahead > look || Math.abs(side) > reach) continue;
    // Not noticing an obstacle is part of the bad-driver charm -- but not while
    // towing: a bump spins the car and throws the caravan to the jackknife
    // limit, so a towing autopilot always sees them.
    if (!ap.seen.has(o)) ap.seen.set(o, car.caravan ? true : Math.random() > AP_BLIND_CHANCE);
    if (!ap.seen.get(o)) continue;
    // Down in the parking lane, swerve out toward the road whichever side
    // the obstacle is on: "away from it" can mean into the curb, wedging the
    // car in the corner between the curb and a parked car.
    if (car.pos.y > street.carCenterY - CAR.width) return Math.cos(car.angle) >= 0 ? -1 : 1;
    return side >= 0 ? -1 : 1;
  }
  return steer;
}

// The campsite is a no-go zone for an autopilot that isn't camping: driving
// straight at a coin beside the campsite took it in among the pitches, where
// it nosed into a free one. The zone is the grass strip grown by
// AP_CAMP_KEEP_OUT, and runs up to the top wall, closing the lane above the
// bushes too. A path through it goes round the bottom corners instead.
// (Coins never land in it: COIN_CAMP_GAP is wider.)
const AP_CAMP_KEEP_OUT = 28; // px round the grass strip
const AP_CAMP_CORNER = 30; // px further out: the waypoints round its corners

// grassOnly: without the tractors, for a camping rig on its way to line up
// beside them.
function campNoGoZone(grassOnly = false) {
  const a = campsite.area, m = AP_CAMP_KEEP_OUT;
  return { x0: a.x0 - m, x1: a.x1 + m, y0: -1e4, y1: (grassOnly ? a.y1 : campBottom()) + m };
}

function inRect(r, x, y) {
  return x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;
}

// Does the segment (ax, ay)-(bx, by) pass through rectangle r? (Liang-Barsky)
function segmentHitsRect(ax, ay, bx, by, r) {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, ax - r.x0], [dx, r.x1 - ax], [-dy, ay - r.y0], [dy, r.y1 - ay]]) {
    if (p === 0) {
      if (q <= 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 >= t1) return false;
    }
  }
  return true;
}

// Where to drive instead of (tx, ty), keeping out of the campsite.
function apKeepOut(car, tx, ty, grassOnly = false) {
  const z = campNoGoZone(grassOnly), x = car.pos.x, y = car.pos.y;
  if (inRect(z, tx, ty)) return { x: tx, y: ty }; // it's meant to be in there
  if (inRect(z, x, y)) {
    // already in it: down out of the pitches, or off the end of the lane
    // above the bushes (which reaches a little into the grass)
    const a = campsite.area;
    if (y > CAMP_TOP + CAMP_BUSH_Y && x > a.x0 && x < a.x1) {
      // a tractor below: along the passage past it first, the way it's
      // facing (towing, it can't turn round in there)
      const t = tractors.find((q) => Math.abs(q.x - x) < TRACTOR.length / 2 + 30 && y < q.y);
      if (t) {
        const way = Math.abs(Math.cos(car.angle)) > 0.3 ? Math.sign(Math.cos(car.angle)) : x < t.x ? -1 : 1;
        return { x: t.x + way * (TRACTOR.length / 2 + 60), y: t.y - TRACTOR.width / 2 - 34 };
      }
      return { x, y: z.y1 + AP_CAMP_CORNER };
    }
    return { x: x < (z.x0 + z.x1) / 2 ? z.x0 - AP_CAMP_CORNER : z.x1 + AP_CAMP_CORNER, y };
  }
  if (!segmentHitsRect(x, y, tx, ty, z)) return { x: tx, y: ty };
  // round one bottom corner, or both, whichever is shorter and clear
  const left = { x: z.x0 - AP_CAMP_CORNER, y: z.y1 + AP_CAMP_CORNER };
  const right = { x: z.x1 + AP_CAMP_CORNER, y: z.y1 + AP_CAMP_CORNER };
  let best = null, bestLen = Infinity;
  for (const route of [[left], [right], [left, right], [right, left]]) {
    const pts = [{ x, y }, ...route, { x: tx, y: ty }];
    let len = 0, clear = true;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (segmentHitsRect(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, z)) clear = false;
    }
    if (clear && len < bestLen) {
      bestLen = len;
      best = route[0];
    }
  }
  return best || { x: tx, y: ty };
}

// Drive toward (tx, ty) at up to `cruise`. Handles its own clumsy
// three-point turns and backing out when wedged, and keeps out of the
// campsite unless it's camping (and on the way to camp, out of its grass:
// keepOutGrass). Returns the distance left to (tx, ty).
function apDriveTo(car, ap, tx, ty, cruise, { avoid = true, keepOutGrass = false } = {}) {
  const dist = Math.hypot(tx - car.pos.x, ty - car.pos.y);
  const camping = ap.goal === "park" && car.gamePhase >= 4;
  const keepOut = !camping || keepOutGrass;
  if (keepOut) ({ x: tx, y: ty } = apKeepOut(car, tx, ty, camping));
  const dx = tx - car.pos.x, dy = ty - car.pos.y;
  let err = wrapAngle(Math.atan2(dy, dx) - car.angle);
  const speed = speedOf(car);
  // Turning round on the curb side of the road: always turn toward the road.
  // Turning the other way points the car into the curb and the parked cars,
  // where it wedges itself in the corner.
  // Likewise below the campsite: turn round downward, into the open lot --
  // turning up took it round the end of the campsite into the top corner.
  // The direction is picked once per turn (ap.turnRound): picked afresh
  // every step, a car pointing straight up flipped between full left and
  // full right lock and drove straight on, into a free pitch.
  // (Cleared once |err| is under 1.8: kept down to 1.2, it outlived the turn
  // whenever the target moved, and turned one car into the campsite's end.)
  if (Math.abs(err) < 1.8) ap.turnRound = 0;
  else if (!ap.turnRound && Math.abs(err) > 2) {
    if (car.pos.y > street.centerlineY) ap.turnRound = Math.cos(car.angle) >= 0 ? -1 : 1;
    else if (car.pos.y < campsite.area.y1 + 160) ap.turnRound = Math.cos(car.angle) >= 0 ? 1 : -1;
  }
  if (ap.turnRound) err = ap.turnRound * Math.PI;
  // Nosed into the pitches anyway: back straight out.
  const a = campsite.area;
  if (keepOut && ap.reverseTime <= 0 && Math.abs(err) > 2 &&
      car.pos.y > CAMP_TOP + CAMP_BUSH_Y && car.pos.y < a.y1 && car.pos.x > a.x0 && car.pos.x < a.x1) {
    ap.reverseTime = 0.8;
    ap.reverseSteer = 0;
  }

  if (ap.reverseTime > 0) {
    // towing, it backs up slowly and steers the caravan straight behind
    ap.drive.throttle = apThrottleFor(car, car.caravan ? -40 : -70);
    ap.drive.steer = car.caravan ? apCaravanReverseSteer(car) : ap.reverseSteer;
    return dist;
  }
  // Target behind and close: back up with opposite lock to swing the nose
  // round. Not with a caravan: that folds it up; it loops round forward.
  if (!car.caravan && Math.abs(err) > 2 && Math.hypot(dx, dy) < 110 && speed < 60) {
    ap.reverseTime = 0.6 + Math.random() * 0.4;
    ap.reverseSteer = err > 0 ? -1 : 1;
  }

  const target = cruise * clamp(1.15 - Math.abs(err) / 1.5, 0.3, 1);
  let steer = clamp(err * AP_STEER_GAIN, -1, 1) + Math.sin(ap.wobblePhase) * AP_WOBBLE * ap.sloppy;
  if (avoid) steer = apAvoid(car, ap, steer);
  ap.drive.throttle = apThrottleFor(car, target);
  ap.drive.steer = apCaravanForwardSteer(car, clamp(steer, -1, 1));
  return dist;
}

// Pushing but not moving (wedged on a campsite rig, a wall, the other car): back
// out with opposite lock and try again on a different line.
function apCheckStuck(car, ap, dt, pushing) {
  const speed = speedOf(car);
  if (ap.reverseTime > 0 || !pushing || speed > 8) {
    ap.stuckTime = 0;
    return;
  }
  ap.stuckTime += dt;
  if (ap.stuckTime > 0.8) {
    ap.stuckTime = 0;
    // Stuck again soon after the last escape: the same short back-up would
    // loop forever, so back out further each time, alternating sides.
    ap.stuckStreak = gameTime - ap.lastStuckAt < 4 ? ap.stuckStreak + 1 : 0;
    ap.lastStuckAt = gameTime;
    ap.reverseTime = Math.min(2.5, 0.7 + Math.random() * 0.6 + ap.stuckStreak * 0.5);
    ap.reverseSteer = (ap.drive.steer >= 0 ? -1 : 1) * (ap.stuckStreak % 2 ? -1 : 1);
    // Towing, it backs straight up much further (it steers the caravan
    // straight behind, so the side doesn't matter), leaving room to turn
    // round forward. Short back-ups left rigs nose-on to the curb or a wall,
    // shuffling in the same spot for minutes. (Backing up on a curve instead
    // backfired: swinging the caravan over first turns the car the wrong way.)
    if (car.caravan) ap.reverseTime = Math.min(4.5, 2.5 + ap.stuckStreak * 0.7);
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

// ---- Towing a caravan -----------------------------------------------------
// Reversing, the caravan swings the opposite way to the steering, and any
// angle grows. So an autopilot reversing with a caravan steers against the
// swing: steer = -gain * (hitch angle - the angle it wants). That holds a
// straight reverse (the caravan tests: never worse than 9 deg from a kink,
// where the other sign jackknifes), and it's also the right way out of a
// jackknife (see updateCaravan's unjam rule). Before this it reversed as if
// there were no caravan, full lock the "natural" way, folding it at once.
const AP_CARAVAN_REVERSE_GAIN = 4;

function apCaravanReverseSteer(car, wantHitch = 0) {
  const hitch = wrapAngle(car.caravan.angle - car.angle);
  return clamp(-AP_CARAVAN_REVERSE_GAIN * (hitch - wantHitch), -1, 1);
}

// Going forward, a tight slow turn folds the caravan too: circling at full
// lock it swings to the jackknife limit and stays there (the first caravan
// parking version orbited its approach point like that, 0 parks in 12).
// So past AP_CARAVAN_MAX_FOLD, steering that would swing it further is eased
// off, all the way to straight by AP_CARAVAN_MAX_FOLD + 0.3, and the caravan
// catches up. (Forward, steering the same sign as the hitch angle closes it.)
const AP_CARAVAN_MAX_FOLD = 0.8; // rad, ~46 deg

function apCaravanForwardSteer(car, steer) {
  if (!car.caravan) return steer;
  const hitch = wrapAngle(car.caravan.angle - car.angle);
  if (Math.abs(hitch) <= AP_CARAVAN_MAX_FOLD || Math.sign(steer) === Math.sign(hitch)) return steer;
  return steer * clamp((AP_CARAVAN_MAX_FOLD + 0.3 - Math.abs(hitch)) / 0.3, 0, 1);
}

// Parking with a caravan: into the caravan space (or else the longest run of
// free bays), always driving in forward, heading right like the parked cars.
// It never needs to reverse: the space is long enough to drive straight in.
// 1. "approach": head for a point well before the space, out on the road
// 2. "line": follow a line AP_CARAVAN_LINE_GAP out from the parked row --
//    chasing a point ahead on it lines the rig up by itself, turning it
//    round in a wide loop if it has to. Past the start of the space, lined
//    up (car and caravan straight, on the line), it goes in; otherwise it
//    goes round again
// 3. "in": chase a point AP_CARAVAN_LOOKAHEAD ahead on the parked row's
//    line -- a smooth merge toward the curb, with the caravan cutting in
//    behind -- and stop a little short of the car ahead
// 4. "check": stopped; if that didn't count, "leave" forward and go round
const AP_CARAVAN_LINE_GAP = 32; // px out from the parked row's line
const AP_CARAVAN_TURN_AT = 0; // px past the start of the space: start easing in
const AP_CARAVAN_LOOKAHEAD = 30; // px ahead on the curb line it steers for
const AP_CARAVAN_IN_SPEED = 35; // px/s easing in
const AP_CARAVAN_STOP_SHORT = 10; // px left before the car ahead: room to pull out again

// The space to park the rig in, as bay bounds {x0, x1}: the caravan space, or
// else the longest run of adjacent free bays.
function apCaravanSpace(car) {
  const b = street.bays;
  const spaces = [...new Set(b.map((bay) => bay.caravanSpace).filter(Boolean))].map((id) => {
    const bays = b.filter((bay) => bay.caravanSpace === id);
    return { id, x0: bays[0].x0, x1: bays[bays.length - 1].x1 };
  });
  if (spaces.length) {
    // stick with the one it picked; else one the other autopilot isn't going for
    const other = car === car1 ? car2 : car1;
    const theirs = other.autopilot && other.ap.cpark ? other.ap.cpark.spaceId : 0;
    const mine = car.ap.cpark && spaces.find((sp) => sp.id === car.ap.cpark.spaceId);
    // Both picked the same one (only one was open yet): P2 moves over to
    // another once there is one, unless it's already driving in. Before
    // this, both stuck with space 1 and jammed each other for good.
    const moveOver = mine && mine.id === theirs && car === car2 && car.ap.cpark.phase !== "in" && spaces.length > 1;
    if (mine && !moveOver) return mine;
    const pick = spaces.find((sp) => sp.id !== theirs) || spaces[0];
    if (car.ap.cpark) car.ap.cpark.spaceId = pick.id;
    return pick;
  }
  let best = null;
  for (let i = 0; i < b.length; i++) {
    if (b[i].end || bayOccupied(b[i])) continue;
    let j = i;
    while (j + 1 < b.length && !b[j + 1].end && !bayOccupied(b[j + 1])) j++;
    if (!best || b[j].x1 - b[i].x0 > best.x1 - best.x0) best = { x0: b[i].x0, x1: b[j].x1 };
    i = j;
  }
  return best;
}

const AP_CARAVAN_TURN_UP = 160; // px above the line: where a rig arriving the wrong way U-turns down onto it

function apParkCaravan(car, ap, dt) {
  if (!ap.cpark) ap.cpark = { phase: "approach", t: 0, spaceId: 0 };
  const space = apCaravanSpace(car);
  if (!space) {
    // nowhere to go yet: circle out on the road
    apDriveTo(car, ap, W / 2, street.npcLaneY - 60, 120);
    return;
  }
  const p = ap.cpark;
  const setPhase = (phase) => { p.phase = phase; p.t = 0; };
  p.t += dt;
  const speed = speedOf(car);
  const lineY = street.carCenterY - AP_CARAVAN_LINE_GAP;
  const a = wrapAngle(car.angle); // 0 = heading right, along the row
  const hitch = wrapAngle(car.caravan.angle - car.angle);
  const front = car.pos.x + CAR.length / 2;
  const stopAt = space.x1 - AP_CARAVAN_STOP_SHORT;

  if (p.phase === "approach") {
    // Coming from the right, it will arrive pointing the wrong way. So it
    // aims higher, AP_CARAVAN_TURN_UP above the line, and U-turns down onto
    // it (see "line"). Arriving at the usual height and U-turning up, away
    // from the curb, left it ~150 px above the line with too little room to
    // come down before the space. It went round and did the same again,
    // forever: both caravan spaces are often at the left end of the row.
    const ax = clamp(space.x0 - 260, 80, W - 80);
    if (p.t <= dt) p.fromRight = car.pos.x > ax + 40;
    const d = apDriveTo(car, ap, ax, lineY - (p.fromRight ? AP_CARAVAN_TURN_UP : 50), 150);
    apCheckStuck(car, ap, dt, ap.drive.throttle !== 0);
    if (d < 90) setPhase("line");
  } else if (p.phase === "line") {
    // Pointing the wrong way (say, arriving from the right), it turns round
    // toward the road, never toward the curb: turning the other way wedged
    // its nose against the parked car at the end of the row. The way to
    // turn is picked once and kept until it's round: picked afresh every
    // step, a rig pointing straight up (cos ~ 0) flipped from full left to
    // full right and back, drove straight on up and stuck at the top wall.
    const err = wrapAngle(Math.atan2(lineY - car.pos.y, 90) - car.angle);
    // Well above the line, it U-turns down onto it instead.
    if (Math.abs(err) <= 1.6) p.turnDir = 0;
    else if (!p.turnDir) p.turnDir = (Math.cos(car.angle) >= 0 ? -1 : 1) * (car.pos.y < lineY - AP_CARAVAN_TURN_UP + 30 ? -1 : 1);
    const steer = p.turnDir ? p.turnDir : apSteerAt(car, car.pos.x + 90, lineY);
    ap.drive.steer = apCaravanForwardSteer(car, steer);
    ap.drive.throttle = apThrottleFor(car, 70);
    apCheckStuck(car, ap, dt, true);
    if (car.pos.x > space.x0 + AP_CARAVAN_TURN_AT) {
      const linedUp = Math.abs(a) < 0.35 && Math.abs(hitch) < 0.3 && Math.abs(car.pos.y - lineY) < 14;
      setPhase(linedUp ? "in" : "leave");
    }
    if (p.t > 20) setPhase("approach");
  } else if (p.phase === "in") {
    ap.drive.steer = apCaravanForwardSteer(car, apSteerAt(car, car.pos.x + AP_CARAVAN_LOOKAHEAD, street.carCenterY + 1));
    const left = stopAt - front;
    ap.drive.throttle = left > 2 ? apThrottleFor(car, Math.min(AP_CARAVAN_IN_SPEED, 6 + left)) : apStop(car);
    if ((left <= 2 && speed < 2) || (p.t > 0.6 && speed < 2) || p.t > 12) setPhase("check");
  } else if (p.phase === "check") {
    ap.drive.throttle = apStop(car);
    ap.drive.steer = 0;
    // still not counted as parked after a moment (the coin race would have
    // moved it on): pull out and go round again
    if (p.t > 0.8) setPhase("leave");
  } else if (p.phase === "leave") {
    // pull out forward, then loop back round to the start
    ap.drive.throttle = apThrottleFor(car, 70);
    ap.drive.steer = apCaravanForwardSteer(car, apSteerAt(car, car.pos.x + 90, lineY - 50));
    apCheckStuck(car, ap, dt, true);
    if (p.t > 2.5) setPhase("approach");
  }
}

// ---- Phase 4: reversing into a campsite pitch ------------------------------
// Steering a real reverse into a slot is a control problem; this cheats,
// deliberately (the user's idea: "let the caravan pull the car"). The
// autopilot drives normally to line up -- along the aisle below the
// campsite toward the pitch (from whichever side it's on), until the
// caravan's axle is about a turning radius past it. Then the reverse itself
// is scripted (car.towedBack):
// - the caravan's axle is moved along a planned path: a quarter circle from
//   the aisle round into the pitch, then straight back to where a parked
//   caravan's axle sits (apCampTowPath)
// - the car is dragged behind the caravan's hitch by the same follow-the-
//   hitch rule a caravan normally uses to follow a car. A towed thing
//   trailing behind is stable, so the car follows smoothly, and it reads as
//   a real reverse-in; its front wheels are turned to match its actual
//   curve (from its yaw rate and speed)
// While towed back, the car skips stepCar and the caravan skips its own
// update and collisions (update); other cars still collide with the car.
// If anyone comes within AP_CAMP_CLEARANCE it waits; blocked for
// AP_CAMP_WAIT_MAX, or lined up badly, it drives off and comes round again.
const AP_CAMP_LINE_GAP = 36; // px below the pitches' opening: the line it lines up along
const AP_CAMP_ARC_R = 70; // px: the quarter circle the caravan's axle backs round
const AP_CAMP_TURN_DROP = 90; // px below the line: where it arrives to line up, with room to U-turn either way
const AP_CAMP_ARC_MIN = 45, AP_CAMP_ARC_MAX = 110; // px: stopped outside these, it goes round again
const AP_CAMP_REVERSE_SPEED = 30; // px/s along the path
const AP_CAMP_CLEARANCE = 36; // px: anyone this close to the rig makes it wait
const AP_CAMP_WAIT_MAX = 4; // s

// Is another player (car or caravan) in this pitch?
function pitchTaken(p, except) {
  return [car1, car2].some((c) => {
    if (c === except) return false;
    const pts = [c.pos];
    if (c.caravan) pts.push(caravanPoint(c, CARAVAN.tongue + CARAVAN.length / 2));
    return pts.some((q) => q.x > p.x0 && q.x < p.x1 && q.y > p.y0 && q.y < p.y1 + 10);
  });
}

// Where a parked caravan's axle sits in pitch p: car front just inside the
// opening, as buildCampsite parks the rigs.
function campAxleY(p) {
  return p.y1 - 6 - CAR.length / 2 - CARAVAN.hitchBack - CARAVAN.axleBack;
}

// The caravan axle's path from (ax, ay) into pitch p, for a rig that lined
// up heading dir (+1 right, -1 left): a quarter circle of radius
// R = (ax - cx) * dir round to straight up, then straight back. at(s) gives
// the point and the direction of travel s px along it.
function apCampTowPath(ax, ay, p, dir) {
  const cx = (p.x0 + p.x1) / 2, R = (ax - cx) * dir, arc = (R * Math.PI) / 2;
  const straight = ay - R - campAxleY(p);
  if (R < AP_CAMP_ARC_MIN || R > AP_CAMP_ARC_MAX || straight < 0) return null;
  return {
    length: arc + straight,
    at(s) {
      if (s <= arc) {
        const phi = Math.PI / 2 + s / R;
        return { x: ax + dir * R * Math.cos(phi), y: ay - R + R * Math.sin(phi), dx: -dir * Math.sin(phi), dy: Math.cos(phi) };
      }
      return { x: cx, y: ay - R - (s - arc), dx: 0, dy: -1 };
    },
  };
}

// One step of the scripted reverse: the caravan moves along the path, and
// pulls the car. Returns true when it's there.
function apCampTowStep(car, t, dt) {
  const cv = car.caravan;
  t.s = Math.min(t.path.length, t.s + AP_CAMP_REVERSE_SPEED * dt);
  const p = t.path.at(t.s);
  cv.angle = Math.atan2(-p.dy, -p.dx); // the caravan points back toward the car, against the way it's going
  cv.axle = { x: p.x, y: p.y };
  const hx = p.x + Math.cos(cv.angle) * CARAVAN.axleBack, hy = p.y + Math.sin(cv.angle) * CARAVAN.axleBack;
  // the car follows its hitch, like a caravan follows a car
  const dx = car.pos.x - hx, dy = car.pos.y - hy, d = Math.hypot(dx, dy) || 1;
  const before = { x: car.pos.x, y: car.pos.y, a: car.angle };
  car.angle = Math.atan2(dy, dx);
  car.pos.x = hx + (dx / d) * CARAVAN.hitchBack;
  car.pos.y = hy + (dy / d) * CARAVAN.hitchBack;
  car.vel.x = (car.pos.x - before.x) / dt;
  car.vel.y = (car.pos.y - before.y) / dt;
  car.angularVel = wrapAngle(car.angle - before.a) / dt;
  // front wheels to match the curve: reversing at speed v, yaw rate w means
  // a steering angle of atan(w * wheelBase / -v)
  const v = Math.max(1, Math.hypot(car.vel.x, car.vel.y));
  car.steerCurrent = clamp(Math.atan((car.angularVel * CAR.wheelBase) / -v), -CAR.maxSteer * 1.15, CAR.maxSteer * 1.15);
  return t.s >= t.path.length;
}

// Where a reverse into pitch works: the stretch of aisle it lines up in (the
// caravan's axle stops AP_CAMP_ARC_R past the pitch, the car beyond that)
// plus what it sweeps backing in.
function campZone(pitch, dir) {
  const cx = (pitch.x0 + pitch.x1) / 2, far = cx + dir * 210;
  return { x0: Math.min(cx - 40, far), x1: Math.max(cx + 40, far), y0: pitch.y1 - 20, y1: pitch.y1 + AP_CAMP_LINE_GAP + 40 };
}

// Should it hold back? If the other player's rig is in its zone -- or, for
// two autopilots whose zones overlap, if the other is already reversing in
// (or lining up, and P1 goes first). Two autopilots lining up along the same
// stretch of aisle blocked each other's reverse, gave up, went round and met
// again, for minutes; a first, cruder rule (anyone within 260 px of the
// pitch) made one of them wait out the other's every park, even at a
// different pitch.
function campAisleBusy(car, pitch, dir) {
  const other = car === car1 ? car2 : car1;
  const mine = campZone(pitch, dir);
  const oc = other.autopilot && other.ap.camp;
  if (oc && oc.pitch && (oc.phase === "line" || oc.phase === "tow")) {
    const theirs = campZone(oc.pitch, oc.dir);
    const overlap = mine.x0 < theirs.x1 && theirs.x0 < mine.x1;
    if (overlap && (other.towedBack || (oc.phase === "line" && car === car2))) return true;
  }
  const pts = [other.pos];
  if (other.caravan) for (const cs of CARAVAN.circles) pts.push(caravanPoint(other, cs));
  return pts.some((q) => q.x > mine.x0 - 20 && q.x < mine.x1 + 20 && q.y > mine.y0 && q.y < mine.y1 + 20);
}

function apEndTow(car) {
  car.towedBack = false;
  car.vel.x = car.vel.y = 0;
  car.angularVel = 0;
}

function apParkCamp(car, ap, dt) {
  if (!ap.camp) ap.camp = { phase: "approach", t: 0, pitch: null, tow: null, wait: 0, dir: 1, side: 0 };
  const p = ap.camp;
  const setPhase = (phase) => {
    p.phase = phase;
    p.t = 0;
    p.wait = 0;
    if (phase === "approach") p.side = 0; // decided afresh on the way in, then kept
  };
  p.t += dt;
  // A free pitch nobody else is in, the nearest one -- but not the one the
  // other autopilot is going for, if there's a choice: both heading for the
  // same pitch, they kept giving way to each other at the same spot.
  const other = car === car1 ? car2 : car1;
  const theirs = other.autopilot && other.ap.camp ? other.ap.camp.pitch : null;
  if (!p.pitch || (p.phase !== "tow" && (pitchTaken(p.pitch, car) || (p.pitch === theirs && car === car2)))) {
    let open = freePitches().filter((q) => !pitchTaken(q, car));
    if (open.length > 1) open = open.filter((q) => q !== theirs);
    p.pitch = open.sort((a, b) => Math.abs((a.x0 + a.x1) / 2 - car.pos.x) - Math.abs((b.x0 + b.x1) / 2 - car.pos.x))[0] || null;
    if (!p.pitch) {
      apDriveTo(car, ap, W / 2, campsite.area.y1 + 120, 120); // both taken: circle below and wait
      return;
    }
    if (p.phase !== "approach") setPhase("approach");
  }
  const pitch = p.pitch, cx = (pitch.x0 + pitch.x1) / 2;
  const lineY = pitch.y1 + AP_CAMP_LINE_GAP;
  const hitch = wrapAngle(car.caravan.angle - car.angle);
  const axle = car.caravan.axle;
  const towardPitch = Math.cos(car.angle) * p.dir; // 1: heading straight along the line toward (and past) the pitch

  if (p.phase === "approach") {
    // to the line, on whichever side of the pitch it's on; it will line up
    // heading toward the pitch (dir), and reverse round from past it
    // Decided once per attempt: recomputing it every step flipped the target
    // back and forth as it looped round past the pitch.
    // From the side away from the other tractor, if it's close: lining up
    // past it, the rig hit it.
    if (!p.side) {
      p.side = car.pos.x < cx ? -1 : 1;
      if (tractors.some((t) => t.pitch !== pitch && (t.x - cx) * p.side > 0 && Math.abs(t.x - cx) < 320)) p.side = -p.side;
    }
    const side = p.side;
    p.dir = -side;
    // (well clear of the side walls: a rig that overshot into one wedged there for minutes)
    // (further out with a tractor in front: room to climb onto the line before it)
    const out = tractors.length ? 320 : 240;
    const d = apDriveTo(car, ap, clamp(cx + side * out, 170, W - 170), lineY + AP_CAMP_TURN_DROP, 130, { keepOutGrass: true });
    apCheckStuck(car, ap, dt, ap.drive.throttle !== 0);
    if (d < 70) setPhase(campAisleBusy(car, pitch, p.dir) ? "hold" : Math.cos(car.angle) * p.dir > 0.3 ? "line" : "turn");
  } else if (p.phase === "hold") {
    // the aisle is busy: wait out of the way, below it
    const d = apDriveTo(car, ap, clamp(cx - p.dir * 240, 170, W - 170), lineY + AP_CAMP_TURN_DROP + 60, 100, { keepOutGrass: true });
    if (d < 40) {
      ap.drive.throttle = apStop(car);
      ap.drive.steer = 0;
    }
    apCheckStuck(car, ap, dt, ap.drive.throttle !== 0);
    p.wait = campAisleBusy(car, pitch, p.dir) ? 0 : p.wait + dt;
    if (p.wait > 1) {
      p.wait = 0;
      setPhase("approach");
    }
  } else if (p.phase === "turn") {
    // Facing away from the pitch: one wide U-turn in the open lot, the short
    // way round -- unless that swings it up into the campsite, then the long
    // way. (Always turning downward looped two thirds of a circle onto the
    // road whenever it happened to be facing up.)
    const err = wrapAngle((p.dir > 0 ? 0 : Math.PI) - car.angle);
    const toUp = wrapAngle(-Math.PI / 2 - car.angle);
    const shortPassesUp = Math.sign(toUp) === Math.sign(err) && Math.abs(toUp) < Math.abs(err);
    const way = shortPassesUp && car.pos.y < campsite.area.y1 + 140 ? -Math.sign(err) : Math.sign(err);
    ap.drive.steer = apCaravanForwardSteer(car, way || 1);
    ap.drive.throttle = apThrottleFor(car, 45);
    apCheckStuck(car, ap, dt, true);
    if (towardPitch > 0.7) setPhase("line");
    if (p.t > 12) setPhase("approach");
  } else if (p.phase === "line") {
    // Someone in the way: brake and wait a moment -- usually they're just
    // passing. Going round again at once cost 10-20s every time.
    if (campAisleBusy(car, pitch, p.dir)) {
      ap.drive.throttle = apStop(car);
      ap.drive.steer = 0;
      p.wait += dt;
      if (p.wait > AP_CAMP_WAIT_MAX + 2) setPhase("hold");
      return;
    }
    p.wait = 0;
    // With a tractor in front of the pitch: up onto the line before it,
    // or the rig catches its corner (cutting in from below, it did).
    const t = tractors.find((q) => q.pitch === pitch);
    const before = t ? t.x - p.dir * (TRACTOR.length / 2 + 80) : 0; // 80 px short of the tractor's near end
    const low = t && Math.abs(car.pos.y - lineY) > 10 && (before - car.pos.x) * p.dir > 0;
    ap.drive.steer = apCaravanForwardSteer(car, low ? apSteerAt(car, before, lineY) : apSteerAt(car, car.pos.x + p.dir * 90, lineY));
    // stop once the caravan's axle is a turning radius past the pitch
    const toStop = (cx + p.dir * AP_CAMP_ARC_R - axle.x) * p.dir;
    ap.drive.throttle = toStop > 2 ? apThrottleFor(car, Math.min(60, 8 + toStop)) : apStop(car);
    apCheckStuck(car, ap, dt, true);
    if (toStop <= 2 && speedOf(car) < 2) {
      const linedUp = towardPitch > 0.97 && Math.abs(hitch) < 0.25 && Math.abs(axle.y - lineY) < 12;
      const path = linedUp ? apCampTowPath(axle.x, axle.y, pitch, p.dir) : null;
      if (path) {
        p.tow = { path, s: 0 };
        car.towedBack = true;
        setPhase("tow");
      } else setPhase("leave");
    }
    if (towardPitch < 0 || p.t > 20 || toStop < -80) setPhase("leave");
  } else if (p.phase === "tow") {
    ap.drive.throttle = ap.drive.steer = 0;
    // anyone in the way: wait for them (and give up if they don't move)
    const rig = [car.pos, ...CARAVAN.circles.map((cs) => caravanPoint(car, cs))];
    const others = [car1, car2, ...npcs].filter((o) => o !== car);
    const blocked = others.some((o) => {
      const pts = [o.pos];
      if (o.caravan) for (const cs of CARAVAN.circles) pts.push(caravanPoint(o, cs));
      return pts.some((q) => rig.some((r) => Math.hypot(q.x - r.x, q.y - r.y) < AP_CAMP_CLEARANCE));
    });
    if (blocked) {
      car.vel.x = car.vel.y = 0;
      p.wait += dt;
      if (p.wait > AP_CAMP_WAIT_MAX) {
        apEndTow(car);
        setPhase("leave");
      }
      return;
    }
    p.wait = 0;
    if (apCampTowStep(car, p.tow, dt)) {
      apEndTow(car);
      setPhase("check");
    }
  } else if (p.phase === "check") {
    ap.drive.throttle = apStop(car);
    ap.drive.steer = 0;
    // parked now, the coin race moves it on; still here after a moment, retry
    if (p.t > 1) setPhase("leave");
  } else if (p.phase === "leave") {
    // pull out forward, away from the campsite, and come round again --
    // along the passage first if a tractor's parked in front
    ap.drive.throttle = apThrottleFor(car, 70);
    const t = tractors.find((q) => q.pitch === pitch);
    const way = Math.abs(Math.cos(car.angle)) > 0.3 ? Math.sign(Math.cos(car.angle)) : t ? Math.sign(car.pos.x - t.x) || 1 : 1;
    ap.drive.steer = apCaravanForwardSteer(car, t && Math.abs(car.pos.x - t.x) < TRACTOR.length / 2 + 50
      ? apSteerAt(car, car.pos.x + way * 150, lineY)
      : apSteerAt(car, car.pos.x + way * 90, lineY + 90));
    apCheckStuck(car, ap, dt, true);
    if (p.t > 2.5) setPhase("approach");
  }
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
    ap.park = ap.garage = ap.cpark = ap.camp = null;
    if (car.towedBack) apEndTow(car);
    if (goal !== "harass") ap.harass = null;
  }

  if (goal === "coin" && !coin) {
    // waiting for the other player to move before the first coin appears
    ap.drive.throttle = apStop(car);
    ap.drive.steer = 0;
  } else if (goal === "coin") {
    apDriveTo(car, ap, coin.x, coin.y, ap.cruise);
    apCheckStuck(car, ap, dt, ap.drive.throttle !== 0);
  } else if (goal === "harass") {
    apHarass(car, ap, dt);
  } else if (goal === "garage") {
    apGarage(car, ap, dt);
  } else if (car.gamePhase >= 4 && car.caravan) {
    apParkCamp(car, ap, dt);
  } else if (car.caravan) {
    apParkCaravan(car, ap, dt);
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
    // follow the pad's centerline in, easing off to stop in the middle
    const dx = px - car.pos.x;
    const target = Math.min(120, Math.sqrt(2 * 300 * Math.max(0, dx)));
    ap.drive.steer = apSteerAt(car, car.pos.x + 60, py);
    ap.drive.throttle = dx > 8 ? apThrottleFor(car, target) : apStop(car);
    if (onGaragePad(car) && speedOf(car) < 5) s.phase = "wait";
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

// A random free bay -- or, sometimes, the one the other autopilot is already
// going for. Fight! It leaves bays an arriving parked car is heading for
// alone if it can (racing it sends the car off looking for another, which
// meant traffic in the row most of the time). With no free bay at all, any
// bay: it'll just bump into whoever's there and pick again once one frees up.
function apChooseSpot(car) {
  const other = car === car1 ? car2 : car1;
  if (other.autopilot && other.ap.park && Math.random() < 0.45) return other.ap.park.bay;
  const unclaimed = unclaimedBays(), free = freeBays();
  return pickOf(unclaimed.length ? unclaimed : free.length ? free : street.bays);
}

// Starts a parking attempt at `bay` (a random one if not given), from
// `phase` -- parked cars arriving along the lane skip the approach.
function apStartPark(car, ap, bay = null, phase = "approach") {
  const s = bay || apChooseSpot(car);
  ap.park = {
    bay: s,
    dir: car.pos.x < (s.x0 + s.x1) / 2 ? 1 : -1,
    gap: 30 + Math.random() * 10, // how far out from the parked row it lines up
    rush: 1 + Math.random() * Math.random() * 2.5, // sometimes it floors it in reverse
    phase, t: 0, phaseT: 0,
    detour: false, rear0: 0, shuffle: 1, shuffleT: 0,
  };
}

function apRearY(car) {
  return car.pos.y - Math.sin(car.angle) * CAR.wheelBase / 2;
}

function apPark(car, ap, dt) {
  // No attempt yet, the street was rebuilt, or someone else is in the bay:
  // pick again (only if there's a free one to switch to).
  if (!ap.park || !street.bays.includes(ap.park.bay) ||
      (bayOccupied(ap.park.bay, car) && freeBays().length)) apStartPark(car, ap, car.bay || null);
  const p = ap.park;
  const geo = apParkGeometry(p, p.bay);
  const a = wrapAngle(car.angle - geo.heading); // heading error vs. parallel to the row
  const speed = speedOf(car);
  const setPhase = (phase) => { p.phase = phase; p.phaseT = 0; };
  // The timeout covers the maneuver, not the drive over: a badly damaged car
  // crawling at its minimum speed can take longer than that just to arrive.
  if (p.phase !== "approach") p.t += dt;
  p.phaseT += dt;
  if (p.t > AP_PARK_TIMEOUT) {
    apStartPark(car, ap, car.bay || null);
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
    // Pointing the wrong way, wedged, or taking forever: start over. The time
    // limit is generous because a wreck creeps along at DAMAGED_MIN_SPEED.
    const wedged = p.phaseT > 1.5 && speed < 3 && toStage > 2;
    if (Math.abs(a) > 1.3 || wedged || p.phaseT > 20) setPhase("approach");
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
    // Parked-car NPCs (they have a car.bay) center up more carefully: any
    // slack they leave on one side eats into the free bay next to them.
    const tolerance = car.bay ? Math.min(geo.room, 1.5) : geo.room;
    if ((Math.abs(err) < 0.1 && Math.abs(off) <= tolerance) || p.phaseT > 6) {
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
    if (p.phaseT > 1.3) apStartPark(car, ap, car.bay || null);
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
    campsite = buildCampsite();
    replaceTractors();
    const oldLaneY = street.npcLaneY, oldCurbY = street.curbY;
    street = buildStreet();
    resetParkers(); // a fresh parked row for the new layout (cars mid-maneuver just vanish)
    staticDirty = true;
    mechanic = null; // the garage moved: call off any repair in progress (nothing was charged yet); the door rolls shut

    // Carry traffic along with its lane, and pedestrians along with the
    // sidewalk; anything now past the new right edge walks/drives off.
    for (const n of npcs) n.pos.y += street.npcLaneY - oldLaneY;
    for (const p of pedestrians) {
      p.y += street.curbY - oldCurbY;
      if (p.dog) p.dog.y += street.curbY - oldCurbY;
    }

    for (const car of [car1, car2]) {
      car.pos.x = clamp(car.pos.x, CAR.wallRadius, W - CAR.wallRadius);
      car.pos.y = clamp(car.pos.y, CAR.wallRadius, street.curbY - CAR.wallRadius);
      if (car.caravan) placeCaravanAxle(car);
    }

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
  updateParkers(dt);
  updateTractors(dt);
  for (const car of [car1, car2]) if (car.autopilot) updateAutopilot(car, dt);

  const movers = [car1, car2, ...npcs, ...parkers];
  for (const car of [car1, car2]) {
    // where the car was before this step, for a jammed caravan to undo the move
    car.prevPos = { x: car.pos.x, y: car.pos.y };
    car.prevAngle = car.angle;
  }
  for (const car of movers) if (!car.towedBack) stepCar(car, dt); // towed back: see apParkCamp

  // Only the players are fenced in by the arena walls -- traffic enters and
  // leaves through the side edges (see updateTraffic).
  resolveWalls(car1);
  resolveWalls(car2);

  for (const car of movers) {
    resolveCurb(car);
    for (const c of campsite.circles) resolveCarVsStaticCircle(car, { x: c.x, y: c.y }, c.r, c.key);
  }
  for (let i = 0; i < movers.length; i++) {
    for (let j = i + 1; j < movers.length; j++) resolveCarVsCar(movers[i], movers[j]);
  }
  for (const car of [car1, car2]) if (car.caravan && !car.towedBack) updateCaravan(car);
  for (const car of [car1, car2]) if (car.caravan && !car.towedBack) resolveCaravanCollisions(car);

  updateCountdown(dt);
  updateCoin(dt);
  updateCoinRace();
  updateCaravanDue();
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
// building, the campsite -- is drawn once into `staticLayer` by
// buildStaticLayer() and blitted each frame. It MUST be rebuilt whenever
// street/campsite are rebuilt (setupWorld and the resize handler), or the
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
  gravel: "#e9d6a8",
  gravelDark: "#b89e6a",
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
  drawCampsite(c);
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
  const { curbY, centerlineY, npcLaneY, bays } = street;

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

  // parking bays: a painted mark at each end of every bay, and a "P" painted
  // in every bay but the end ones (which always stay parked in). The parked
  // cars cover theirs, so the free bays show a "P". It used to be drawn live
  // on free bays only, and sometimes didn't show.
  for (const x of [bays[0].x0, ...bays.map((b) => b.x1)]) {
    inkShape(c, roundRectPoints(x - 2, curbY - 15, 4, 13, 2, 4), "#ffffff", 1.5);
  }
  for (const b of bays) if (!b.end) inkText(c, "P", (b.x0 + b.x1) / 2, street.carCenterY, 17, "#ffffff");
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

// The campsite (see buildCampsite): a grass strip with a round bush between
// each pair of pitches at the back, a gravel pad per pitch, and the parked
// rigs -- caravan first, so the car sits on top at the hitch, as on the road.
function drawCampsite(c) {
  const { area, pitches, rigs, bushes } = campsite;
  tracePath(c, roundRectPoints(area.x0 + 3, area.y0 + 4, area.x1 - area.x0, area.y1 - area.y0, 14, 8));
  c.fillStyle = PAL.shadow;
  c.fill();
  inkShape(c, wobble(roundRectPoints(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0, 14, 8), 71, 1), PAL.lawn, 2.5);
  for (const p of pitches) {
    const seed = p.x0 * 0.7;
    const pad = pitchPad(p);
    inkShape(c, wobble(roundRectPoints(pad.x0, pad.y0, pad.x1 - pad.x0, pad.y1 - pad.y0, 5, 6), seed, 0.6), PAL.gravel, 1.5);
    for (let k = 0; k < 7; k++) { // a few pebbles
      const px = p.x0 + 8 + hash01(seed + k) * (p.x1 - p.x0 - 16), py = p.y0 + 8 + hash01(seed + k + 20) * (p.y1 - p.y0 - 12);
      c.beginPath();
      c.arc(px, py, 1.2, 0, Math.PI * 2);
      c.fillStyle = PAL.gravelDark;
      c.fill();
    }
  }
  for (const b of bushes) {
    tracePath(c, roundRectPoints(b.x - b.r + 3, b.y - b.r + 3, b.r * 2, b.r * 2, b.r, 5));
    c.fillStyle = PAL.shadow;
    c.fill();
    inkShape(c, wobble(roundRectPoints(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2, b.r, 5), b.x, 2), PAL.lawnDark, 2);
    for (let k = 0; k < 3; k++) { // a few leafy tufts
      const a = b.x + k * 2.1, tx = b.x + Math.cos(a) * b.r * 0.45, ty = b.y + Math.sin(a) * b.r * 0.45;
      inkLine(c, tx - 3, ty + 2, tx, ty - 3, a, 1.3, INK, 0.4);
      inkLine(c, tx, ty - 3, tx + 3, ty + 2, a + 0.5, 1.3, INK, 0.4);
    }
  }
  for (const rig of rigs) {
    drawCaravan(c, rig);
    drawCar(c, rig);
  }
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

// A tractor from above: big rear wheels under the cab, small front ones
// either side of a long hood, an exhaust stack and a white cab roof.
function tractorArt(t) {
  if (t.art) return t.art;
  const s = t.seed;
  t.art = {
    fender: wobble(roundRectPoints(-23, -12, 24, 24, 5, 5), s, 0.6),
    hood: wobble(roundRectPoints(-2, -7.5, 28, 15, 4, 5), s + 1, 0.5),
    roof: wobble(roundRectPoints(-21, -9.5, 16, 19, 3, 4), s + 2, 0.4),
  };
  return t.art;
}

function drawTractor(c, t) {
  const art = tractorArt(t);
  c.save();
  c.translate(t.x + 3, t.y + 4);
  c.rotate(t.angle);
  c.fillStyle = PAL.shadow;
  c.beginPath();
  c.roundRect(-23, -16, 49, 32, 6);
  c.fill();
  c.restore();

  c.save();
  c.translate(t.x, t.y);
  c.rotate(t.angle);
  for (const [x, y, len, wid] of [[-10, -11.5, 22, 9], [-10, 11.5, 22, 9], [15, -8.5, 11, 5], [15, 8.5, 11, 5]]) {
    c.beginPath();
    c.roundRect(x - len / 2, y - wid / 2, len, wid, 3);
    c.fillStyle = PAL.tire;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = 1.5;
    c.stroke();
    if (len > 15) for (let k = -2; k <= 2; k++) inkLine(c, x + k * 4, y - wid / 2 + 1.5, x + k * 4 - 1.5, y + wid / 2 - 1.5, t.seed + k, 1.2, PAL.hub, 0); // tread
  }
  inkShape(c, art.hood, t.color, 2.2);
  inkShape(c, art.fender, t.color, 2.5);
  inkShape(c, art.roof, "#f4f1e8", 1.6);
  inkLine(c, 25, -5, 25, 5, t.seed + 9, 1.4, INK, 0); // grille
  for (const y of [-5, 5]) {
    c.beginPath();
    c.arc(23, y, 1.8, 0, Math.PI * 2);
    c.fillStyle = "#fff6b0";
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = INK;
    c.stroke();
  }
  c.beginPath(); // exhaust stack
  c.arc(8, -4, 2.6, 0, Math.PI * 2);
  c.fillStyle = "#4a4652";
  c.fill();
  c.lineWidth = 1.2;
  c.strokeStyle = INK;
  c.stroke();
  c.restore();
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

  if (car.hoodOpen > 0) drawOpenHood(c, car);
  drawDents(c, art.body, car.dents);
  c.restore();
}

// The hood, lifted by the mechanic (car.hoodOpen 0..1), in the car's own
// frame. Hinged at the windshield, it swings up front edge first, so from
// above it shrinks back toward the hinge and uncovers the engine bay.
function drawOpenHood(c, car) {
  const L = CAR.length, Wd = CAR.width, hinge = L * 0.24, len = L / 2 - 2 - hinge;
  // the engine bay: dark, with the engine block, a filler cap and a hose
  c.beginPath();
  c.roundRect(hinge, -Wd / 2 + 3, len, Wd - 6, 2);
  c.fillStyle = "#3b3745";
  c.fill();
  c.beginPath();
  c.roundRect(hinge + 2.5, -5, len - 5, 10, 2);
  c.fillStyle = "#8e8a99";
  c.fill();
  c.strokeStyle = INK;
  c.lineWidth = 1.1;
  c.stroke();
  c.beginPath();
  c.arc(hinge + len - 4, 6.5, 1.6, 0, Math.PI * 2);
  c.fillStyle = "#ffd23f";
  c.fill();
  c.stroke();
  inkLine(c, hinge + 3, -7, hinge + len - 3, -6.5, car.seed + 5, 1.4, "#1b1922", 0.4);
  // the hood panel itself, foreshortened as it swings up toward vertical
  const shown = len * Math.cos(car.hoodOpen * 1.25);
  c.fillStyle = PAL.shadow; // its shadow falls forward on the engine
  c.fillRect(hinge + shown, -Wd / 2 + 3, Math.min(4 * car.hoodOpen, len - shown), Wd - 6);
  c.beginPath();
  c.roundRect(hinge - 0.5, -Wd / 2 + 1.5, shown + 1.5, Wd - 3, 2);
  c.fillStyle = car.color;
  c.fill();
  c.strokeStyle = INK;
  c.lineWidth = 1.6;
  c.stroke();
  // the underside's light edge, catching the sun as it rises
  if (car.hoodOpen > 0.3) inkLine(c, hinge + shown - 0.5, -Wd / 2 + 3, hinge + shown - 0.5, Wd / 2 - 3, car.seed + 6, 1.2, "rgba(255,255,255,0.7)", 0);
}

// Collision dents: a dark bruise with ink crack lines, clipped to the body
// outline. In the body's own (already transformed) frame; shared by cars and
// caravans.
function drawDents(c, body, dents) {
  if (!dents.length) return;
  c.save();
  tracePath(c, body);
  c.clip();
  for (const d of dents) {
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

// ---- Dynamic scene elements ------------------------------------------------

// The in-world "now go park" cue (there's no status text): while a player is
// in "mustPark", every open spot pulses in that player's color. With both
// players waiting to park, the two pulses run half a cycle apart, so the
// spots alternate between their colors.
// A big painted "P" on every free bay. Free bays change as parked cars come
// and go, so this is drawn live rather than in the static layer. They used
// to pulse in the color of any player who must park; that went, on request,
// when the HUD started saying "Next: Park".
// In game phase 4, the free campsite pitches pulse blue/orange for every
// player who must park there.
function drawCampTargets() {
  const waiting = [car1, car2].filter((c) => c.gameState === "mustPark" && c.gamePhase >= 4);
  drawTargetPulse(waiting, freePitches().map((p) => ({ x: p.x0 + 2, y: p.y0, w: p.x1 - p.x0 - 4, h: p.y1 - p.y0 + 4 })));
}

// The shared "go here" cue: each rect pulses (tinted fill + outline) in the
// color of every car in `cars`. With two cars, their pulses run half a cycle
// apart so the colors alternate. Used for the garage pad and the campsite's
// free pitches (the parking bays used it too, until the HUD started saying
// "Next: Park").
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

// A caravan, top-down, in the same ink style as the cars: cream roof with a
// skylight and roof vents, a band of the car's color across the front, an
// A-frame drawbar to the hitch ball, and its one axle's wheels peeking out
// the sides. Drawn in a frame centered on the body, +x toward the hitch.
function caravanArt(cv) {
  if (cv.art) return cv.art;
  const L = CARAVAN.length, Wd = CARAVAN.width, s = cv.seed;
  cv.art = {
    body: wobble(roundRectPoints(-L / 2, -Wd / 2, L, Wd, 7, 5), s, 0.7),
    front: wobble(roundRectPoints(L / 2 - 9, -Wd / 2 + 2, 7, Wd - 4, 3, 4), s + 1, 0.3),
    skylight: wobble(roundRectPoints(-6, -5, 14, 10, 3, 4), s + 2, 0.3),
  };
  return cv.art;
}

function drawCaravan(c, car) {
  const cv = car.caravan, art = caravanArt(cv);
  const L = CARAVAN.length, Wd = CARAVAN.width;
  const center = caravanPoint(car, CARAVAN.tongue + L / 2);
  const hitchX = L / 2 + CARAVAN.tongue, axleX = hitchX - CARAVAN.axleBack;

  c.save();
  c.translate(center.x + 3, center.y + 4);
  c.rotate(cv.angle);
  tracePath(c, art.body);
  c.fillStyle = PAL.shadow;
  c.fill();
  c.restore();

  c.save();
  c.translate(center.x, center.y);
  c.rotate(cv.angle);
  // A-frame drawbar and hitch ball
  inkLine(c, L / 2 - 2, -7, hitchX, 0, cv.seed + 3, 2.2, INK, 0.3);
  inkLine(c, L / 2 - 2, 7, hitchX, 0, cv.seed + 4, 2.2, INK, 0.3);
  c.beginPath();
  c.arc(hitchX, 0, 2.6, 0, Math.PI * 2);
  c.fillStyle = PAL.tire;
  c.fill();
  c.strokeStyle = INK;
  c.lineWidth = 1.2;
  c.stroke();
  // wheels half under the body
  drawWheel(c, axleX, -Wd / 2, 0);
  drawWheel(c, axleX, Wd / 2, 0);

  inkShape(c, art.body, "#f7f0dc", 2.5);
  inkShape(c, art.front, car.color, 1.5);
  inkShape(c, art.skylight, PAL.glass, 1.5);
  for (const x of [-L / 2 + 8, -L / 2 + 15]) inkShape(c, roundRectPoints(x - 2.5, -3, 5, 6, 1.5, 3), "#d9cfb6", 1.2);
  drawDents(c, art.body, cv.dents);
  c.restore();
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
  if (!m || m.state === "opening" || m.state === "closing") return;
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
// pickup. Game state is shown in the world instead (the painted P's, the
// garage pad flash) -- keep it that way rather than adding status text back.
const keysEl1 = document.getElementById("p1-keys");
const keysEl2 = document.getElementById("p2-keys");
const scoreEl1 = document.getElementById("p1-score");
const scoreEl2 = document.getElementById("p2-score");
const phaseEl1 = document.getElementById("p1-phase");
const phaseEl2 = document.getElementById("p2-phase");
const nextEl1 = document.getElementById("p1-next");
const nextEl2 = document.getElementById("p2-next");
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

function updateHud(car, keysEl, scoreEl, autoBtn, phaseEl, nextEl) {
  // the player's keys, until they first drive
  if (keysEl.hidden !== car.hasDriven) keysEl.hidden = car.hasDriven;
  const score = String(car.score);
  if (scoreEl.textContent !== score) scoreEl.textContent = score;
  // "<game phase>:<the coin about to be taken>", counting from 1: "2:1" is
  // phase 2, going for its first coin. In the last phase it keeps counting.
  const phase = `${car.gamePhase}:${car.phaseCoins + 1}`;
  if (phaseEl.textContent !== phase) phaseEl.textContent = phase;
  const next = car.gameState !== "mustPark" ? "Next: Coin" : car.gamePhase >= 4 ? "Next: Camp" : "Next: Park";
  if (nextEl.textContent !== next) nextEl.textContent = next;
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
    } else if (p.type === "callout") {
      // pop in to 1.2x with an overshoot over the first 0.2 s, then keep
      // growing slowly; hold, then fade out over the last half
      const pop = Math.min(1, t / 0.18);
      const scale = pop < 1 ? 0.4 + 0.8 * (1 - (1 - pop) * (1 - pop)) * (1 + 0.25 * Math.sin(pop * Math.PI)) : 1.2 + (t - 0.18) * 0.25;
      ctx.globalAlpha = 0.88 * Math.min(1, (1 - t) / 0.5);
      ctx.font = `900 ${p.size}px "Trebuchet MS", "Segoe UI", sans-serif`;
      const half = (ctx.measureText(p.text).width * scale) / 2 + 12;
      // above the car, drifting up -- below it near the top edge -- and
      // kept on screen; with no car, in the middle of the open lot
      let x = W / 2, y = (campBottom() + street.curbY) / 2 - t * 16;
      if (p.car) {
        const above = p.y - 70 > p.size;
        x = clamp(p.x, Math.min(half, W / 2), Math.max(W - half, W / 2));
        y = above ? p.y - 62 - t * 22 : p.y + 62 + t * 22;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      inkText(ctx, p.text, 0, 0, p.size, p.color);
      ctx.restore();
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
  // A window with no size yet (e.g. a tab loaded while hidden): drawing a
  // zero-size layer throws, which would kill the frame loop for good.
  if (!W || !H) return;
  if (staticDirty) {
    buildStaticLayer();
    staticDirty = false;
  }
  ctx.drawImage(staticLayer, 0, 0); // ground, street, garage building, campsite
  drawCampTargets();
  drawGaragePad();
  drawGarageDoor();
  drawPedestrians();
  drawMechanic();
  for (const pc of parkers) drawCar(ctx, pc);
  for (const n of npcs) drawCar(ctx, n);
  for (const t of tractors) drawTractor(ctx, t);
  if (coin) drawCoin(coin);
  for (const car of [car1, car2]) if (car.caravan) drawCaravan(ctx, car);
  drawCar(ctx, car1);
  drawCar(ctx, car2);
  drawParticles();

  updateHud(car1, keysEl1, scoreEl1, autoBtn1, phaseEl1, nextEl1);
  updateHud(car2, keysEl2, scoreEl2, autoBtn2, phaseEl2, nextEl2);
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
