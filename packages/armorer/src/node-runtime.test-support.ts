import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import {
  createCodingTools,
  type GlobResult,
  type GrepResult,
  type ReadFileResult,
} from './coding/index.ts';
import { runRuntimeSmoke } from './runtime-smoke.ts';

nodeTest('armorer smoke', async () => {
  await runRuntimeSmoke();
  const root = await mkdtemp(join(tmpdir(), 'armorer-node-smoke-'));
  try {
    await mkdir(join(root, 'src'));
    await Promise.all([
      writeFile(join(root, 'src', 'one.ts'), 'export const needle = 1;\n'),
      writeFile(join(root, 'src', 'two.tsx'), 'export const needle = 2;\n'),
      writeFile(join(root, 'green.test.ts'), 'green'),
      writeFile(join(root, 'red.test.ts'), 'red'),
    ]);
    const { readFile, glob, grep } = createCodingTools({ root });
    const file = (await readFile({ path: 'src/one.ts' })) as ReadFileResult;
    const extensions = (await glob({ pattern: 'src/*.{ts,tsx}' })) as GlobResult;
    const classes = (await glob({ pattern: '[gr]*.test.ts' })) as GlobResult;
    const matches = (await grep({ pattern: 'needle', glob: 'src/*.{ts,tsx}' })) as GrepResult;
    if (file.content !== 'export const needle = 1;\n') throw new Error('read-file did not read.');
    if (extensions.paths.length !== 2 || classes.paths.length !== 2 || matches.matches.length !== 2)
      throw new Error('coding tools did not return the expected temporary-tree results.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
