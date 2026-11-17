import { plugin } from 'bun';
import { afterEach } from 'bun:test';

import { registerGlobalCleanup, setupHappyDom, sveltePlugin } from '@lostgradient/testing';

// The panels render Svelte components into a `document`, so their tests need one, and Bun needs
// the compiler for `.svelte` files and rune modules. Both are installed before any test file's
// imports resolve; run the tests with the `browser` and `svelte` conditions (the package script).
setupHappyDom();

await plugin(sveltePlugin({ generate: 'client' }));

// One cleanup after every test, so a mounted panel never outlives the test that rendered it.
await registerGlobalCleanup(afterEach);
