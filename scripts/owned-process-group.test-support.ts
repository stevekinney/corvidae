import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runOwnedProcessGroup } from './owned-process-group.ts';

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

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
    environment: process.env,
    register: async (pid) => {
      await writeFile(join(root, 'gate-pid'), String(pid));
      await new Promise(() => {});
    },
  });
}
