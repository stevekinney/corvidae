import {
  EXPECTED_SOURCE_GLOBS,
  checkCoverageRatchet,
} from '@lostgradient/testing/coverage-ratchet';
import { resolve } from 'node:path';

await checkCoverageRatchet({
  packageRoot: resolve(import.meta.dir, '..'),
  expectedSourceGlobs: EXPECTED_SOURCE_GLOBS,
});
