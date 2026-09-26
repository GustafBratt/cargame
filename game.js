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

const CONTROL_KEYS = new Set(["w", "a", "s", "d", "i", "j", "k", "l", "r"]);
const keys = new Set();

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (CONTROL_KEYS.has(k)) e.preventDefault();
  keys.add(k);
  if (k === "r") resetCars();
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
    damage: 0, // 0..1, see applyDamage
    dents: [], // car-local {x, y, r}, drawn by drawCar
    color,
    input, // { up, down, left, right } key names
    startPos: { x, y },
    startAngle: angle,
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function readInput(car) {
  if (car.drive) return car.drive; // AI-controlled traffic, see npcDrive
  const throttle = (keys.has(car.input.up) ? 1 : 0) - (keys.has(car.input.down) ? 1 : 0);
  const steer = (keys.has(car.input.right) ? 1 : 0) - (keys.has(car.input.left) ? 1 : 0);
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
  const steerTarget = steer * p.maxSteer;
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
let particles = []; // cosmetic-only firework sparks/rings, see spawnFirework

const PARKED_COLORS = ["#6b7280", "#7c6b52", "#59695a", "#69596c", "#54606b", "#7a5c53"];

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

function resetCars() {
  car1.pos.x = car1.startPos.x; car1.pos.y = car1.startPos.y;
  car1.angle = car1.startAngle; car1.vel.x = 0; car1.vel.y = 0; car1.angularVel = 0;
  car2.pos.x = car2.startPos.x; car2.pos.y = car2.startPos.y;
  car2.angle = car2.startAngle; car2.vel.x = 0; car2.vel.y = 0; car2.angularVel = 0;

  car1.score = 0; car1.gameState = "seekCoin";
  car2.score = 0; car2.gameState = "seekCoin";
  repairCar(car1);
  repairCar(car2);
  spawnCoin();
  particles.length = 0;
  resetTraffic();
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
    up: "w", down: "s", left: "a", right: "d",
  });
  car2 = createCar(W * 0.65, H * 0.5, Math.PI / 2, "#ffa64f", {
    up: "i", down: "k", left: "j", right: "l",
  });

  crates = buildCrates();
  street = buildStreet();

  car1.score = 0; car1.gameState = "seekCoin";
  car2.score = 0; car2.gameState = "seekCoin";
  spawnCoin();
  particles.length = 0;
  resetTraffic();
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

