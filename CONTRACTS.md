# SF Roadster Rush — module contracts

A browser 3D street-racing game set in a real-data San Francisco. Supercars with a
Tesla-Roadster-style "thruster package": cold-gas boost, thruster hops onto rooftops,
short hover glides. NOT full flight — cars are ground vehicles that can hop and glide.

Every module author MUST follow this file exactly. If something here is ambiguous, pick
the simplest reading, implement it, and document the choice at the top of your module.

## Tech + hard rules

- Plain ES modules, no build step, no bundler. Three.js **r160** via import map:
  ```html
  <script type="importmap">{"imports":{
    "three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
  ```
  Import as `import * as THREE from 'three'` and `import { X } from 'three/addons/...'`.
  No other external libraries. No other network hosts at runtime: the game is published
  in a sandbox where `fetch()` works ONLY for files shipped next to `index.html`
  (relative URLs). Textures must be generated procedurally (canvas / DataTexture) or be
  files inside this folder. No copyrighted audio, models, or images may be bundled.
- Folder layout (relative to `sf-roadster/`):
  ```
  index.html            integrator (lead)
  styles.css            UI agent
  src/main.js           integrator: loop, state machine, camera, input, race logic
  src/env.js            integrator: sky, sun, fog, day/night, post-processing
  src/world/*.js        MAP agent   (entry: src/world/city.js)
  data/*                MAP agent   (baked SF data files)
  tools/*               MAP agent   (Node/Python bake scripts, not shipped to players)
  src/cars/*.js         CARS agent  (entry: src/cars/models.js, src/cars/fx.js, src/cars/showroom.js)
  src/physics/*.js      PHYSICS agent (entry: src/physics/vehicle.js, ai.js, traffic.js)
  src/audio/*.js        AUDIO agent (entry: src/audio/audio.js)
  src/ui/*.js           UI agent    (entry: src/ui/ui.js)
  dev/*.html            any agent's standalone test pages (not shipped)
  ```
  Only write inside your own area. `sf-roadster/package.json` has `"type":"module"` so
  `node --check src/foo.js` works for syntax checks.
- Performance target: 60 fps on a mid-range Windows laptop GPU at 1080p, "high" quality.
  Merge geometry, use InstancedMesh, avoid per-frame allocations (reuse Vector3s).
- No `alert/confirm/prompt`. Wrap any `localStorage` access in try/catch.
- Never put API keys or secrets anywhere in this project.

## Coordinates and units (everyone)

- Meters, seconds, radians, Y up. Water level is `y = 0`.
- Geographic origin = Union Square, `LAT0 = 37.7880, LON0 = -122.4075`.
  `x = (lon - LON0) * 111320 * cos(LAT0 * PI/180)` (east is +x)
  `z = -(lat - LAT0) * 110540` (north is -z, south is +z)
- **Heading** `h` is a rotation about +Y. A car with heading `h` faces world direction
  `forward = (sin h, 0, cos h)`. So `object.rotation.y = h` points a model's local +Z
  along forward. Heading 0 faces south (+z); heading PI faces north.
- **Car local frame**: forward = +Z, up = +Y, **left = +X**, right = -X.
  Origin is on the ground plane (bottom of tires at y=0), centered between the axles.
- Steering input/angle: positive = turn toward the driver's RIGHT. Visually a front
  wheel pivot turned right has `pivot.rotation.y = -steerAngle`.
- Wheel order everywhere: `[FL, FR, RL, RR]` = `[(+x,+z), (-x,+z), (+x,-z), (-x,-z)]`.
- Wheel spin: rolling forward means `wheel.rotation.x += (forwardSpeed / radius) * dt`.

## MAP agent — `src/world/city.js`

```js
export async function loadWorld(scene, { quality = 'high', onProgress } = {}) // -> World
```
`onProgress(fraction 0..1, message)`. The World object:

