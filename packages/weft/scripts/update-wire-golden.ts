/**
 * Rewrites the wire goldens Weft owns: `src/server/__fixtures__/wire-golden/` and
 * `src/server/__fixtures__/fault-envelope-golden/`. Run it from `packages/weft` after a change
 * that legitimately alters an operation or a fault mapping, and commit the result.
 */

import {
  FAULT_ENVELOPE_GOLDEN_DIRECTORY,
  writeFaultEnvelopeGolden,
} from '../src/server/fault-envelope-golden.test-support.ts';
import { WIRE_GOLDEN_DIRECTORY, writeWireGolden } from '../src/server/wire-golden.test-support.ts';

await writeWireGolden(WIRE_GOLDEN_DIRECTORY);
await writeFaultEnvelopeGolden(FAULT_ENVELOPE_GOLDEN_DIRECTORY);