function spawnCoin() {
  coin = randomCoinPos();
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

function onGaragePad(car) {
  const g = street.garage;
  return car.pos.x > g.x0 && car.pos.x < g.x1 && car.pos.y > g.padY0 && car.pos.y < g.curbY;
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
    if (car.gameState !== "seekCoin") continue;
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
const NPC_LOOKAHEAD = 90; // px, how far along the lane the steering aims
const NPC_BRAKE_DIST = 110; // px, brake for any car this close ahead in the car's path
const NPC_COLORS = ["#e6e6e6", "#d9534f", "#5cb85c", "#9b7fd4", "#3d4a5c", "#c27ba0"];

function nextNpcSpawnDelay() {
  return -Math.log(1 - Math.random()) * NPC_SPAWN_MEAN;
}

function resetTraffic() {
  npcs.length = 0;
  npcSpawnTimer = nextNpcSpawnDelay();
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

  // Steer toward a point further along the lane -- keeps the car on the lane
  // line, and also brings it back (turning around if needed) after a hit.
  const tx = npc.pos.x + npc.dir * NPC_LOOKAHEAD;
  const headingErr = wrapAngle(Math.atan2(street.npcLaneY - npc.pos.y, tx - npc.pos.x) - npc.angle);
  let steer = clamp(headingErr * 2.5, -1, 1);

  let blocked = false;
  for (const other of [car1, car2, ...npcs]) {
    if (other === npc) continue;
    const dx = other.pos.x - npc.pos.x, dy = other.pos.y - npc.pos.y;
    const ahead = dx * forward.x + dy * forward.y;
    const side = dy * forward.x - dx * forward.y;
    if (ahead > 0 && ahead < NPC_BRAKE_DIST && Math.abs(side) < CAR.width + 6) {
      blocked = true;
      break;
    }
  }

  let throttle;
  if (npc.reverseTime > 0) {
    // Backing out of a jam: opposite lock, since reversing swings the nose
    // the other way.
    npc.reverseTime -= dt;
    throttle = -1;
    steer = -steer;
  } else if (blocked) {
    throttle = forwardSpeed > 1 ? -1 : 0; // brake, but never start reversing into a queue
  } else {
    throttle = forwardSpeed < NPC_CRUISE_SPEED ? 1 : 0;
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

  updateCoinRace();
  updateGarage();
  for (const car of movers) emitSmoke(car, dt);
  updateParticles(dt);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function drawGrid() {
  ctx.fillStyle = "#2b2e37";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  const step = 60;
  ctx.beginPath();
  for (let x = 0; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 0; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
}

function drawStreet() {
  const { curbY, parkingSpots } = street;

  // sidewalk
  ctx.fillStyle = "#4a4d55";
  ctx.fillRect(0, curbY, W, H - curbY);

  // curb line
  ctx.strokeStyle = "#c9ccd3";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, curbY);
  ctx.lineTo(W, curbY);
  ctx.stroke();

  // dashed road centerline, a bit above the parked row
  ctx.strokeStyle = "rgba(230, 200, 90, 0.55)";
  ctx.lineWidth = 3;
  ctx.setLineDash([22, 18]);
  ctx.beginPath();
  ctx.moveTo(0, street.centerlineY);
  ctx.lineTo(W, street.centerlineY);
  ctx.stroke();
  ctx.setLineDash([]);

  // parking-spot boundary markings, painted on the curb
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const spot of parkingSpots) {
    ctx.fillRect(spot.x0 - 1.5, curbY - 2, 3, 16);
    ctx.fillRect(spot.x1 - 1.5, curbY - 2, 3, 16);
    ctx.fillText("P", (spot.x0 + spot.x1) / 2, curbY - 22);
  }
}

function drawCoin(coin) {
  const pulse = 1 + 0.08 * Math.sin(performance.now() / 250);
  const r = COIN_RADIUS * pulse;

  ctx.save();
  ctx.translate(coin.x, coin.y);

  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = "#ffd54f";
  ctx.strokeStyle = "#b8860b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function drawCrate(c) {
  ctx.fillStyle = "#8a5a34";
  ctx.strokeStyle = "#5c3a20";
  ctx.lineWidth = 2;
  ctx.fillRect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
  ctx.strokeRect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
}

function drawWheel(localX, localY, extraAngle) {
  const wLen = 14, wWid = 7;
  ctx.save();
  ctx.translate(localX, localY);
  ctx.rotate(extraAngle);

  // tire: dark fill with a light outline so it reads clearly against both
  // the asphalt and the car body, at any rotation.
  ctx.fillStyle = "#161616";
  ctx.strokeStyle = "#9aa0aa";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(-wLen / 2, -wWid / 2, wLen, wWid, 1.5);
  ctx.fill();
  ctx.stroke();

  // sidewall stripe running the length of the tire, so its pointing
  // direction is legible at a glance even at small sizes.
  ctx.strokeStyle = "#d7dae0";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-wLen / 2 + 2, 0);
  ctx.lineTo(wLen / 2 - 2, 0);
  ctx.stroke();

  ctx.restore();
}

function drawCar(car) {
  const { length, width } = CAR;
  const halfWB = CAR.wheelBase / 2;
  const halfTrack = width / 2;

  ctx.save();
  ctx.translate(car.pos.x, car.pos.y);
  ctx.rotate(car.angle);

  // wheels (drawn first, so the body sits on top) -- the two front wheels
  // get distinct Ackermann angles, so the inner one visibly turns sharper
  // than the outer one during a turn, same as a real front axle.
  const wheelAngles = ackermannWheelAngles(car.steerCurrent, CAR.wheelBase, CAR.track);
  drawWheel(halfWB, -halfTrack, wheelAngles.left);
  drawWheel(halfWB, halfTrack, wheelAngles.right);
  drawWheel(-halfWB, -halfTrack, 0);
  drawWheel(-halfWB, halfTrack, 0);

  // body
  ctx.fillStyle = car.color;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  roundedRect(-length / 2, -width / 2, length, width, 5);
  ctx.fill();
  ctx.stroke();

  // cabin / windshield to show facing direction
  ctx.fillStyle = "rgba(20,25,35,0.6)";
  roundedRect(length * 0.02, -width / 2 + 4, length * 0.35, width - 8, 3);
  ctx.fill();

  // collision dents: a dark hollow with a bright crumple edge, clipped to
  // the body so a dent at the bumper doesn't spill onto the road.
  if (car.dents.length) {
    ctx.save();
    roundedRect(-length / 2, -width / 2, length, width, 5);
    ctx.clip();
    for (const d of car.dents) {
      const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
      g.addColorStop(0, "rgba(0,0,0,0.55)");
      g.addColorStop(0.65, "rgba(0,0,0,0.25)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * 0.6, Math.PI * 0.9, Math.PI * 1.9);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore();
}

function drawGarage() {
  const g = street.garage;
  const w = g.x1 - g.x0;

  // service pad on the road: hazard-striped border around a darker slab
  ctx.fillStyle = "rgba(20,22,28,0.55)";
  ctx.fillRect(g.x0, g.padY0, w, g.curbY - g.padY0);
  ctx.save();
  ctx.strokeStyle = "#e0b43a";
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 7]);
  ctx.strokeRect(g.x0 + 1.5, g.padY0 + 1.5, w - 3, g.curbY - g.padY0 - 3);
  ctx.restore();
  ctx.fillStyle = "rgba(224,180,58,0.85)";
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`REPAIR · ${REPAIR_COST} COIN`, (g.x0 + g.x1) / 2, g.padY0 + 16);

  // building on the sidewalk, roll-up door facing the pad
  const by0 = g.curbY + 4;
  ctx.fillStyle = "#5b4636";
  ctx.strokeStyle = "#2e231b";
  ctx.lineWidth = 2;
  ctx.fillRect(g.x0, by0, w, g.bottomY - by0);
  ctx.strokeRect(g.x0, by0, w, g.bottomY - by0);

  const doorInset = 18;
  const doorH = Math.min(22, (g.bottomY - by0) * 0.45);
  ctx.fillStyle = "#9aa0aa";
  ctx.fillRect(g.x0 + doorInset, by0, w - doorInset * 2, doorH);
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = by0 + 4; y < by0 + doorH; y += 4) {
    ctx.moveTo(g.x0 + doorInset, y);
    ctx.lineTo(g.x1 - doorInset, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#f1e3c8";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.fillText("GARAGE", (g.x0 + g.x1) / 2, Math.min(by0 + doorH + 18, g.bottomY - 6));
}

function roundedRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const speedEl1 = document.getElementById("p1-speed");
const speedEl2 = document.getElementById("p2-speed");
const scoreEl1 = document.getElementById("p1-score");
const scoreEl2 = document.getElementById("p2-score");
const statusEl1 = document.getElementById("p1-status");
const statusEl2 = document.getElementById("p2-status");

function statusText(car) {
  if (car.damage > 0 && car.score < REPAIR_COST && onGaragePad(car)) return `Repairs cost ${REPAIR_COST} coin!`;
  return car.gameState === "mustPark" ? "Now parallel park!" : "Race for the coin!";
}

function updateHud(car, speedEl, scoreEl, statusEl) {
  speedEl.textContent = `${Math.round(Math.hypot(car.vel.x, car.vel.y) * 0.22)} mph`;
  scoreEl.textContent = `Coins: ${car.score}`;
  statusEl.textContent = statusText(car);
}

function drawParticles() {
  for (const p of particles) {
    const t = p.life / p.maxLife;
    if (p.type === "spark") {
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1 - t * 0.4), 0, Math.PI * 2);
      ctx.fill();
    } else if (p.type === "streak") {
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size;
      ctx.lineCap = "round";
      const speed = Math.hypot(p.vx, p.vy);
      const len = Math.min(speed * 0.045, 16);
      const dx = speed > 0.01 ? (p.vx / speed) * len : 0;
      const dy = speed > 0.01 ? (p.vy / speed) * len : 0;
      ctx.beginPath();
      ctx.moveTo(p.x - dx, p.y - dy);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else if (p.type === "ring") {
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.type === "smoke") {
      ctx.globalAlpha = p.alpha * (1 - t);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.type === "flash") {
      ctx.globalAlpha = (1 - t) * 0.9;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
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
  drawGrid();
  drawStreet();
  drawGarage();
  for (const c of crates) drawCrate(c);
  for (const pc of street.parkedCars) drawCar(pc);
  for (const n of npcs) drawCar(n);
  if (coin) drawCoin(coin);
  drawCar(car1);
  drawCar(car2);
  drawParticles();

  updateHud(car1, speedEl1, scoreEl1, statusEl1);
  updateHud(car2, speedEl2, scoreEl2, statusEl2);
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
