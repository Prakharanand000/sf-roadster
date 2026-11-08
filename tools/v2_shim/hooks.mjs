// Module hook for register.mjs: imports of src/world/city.js from outside src/world get with_v2.mjs
// (the world modules themselves, and with_v2.mjs, keep the real one).
const SHIM = new URL('./with_v2.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  const parent = context.parentURL || '';
  if (r.url.endsWith('/src/world/city.js') && parent !== SHIM && !parent.includes('/src/world/')) return { ...r, url: SHIM, shortCircuit: true };
  return r;
}
