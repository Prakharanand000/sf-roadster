// city.js with createWorldData loading data/pilot.json + pilot.bin.wasm (see register.mjs).
import { readFileSync } from 'node:fs';
import * as city from '../../src/world/city.js';

export * from '../../src/world/city.js';

const data = new URL('../../data/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('pilot.json', data), 'utf8'));
const bin = readFileSync(new URL('pilot.bin.wasm', data));
const pilot = { index, buffer: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) };

export function createWorldData(worldIndex, buffer) {
  return city.createWorldData(worldIndex, buffer, pilot);
}
