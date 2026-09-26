# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, no-build, top-down 2-player car sandbox. Vanilla HTML/CSS/JS, rendered on a `<canvas>` with `requestAnimationFrame`. Cars are rectangles with visible wheels (front wheels turn with steering); Player 1 drives with WASD, Player 2 with IJKL or the arrow keys. There's a grid of static crates to bump into, a curbside street with parked cars and two marked practice spots for parallel parking, and the two players collide with each other too. AI traffic drives across the street lane above the centerline. Hard hits dent cars, make them smoke, and slow them down; a garage in the bottom-right corner repairs a car for 1 coin.

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

Each car is a plain object with `pos`, `vel` (world-space), `angle`, `angularVel`. The model is a genuine **two-axle dynamic bicycle model** (mass normalized to 1, so tire forces below are directly accelerations) -- not a kinematic approximation with hand-tuned clamps:

1. **Steering rack rate limit**: `car.steerCurrent` (the actual physical steering-rack angle, used by both physics and rendering) chases the raw input target (`steer * CAR.maxSteer * steerLockScale(speed)`, see variable-ratio steering below) at a rate-limited pace rather than snapping to it — and that ramp is deliberately **asymmetric**: slow winding up toward a larger angle (rate `6`), fast winding back down toward center (rate `30`). This is the fix for a real tuning bug: with the rack reacting instantly (as it originally did — only *rendering* was lagged, for visual smoothness), a one-frame tap snapped the front tire straight to a large slip angle and read as absurdly oversensitive ("a quick touch does a 180"). A naive *symmetric* slow ramp made it worse, not better: releasing the key no longer cut off the turn immediately, it left a decaying "tail" of steering angle that kept adding rotation after release, and integrated out to *more* total turn from a quick tap than the instant on/off original had. Asymmetric ramping is what actually fixes it — slow onset tames the tap, fast release stops it promptly once you let go. Don't go back to a single shared rate without re-deriving why (it was tried and made things worse).
2. **Per-axle tire slip → lateral force**: front and rear axle each get a slip angle (`Math.atan2(lateralVel, longitudinalVel)` of that axle's ground-contact velocity, which already includes the `angularVel * perp(r)` contribution from the car's own rotation), turned into a lateral force via `-corneringStiffness * slipAngle`, clamped to that axle's `maxGrip`. `maxGripRear` is set a little below `maxGripFront` on purpose: push a turn too hard and the *rear* breaks loose first (oversteer/drift, tunable/fun), rather than the front just plowing straight (understeer). `corneringStiffness*` is kept low relative to `maxSteer` on purpose too — at a much higher stiffness, saturation (hitting `maxGrip`) was reached at only ~8-9° of slip, well below `maxSteer` (originally ~34°, now ~27° — see the turning-radius note below), so *any* meaningful steering input already commanded the same maximum torque as full lock; there was no proportional/gentle region at all. (Note this alone didn't fix the "quick touch" issue — see point 1's asymmetric rate limit, which is the part that actually did.)
3. **Force → torque → angularVel**: both axle forces act at their `r` offset from the CG (`±wheelBase/2` along heading), so `torque = r_front × F_front + r_rear × F_rear` feeds `angularVel += (torque / CAR.inertia) * dt` (inertia is the standard rectangular-plate yaw-inertia formula). Turning rate is therefore *emergent* from tire grip, not an artificial target the old model had to lerp toward -- a full-lock turn at high speed naturally understeers/drifts once the tires saturate, with no separate speed-based steering-authority taper needed (there used to be one; removing it and letting the grip clamp do that job naturally was the key insight of the original bicycle-model rework -- don't reintroduce it, retune `maxGripFront`/`maxGripRear`/`corneringStiffness*` instead if turn rate needs adjusting).
4. **Low-speed grip fade**: both axle forces are scaled by `min(speed / CAR.lowSpeedGripRef, 1)` to avoid at-rest jitter from a noisy near-zero-speed slip angle -- this is cosmetic/numerical, not a handling feature.
5. **Engine/brake/reverse**: unchanged from before -- a longitudinal accel/decel applied along the car's forward axis at the CG, direction and magnitude chosen from throttle sign and current forward speed (braking vs. reversing). Rear-wheel drive; a pure heading-aligned force at the rear axle produces zero torque either way (r and F parallel), so it's simplest to just add it straight to the CG rather than routing it through the axle-force/torque machinery above.
6. **Drag + rolling resistance + top-speed clamp**: unchanged from before, and deliberately so -- these were already tuned per explicit feedback ("acceleration too fast" / "can't parallel park") and this rework was scoped to *turning* dynamics, not to re-litigate straight-line feel. The top-speed clamp only touches the forward/reverse component; lateral (drift) speed is left alone since it's already grip-limited by the tire model.

Verified via scripted taps at several speeds that a brief (100-200ms) steering tap now produces a small, roughly-proportional heading nudge (single-digit to ~20° depending on speed) instead of tens-to-hundreds of degrees, while a *sustained* 3-second full-lock hold from rest still turns the car through 500°+ — i.e. quick taps got dramatically gentler without blunting sustained turning power.

**Turning radius** is set by `maxSteer` via the kinematic relation `wheelBase / tan(maxSteer)` (measured/confirmed empirically to match the car's actual settled turning circle, not just the kinematic ideal). It was originally 0.6 rad (~34°, radius ≈44px, only ~1.1x the car's own length — very go-kart-tight) and was brought down to 0.38 rad (~22°, radius ≈75-76px, ~1.7x length) after feedback that it turned too sharply, then back up to 0.47 rad (~27°, radius ≈60px, ~1.3x length) after feedback that parallel parking had become too hard. "Make it more oversteered" in that context meant a tighter turning circle, not literal oversteer: parking happens below `lowSpeedGripRef`, where tire forces are faded out and rear-grip balance barely matters. If this needs retuning again, change `maxSteer` alone rather than the tire-grip constants above — grip/stiffness govern *how hard you can push before sliding*, not the car's basic geometric turning circle, and touching them here would re-risk the "quick touch" oversensitivity that was carefully tuned out. A smaller `maxSteer` also makes the marked parallel-parking spots (especially the tight one) require more careful maneuvering, same as a real car with a wider turning circle — that's an expected tradeoff of this change, not a bug.

**Variable-ratio steering** (`steerLockScale`, the `steerLock*`/`steer*Speed` constants in `CAR`): `maxSteer` is the full lock at `steerMidSpeed` (120 px/s). Lock rises to 1.15x at crawl (≤40 px/s) and falls to 0.8x at speed (≥260 px/s), linearly interpolated on `|forwardSpeed|`. It's applied to the rate-limited `steerTarget`, so the asymmetric ramp from point 1 still governs how fast the rack moves. This was added on explicit request ("smaller radius at crawl, larger at speed"). It is *not* the old steering-authority taper that point 3 warns against. That taper was a crutch to keep a kinematic model's turn rate sane at speed. This only reshapes the geometric turning circle, which at crawl speed no grip constant can affect; above that, the tire-grip clamp still decides when a turn slides. Measured settled full-lock radius: ≈52px at crawl (forward or reverse), ≈59px at 100 px/s, ≈65px at 150, ≈72px at ~215 px/s (the fastest speed a full-lock turn can hold). Tune the crawl/fast ends with `steerLockCrawl`/`steerLockFast`, and the overall circle with `maxSteer`.

All tunable constants live in the `CAR` object at the top of `game.js`.

### Ackermann steering geometry (`ackermannWheelAngles`)

The dynamics above treat steering as a single effective front wheel (the standard "bicycle model" simplification) -- Ackermann geometry is specifically about deriving the two *actual* road-wheel angles from that effective angle for correct rolling kinematics, so it's a rendering-only concern layered on top, not a second dynamics path. Given the effective steer angle, `ackermannWheelAngles` computes the turn radius from the rear axle (`wheelBase / tan(steer)`) and returns distinct inner/outer wheel angles (`atan(wheelBase / (radius ∓ track/2))`) so the wheel on the inside of the turn visibly cranks over further than the outside one, same as a real front axle. `drawCar` calls it with `car.steerCurrent` (the same rate-limited angle the dynamics use — there's only one steering-angle value now, not a separate physics-vs-rendering pair) so the visual always matches what the tires are actually doing. Getting the left/right assignment right depends on the world-space handedness already established by `capsuleOffsets`/`right = {-forward.y, forward.x}` -- see the comment in `ackermannWheelAngles` before changing the sign logic, it's easy to mirror by accident.

