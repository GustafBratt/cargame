# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, no-build, top-down 2-player car sandbox. Vanilla HTML/CSS/JS, rendered on a `<canvas>` with `requestAnimationFrame`. Cars are rectangles with visible wheels (front wheels turn with steering); Player 1 drives with WASD, Player 2 with IJKL. There's a grid of static crates to bump into, a curbside street with parked cars and two marked practice spots for parallel parking, and the two players collide with each other too.

There is no framework, no package.json, and no build/bundle step — the browser loads `index.html`, `style.css`, and `game.js` directly.

## Commands

There's no build, lint, or test tooling in this repo. To run the game locally:

```
node serve.js [port]   # zero-dependency static server, defaults to port 5500
```

Then open `http://localhost:<port>/` in a browser. `serve.js` is a small hand-rolled `http` server (no npm install needed) that serves `index.html`, `game.js`, and `style.css` with correct MIME types.

Alternatively, `index.html` can be opened directly as a `file://` URL — the game has no server-side dependencies.

## Architecture

Everything lives in `game.js` as top-level script state (no modules, no classes) and runs in one `requestAnimationFrame` loop that separates **fixed-step physics** from **variable-rate rendering**:

- `frame(now)` accumulates real elapsed time and calls `update(FIXED_DT)` (`FIXED_DT = 1/120`) zero or more times per rendered frame, then calls `render()` once. This keeps the physics deterministic and stable regardless of display refresh rate.

### Car physics (`stepCar`)

Each car is a plain object with `pos`, `vel` (world-space), `angle`, `angularVel`. The model is a simplified rear-wheel-drive bicycle model with a tire-grip limit, tuned for arcade "somewhat realistic" drift rather than a full rigid-body/tire-slip simulation:

1. **Steering → heading rate**: a target angular velocity is computed from the classic bicycle-model formula (`forwardSpeed / wheelBase * tan(steerAngle)`), then `angularVel` eases toward that target (`chassisResponse`) rather than snapping to it.
2. **Speed-sensitive steering authority**: effective steering angle is scaled down as forward speed rises (`speedSteerFactor` in `stepCar`). Without this, the kinematic formula demands unrealistic (600+ deg/s) turn rates at high speed with full lock — this is the one non-obvious tuning fix in the model, so don't remove it without re-deriving the alternative.
3. **Engine/brake/reverse**: a longitudinal accel/decel applied along the car's forward axis, direction and magnitude chosen from throttle sign and current forward speed (braking vs. reversing).
4. **Drag + rolling resistance**: proportional drag plus a constant rolling-resistance term slow the car when coasting.
5. **Tire grip / drift**: lateral (sideways) velocity is bled off only up to a per-frame max (`maxLateralAccel * dt`). Under normal driving this fully cancels sideways slip; under a sharp turn at speed it can't keep up, so residual lateral velocity persists — that residual *is* the drift.

All tunable constants live in the `CAR` object at the top of `game.js`.

### Collision

Cars use a **capsule** shape for collision: two circles of radius `CAR.capsuleRadius` (half the car's width) offset ±`CAR.capsuleOffset` along the car's heading (`capsuleOffsets`/`capsuleCenters`), which hugs the actual rectangle closely with near-zero overshoot. This precision matters because the parking spots are only just wider than a car — a single fat circle (the original approach) would make them impossible to enter. `resolveCarVsStaticCircle` collides a car's capsule against one static circle (a crate, or one end of a parked car's own capsule) and feeds the resulting push/impulse back into the car's real `pos`/`vel`; `resolveCarVsCar` does all 2×2 circle-pair combinations between two cars. The low-level circle-vs-circle math (penetration separation + restitution impulse) lives in `resolveCircles` and is reused by both.

Off-center hits also spin the car: `applyCollisionSpin` takes the lever arm `r` (car-center to whichever capsule circle just collided) and the velocity delta that circle's impulse produced, and turns `r × Δv` into an `angularVel` change (scaled by `CAR.spinTorqueScale`, clamped to `CAR.maxCollisionSpin`). A dead-center hit (both circles impacted symmetrically) nets ~zero torque by construction — this is what makes a straight-on bump still feel "clean" while a glancing or corner hit visibly spins the car. The spin decays back down on its own afterward through the same `chassisResponse` easing `stepCar` already does toward `desiredAngularVel` (usually ~0 when not steering) — no separate decay logic needed.

