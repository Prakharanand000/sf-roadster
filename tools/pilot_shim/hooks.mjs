// Module hook for register.mjs: every import of src/world/city.js gets with_pilot.mjs instead
// (except the import inside with_pilot.mjs itself).
const SHIM = new URL('./with_pilot.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (r.url.endsWith('/src/world/city.js') && context.parentURL !== SHIM) return { ...r, url: SHIM, shortCircuit: true };
  return r;
}
