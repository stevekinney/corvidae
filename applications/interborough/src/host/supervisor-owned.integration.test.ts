import { runWithHangGuard, spawnPipedWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { workflow, type Engine, type WorkflowContext } from '@lostgradient/weft';
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUILD_INFO_FILE, readSourceInfo } from './build-info.ts';
import { startHost } from './host.ts';
import { readInstanceRecord } from './instance-record.ts';
import { runSupervisor } from './supervisor.ts';

const root = mkdtempSync(join(tmpdir(), 'interborough-owned-supervisor-'));
mkdirSync(join(root, 'build'));
writeFileSync(join(root, 'build', 'index.html'), '<!doctype html><title>fixture</title>');
const initialized = await runWithHangGuard(['git', 'init', '-q', root]);
if (initialized.exitCode !== 0) throw new Error('Could not initialize the disposable worktree.');
const homeB = join(root, 'home-b');
const hostB = await startHost({
  environment: { INTERBOROUGH_HOME: homeB },
  port: 0,
  log: () => {},
});
const artifact = join(homeB, 'sibling-artifact');
writeFileSync(artifact, 'sibling artifact');
const digest = () => createHash('sha256').update(readFileSync(artifact)).digest('hex');
const beforeDigest = digest();
const owner = spawnPipedWithHangGuard([
  process.execPath,
  join(import.meta.dir, 'supervisor-owned.test-support.ts'),
  root,
]);
const output = new Response(owner.stdout).text();
const errors = new Response(owner.stderr).text();
const sibling = spawnPipedWithHangGuard([
  process.execPath,
  join(import.meta.dir, 'supervisor-owned.test-support.ts'),
  root,
  'dev',
  'home-live',
]);
void new Response(sibling.stdout).text();
void new Response(sibling.stderr).text();
let stopped = false;
let beforeA = 0;
let afterB = 0;
let resultB: unknown;
let listenerClosed = false;
let cleanupMilliseconds = 0;
let serveStatus = 0;
let serveClosed = false;
let liveSiblingStatus = 0;
try {
  const homeA = join(root, 'home-a');
  await waitUntil(async () => (await readInstanceRecord(homeA)) !== undefined, {
    message: 'supervised A to bind its listener',
  });
  const record = await readInstanceRecord(homeA);
  if (record === undefined) throw new Error('A did not write its instance record.');
  const responseA = await fetch(new URL('/host/status', record.url));
  beforeA = responseA.status;
  const liveHome = join(root, 'home-live');
  await waitUntil(async () => (await readInstanceRecord(liveHome)) !== undefined, {
    message: 'second supervised instance to bind its listener',
  });
  const liveRecord = await readInstanceRecord(liveHome);
  if (liveRecord === undefined) throw new Error('The sibling did not write its instance record.');
  owner.kill('SIGKILL');
  await owner.exited;
  stopped = true;
  const cleanupStart = performance.now();
  await runSupervisor(['cleanup'], undefined, { directory: root });
  await runSupervisor(['cleanup'], undefined, { directory: root });
  cleanupMilliseconds = performance.now() - cleanupStart;
  const liveResponse = await fetch(new URL('/host/status', liveRecord.url));
  liveSiblingStatus = liveResponse.status;
  listenerClosed = await fetch(new URL('/host/status', record.url)).then(
    () => false,
    () => true,
  );
  const responseB = await fetch(new URL('/host/status', hostB.url));
  afterB = responseB.status;
  const queued = workflow({ name: 'owned-sibling-check' }).execute(async function* (
    _context: WorkflowContext,
  ) {
    return 'completed';
  });
  const engine = hostB.engine as Engine;
  engine.register(queued);
  const item = await engine.start('owned-sibling-check', null, { id: 'owned-sibling-item' });
  resultB = await item.result();
  writeFileSync(join(root, 'retained.log'), `${await output}\n${await errors}`);
  writeFileSync(
    join(root, 'build', BUILD_INFO_FILE),
    JSON.stringify(readSourceInfo(join(import.meta.dir, '../..'))),
  );
  const serving = spawnPipedWithHangGuard([
    process.execPath,
    join(import.meta.dir, 'supervisor-owned.test-support.ts'),
    root,
    'serve',
  ]);
  void new Response(serving.stdout).text();
  void new Response(serving.stderr).text();
  let serveStopped = false;
  try {
    const serveHome = join(root, 'home-serve');
    await waitUntil(async () => (await readInstanceRecord(serveHome)) !== undefined, {
      message: 'serve supervisor to bind its listener',
    });
    const serveRecord = await readInstanceRecord(serveHome);
    if (serveRecord === undefined) throw new Error('Serve did not write its instance record.');
    const serveResponse = await fetch(new URL('/host/status', serveRecord.url));
    serveStatus = serveResponse.status;
    serving.kill('SIGKILL');
    await serving.exited;
    serveStopped = true;
    await runSupervisor(['cleanup'], undefined, { directory: root });
    await runSupervisor(['cleanup'], undefined, { directory: root });
    serveClosed = await fetch(new URL('/host/status', serveRecord.url)).then(
      () => false,
      () => true,
    );
  } finally {
    if (!serveStopped) serving.kill('SIGKILL');
  }
} finally {
  if (!stopped) owner.kill('SIGKILL');
  sibling.kill('SIGTERM');
  await sibling.exited;
  await hostB.close();
}
console.info(`owned supervisor cleanup measurement in milliseconds: ${cleanupMilliseconds}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('retiring a killed supervisor leaves the sibling usable', () => {
  expect(beforeA).toBe(200);
  expect(listenerClosed).toBe(true);
  expect(liveSiblingStatus).toBe(200);
  expect(serveStatus).toBe(200);
  expect(serveClosed).toBe(true);
  expect(afterB).toBe(200);
  expect(resultB).toBe('completed');
  expect(digest()).toBe(beforeDigest);
  expect(existsSync(join(root, 'retained.log'))).toBe(true);
  expect(readFileSync(join(root, 'retained.log'), 'utf8')).toContain('Started the host');
});
