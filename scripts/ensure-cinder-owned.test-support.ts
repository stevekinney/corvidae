import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureCinderGenerated } from '../components/cinder/scripts/ensure-cinder-generated.ts';

const root = process.argv[2];
if (root === undefined) throw new Error('The scenario needs a fixture root.');
await ensureCinderGenerated({
  root,
  ...(process.argv[3] === 'before-publication'
    ? {
        beforeLeasePublication: () => {
          writeFileSync(join(root, 'before-publication'), 'ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        },
      }
    : {}),
  ...(process.argv[3] === 'before-registration'
    ? {
        beforeRegistration: (pid: number) => {
          writeFileSync(join(root, 'gate-pid'), String(pid));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        },
      }
    : {}),
});