### Collision

Cars use a **capsule** shape for collision: two circles of radius `CAR.capsuleRadius` (half the car's width) offset ±`CAR.capsuleOffset` along the car's heading (`capsuleOffsets`/`capsuleCenters`), which hugs the actual rectangle closely with near-zero overshoot. This precision matters because the parking spots are only just wider than a car — a single fat circle (the original approach) would make them impossible to enter. `resolveCarVsStaticCircle` collides a car's capsule against one static circle (a crate, or one end of a parked car's own capsule) and feeds the resulting push/impulse back into the car's real `pos`/`vel`; `resolveCarVsCar` does all 2×2 circle-pair combinations between two cars. The low-level circle-vs-circle math (penetration separation + restitution impulse) lives in `resolveCircles` and is reused by both, but each caller passes its own coefficient of restitution rather than a shared hardcoded one: `CAR.carCollisionRestitution` (0.85, high on purpose — ramming a stationary car should send it flying, verified this transfers ~86% of the striker's kinetic energy to it) for `resolveCarVsCar`, and the lower/more-damped `CAR.obstacleCollisionRestitution` (0.5, unchanged from the original tuning) for `resolveCarVsStaticCircle` (crates and parked cars) — don't let these drift back into a single shared constant, they're intentionally different.

Off-center hits also spin the car: `applyCollisionSpin` takes the lever arm `r` (car-center to whichever capsule circle just collided) and the velocity delta that circle's impulse produced, and turns `r × Δv` into an `angularVel` change (scaled by `CAR.spinTorqueScale`, clamped to `CAR.maxCollisionSpin`). A dead-center hit (both circles impacted symmetrically) nets ~zero torque by construction — this is what makes a straight-on bump still feel "clean" while a glancing or corner hit visibly spins the car. The spin decays back down on its own afterward through the same tire-force/torque dynamics `stepCar` already runs every frame (a spinning car develops slip angles at both axles, which generate a restoring torque) — no separate decay logic needed. This system is independent of the physics model above (it only ever reads/writes `car.vel`/`car.angularVel`/`car.pos`), so it survived the two-axle dynamics rework unchanged.

