import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resetOwnedFixture } from './fixture-ownership.ts';

const [root, phase] = process.argv.slice(2);
if (root === undefined || (phase !== 'pending' && phase !== 'partial' && phase !== 'root'))
  throw new Error('Expected a root and interruption phase.');
const stop = () => {
  writeFileSync(join(root, 'phase-ready'), phase);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const lease = await resetOwnedFixture(
  join(root, 'home'),
  { root, owner: root },
  undefined,
  undefined,
  phase === 'pending' ? stop : undefined,
  phase === 'partial' ? stop : undefined,
  phase === 'root' ? stop : undefined,
);
lease.release();
