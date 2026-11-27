import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { processEnvironment } from './environment-configuration.ts';
import { runOwnedProcessGroup } from './owned-process-group.ts';

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined) throw new Error('The scenario requires a directory.');
  await runOwnedProcessGroup({
    command: [
      process.execPath,
      '-e',
      'await Bun.write(process.argv[1], "forbidden")',
      join(root, 'after-owner-death'),
    ],
    cwd: root,
    environment: processEnvironment(),
    register: async (pid) => {
      await writeFile(join(root, 'gate-pid'), String(pid));
      await new Promise(() => {});
    },
  });
}
