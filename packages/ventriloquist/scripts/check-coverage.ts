import { checkCoverageRatchet } from '@lostgradient/testing/coverage-ratchet';
import { resolve } from 'node:path';

await checkCoverageRatchet({
  packageRoot: resolve(import.meta.dir, '..'),
  expectedSourceGlobs: ['src/**/*.ts', 'src/**/*.svelte'],
});
