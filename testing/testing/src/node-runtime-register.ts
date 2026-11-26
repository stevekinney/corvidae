import { registerHooks } from 'node:module';

const shimUrl = new URL('./node-runtime-shim.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'bun:test') return { url: shimUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
