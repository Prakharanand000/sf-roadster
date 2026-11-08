// Runs any Node world test with the pilot overlay loaded, without editing it:
//   node --import ./tools/pilot_shim/register.mjs dev/physics-ai-sf.mjs nob-hill-jumps
// The hook swaps src/world/city.js for with_pilot.mjs, whose createWorldData adds data/pilot.*.
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