| member | meaning |
|---|---|
| `heightAt(x, z)` | terrain (ground) height, no buildings/bridges. Over water returns seabed (<0). |
| `surfaceHeight(x, z, yRef)` | highest drivable surface at (x,z) whose height is <= `yRef + 0.75`: terrain, bridge decks, flat building roofs. Physics uses this for ground contact so cars can land on rooftops and drive on the Golden Gate deck. |
| `normalAt(x, z, yRef)` | unit THREE.Vector3 normal of that same surface (write into an optional 4th arg `out`). |
| `surfaceAt(x, z, yRef)` | `'road' | 'sidewalk' | 'grass' | 'sand' | 'roof' | 'bridge' | 'water'` |
| `isWater(x, z)` | true when terrain at (x,z) is below water level and no deck covers it |
| `collideCircle(x, z, r, y, out)` | walls only. Tests a circle (car footprint radius r, car base at height y) against building footprints and solid landmark parts whose top is > `y + 0.75`. Returns `null` or `out` filled as `{ nx, nz, depth }` (push direction, unit, in XZ) for the deepest hit. Must be fast (spatial hash), called ~8x per car per frame. |
| `bounds` | `{ minX, maxX, minZ, maxZ }` playable area (physics clamps to it) |
| `roads` | `[{ points: [[x,z],...], width, type, name, oneway }]` simplified road centerlines (for minimap, traffic, AI) |
| `roadGraph` | optional; `{ nodes:[[x,z]], edges:[[a,b,len]] }` |
| `tracks` | see below |
| `spawn` | `{ x, z, heading }` free-roam start on a road |
| `landmarks` | `[{ id, name, x, z, radius, blurb }]` for free-roam discovery |
| `minimapImage` | optional `HTMLCanvasElement` top-down render of land/water/parks/roads covering `bounds` |
| `update(dt, camera, env)` | per-frame: water animation, chunk visibility/LOD. `env = { night: 0..1, time }` |
| `setNight(n)` | 0 = day, 1 = full night: window emissive glow, street lights intensity |
| `dispose()` | optional |

