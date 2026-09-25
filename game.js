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
  maxSteer: 0.6, // radians, at a standstill
  steerSpeedRef: 140, // px/s; steering authority halves around this speed
  maxAngularVel: 3.2, // rad/s safety cap
  chassisResponse: 11, // how fast heading catches up to the steered direction
  enginePower: 340, // forward acceleration, px/s^2 -- kept gentle for parking-scale control
  brakePower: 1150, // deceleration when braking while moving forward
  reversePower: 200,
  dragCoeff: 0.62, // proportional drag
  rollResist: 55, // constant rolling resistance, px/s^2
  maxLateralAccel: 720, // tire grip limit -> higher = less drift
  maxSpeed: 360,
  maxReverseSpeed: 120,
  spinTorqueScale: 220, // divides collision torque (r x dv) into an angularVel change -- lower = more dramatic spin from hits
  maxCollisionSpin: 9, // rad/s safety clamp on angularVel after any single collision impulse
};
CAR.wallRadius = Math.hypot(CAR.length, CAR.width) / 2;
// Collision shape: a "capsule" made of two circles along the centerline,
// sized to hug the actual rectangle closely (needed for tight maneuvers
// like parallel parking, where a single fat circle would be too sloppy).
CAR.capsuleOffset = (CAR.length - CAR.width) / 2;
CAR.capsuleRadius = CAR.width / 2;