Arena walls and the street curb still use a single coarser circle (`CAR.wallRadius` / `CAR.capsuleRadius` respectively, via `resolveWalls` / `resolveCurb`) — precision isn't needed there, they're just "don't leave the play area" bounds.

### Street / parking (`buildStreet`)

A row of parked cars (reusing the same car object shape, just never fed through `stepCar`) is laid out along a curb using a small segment-based DSL: alternating `{t:'car'}`, `{t:'gap', w}` (tight bumper-to-bumper spacing), and `{t:'spot', w}` (an open parking space, recorded for rendering the "P" markings). The row is horizontally centered in the canvas. `resolveCurb` stops cars crossing the curb line into the sidewalk, using the same capsule radius as the curb clearance the parked row itself sits at, so the player can get exactly as close to the curb as the parked cars do — don't switch that back to `wallRadius` (it was, briefly; the coarser radius made the player unable to get as close to the curb as the parked row, effective clearance always ~8px worse than intended).

`crates` (built by `buildCrates`) and `street` both derive their layout from `W`/`H` at build time, and both get rebuilt on window resize (see the `resize` listener near the bottom of the file) — this used to be a "build once, never touch again" design, but that let `street.curbY` (and therefore the coin's spawn range, the curb collision limit, and the drawn sidewalk position) go stale relative to the actual canvas after a resize, which could spawn a coin below the new canvas bottom on a window that got shorter. The resize listener now rebuilds both and re-clamps the active `coin` into the fresh bounds, debounced (200ms) so a window drag doesn't reshuffle parked-car colors on every intermediate frame. If you touch this again: any future per-run-random world content needs the same "rebuild + re-clamp on resize" treatment, or it'll reintroduce the same class of bug.

### Coin race / parallel-park game loop (`updateCoinRace`)

A single shared `coin` (`{x,y}`, module-level) is always present on the map. Eligibility to collect it is per-car, not shared: a car can only pick it up while its own `gameState === "seekCoin"`. Whichever eligible car reaches it first (checked in `car1, car2` order, so simultaneous ties favor P1) scores, flips to `gameState = "mustPark"`, and `spawnCoin()` immediately drops a new coin elsewhere — the *other* car's eligibility never depended on the scorer parking, so it can keep going right away. A car in `"mustPark"` stays locked out of every coin (even ones that spawned after its own pickup) until it independently satisfies `isParked` — stopped (`PARK_SPEED_LIMIT`), aligned with the curb within `PARK_ANGLE_TOLERANCE`, at the parked row's y-offset, centered inside one of `street.parkingSpots` — at which point it flips back to `"seekCoin"` and can grab whatever coin is currently sitting there, and `spawnFirework(car.pos.x, car.pos.y, car.color)` fires as the visible "you parked successfully" cue. This is the key invariant: **each car's own take→park cycle gates only that car**, never the other one. `resetCars` (bound to `R`) resets both scores/states, spawns a fresh coin, and clears `particles`.

### Particles (`spawnFirework` / `updateParticles` / `drawParticles`)

A flat `particles` array (module-level) holds purely cosmetic `"spark"` (radiating, decelerating dot) and `"ring"` (expanding stroked circle) entries, each with its own `life`/`maxLife`; `updateParticles(dt)` ages and prunes them inside the fixed-step `update()` loop (so motion stays smooth regardless of render rate), and `drawParticles()` paints them last in `render()`, on top of everything else. This system never touches car state or game logic — it's purely triggered by (and reacts to) `updateCoinRace`, never the other way around. If another "moment" ever needs celebrating, reuse `spawnFirework` rather than growing a second particle system.

### Rendering

`drawCar` draws each car (player or parked) in its own rotated/translated canvas context: wheels first (front wheels additionally rotated by `car.steerVisual`, a smoothed version of the current steering angle, purely for visual feedback), then the body rectangle, then a cabin/windshield rect to make facing direction readable at a glance. Wheels are drawn with a light outline + center stripe (`drawWheel`) specifically so steering direction stays legible at small sizes against the dark asphalt — keep that contrast if retuning colors. `drawStreet` draws the sidewalk, curb line, dashed centerline, and the "P" spot markings, in that order, before crates and cars are drawn on top.

### Input

A single global `Set` (`keys`) tracks currently-held keys via `keydown`/`keyup` listeners; `readInput(car)` reads throttle/steer from each car's own key bindings (`car.input`). `R` resets both cars to their start positions/orientations. Key handling calls `preventDefault()` only for the specific keys the game uses, so it doesn't swallow other browser shortcuts.
