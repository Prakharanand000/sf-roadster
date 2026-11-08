# World format change: what the map needs from physics (DRAFT, not sent)

From the MAP side, for Prakhar. The full design is in `tools/research/tile-format-proposal.md`; this
note is the short version: what changes, why, and the exact edits on your side.

## In one minute

- **Goal.** Grow the map from northern SF to all of SF, then Oakland, Berkeley and the rest of the
  Bay Area, at true 1:1 scale with lidar-accurate roads.
- **Why today's world can't grow.**
  - It stores positions as int16 quarter-metres, so nothing can be more than 8.2 km from Union Square.
  - It loads everything at once.
  - Its projection constants squash the map by 0.41% north-south and 0.13% east-west (about 40-50 m across SF).
  - Tunnels are dropped, and the Golden Gate is the only bridge deck.
- **The new world ("SFT1").**
  - 512 m tiles that stream in as you drive.
  - A local transverse Mercator projection.
  - Sea level at y = 0.
  - Bridges, viaducts and tunnels as real multi-level surfaces.
- **Your side.** About 10 lines in `vehicle.js`, `ai.js` and `traffic.js`.
  - Every edit is feature-detected, so your code keeps working against today's world, the new one
    and `mockWorld.js`.
  - Either of us can merge first.
- **Contract text.** `tools/contracts-sft1.patch` has the exact `CONTRACTS.md` diff. It is not
  applied: you review it first. Check it with `git apply --check tools/contracts-sft1.patch`.

## Try the lidar pilot first (about 5 minutes)

Nob Hill + FiDi (4 km²) already runs on lidar ground with measured road crowns and curbs. It sits
behind today's API, so it needs no change from you.

```
python tools/serve_nocache.py 8174 .
```

Open http://localhost:8174, choose Free Roam, and drive up California St. Add `?pilot=0` to the URL
to compare against today's ground.

- **Tests:** `node tools/test_pilot.mjs` runs 16 gates.
- **Your AI race on the pilot, unmodified:** `node --import ./tools/pilot_shim/register.mjs dev/physics-ai-sf.mjs nob-hill-jumps`
- **Write-up:** `tools/research/pilot-bake.md`

**What the pilot found that is yours to call:**
1. **Terrain cliffs.** The lidar ground has real retaining walls, up to about 5 m (sunken plazas, the
   Stockton cut, the Nob Hill plateau). `collideCircle` only tests buildings and landmarks, so
   physics treats these walls as very steep ground. Should terrain steps above about 0.5 m become
   wall solids?
2. **AI on Nob Hill is a few seconds slower.** Over 5 seeds it averaged +4 s, with 14 of 15 rivals
   slower, and no more resets or crashes. It is probably the real crests and curbs. Is the
   crest-braking in `ai.js` fine with that?
3. **Curbs** are 9-17 cm (median 13), with a 25 cm-wide bevel. Too harsh or too soft when you hop one?
4. **Jones St at Vallejo** is split-level. Nob Hill Jumps crosses between the two roadways (1.15 m).
   That's ours: we'll re-route the track.

## Decisions we need from you

| | Question | Our proposal |
|---|---|---|
| A | **Datum.** Heights move to "sea level = 0" (NAVD88 − 0.969 m), so everything sits 0.97 m lower than today. | Yes. It keeps `vehicle.js:269` (`inWater` at y < 0.3) correct. |
| B | **Projection.** Positions shift by up to about 45 m when we re-bake. | Fine for physics: nothing under `src/physics` uses lat/lon. We'll grep `dev/` for hard-coded coordinates; tell us if any of yours matter. |
| C | **Physics defaults for 1:1 data.** | Pitched roofs drivable with their real normal (today `vehicle.js:618` forces n.y < 0.75 to straight up). Street props (trees, poles, meters, shelters) as breakable thin solids within 300 m. Speed humps and embedded rails as small profile bumps. Bascule bridges static. |
| D | **Merge order.** | We ship the additive members on today's world first, then re-bake with the new projection, then tiles, then streaming. We run your `dev/physics-ai-*.mjs` at every step. |

## The changes

### No code from you

| # | Change |
|---|---|
| 1 | Projection text → the transverse Mercator above. Nothing under `src/physics` uses lat/lon. |
| 2 | Datum text: sea water stays at y = 0 (decision A). |
| 3 | `surfaceHeight`, `normalAt` and `surfaceAt` cover any number of stacked decks, viaducts, ramps and tunnel floors. Same signatures; identical results outside structures and tunnels. |
| 4 | `heightAt` is bare earth and not a valid floor inside a tunnel (see 5). |
| 8 | Tracks, checkpoints, grid slots and spawn gain y: `[x,z,y]` and `{x,z,y,heading}`. |
| 10 | Optional `ceilingHeight(x,z,y)`: the underside of the deck or tunnel roof above. Use it to cap hop and hover whenever you like. |
| 11 | `collideCircle` also hits pillars, parapets, Jersey barriers and tunnel walls, and adds `out.top`. Optional: use it in place of the re-probe at `vehicle.js:886`. |
| 12 | `surfaceAt` may also return `'brick'` and `'dirt'`. Your `SURFACE_GRIP[s] ?? 1` and `SURFACE_DRAG[s] ?? 0` (`vehicle.js:263-264`) already handle them. |
| 13 | Streaming guarantee: queries stay synchronous and allocation-free, and never throw or return NaN. They are full detail within 1 km and along pinned track corridors. `isLoaded(x,z)` says where. |
| 15 | Kept: `deckAt`, `roadAt`, `roadHit`, `landcoverAt` and `createWorldData(index, buffer)`, so your dev tests keep running. |

