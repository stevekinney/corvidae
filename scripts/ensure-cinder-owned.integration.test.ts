import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflow, type Engine, type WorkflowContext } from '../packages/weft/src/index.ts';

import { startHost } from '../applications/interborough/src/host/host.ts';
import { CINDER_PACKAGE_NAME } from '../components/cinder/scripts/ensure-cinder-generated.ts';
import { spawnPipedWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { waitUntil } from '../testing/testing/src/wait-until.ts';
import { processIsAlive } from './owned-process-group.test-support.ts';
import { retireOwnedProcessLease } from './owned-process-lease.ts';

const root = mkdtempSync(join(tmpdir(), 'cinder-owned-'));
const sibling = await startHost({
  environment: { INTERBOROUGH_HOME: join(root, 'sibling-home') },
  port: 0,
  log: () => {},
});
const siblingArtifact = await sibling.bureau.assets!.admit(
  {
    source: { kind: 'inline', bytes: new TextEncoder().encode('preserved sibling artifact') },
    declaredMediaType: 'text/plain',
  },
  { id: 'anonymous:local' },
);
await siblingArtifact.work.result();
const siblingEngine = sibling.engine as Engine;
siblingEngine.register(
  workflow({ name: 'sibling-qualification' }).execute(async function* (_context: WorkflowContext) {
    return 'completed';
  }),
);
const siblingChecks: Array<{ status: number; result: unknown; digest: string }> = [];
const cleanupMilliseconds: number[] = [];
async function verifySibling(id: string) {
  const response = await fetch(new URL('/host/status', sibling.url));
  const status = response.status;
  const handle = await siblingEngine.start('sibling-qualification', null, { id });
  const result = await handle.result();
  const asset = await sibling.bureau.assets!.resolve(
    { assetId: siblingArtifact.assetId },
    { id: 'anonymous:local' },
  );
  if (asset.content.kind !== 'bytes') throw new Error('Expected sibling artifact bytes.');
  siblingChecks.push({
    status,
    result,
    digest: createHash('sha256').update(asset.content.bytes).digest('hex'),
  });
}
/** A fixture root lists its workspaces, which is how the helper finds the one named for Cinder. */
const workspaces = JSON.stringify({ workspaces: ['components/*'] });
const cinder = join(root, 'components/cinder');
writeFileSync(join(root, 'package.json'), workspaces);
mkdirSync(join(cinder, 'src'), { recursive: true });
mkdirSync(join(cinder, 'scripts'), { recursive: true });
writeFileSync(
  join(cinder, 'package.json'),
  JSON.stringify({ name: CINDER_PACKAGE_NAME, scripts: { metadata: 'bun metadata.ts' } }),
);
writeFileSync(
  join(cinder, 'metadata.ts'),
  'const server = Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response("building")}); await Bun.write("build-url", server.url.href);',
);
const owner = spawnPipedWithHangGuard([
  process.execPath,
  join(import.meta.dir, 'ensure-cinder-owned.test-support.ts'),
  root,
]);
void new Response(owner.stdout).text();
void new Response(owner.stderr).text();
let stopped = false;
let response = '';
let closed = false;
try {
  await waitUntil(() => existsSync(join(cinder, 'build-url')), {
    message: 'the owned generator to start',
  });
  const url = readFileSync(join(cinder, 'build-url'), 'utf8');
  const buildResponse = await fetch(url);
  response = await buildResponse.text();
  owner.kill('SIGKILL');
  await owner.exited;
  stopped = true;
  const lock = join(cinder, '.generate-lock');
  const cleanupStart = performance.now();
  await retireOwnedProcessLease(lock, root);
  await retireOwnedProcessLease(lock, root);
  cleanupMilliseconds.push(performance.now() - cleanupStart);
  closed = await fetch(url).then(
    () => false,
    () => true,
  );
  await verifySibling('after-build-interruption');
} finally {
  if (!stopped) owner.kill('SIGKILL');
}
const preRoot = mkdtempSync(join(tmpdir(), 'cinder-owned-pre-registration-'));
const preCinder = join(preRoot, 'components/cinder');
writeFileSync(join(preRoot, 'package.json'), workspaces);
mkdirSync(join(preCinder, 'src'), { recursive: true });
mkdirSync(join(preCinder, 'scripts'), { recursive: true });
writeFileSync(
  join(preCinder, 'package.json'),
  JSON.stringify({ name: CINDER_PACKAGE_NAME, scripts: { metadata: 'bun metadata.ts' } }),
);
writeFileSync(join(preCinder, 'metadata.ts'), 'await Bun.write("should-not-run", "bad")');
const preOwner = spawnPipedWithHangGuard([
  process.execPath,
  join(import.meta.dir, 'ensure-cinder-owned.test-support.ts'),
  preRoot,
  'before-registration',
]);
void new Response(preOwner.stdout).text();
void new Response(preOwner.stderr).text();
let preStopped = false;
let gatePid = 0;
try {
  await waitUntil(() => existsSync(join(preRoot, 'gate-pid')), {
    message: 'the unregistered generator gate',
  });
  gatePid = Number(readFileSync(join(preRoot, 'gate-pid'), 'utf8'));
  preOwner.kill('SIGKILL');
  await preOwner.exited;
  preStopped = true;
  await waitUntil(() => !processIsAlive(gatePid), {
    message: 'the unregistered generator gate to exit',
  });
  const cleanupStart = performance.now();
  await retireOwnedProcessLease(join(preCinder, '.generate-lock'), preRoot);
  await retireOwnedProcessLease(join(preCinder, '.generate-lock'), preRoot);
  cleanupMilliseconds.push(performance.now() - cleanupStart);
  await verifySibling('after-group-registration-interruption');
} finally {
  if (!preStopped) preOwner.kill('SIGKILL');
}
const unpublishedRoot = mkdtempSync(join(tmpdir(), 'cinder-owned-unpublished-'));
const unpublishedCinder = join(unpublishedRoot, 'components/cinder');
writeFileSync(join(unpublishedRoot, 'package.json'), workspaces);
mkdirSync(join(unpublishedCinder, 'src'), { recursive: true });
mkdirSync(join(unpublishedCinder, 'scripts'), { recursive: true });
writeFileSync(
  join(unpublishedCinder, 'package.json'),
  JSON.stringify({ name: CINDER_PACKAGE_NAME, scripts: { metadata: 'bun metadata.ts' } }),
);
writeFileSync(join(unpublishedCinder, 'metadata.ts'), 'await Bun.write("should-not-run", "bad")');
const unpublishedOwner = spawnPipedWithHangGuard([
  process.execPath,
  join(import.meta.dir, 'ensure-cinder-owned.test-support.ts'),
  unpublishedRoot,
  'before-publication',
]);
void new Response(unpublishedOwner.stdout).text();
void new Response(unpublishedOwner.stderr).text();
let unpublishedStopped = false;
let pendingBefore = 0;
let pendingAfter = 0;
try {
  await waitUntil(() => existsSync(join(unpublishedRoot, 'before-publication')), {
    message: 'the staged generation owner',
  });
  pendingBefore = readdirSync(unpublishedCinder).filter((entry) =>
    entry.startsWith('.generate-lock.pending-'),
  ).length;
  unpublishedOwner.kill('SIGKILL');
  await unpublishedOwner.exited;
  unpublishedStopped = true;
  const cleanupStart = performance.now();
  await retireOwnedProcessLease(join(unpublishedCinder, '.generate-lock'), unpublishedRoot);
  await retireOwnedProcessLease(join(unpublishedCinder, '.generate-lock'), unpublishedRoot);
  cleanupMilliseconds.push(performance.now() - cleanupStart);
  pendingAfter = readdirSync(unpublishedCinder).filter((entry) =>
    entry.startsWith('.generate-lock.pending-'),
  ).length;
  await verifySibling('after-lease-publication-interruption');
} finally {
  if (!unpublishedStopped) unpublishedOwner.kill('SIGKILL');
}
console.info(
  `owned generator cleanup measurements in milliseconds: ${cleanupMilliseconds.join(', ')}`,
);
afterAll(async () => {
  await sibling.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(preRoot, { recursive: true, force: true });
  rmSync(unpublishedRoot, { recursive: true, force: true });
});

test('B serves and completes queued work while retaining the same artifact after each interruption', () => {
  expect(siblingChecks).toHaveLength(3);
  expect(siblingChecks.map((check) => check.status)).toEqual([200, 200, 200]);
  expect(siblingChecks.map((check) => check.result)).toEqual([
    'completed',
    'completed',
    'completed',
  ]);
  expect(new Set(siblingChecks.map((check) => check.digest)).size).toBe(1);
});

test('a killed generator owner can retire its verified build group twice', () => {
  expect(response).toBe('building');
  expect(closed).toBe(true);
  expect(existsSync(join(cinder, '.generate-lock'))).toBe(false);
  expect(existsSync(join(cinder, 'build-url'))).toBe(true);
});

test('a killed owner before group registration never starts the generator', () => {
  expect(gatePid).toBeGreaterThan(0);
  expect(processIsAlive(gatePid)).toBe(false);
  expect(existsSync(join(preCinder, 'should-not-run'))).toBe(false);
  expect(existsSync(join(preCinder, '.generate-lock'))).toBe(false);
});

test('a killed owner before lease publication leaves only a verifiable staged record', () => {
  expect(pendingBefore).toBe(1);
  expect(pendingAfter).toBe(0);
  expect(existsSync(join(unpublishedCinder, 'should-not-run'))).toBe(false);
  expect(existsSync(join(unpublishedCinder, '.generate-lock'))).toBe(false);
});