function createCar(x, y, angle, color, input) {
  return {
    pos: { x, y },
    vel: { x: 0, y: 0 },
    angle,
    angularVel: 0,
    steerVisual: 0,
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
  const throttle = (keys.has(car.input.up) ? 1 : 0) - (keys.has(car.input.down) ? 1 : 0);
  const steer = (keys.has(car.input.right) ? 1 : 0) - (keys.has(car.input.left) ? 1 : 0);
  return { throttle, steer };
}

function stepCar(car, dt) {
  const { throttle, steer } = readInput(car);
  const p = CAR;

  const forward = { x: Math.cos(car.angle), y: Math.sin(car.angle) };
  const right = { x: -forward.y, y: forward.x };

  const forwardSpeed = car.vel.x * forward.x + car.vel.y * forward.y;
  const speed = Math.hypot(car.vel.x, car.vel.y);

  // Steering: front wheels turn, heading rate follows a simple bicycle model
  // and eases toward that target (simulates chassis/suspension response).
  // Effective steering authority tapers off with speed, since real tires
  // can't generate enough lateral grip to hit the kinematic turn rate a full
  // lock implies once a car is moving fast (otherwise a full-lock turn at
  // top speed asks for 600+ deg/s of rotation, which reads as a spin-out).
  const speedSteerFactor = 1 / (1 + Math.abs(forwardSpeed) / p.steerSpeedRef);
  const steerAngle = steer * p.maxSteer * speedSteerFactor;
  car.steerVisual += (steerAngle - car.steerVisual) * Math.min(1, 14 * dt);

  const desiredAngularVel = clamp(
    (forwardSpeed / p.wheelBase) * Math.tan(steerAngle),
    -p.maxAngularVel,
    p.maxAngularVel
  );
  car.angularVel += (desiredAngularVel - car.angularVel) * Math.min(1, p.chassisResponse * dt);
  car.angle += car.angularVel * dt;

  // Engine / brake / reverse along the car's forward axis.
  let longAccel = 0;
  if (throttle > 0) {
    longAccel = p.enginePower;
  } else if (throttle < 0) {
    longAccel = forwardSpeed > 1 ? -p.brakePower : -p.reversePower;
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

  // Tire grip: lateral velocity only bleeds off up to the grip limit, so a
  // sharp turn taken too fast leaves residual sideways speed -> drift.
  const lateralSpeed = car.vel.x * right.x + car.vel.y * right.y;
  const maxCorrection = p.maxLateralAccel * dt;
  const correction = clamp(lateralSpeed, -maxCorrection, maxCorrection);
  car.vel.x -= right.x * correction;
  car.vel.y -= right.y * correction;

  // Clamp forward/reverse top speed along the heading.
  const fwdAfter = car.vel.x * forward.x + car.vel.y * forward.y;
  const latAfter = car.vel.x * right.x + car.vel.y * right.y;
  const fwdClamped = clamp(fwdAfter, -p.maxReverseSpeed, p.maxSpeed);
  car.vel.x = forward.x * fwdClamped + right.x * latAfter;
  car.vel.y = forward.y * fwdClamped + right.y * latAfter;

  car.pos.x += car.vel.x * dt;
  car.pos.y += car.vel.y * dt;
}

function resolveWalls(car) {
  const r = CAR.wallRadius;
  if (car.pos.x - r < 0) {
    car.pos.x = r;
    car.vel.x = Math.abs(car.vel.x) * 0.4;
    car.angularVel *= 0.5;
  } else if (car.pos.x + r > W) {
    car.pos.x = W - r;
    car.vel.x = -Math.abs(car.vel.x) * 0.4;
    car.angularVel *= 0.5;
  }
  if (car.pos.y - r < 0) {
    car.pos.y = r;
    car.vel.y = Math.abs(car.vel.y) * 0.4;
    car.angularVel *= 0.5;
  } else if (car.pos.y + r > H) {
    car.pos.y = H - r;
    car.vel.y = -Math.abs(car.vel.y) * 0.4;
    car.angularVel *= 0.5;
  }
}

function resolveCircles(aPos, aVel, aR, bPos, bVel, bR, bStatic) {
  const dx = bPos.x - aPos.x;
  const dy = bPos.y - aPos.y;
  const dist = Math.hypot(dx, dy) || 0.001;
  const overlap = aR + bR - dist;
  if (overlap <= 0) return;

  const nx = dx / dist, ny = dy / dist;
  const pushA = bStatic ? overlap : overlap / 2;
  const pushB = bStatic ? 0 : overlap / 2;
  aPos.x -= nx * pushA; aPos.y -= ny * pushA;
  if (!bStatic) { bPos.x += nx * pushB; bPos.y += ny * pushB; }

  const rvx = (bStatic ? 0 : bVel.x) - aVel.x;
  const rvy = (bStatic ? 0 : bVel.y) - aVel.y;
  const velAlongNormal = rvx * nx + rvy * ny;
  if (velAlongNormal > 0) return;

  const restitution = 0.5;
  const impulse = (-(1 + restitution) * velAlongNormal) / (bStatic ? 1 : 2);
  aVel.x -= impulse * nx; aVel.y -= impulse * ny;
  if (!bStatic) { bVel.x += impulse * nx; bVel.y += impulse * ny; }
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
function resolveCarVsStaticCircle(car, obstaclePos, obstacleR) {
  for (const r of capsuleOffsets(car.angle)) {
    const c = { x: car.pos.x + r.x, y: car.pos.y + r.y };
    const posBefore = { x: c.x, y: c.y };
    const velBefore = { x: car.vel.x, y: car.vel.y };
    resolveCircles(c, car.vel, CAR.capsuleRadius, obstaclePos, null, obstacleR, true);
    car.pos.x += c.x - posBefore.x;
    car.pos.y += c.y - posBefore.y;
    applyCollisionSpin(car, r, velBefore);
  }
}

function resolveCarVsCar(carA, carB) {
  for (const rA of capsuleOffsets(carA.angle)) {
    for (const rB of capsuleOffsets(carB.angle)) {
      const a = { x: carA.pos.x + rA.x, y: carA.pos.y + rA.y };
      const b = { x: carB.pos.x + rB.x, y: carB.pos.y + rB.y };
      const posBeforeA = { x: a.x, y: a.y }, posBeforeB = { x: b.x, y: b.y };
      const velBeforeA = { x: carA.vel.x, y: carA.vel.y }, velBeforeB = { x: carB.vel.x, y: carB.vel.y };
      resolveCircles(a, carA.vel, CAR.capsuleRadius, b, carB.vel, CAR.capsuleRadius, false);
      carA.pos.x += a.x - posBeforeA.x; carA.pos.y += a.y - posBeforeA.y;
      carB.pos.x += b.x - posBeforeB.x; carB.pos.y += b.y - posBeforeB.y;
      applyCollisionSpin(carA, rA, velBeforeA);
      applyCollisionSpin(carB, rB, velBeforeB);
    }
  }
}

// ---------------------------------------------------------------------------
// World: cars + static crates + parking street
// ---------------------------------------------------------------------------

let car1, car2, crates, street;
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

  return { curbY, carCenterY, parkedCars, parkingSpots };
}

function resetCars() {
  car1.pos.x = car1.startPos.x; car1.pos.y = car1.startPos.y;
  car1.angle = car1.startAngle; car1.vel.x = 0; car1.vel.y = 0; car1.angularVel = 0;
  car2.pos.x = car2.startPos.x; car2.pos.y = car2.startPos.y;
  car2.angle = car2.startAngle; car2.vel.x = 0; car2.vel.y = 0; car2.angularVel = 0;

  car1.score = 0; car1.gameState = "seekCoin";
  car2.score = 0; car2.gameState = "seekCoin";
  spawnCoin();
  particles.length = 0;
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
const PARK_SPEED_LIMIT = 7; // px/s, "stopped" for parking-detection purposes
const PARK_Y_TOLERANCE = 8;
const PARK_ANGLE_TOLERANCE = 0.2; // radians (~11.5deg), either direction along the curb
const PARK_X_MARGIN = 5; // px inset from the spot's painted edges the center must clear

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

// A little celebration burst -- radiating sparks plus an expanding ring --
// fired at the moment a parking attempt is confirmed successful. Purely
// cosmetic: never touches physics or game state.
function spawnFirework(x, y, color) {
  const sparkColors = [color, "#ffd54f", "#ffffff"];
  const count = 26;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
    const speed = 90 + Math.random() * 130;
    particles.push({
      type: "spark",
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 1.8 + Math.random() * 2.2,
      color: sparkColors[Math.floor(Math.random() * sparkColors.length)],
      life: 0,
      maxLife: 0.45 + Math.random() * 0.35,
    });
  }
  particles.push({ type: "ring", x, y, radius: 4, growSpeed: 220, color, life: 0, maxLife: 0.35 });
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
    if (p.type === "spark") {
      p.vx *= 1 - 2.2 * dt;
      p.vy *= 1 - 2.2 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    } else {
      p.radius += p.growSpeed * dt;
    }
  }
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
    street = buildStreet();

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
    car.vel.y = -Math.abs(car.vel.y) * 0.4;
    car.angularVel *= 0.5;
  }
}

function update(dt) {
  stepCar(car1, dt);
  stepCar(car2, dt);

  resolveWalls(car1);
  resolveWalls(car2);
  resolveCurb(car1);
  resolveCurb(car2);

  for (const c of crates) {
    resolveCarVsStaticCircle(car1, { x: c.x, y: c.y }, c.r);
    resolveCarVsStaticCircle(car2, { x: c.x, y: c.y }, c.r);
  }
  for (const pc of street.parkedCars) {
    for (const cc of pc.collisionCircles) {
      resolveCarVsStaticCircle(car1, cc, CAR.capsuleRadius);
      resolveCarVsStaticCircle(car2, cc, CAR.capsuleRadius);
    }
  }
  resolveCarVsCar(car1, car2);

  updateCoinRace();
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
  ctx.moveTo(0, curbY - 90);
  ctx.lineTo(W, curbY - 90);
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

  // wheels (drawn first, so the body sits on top)
  drawWheel(halfWB, -halfTrack, car.steerVisual);
  drawWheel(halfWB, halfTrack, car.steerVisual);
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

  ctx.restore();
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
    } else {
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function render() {
  drawGrid();
  drawStreet();
  for (const c of crates) drawCrate(c);
  for (const pc of street.parkedCars) drawCar(pc);
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