### Small edits from you

**5. `floorHeight(x, z)`**, 1 line at `vehicle.js:802`:
```js
const tH = (world.floorHeight || world.heightAt)(com.x, com.z);
```
Inside a tunnel, `heightAt` is the hill above, so today's "never below terrain" clamp would lift
every car out onto the hilltop.

**6. `groundHeight(x, z, yRef)`**, about 4 lines in `ai.js`:
- At :82, pass a y reference: `world.groundHeight(pt.x, pt.z, k === 0 ? seedY : y + 2)`, with
  `seedY = track.path[0][2] ?? world.heightAt(pt.x, pt.z) + 1`.
- In the `gh` helper at :123, pass `this.h[i] + 2` (or `heightAtS(s) + 2`).

Without a y reference, the AI driving under the Bay Bridge approach reads the deck above it as the
road. On the SoMa viaducts it sees fake 10-20 m "steps" and hops. Your fallback at :83 already
chains yRef this way.

**7. Road points become `[x, z, y]` plus `level`** (−1 tunnel, 0 ground, ≥ 1 structure). In `traffic.js`:
- `placeCar` (:181): at :190, seed `car.y` from the interpolated road y instead of `NaN`.
- `_prepRoads` (:121), endpoint links at :137-160: skip a link when its two ends differ in y by
  more than 2 m.

Today `car.y = NaN` makes the first pose use yRef 1e4, so a surface-street car under a viaduct
spawns on the deck. Linking on x/z alone also joins ramps to the streets beneath them. Extra array
elements are ignored by today's `points[i][0]` / `[1]` reads.

**9. `roadsNear(x, z, r, out) → count`.** In `traffic.js` `_spawn` (:200): when `world.roadsNear`
exists, pick from the returned roads, weighted by length, instead of the global table. At
Bay-Area size, uniform sampling with 24 tries succeeds about 9× less often, and traffic would starve.

### Integrator (main.js, not yours)

| # | Change |
|---|---|
| 14 | `world.ensure(region)` before race start, teleports and resets; `isLoaded`, `stats`. |
| | Camera clamp at main.js:159 → `surfaceHeight(x, z, camY)`. |
| | Gate height at main.js:604 → `checkpoint.y`. |
| | Resets at main.js:546/575/581/654/657 pass the slot or road y. |

Later lighting work (`env` gains hour, fog and wetness; `signalPhase`; `lightField`) comes
separately.

`mockWorld.js` needs nothing. For parity you could add `floorHeight = heightAt`,
`ceilingHeight = () => Infinity` and a brute-force `roadsNear`.

## What happens next on the MAP side

Nothing gets pushed to the repo until you've agreed to this.

1. Additive members on today's world: `floorHeight = heightAt`, `groundHeight` with yRef, y on
   roads/tracks/spawn, `roadsNear`, `ceilingHeight = Infinity`, `ensure` resolving at once,
   `isLoaded = true`.
2. Re-bake with the new projection and datum. Rerun your `dev/physics-ai-*.mjs` and the world tests.
3. Tiled world loaded eagerly, parity-tested against the old one (10⁶ random points, every track,
   tile borders exact).
4. Streaming on, then all of SF, then the East Bay.

## Update 2026-10-26: the v2 world exists (behind `?world=v2`)

Steps 2–4 are built without waiting, as a separate world you can try with `?world=v2` on any page
(today's world is untouched without the flag). It needs no code from you, because it works around
the 2D API instead of changing it. Here is what it does, so you can judge whether the edits above
are still wanted:

- **Bay Bridge.** The real west span and YBI tunnel are double-decked. Your `roadAt` and
  `groundHeight` can't tell decks apart, and traffic places cars with `surfaceHeight(x, z, 1e4)`.
  So v2 lays the two directions side by side at the upper deck's height. With `floorHeight`,
  `groundHeight(x, z, yRef)` and y on roads (above), it could be the real double deck.
- **`groundHeight` (used by `ai.js` for track profiles).** Where a deck crosses over a road (the
  Embarcadero under the bridge), v2 follows the level of the previous call when it was within
  12 m. Your 2 m sampling then stays on its road and doesn't hop. A yRef argument would make this
  explicit.
- **`surfaceHeight(x, z, 1e4)` (spawns).** Where roads cross at different levels it returns the
  lowest road surface, so traffic spawned under the bridge stays on the street.
- **YBI tunnel.** The ground is cut to the tunnel floor, so your `heightAt` clamp
  (vehicle.js:802) keeps cars in the bore. The hill is a roof surface that only cars above it see.
- **Additive members.** `roadDeckAt(ri, x, z)` (the road builder draws bridge roads with it),
  `deckSurf`, `streamer` stats, and a seventh track, `bay-bridge-run`.
- **Your AI on v2.** `node --import ./tools/v2_shim/register.mjs dev/physics-ai-sf.mjs all`:
  - all seven tracks finish, with no DNF and no water;
  - resets on today's six tracks (all four cars) are the same as today's world with the pilot (3);
  - Bay Bridge Run has 0 resets.
