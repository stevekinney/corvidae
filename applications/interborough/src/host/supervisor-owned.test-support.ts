import { join } from 'node:path';

import { runSupervisor } from './supervisor.ts';

const root = process.argv[2];
if (root === undefined) throw new Error('The scenario needs a fixture worktree.');
process.chdir(root);
const mode = process.argv[3] === 'serve' ? 'serve' : 'dev';
process.env['INTERBOROUGH_HOME'] = join(
  root,
  process.argv[4] ?? (mode === 'serve' ? 'home-serve' : 'home-a'),
);
process.env['INTERBOROUGH_PORT'] = '0';
process.env['INTERBOROUGH_BUILD_DIRECTORY'] = join(root, 'build');
process.exitCode = await runSupervisor(
  [mode, '--entry', join(import.meta.dir, 'serve.ts')],
  undefined,
  {
    directory: root,
    read: () => ({
      topLevel: root,
      gitDirectory: join(root, '.git', 'worktrees', 'fixture'),
      commonDirectory: join(root, '.git'),
    }),
  },
);
