/**
 * Rewrites Bureau's wire goldens, `src/http/__fixtures__/wire-golden/`. Run it from
 * `packages/bureau` after a change that legitimately alters a served document or an error body,
 * and commit the result.
 */

import {
  BUREAU_WIRE_GOLDEN_DIRECTORY,
  writeBureauWireGolden,
} from '../src/http/wire-golden.test-support.ts';

await writeBureauWireGolden(BUREAU_WIRE_GOLDEN_DIRECTORY);
