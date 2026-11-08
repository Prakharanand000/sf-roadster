// Runs any Node world test on the v2 world (data/v2), without editing it:
//   node --import ./tools/v2_shim/register.mjs dev/physics-ai-sf.mjs nob-hill-jumps
// The hook swaps src/world/city.js for with_v2.mjs, whose createWorldData ignores the v1 files the
// caller read and returns the v2 world (tiles load from disk on first touch).
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