Track object:
```js
{ id, name, area, description, laps,          // laps >= 1; laps === 1 && !loop -> point-to-point
  loop: bool,                                  // true = circuit
  path: [[x,z], ...],                          // dense centerline (every ~8 m) along real streets
  checkpoints: [{ x, z, heading, width }],     // ordered gates ON the path, every ~150-250 m; last one = finish for point-to-point
  grid: [{ x, z, heading }] * 6,               // starting slots, 2 columns, on the road, facing along path
  lengthMeters, difficulty: 1..5 }
```
Required tracks (use real street routing via the OSM road graph): Embarcadero Sprint
(Fisherman's Wharf -> Embarcadero -> Ferry Building -> Oracle Park), Lombard Zigzag
(Russian Hill circuit incl. the crooked block of Lombard St and Hyde St), Golden Gate Run
(Marina -> Crissy Field/Presidio -> across the Golden Gate Bridge deck to past the north
tower), Nob Hill Jumps (steep streets: California, Taylor, Jones, Filbert-style hill crests),
Downtown Grand Prix (FiDi: Market, Montgomery, Columbus near Transamerica, Embarcadero),
Painted Ladies Tour (Alamo Square, the Panhandle, edge of Golden Gate Park).

## CARS agent — `src/cars/models.js`, `src/cars/fx.js`, `src/cars/showroom.js`

```js
export const CARS = [ CarSpec, ... ]
export function createCarModel(id, { color, quality = 'high' } = {}) // -> CarModel
export function createTrafficCarModel(seed)                          // -> CarModel (cheap, low poly)
```
CarSpec:
```js
{ id, name, make, tagline, engine: 'electric'|'flat6'|'v8'|'v10'|'v12'|'w16'|'hybrid-v8',
  colors: ['#hex', ...]  /* first = default */,
  stats: { speed, accel, handling, thrusters } /* 0..10 for UI bars */,
  dims: { length, width, height, wheelBase, track, wheelRadius, rideHeight },
  physics: { mass /*kg*/, maxSpeed /*m/s*/, engineForce /*N*/, brakeForce /*N*/,
             gripFront, gripRear /* lateral grip ~ 1.0-1.6 g */, steerMax /*rad*/,
             driftFactor /* 0..1 how easily the rear slides */, downforce,
             thrusterCapacity /* seconds of full thrust */, thrusterForce /*N*/,
             jumpImpulse /* m/s vertical velocity added by a hop */, gears: 7 } }
```
Required cars (fan-made likeness, original procedural geometry, no logos):
`roadster` Tesla Roadster (2nd gen, SpaceX package; best thrusters), `gt3rs` Porsche 911
GT3 RS, `amgone` Mercedes-AMG ONE, `720s` McLaren 720S, `revuelto` Lamborghini Revuelto,
`sf90` Ferrari SF90 Stradale, `chiron` Bugatti Chiron, `nevera` Rimac Nevera.

CarModel:
```js
{ group,            // THREE.Group, car local frame as above; add to scene, set position/quaternion
  body,             // Object3D containing all non-wheel parts (physics may tilt it slightly for lean)
  wheelPivots: [FL, FR, RL, RR],  // Object3D at each hub; physics sets .position.y (suspension) and .rotation.y (front steer)
  wheels: [FL, FR, RL, RR],       // children of the pivots; physics sets .rotation.x (spin)
  wheelBaseY,       // rest y of the pivots (hub height at rest)
  thrusterNozzles: [Object3D],    // rear/underbody nozzle anchors (local), used by fx
  setColor(hex), setBrake(on: bool), setHeadlights(on: bool), setReverse(on: bool),
  setThruster(level 0..1, mode 'boost'|'hover'), // drives built-in flame/glow meshes
  dispose() }
```
`src/cars/fx.js`:
```js
export class CarFX {
  constructor(scene)
  add(carModel)              // returns handle
  update(dt, handle, state)  // state = Vehicle public state (see PHYSICS), draws tire smoke, skid marks, boost trail, landing dust, water splash
  burst(type, position)      // 'collision' sparks | 'land' dust | 'splash' | 'checkpoint' glow
  clear() }
```
`src/cars/showroom.js`:
```js
export function createShowroom() // -> { group, carAnchor /*Object3D on turntable*/, cameraPos /*Vector3*/, cameraTarget /*Vector3*/, update(dt), setVisible(bool) }
```
The showroom is placed by its author at world position (0, -2000, 0) (far below the city)
with its own lights, so it never interferes with the city; the integrator toggles visibility.

## PHYSICS agent — `src/physics/vehicle.js`, `ai.js`, `traffic.js`

```js
export class Vehicle {
  constructor(spec /* CarSpec */, world /* World */)
  reset(x, z, heading, y /* optional; default world.surfaceHeight(x,z,1e4) */)
  update(dt, input)            // fixed-step internally (substep at 120 Hz)
  applyToModel(carModel)       // sets group position/quaternion, wheels, steer, suspension, body lean, brake/reverse lights, thruster level
  // public state (read-only for others):
  position /*Vector3*/, quaternion, velocity /*Vector3*/, heading,
  speed /* m/s along forward, signed */, speedKmh, rpm /* 0..1 */, gear, throttle,
  onGround, airTime, drifting, driftAngle, slip /* 0..1 */, boosting, hovering,
  thrusterFuel /* 0..1 */, wheelContacts: [{ x, y, z, onGround, slip }] * 4,
  surface /* from world.surfaceAt */, inWater, lastImpact /* N of last collision this frame or 0 */,
  // event hooks (set by integrator, may be null):
  onCollision(impactStrength 0..1, point), onLand(strength 0..1), onJump(), onSplash()
}
```
Input object (built by integrator from keyboard/gamepad/touch):
`{ throttle 0..1, brake 0..1, steer -1..1, handbrake bool, boost bool, jump bool (held), jumpPressed bool (edge, true for one frame) }`
Arcade-sim feel: speed-sensitive steering, weight transfer, drift with handbrake and
counter-steer, drift charges `thrusterFuel`, boost uses fuel, `jumpPressed` while on ground
= thruster hop (vertical impulse, can reach low rooftops), holding `jump` in the air = hover
(gravity reduced, fuel drains, max ~2 s total). Gravity 9.81 (feel free to use ~1.4x for snappy
landings). Cars must climb SF hills, catch air over crests, land on roofs, bounce off walls,
and never tunnel through buildings at 300 km/h.

```js
export function resolveVehicleCollisions(vehicles /* Vehicle[] incl. traffic proxies */) // circle/OBB pushes + impulses
export class AIDriver {
  constructor(vehicle, track, { skill 0..1, aggression 0..1, name })
  getInput(dt, world, others /* Vehicle[] */) // -> input object; follows track.path with lookahead, brakes for corners, uses boost on straights, rubber-banding
  progress                                    // distance along path (m), updated in getInput
}
export class Traffic {
  constructor(scene, world, createTrafficCarModel, { count })
  update(dt, playerVehicle)   // kinematic cars on world.roads, yield/stop when near player, respawn far away
  setEnabled(bool)
  proxies                     // collision stand-ins compatible with resolveVehicleCollisions
  nearMissCheck(playerVehicle) // -> number of new near misses this frame
}
```

## AUDIO agent — `src/audio/audio.js`

```js
export class AudioSystem {
  constructor()
  unlock()                                   // create/resume AudioContext; call from a user gesture
  setVolumes({ master, music, sfx })         // 0..1
  setEngineProfile(engine /* CarSpec.engine */)
  updateEngine({ rpm, throttle, speed, gear, boosting, hovering, onGround, slip, inWater }) // every frame
  play(name, { intensity = 1 } = {})         // 'collision','land','jump','boost','checkpoint','lap','countdown','go','finish','splash','nearmiss','discover','ui-click','ui-hover','gear'
  setRadio(station)                          // 'bollywood-fm' (generative), 'my-playlist', 'off'
  nextTrack(); prevTrack()
  addUserFiles(fileList)                     // user's own MP3/M4A/OGG files -> 'my-playlist'
  onTrackChange = null                       // (info: { title, artist, station }) => void
  duck(amount 0..1)                          // lower music (e.g. pause menu, countdown)
  setPaused(bool)
}
```
"Bollywood FM" must be generated live with Web Audio (no samples bundled): dhol/tabla
patterns (keherwa, dadra, bhangra chaal), tanpura drone, sitar-like plucked lead
(Karplus-Strong with meend pitch slides), shehnai/flute-like lead, string pads, bass,
claps, in real raag scales; several distinct "songs" with fun Hinglish SF-themed titles.

## UI agent — `src/ui/ui.js` + `styles.css`

```js
export class UI {
  constructor(root /* HTMLElement overlay, pointer-events managed by UI */, callbacks)
  show(screen) // 'loading'|'menu'|'garage'|'tracks'|'hud'|'pause'|'results'|'settings'|'controls'|'none'
  setLoading(fraction, message)
  setCars(CARS); setTracks(tracks); setSelectedCar(id, color)
  updateHUD(h)  // per frame, cheap DOM writes only when values change
  countdown(n)  // 3,2,1,0 (0 = GO)
  toast(text, kind /* 'info'|'good'|'warn'|'discover'|'music' */, ms)
  showResults(r)
  setMinimap(world)             // uses world.bounds, world.roads, world.minimapImage
  updateMinimap(m)              // { player:{x,z,heading}, rivals:[{x,z,heading}], checkpoints:[{x,z}], next: index, landmarks:[{x,z,found}] }
  setNowPlaying({ title, artist, station })
  getTouchInput()               // -> input object or null when not a touch device / not active
  getSettings(); setSettings(s)
}
```
`h` = `{ mode:'race'|'free'|'trial', speed, units:'kmh'|'mph', gear, rpm, boost /*fuel 0..1*/,
boosting, hovering, lap, laps, position, racers, raceTime, lapTime, bestLap, checkpoint,
checkpoints, nextDir /*radians relative to camera, for the arrow*/, nextDist, drift /*current combo*/,
score, message, landmarksFound, landmarksTotal }`.
Results `r` = `{ trackName, position, time, bestLap, standings:[{ name, car, time, isPlayer }], score }`.
Callbacks the UI calls: `onStartRace({ trackId, mode: 'race'|'trial', carId, color, rivals, laps })`,
`onFreeRoam({ carId, color })`, `onGarageCar(carId, color)` (preview change), `onGarageOpen()`,
`onGarageClose()`, `onResume()`, `onRestart()`, `onQuit()`, `onSettings(settings)`,
`onRadio(station)`, `onNextTrack()`, `onPrevTrack()`, `onMusicFiles(fileList)`, `onUIClick()`, `onUIHover()`.
Settings = `{ quality:'low'|'medium'|'high', units, master, music, sfx, camera:'chase'|'far'|'hood',
traffic: bool, timeOfDay:'auto'|'dawn'|'day'|'golden'|'night', fog: bool /* Karl the Fog */, rivals: 1..7 }`.

## Controls (integrator implements; UI shows them)

W/↑ throttle · S/↓ brake/reverse · A/D or ←/→ steer · Space handbrake/drift ·
Shift boost thrusters · E (hold in air) thruster hop / hover · C camera · R reset to road ·
H headlights · M next song · N radio station · Esc/P pause.
Gamepad: RT throttle, LT brake, left stick steer, X handbrake, RB/B boost, A hop/hover, Y camera, Start pause.