Arena walls and the street curb still use a single coarser circle (`CAR.wallRadius` / `CAR.capsuleRadius` respectively, via `resolveWalls` / `resolveCurb`) — precision isn't needed there, they're just "don't leave the play area" bounds. They don't go through `resolveCircles` at all (no obstacle to push apart from, just a boundary to clamp against), so their bounce isn't a real restitution coefficient — it's a flat "reflect the offending velocity component at `CAR.wallBounce` (0.75) of its incoming magnitude" for the arena walls specifically (bumped up from 0.4 per feedback that wall hits should bounce more). `resolveCurb` keeps its own separate, still-low `0.4` factor rather than sharing `wallBounce` — a hard bounce off the curb while trying to park would fight the whole point of that boundary, which is to let you snug right up to it.

### Street / parking (`buildStreet`)

A row of parked cars (reusing the same car object shape, just never fed through `stepCar`) is laid out along a curb using a small segment-based DSL: alternating `{t:'car'}`, `{t:'gap', w}` (tight bumper-to-bumper spacing), and `{t:'spot', w}` (an open parking space, recorded for rendering the "P" markings). The row is horizontally centered in the canvas. `resolveCurb` stops cars crossing the curb line into the sidewalk, using the same capsule radius as the curb clearance the parked row itself sits at, so the player can get exactly as close to the curb as the parked cars do — don't switch that back to `wallRadius` (it was, briefly; the coarser radius made the player unable to get as close to the curb as the parked row, effective clearance always ~8px worse than intended).

