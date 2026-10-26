# SF Roadster Rush

A browser 3D street racer set in a real-data San Francisco (OpenStreetMap buildings,
roads and parks on real elevation), with supercars that carry a Tesla-Roadster-style
thruster package: boost, hop onto rooftops, short hover glides.

## Run locally

```bash
cd sf-roadster
python -m http.server 8100
```
Then open http://localhost:8100/play.html (a copy of index.html with a doctype).

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake-reverse | W / S or ↑ / ↓ | RT / LT |
| Steer | A / D or ← / → | Left stick |
| Handbrake drift | Space | X |
| Boost thrusters | Shift | RB or B |
| Thruster hop, hold in air to hover | E | A |
| Camera | C | Y |
| Reset to road | R | |
| Headlights | H | |
| Next song / radio station | M / N | |
| Pause | Esc or P | Start |

## Modules

See CONTRACTS.md. `src/main.js` + `src/env.js` tie the world, cars, physics, audio
and UI modules together.

Fan-made project; not affiliated with any car maker. Map data © OpenStreetMap
contributors (ODbL). Elevation: Mapzen Terrarium / AWS Terrain Tiles. All music is
generated live in the browser; "My Playlist" plays songs from the player's own computer.
