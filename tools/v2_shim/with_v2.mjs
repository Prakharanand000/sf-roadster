// city.js with createWorldData returning the v2 world (see register.mjs), with the lidar tile patches
// (data/v2/lidar/) or else the v2 lidar pilot (data/v2/pilot.*) when present, as the browser loads
// them. PILOT=0 in the environment leaves both out; LIDAR=0 leaves out the patches (the pilot again).
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createWorldData2 } from '../../src/world/v2/city2.js';

export * from '../../src/world/city.js';

// V2_DIR=<folder> races another bake (a backup, for comparisons) instead of data/v2
const dir = process.env.V2_DIR ? pathToFileURL(process.env.V2_DIR.replace(/[\\/]*$/, '/')) : new URL('../../data/v2/', import.meta.url);
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const read = (u) => (existsSync(u) ? ab(readFileSync(u)) : null);

export function createWorldData() {
  const index = JSON.parse(readFileSync(new URL('net.json', dir), 'utf8'));
  let pilot = null, lidar = null;
  if (process.env.PILOT !== '0') {
    if (process.env.LIDAR !== '0' && existsSync(new URL('lidar/index.json', dir))) {
      lidar = {
        index: JSON.parse(readFileSync(new URL('lidar/index.json', dir), 'utf8')),
        bground: read(new URL('lidar/bground.bin', dir)),
        readPatch: (i, j) => read(new URL(`lidar/${i}_${j}.bin.wasm`, dir)),
      };
    } else if (existsSync(new URL('pilot.json', dir))) {
      pilot = { index: JSON.parse(readFileSync(new URL('pilot.json', dir), 'utf8')), buffer: ab(readFileSync(new URL('pilot.bin.wasm', dir))) };
    }
  }
  return createWorldData2(index, ab(readFileSync(new URL('net.bin.wasm', dir))), (i, j) => read(new URL(`tiles/${i}_${j}.bin.wasm`, dir)), pilot, lidar);
}