`crates` (built by `buildCrates`) and `street` both derive their layout from `W`/`H` at build time, and both get rebuilt on window resize (see the `resize` listener near the bottom of the file) — this used to be a "build once, never touch again" design, but that let `street.curbY` (and therefore the coin's spawn range, the curb collision limit, and the drawn sidewalk position) go stale relative to the actual canvas after a resize, which could spawn a coin below the new canvas bottom on a window that got shorter. The resize listener now rebuilds both and re-clamps the active `coin` into the fresh bounds, debounced (200ms) so a window drag doesn't reshuffle parked-car colors on every intermediate frame. If you touch this again: any future per-run-random world content needs the same "rebuild + re-clamp on resize" treatment, or it'll reintroduce the same class of bug.

### Coin race / parallel-park game loop (`updateCoinRace`)

A single shared `coin` (`{x,y}`, module-level) is always present on the map. Eligibility to collect it is per-car, not shared: a car can only pick it up while its own `gameState === "seekCoin"`. Whichever eligible car reaches it first (checked in `car1, car2` order, so simultaneous ties favor P1) scores, flips to `gameState = "mustPark"`, and `spawnCoin()` immediately drops a new coin elsewhere — the *other* car's eligibility never depended on the scorer parking, so it can keep going right away. A car in `"mustPark"` stays locked out of every coin (even ones that spawned after its own pickup) until it independently satisfies `isParked` — stopped (`PARK_SPEED_LIMIT`), aligned with the curb within `PARK_ANGLE_TOLERANCE`, at the parked row's y-offset, centered inside one of `street.parkingSpots` — at which point it flips back to `"seekCoin"` and can grab whatever coin is currently sitting there, and `spawnFirework(car.pos.x, car.pos.y, car.color)` fires as the visible "you parked successfully" cue. This is the key invariant: **each car's own take→park cycle gates only that car**, never the other one.

Coins don't appear instantly. `spawnCoin` sets `coin.age = 0` and calls `spawnImplosion`, a "reverse explosion" of sparks spiraling in onto the spot. `updateCoin` pops the coin in with a flash and ring at `COIN_IMPLODE_TIME` (0.6s), and `drawCoin` scales it in with an overshoot (`popScale`). The coin is **not collectable until it has popped** (`coinCollectable`, checked in `updateCoinRace`), so nobody can grab an invisible coin. `setupWorld` clears `particles` *before* the first `spawnCoin`; the other order silently wipes the first coin's animation. There is no in-game reset (the old `R` key / `resetCars` was removed as UI clutter); reloading the page is the reset.

### Collision damage (`applyDamage`) and the garage (`updateGarage`)

`resolveCircles` returns the closing speed along the contact normal. `resolveCarVsStaticCircle` and `resolveCarVsCar` take the hardest hit across their capsule-circle pairs and apply damage once (so a hit touching both circles isn't counted twice); in a car-vs-car hit both cars take damage. `resolveWalls` and `resolveCurb` feed the incoming normal speed into `applyDamage` directly. Damage (`car.damage`, 0..1) only accrues above `DAMAGE_THRESHOLD`, so parking nudges and curb snugging are free. Each hit leaves a dent (`car.dents`, stored in car-local coordinates so it rotates with the body, drawn clipped to the body in `drawCar`).

Damage has two effects:
- **Slowdown:** `stepCar` scales engine/reverse power and the forward/reverse top-speed clamp by `carHealth(car)` (down to 40% at full damage). Braking is left alone, so a wrecked car can still stop.
- **Smoke:** `emitSmoke` adds `"smoke"` particles just behind the rear bumper, more and darker as damage grows.

This applies to every moving car, NPCs included.

The garage lives in `street.garage`, so it's rebuilt on resize along with the rest of the street. The building sits on the sidewalk in the bottom-right corner, with a service pad on the road in front of it. A *player* that stops on the pad (`GARAGE_SPEED_LIMIT`) with any damage and at least `REPAIR_COST` coins pays and is fully repaired (`repairCar`). With no coins, the pad's border flashes red instead (`garageDenied`). The garage carries no text: the pad shows a wrench (`drawWrench`) next to a coin. Coins are the same `car.score` the coin race awards, so repairs compete with score.

### NPC traffic (`updateTraffic` / `npcDrive`)

AI cars (`npcs`, module-level) spawn as a Poisson process (`NPC_SPAWN_MEAN`, ~10s average), enter from just off the left or right edge, and drive the lane at `street.npcLaneY`, just above the dashed centerline (`street.centerlineY`, also used by `drawStreet`). They're ordinary car objects running through the same `stepCar` physics and all the same collisions as the players; the only difference is that `readInput` returns `car.drive` (set each step by `npcDrive`) instead of reading keys. The one exception is `resolveWalls`: NPCs aren't fenced in by the arena, and `updateTraffic` removes them once they're well outside the canvas.

`npcDrive` steers toward a point `NPC_LOOKAHEAD` ahead along the lane. That both holds the lane and, after a hit, turns the car back around onto it. NPCs are **deliberately mediocre drivers**, per feedback that they recovered from hits too quickly and competently:
- **Lazy steering:** a low `NPC_STEER_GAIN` and a long lookahead, so they rejoin the lane in a wide, sloppy arc.
- **Dazed after a hit:** a jolt (velocity change > `NPC_JOLT` in one step, which only a collision produces) leaves them coasting with the wheel straight for 1.5–3.5s.
- **Slow when lost:** target speed eases from cruise down to a crawl (`NPC_LOST_SPEED`) the further off the lane they are, and they crawl whenever turned around.

Headless measurements: recovery takes ~3–8.5s back to the lane (it was ~1–3.5s); undisturbed cars still hold the lane exactly.

Blocking and getting unstuck:
- **Braking:** they brake for any car within `NPC_BRAKE_DIST` in their path, never reversing into a queue. In the lane they wait behind a blocker. Off the road (`lost`) they creep around it instead. Waiting there loops forever, because the lane point they aim for can sit right behind the blocker.
- **Stopped too long** (1.5s wedged, 3s waiting behind a car): they back up at *full* opposite lock for 1s and retry. It has to be full lock: the lazy steering gain alone backs out nearly straight and drives right back into the same spot.

Without these, a car knocked off the road can wait forever behind a player who isn't moving. That was reproduced headlessly while tuning.

There's only one traffic lane, so `spawnNpc` gives a new car the same direction as any traffic already on screen, and picks a random direction only when the road is empty. This prevents head-on meetings.

`resetTraffic` runs from `setupWorld`. It sets the spawn timer to 0, so the first car rolls in immediately on start; only later spawns follow the random schedule. On resize, NPCs are shifted by the change in `npcLaneY` so they stay in the lane.

### Particles (`spawnFirework` / `updateParticles` / `drawParticles`)

A flat `particles` array (module-level) holds purely cosmetic entries, each with its own `life`/`maxLife`, of seven types — `"implode"` (a coin-spawn spark whose position is a pure function of `life/maxLife` via `implodePos`, not integrated velocity; it starts at negative `life` for a staggered launch, and `drawParticles` skips anything with `life < 0`), `"smoke"` (a drifting, expanding gray puff, emitted by damaged cars via `emitSmoke`) plus these five: `"spark"` (radiating, decelerating dot), `"streak"` (same motion, drawn as a short trailing line along its velocity instead of a dot), `"ring"` (expanding stroked circle), `"flash"` (a fast-fading radial-gradient glow for the initial "pop"), and `"delayedBurst"` (an invisible timer-only marker -- when it expires, `updateParticles` spawns a smaller `spawnSecondaryPop` burst at a jittered offset, which is what gives the firework its two-stage "pop-pop" read instead of one flat burst). `updateParticles(dt)` ages, moves, and prunes all of these inside the fixed-step `update()` loop (so motion stays smooth regardless of render rate); `drawParticles()` paints them last in `render()`, on top of everything else, and resets `ctx.lineCap` afterward since the `"streak"` render sets it to `"round"` and nothing else in the file wraps its own drawing in `save()`/`restore()`. This system never touches car state or game logic — it's purely triggered by game logic (`updateCoinRace`, `updateGarage`, `emitSmoke`), never the other way around. If another "moment" ever needs celebrating, reuse `spawnFirework` rather than growing a second particle system.

### Rendering

`drawCar` draws each car (player or parked) in its own rotated/translated canvas context: wheels first, then the body rectangle, then a cabin/windshield rect to make facing direction readable at a glance. The two front wheels get distinct angles from `ackermannWheelAngles(car.steerCurrent, ...)` rather than sharing one — see the Ackermann section above. Wheels are drawn with a light outline + center stripe (`drawWheel`) specifically so steering direction stays legible at small sizes against the dark asphalt — keep that contrast if retuning colors. `drawStreet` draws the sidewalk, curb line, dashed centerline, and the "P" spot markings, in that order. `drawParkingTargets` and `drawGarage` follow, and then crates and cars are drawn on top.

### HUD and on-screen text: keep it minimal

On-screen text was deliberately cut down after feedback that the game felt like an airport full of signs. The rule: **show game state in the world, not as text**.
- **Players' HUD:** each player gets a small badge with their label and coin count (`updateHud`). The key hint ("P1 — WASD") shows only until that player first drives (`car.hasDriven`, set in `readInput`).
- **Bottom hint line:** the only instructions. It fades out (`updateHint`, CSS `.hint.faded`) after `HINT_SECONDS` of `gameTime` or at the first coin pickup.
- **In-world cues instead of status text:**
  - A player who must park sees every open P spot pulse in their color (`drawParkingTargets`).
  - A badly damaged player (`damage >= GARAGE_HINT_DAMAGE`, 0.3; it was 0.5, which felt like "almost totalled" before the cue appeared) sees the garage pad pulse in their color. The pad's pulse rect is grown 4px outward so its outline frames the dashed hazard border instead of hiding under it.
  - A player who can't afford a repair sees the garage pad's border flash red. It's drawn on top of the pulse, so it wins.

  Both pulses use the shared `drawTargetPulse(cars, rects)` helper. With two cars, their pulses run half a cycle apart so the colors alternate. Reuse it for any future "go here" cue rather than inventing a new one.

There's no speedometer and no in-game reset.

Before adding a new text label or HUD line, look for an in-world way to show the same thing.

### Input

A single global `Set` (`keys`) tracks currently-held keys via `keydown`/`keyup` listeners; `readInput(car)` reads throttle/steer from each car's own key bindings (`car.input`, where each direction is an array of key names so a player can have alternate keys, like P2's IJKL + arrows). Keys are stored lowercased (`"arrowup"`, not `"ArrowUp"`); any new binding also needs adding to `CONTROL_KEYS` so it gets `preventDefault()` (for arrows, that's what stops the page from scrolling). Key handling calls `preventDefault()` only for the specific keys the game uses, so it doesn't swallow other browser shortcuts.
