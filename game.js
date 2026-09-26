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
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());

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
  // Collision damage saps the engine (brakes are left alone -- a wrecked car
  // should still be able to stop).
  const health = carHealth(car);
  let longAccel = 0;
  if (throttle > 0) {
    longAccel = p.enginePower * health;
  } else if (throttle < 0) {
    longAccel = forwardSpeed > 1 ? -p.brakePower : -p.reversePower * health;
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
  const fwdClamped = clamp(fwdAfter, -p.maxReverseSpeed * health, p.maxSpeed * health);
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
    if (car.vel.x < 0) applyDamage(car, -car.vel.x, { x: 0, y: car.pos.y });
    car.vel.x = Math.abs(car.vel.x) * b;
    car.angularVel *= 0.5;
  } else if (car.pos.x + r > W) {
    car.pos.x = W - r;
    if (car.vel.x > 0) applyDamage(car, car.vel.x, { x: W, y: car.pos.y });
    car.vel.x = -Math.abs(car.vel.x) * b;
    car.angularVel *= 0.5;
  }
  if (car.pos.y - r < 0) {
    car.pos.y = r;
    if (car.vel.y < 0) applyDamage(car, -car.vel.y, { x: car.pos.x, y: 0 });
    car.vel.y = Math.abs(car.vel.y) * b;
    car.angularVel *= 0.5;
  } else if (car.pos.y + r > H) {
    car.pos.y = H - r;
    if (car.vel.y > 0) applyDamage(car, car.vel.y, { x: car.pos.x, y: H });
    car.vel.y = -Math.abs(car.vel.y) * b;
    car.angularVel *= 0.5;
  }
}

