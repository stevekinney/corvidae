/**
 * Rewrites the wire goldens Weft owns: `src/server/__fixtures__/wire-golden/`. Run it from
 * `packages/weft` after a change that legitimately alters an operation, and commit the result. The
 * fault-envelope golden belongs to `@lostgradient/backchannel`, which has its own script.
 */

import { WIRE_GOLDEN_DIRECTORY, writeWireGolden } from '../src/server/wire-golden.test-support.ts';

await writeWireGolden(WIRE_GOLDEN_DIRECTORY);
