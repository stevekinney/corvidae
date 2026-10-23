/**
 * The development build in the mode the `dev` script runs it: inside `bun --watch`, with the host's
 * modules loaded. Bundling in that process failed to resolve `@msgpack/msgpack` (COR-1642), so the
 * host builds in a child process; these run the real thing, which takes a bundle's worth of
 * seconds, in the `test:slow` lane. The processes run at module scope, under the hang guard, so
 * they are not on Bun's per-test clock. Nothing asserts on how long anything takes.
 *
 * The second scenario reloads a `--watch` generation while its build child is running: the child
 * must be gone, having built nothing into the output directory, before the next generation's
 * build finishes, so a stale build cannot replace a newer one.
 */
import { afterAll, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';

import { startBrowserBuild, stopBrowserBuilds } from './browser-build.ts';

const scratch = mkdtempSync(join(tmpdir(), 'interborough-dev-watch-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const outdir = join(scratch, 'build');

const child = spawnWithHangGuard(
  [process.execPath, '--watch', join(import.meta.dir, 'dev-watch-fixture.test-support.ts'), outdir],
  { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
);
const [stdout, stderr, code] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);

it('builds the browser application under `bun --watch` after the host modules have loaded', () => {
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('BUILD OK');
  expect(existsSync(join(outdir, 'index.html'))).toBe(true);
});

// A reload keeps the process and drops the module scope, so the generation's build child must end
// by itself. The fixture is outside the package so that rewriting its dependency reloads it
// without touching the tree.
const reloadDirectory = mkdtempSync(join(scratch, 'reload-'));
const generationModule = join(reloadDirectory, 'generation.ts');
const reloadLog = join(reloadDirectory, 'log.txt');
const reloadFixture = join(reloadDirectory, 'fixture.ts');
const reloadOutdir = join(reloadDirectory, 'build');

writeFileSync(generationModule, 'export const generation = 1;\n');
writeFileSync(
  reloadFixture,
  `import { appendFileSync, readFileSync } from 'node:fs';

import { startBrowserBuild } from ${JSON.stringify(join(import.meta.dir, 'browser-build.ts'))};
import { generation } from './generation.ts';

const [outdirPrefix, log] = process.argv.slice(2);
const build = startBrowserBuild({ outdir: outdirPrefix + '-' + generation });
appendFileSync(log, 'start ' + generation + ' ' + build.pid + '\\n');

if (generation === 1) {
  // Wait to be reloaded.
  setInterval(() => {}, 1000);
} else {
  const first = readFileSync(log, 'utf8').split('\\n').find((line) => line.startsWith('start 1 '));
  const previous = Number(first?.split(' ')[2]);
  // An exited child the reloaded generation never waited for stays a zombie, which is gone.
  const alive = (pid) => {
    const state = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)]).stdout.toString().trim();
    return state !== '' && !state.startsWith('Z');
  };
  while (alive(previous)) await Bun.sleep(25);
  appendFileSync(log, 'gone ' + previous + '\\n');
  await build.done;
  appendFileSync(log, 'built\\n');
  process.exit(0);
}
`,
);

const reloading = spawnWithHangGuard(
  [process.execPath, '--watch', reloadFixture, reloadOutdir, reloadLog],
  { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
);

/**
 * Wait until the first generation has started its build child, then reload it. Bun arms its file
 * watch after the module has run, so a change made too early is missed: the dependency is
 * rewritten until the second generation shows up.
 */
async function reloadAfterFirstBuildStarts(): Promise<void> {
  const deadline = Date.now() + 60_000;
  const logged = (text: string): boolean =>
    existsSync(reloadLog) && readFileSync(reloadLog, 'utf8').includes(text);
  while (!logged('start 1 ')) {
    if (Date.now() > deadline) throw new Error('The first generation never started its build.');
    await Bun.sleep(25);
  }
  for (let rewrite = 0; !logged('start 2 '); rewrite += 1) {
    if (Date.now() > deadline) throw new Error('The host was never reloaded.');
    writeFileSync(generationModule, `export const generation = 2; // ${rewrite}\n`);
    await Bun.sleep(300);
  }
}
const [reloadStderr, reloadCode] = await Promise.all([
  new Response(reloading.stderr).text(),
  reloading.exited,
  reloadAfterFirstBuildStarts(),
]).then(([text, exitCode]) => [text, exitCode] as const);

it('ends the earlier generation’s build child when `bun --watch` reloads the host', () => {
  const lines = readFileSync(reloadLog, 'utf8').trim().split('\n');
  const firstChild = lines.find((line) => line.startsWith('start 1 '))?.split(' ')[2];

  expect({ code: reloadCode, stderr: reloadStderr }).toEqual({ code: 0, stderr: '' });
  expect(firstChild).toMatch(/^\d+$/);
  expect(lines).toContain(`gone ${firstChild}`);
  expect(lines.at(-1)).toBe('built');
  // The earlier child was stopped, not allowed to finish: it never replaced a build directory.
  expect(existsSync(`${reloadOutdir}-1`)).toBe(false);
  expect(existsSync(join(`${reloadOutdir}-2`, 'index.html'))).toBe(true);
  expect(readdirSync(reloadDirectory).filter((name) => name.startsWith('.build-staging-'))).toEqual(
    [],
  );
});

// Within one generation (the host stopping), `stopBrowserBuilds` ends a running child and waits.
const stoppedDirectory = mkdtempSync(join(scratch, 'stopped-'));
const stopped = startBrowserBuild({ outdir: join(stoppedDirectory, 'build') });
await stopBrowserBuilds();
const stoppedOutcome = await stopped.done.then(
  () => 'built',
  (error: unknown) => String(error),
);

it('stops a running build child and waits for it when the host stops', () => {
  expect(stoppedOutcome).toContain('The browser build was stopped.');
  expect(readdirSync(stoppedDirectory)).toEqual([]);
});