// Returns the closing speed along the contact normal (0 if the circles
// weren't touching or were already separating) -- how hard the hit was, for
// collision damage.
function resolveCircles(aPos, aVel, aR, bPos, bVel, bR, bStatic, restitution) {
  const dx = bPos.x - aPos.x;
  const dy = bPos.y - aPos.y;
  const dist = Math.hypot(dx, dy) || 0.001;
  const overlap = aR + bR - dist;
  if (overlap <= 0) return 0;

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

// Collides a car's capsule against a single static circle (a crate, or one
// end of a parked car's capsule), feeding the resulting push/impulse back
// into the car's actual pos/vel (each capsule circle is a fixed offset from
// the car center, so a pure translation of the center moves both).
// Point on circle `from`'s rim facing `toward` -- where a collision touched.
function contactPoint(from, toward, radius) {
  const dx = toward.x - from.x, dy = toward.y - from.y;
  const d = Math.hypot(dx, dy) || 0.001;
  return { x: from.x + (dx / d) * radius, y: from.y + (dy / d) * radius };
}

function resolveCarVsStaticCircle(car, obstaclePos, obstacleR) {
  // Both capsule circles can register the same hit; damage is taken once,
  // from the harder of the two.
  let hit = 0, hitAt = null;
  for (const r of capsuleOffsets(car.angle)) {
    const c = { x: car.pos.x + r.x, y: car.pos.y + r.y };
    const posBefore = { x: c.x, y: c.y };
    const velBefore = { x: car.vel.x, y: car.vel.y };
    const s = resolveCircles(c, car.vel, CAR.capsuleRadius, obstaclePos, null, obstacleR, true, CAR.obstacleCollisionRestitution);
    if (s > hit) { hit = s; hitAt = contactPoint(c, obstaclePos, CAR.capsuleRadius); }
    car.pos.x += c.x - posBefore.x;
    car.pos.y += c.y - posBefore.y;
    applyCollisionSpin(car, r, velBefore);
  }
  if (hitAt) applyDamage(car, hit, hitAt);
}

function resolveCarVsCar(carA, carB) {
  let hit = 0, hitAtA = null, hitAtB = null;
  for (const rA of capsuleOffsets(carA.angle)) {
    for (const rB of capsuleOffsets(carB.angle)) {
      const a = { x: carA.pos.x + rA.x, y: carA.pos.y + rA.y };
      const b = { x: carB.pos.x + rB.x, y: carB.pos.y + rB.y };
      const posBeforeA = { x: a.x, y: a.y }, posBeforeB = { x: b.x, y: b.y };
      const velBeforeA = { x: carA.vel.x, y: carA.vel.y }, velBeforeB = { x: carB.vel.x, y: carB.vel.y };
      const s = resolveCircles(a, carA.vel, CAR.capsuleRadius, b, carB.vel, CAR.capsuleRadius, false, CAR.carCollisionRestitution);
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
  if (hitAtA) {
    applyDamage(carA, hit, hitAtA);
    applyDamage(carB, hit, hitAtB);
  }
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
const DAMAGE_PER_SPEED = 1 / 1200; // damage per px/s of closing speed above the threshold
const DAMAGE_SLOWDOWN = 0.6; // at full damage, engine power and top speed drop to 40%
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
  return 1 - DAMAGE_SLOWDOWN * car.damage;
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

  // Repair garage in the bottom-right corner: the building sits on the
  // sidewalk, and its service pad is the patch of road in front of its door.
  const garageW = 120;
  const garage = { x0: W - garageW - 16, x1: W - 16, padY0: curbY - 66, curbY, bottomY: H - 8 };

  return { curbY, carCenterY, centerlineY, npcLaneY, parkedCars, parkingSpots, garage };
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

function randomCoinPos() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = 60 + Math.random() * (W - 120);
    const y = 60 + Math.random() * Math.max(40, street.curbY - 150 - 60);
    if (crates.every((c) => Math.hypot(x - c.x, y - c.y) > c.r + 40)) return { x, y };
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

// A single shared coin is always on the map. Only a car currently in
// "seekCoin" is eligible to collect it -- a car that just scored is parked
// in "mustPark" and can't take the next one, no matter what the other car
// does. Whichever eligible car reaches it first scores, goes to "mustPark",
// and a fresh coin immediately takes its place (so the other car, if still
// eligible, can keep going without waiting on anyone's parking job).
// ---------------------------------------------------------------------------
// Garage
// ---------------------------------------------------------------------------
// A player that stops on the garage pad with any damage pays 1 coin and is
// fully repaired on the spot. Traffic never uses it.

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

function updateGarage() {
  for (const car of [car1, car2]) {
    if (car.damage <= 0 || !onGaragePad(car)) continue;
    if (Math.hypot(car.vel.x, car.vel.y) > GARAGE_SPEED_LIMIT) continue;
    if (car.score < REPAIR_COST) continue;
    car.score -= REPAIR_COST;
    repairCar(car);
    spawnFirework(car.pos.x, car.pos.y, "#7dffa0");
  }
}

function updateCoinRace() {
  for (const car of [car1, car2]) {
    if (car.gameState !== "seekCoin" || !coinCollectable()) continue;
    if (Math.hypot(car.pos.x - coin.x, car.pos.y - coin.y) < PICKUP_DIST) {
      car.score++;
      car.gameState = "mustPark";
      spawnCoin();
      break;
    }
  }

  for (const car of [car1, car2]) {
    if (car.gameState === "mustPark" && isParked(car)) {
      car.gameState = "seekCoin";
      spawnFirework(car.pos.x, car.pos.y, car.color);
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
  npcs.push(npc);
  return true;
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
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
    const oldLaneY = street.npcLaneY;
    street = buildStreet();
    staticDirty = true;

    // Carry traffic along with its lane; anything now past the new right
    // edge is cleaned up by updateTraffic.
    for (const n of npcs) n.pos.y += street.npcLaneY - oldLaneY;

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
    if (car.vel.y > 0) applyDamage(car, car.vel.y, { x: car.pos.x, y: street.curbY });
    car.vel.y = -Math.abs(car.vel.y) * 0.4;
    car.angularVel *= 0.5;
  }
}

function update(dt) {
  gameTime += dt;
  updateTraffic(dt);

  const movers = [car1, car2, ...npcs];
  for (const car of movers) stepCar(car, dt);

  // Only the players are fenced in by the arena walls -- traffic enters and
  // leaves through the side edges (see updateTraffic).
  resolveWalls(car1);
  resolveWalls(car2);

  for (const car of movers) {
    resolveCurb(car);
    for (const c of crates) resolveCarVsStaticCircle(car, { x: c.x, y: c.y }, c.r);
    for (const pc of street.parkedCars) {
      for (const cc of pc.collisionCircles) resolveCarVsStaticCircle(car, cc, CAR.capsuleRadius);
    }
  }
  for (let i = 0; i < movers.length; i++) {
    for (let j = i + 1; j < movers.length; j++) resolveCarVsCar(movers[i], movers[j]);
  }

  updateCoin(dt);
  updateCoinRace();
  updateGarage();
  for (const car of movers) emitSmoke(car, dt);
  updateParticles(dt);
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
  staticLayer.width = W;
  staticLayer.height = H;
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
  const swH = Math.min(46, (H - curbY) * 0.45);
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

// Pink cartoon garage on the sidewalk/lawn, roll-up door facing its pad.
function drawGarageBuilding(c) {
  const g = street.garage;
  const w = g.x1 - g.x0, by0 = g.curbY + 6, h = g.bottomY - by0;
  tracePath(c, roundRectPoints(g.x0 + 5, by0 + 6, w, h, 5, 10));
  c.fillStyle = PAL.shadow;
  c.fill();
  inkShape(c, wobble(roundRectPoints(g.x0, by0, w, h, 5, 8), 77, 1), PAL.garageWall, 3);
  // flat roof inset with a vent
  const inset = 10;
  inkShape(c, wobble(roundRectPoints(g.x0 + inset, by0 + 28, w - inset * 2, h - 28 - inset, 4, 8), 78, 0.8), PAL.garageRoof, 2);
  inkShape(c, wobble(roundRectPoints(g.x1 - 34, by0 + 36, 14, 14, 7, 4), 79, 0.4), "#e9e4f2", 1.8);
  // roll-up door with slats
  const doorH = Math.min(20, h * 0.3), dx0 = g.x0 + 18, dw = w - 36;
  inkShape(c, roundRectPoints(dx0, by0 - 2, dw, doorH, 2, 6), PAL.garageDoor, 2.2);
  for (let y = by0 + 3; y < by0 + doorH - 3; y += 4.5) inkLine(c, dx0 + 3, y, dx0 + dw - 3, y, y, 1, "rgba(35,31,46,0.45)", 0.3);
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
const hintEl = document.getElementById("hint");
const HINT_SECONDS = 10;

function updateHud(car, titleEl, scoreEl) {
  const title = car.hasDriven ? car.label : `${car.label} — ${car.keyHint}`;
  if (titleEl.textContent !== title) titleEl.textContent = title;
  const score = String(car.score);
  if (scoreEl.textContent !== score) scoreEl.textContent = score;
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
  for (const n of npcs) drawCar(ctx, n);
  if (coin) drawCoin(coin);
  drawCar(ctx, car1);
  drawCar(ctx, car2);
  drawParticles();

  updateHud(car1, titleEl1, scoreEl1);
  updateHud(car2, titleEl2, scoreEl2);
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
