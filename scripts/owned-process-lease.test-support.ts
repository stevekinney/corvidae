import { join } from 'node:path';

import { runOwnedProcessGroup } from './owned-process-group.ts';
import { acquireOwnedProcessLease } from './owned-process-lease.ts';

const root = process.argv[2];
if (root === undefined) throw new Error('The scenario requires a directory.');
const lease = await acquireOwnedProcessLease(join(root, 'process-lock'), root, 'listener fixture');
try {
  await runOwnedProcessGroup({
    command: [
      process.execPath,
      '-e',
      'const s = Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response("alive")}); await Bun.write(process.argv[1], s.url.href)',
      join(root, 'listener-url'),
    ],
    cwd: root,
    environment: process.env,
    token: lease.token,
    register: async (pid) => lease.recordProcessGroup(pid),
  });
} finally {
  await lease.release();
}
