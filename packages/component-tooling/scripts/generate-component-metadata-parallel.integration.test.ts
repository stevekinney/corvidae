import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function failedGeneration() {
  const root = await mkdtemp(join(tmpdir(), 'metadata-worker-failure-'));
  const component = join(root, 'src/components/broken');
  const old = join(root, '.metadata/sentinel');
  await mkdir(component, { recursive: true });
  await mkdir(join(root, '.metadata'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@lostgradient/fixture' }));
  await writeFile(join(component, 'broken.svelte'), '<div></div>');
  await writeFile(join(component, 'broken.types.ts'), 'export const notProps = true;');
  await writeFile(old, 'previous metadata');
  try {
    const child = spawnWithHangGuard(
      [
        process.execPath,
        join(import.meta.dir, 'generate-component-artifacts.ts'),
        '--package-root',
        root,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    return { exit, stderr, previous: await readFile(old, 'utf8') };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const failure = await failedGeneration();
async function successfulGeneration() {
  const root = await mkdtemp(join(tmpdir(), 'metadata-workers-success-'));
  try {
    const components = [];
    for (const name of ['alpha', 'beta']) {
      const directory = join(root, name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${name}.types.ts`),
        `export interface ${name === 'alpha' ? 'Alpha' : 'Beta'}Props { label: string }`,
      );
      components.push({ directory, name });
    }
    const modulePath = join(import.meta.dir, 'generate-component-metadata-parallel.ts');
    const source = `import { generateComponentMetadataInWorkers } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await generateComponentMetadataInWorkers(${JSON.stringify(components)})));`;
    const child = spawnWithHangGuard([process.execPath, '-e', source], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const success = await successfulGeneration();
async function interruptedGeneration() {
  const root = await mkdtemp(join(tmpdir(), 'metadata-workers-interruption-'));
  let child: ReturnType<typeof spawnWithHangGuard<'ignore', 'pipe', 'pipe'>> | undefined;
  try {
    await writeFile(join(root, 'alpha.types.ts'), 'export interface AlphaProps { label: string }');
    const components = Array.from({ length: 200 }, () => ({ directory: root, name: 'alpha' }));
    const modulePath = join(import.meta.dir, 'generate-component-metadata-parallel.ts');
    const source = `import { generateComponentMetadataInWorkers } from ${JSON.stringify(modulePath)}; const pending = generateComponentMetadataInWorkers(${JSON.stringify(components)}); console.log('started'); await pending;`;
    child = spawnWithHangGuard([process.execPath, '-e', source], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    if (!new TextDecoder().decode(first.value).includes('started'))
      throw new Error('Parent did not start workers');
    const table = spawnWithHangGuard(['ps', '-eo', 'pid=,ppid='], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [tableExit, tableText] = await Promise.all([
      table.exited,
      new Response(table.stdout).text(),
      new Response(table.stderr).text(),
    ]);
    if (tableExit !== 0) throw new Error('Could not inspect owned workers');
    const parentPid = child.pid;
    const workers = tableText
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([, parent]) => parent === parentPid)
      .map(([pid]) => pid!);
    child.kill('SIGTERM');
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    const remaining = spawnWithHangGuard(['ps', '-p', workers.join(','), '-o', 'pid='], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [remainingExit, remainingText] = await Promise.all([
      remaining.exited,
      new Response(remaining.stdout).text(),
      new Response(remaining.stderr).text(),
    ]);
    return { workers, exit, stderr, remainingExit, remainingText };
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}
const interruption = await interruptedGeneration();

test('a failed worker reports its error and leaves previous metadata untouched', () => {
  expect(failure.exit).not.toBe(0);
  expect(failure.stderr).toContain('does not export');
  expect(failure.previous).toBe('previous metadata');
});
test('two real workers return the complete component set in order', () => {
  expect(success.exit).toBe(0);
  expect(success.stderr).toBe('');
  expect((JSON.parse(success.stdout) as Array<{ name: string }>).map(({ name }) => name)).toEqual([
    'alpha',
    'beta',
  ]);
});
test('interrupting the generator stops both owned workers', () => {
  expect(interruption.workers).toHaveLength(2);
  expect(interruption.exit).not.toBe(0);
  expect(interruption.remainingText.trim()).toBe('');
  expect(interruption.remainingExit).not.toBe(0);
});
