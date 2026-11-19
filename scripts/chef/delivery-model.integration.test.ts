import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';
import {
  acquireDispatch,
  cancelDispatch,
  createExecutionStateStore,
  ExecutionStateError,
  recordMutationIntent,
  releaseDispatch,
  requireAuthority,
} from './execution-state.ts';

const scratchRoot = tmpdir();
const fixtures: string[] = [];

function removeFixtures() {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
}

function fixtureDirectory() {
  const directory = mkdtempSync(join(scratchRoot, 'p09-mutation-'));
  fixtures.push(directory);
  return directory;
}

const authoritySchedule = await outcomeOf(async () => {
  const state = createExecutionStateStore({
    stateDirectory: fixtureDirectory(),
    hostId: 'delivery-model',
  });
  const first = await acquireDispatch(state, {
    resource: 'issue:COR-9',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!first.granted) throw new Error(first.reason);
  const loser = await acquireDispatch(state, {
    resource: 'issue:COR-9',
    runId: 'run-b',
    ownerId: 'owner-b',
  });
  expect(loser).toEqual({ granted: false, reason: 'held locally by owner-a' });
  await recordMutationIntent(state, first.authority, {
    operationId: 'merge:COR-9',
    action: 'merge',
    intentFingerprint: 'original-intent',
  });
  await recordMutationIntent(state, first.authority, {
    operationId: 'merge:COR-9',
    action: 'merge',
    intentFingerprint: 'original-intent',
  });
  expect(
    await throwingRejectionOf(
      recordMutationIntent(state, first.authority, {
        operationId: 'merge:COR-9',
        action: 'merge',
        intentFingerprint: 'changed-intent',
      }),
    ),
  ).toThrow('already names merge');
  expect(await cancelDispatch(state, first.authority)).toBe(true);
  const replacement = await acquireDispatch(state, {
    resource: 'issue:COR-9',
    runId: 'run-b',
    ownerId: 'owner-b',
  });
  if (!replacement.granted) throw new Error(replacement.reason);
  expect(replacement.authority.generation).toBe(first.authority.generation + 1);
  expect(() => requireAuthority(state, first.authority)).toThrow(ExecutionStateError);
  expect(await releaseDispatch(state, first.authority)).toBe(false);
  expect(requireAuthority(state, replacement.authority)).toEqual(replacement.authority);
});

function copiedSource(directory: string, sourceName: string, mutation?: [string, string]) {
  const sourcePath = join(import.meta.dir, sourceName);
  let source = readFileSync(sourcePath, 'utf8').replace(
    /from '((?:\.\.?\/)[^']+)'/g,
    (_match, specifier: string) =>
      `from ${JSON.stringify(resolve(dirname(sourcePath), specifier))}`,
  );
  if (mutation !== undefined) {
    const [from, to] = mutation;
    if (!source.includes(from)) throw new Error(`mutation target missing from ${sourceName}`);
    source = source.replace(from, to);
  }
  const target = join(
    directory,
    `${mutation === undefined ? 'baseline' : 'mutant'}-${basename(sourceName)}`,
  );
  writeFileSync(target, source);
  return pathToFileURL(target).href;
}

async function runOracle(directory: string, name: string, source: string, body: string) {
  const path = join(directory, `${name}.test.ts`);
  writeFileSync(
    path,
    `import { expect, test } from 'bun:test';\nimport * as subject from ${JSON.stringify(source)};\ntest(${JSON.stringify(name)}, async () => {\n${body}\n});\n`,
  );
  const child = spawnWithHangGuard(['bun', 'test', path], { stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await child.exited;
  const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
  return { exitCode, output };
}

async function expectMutationFailure(
  name: string,
  sourceName: string,
  mutation: [string, string],
  oracle: string,
) {
  const directory = fixtureDirectory();
  const baseline = await runOracle(
    directory,
    `${name}-baseline`,
    copiedSource(directory, sourceName),
    oracle,
  );
  expect(baseline.exitCode, baseline.output).toBe(0);
  const mutant = await runOracle(
    directory,
    `${name}-mutant`,
    copiedSource(directory, sourceName, mutation),
    oracle,
  );
  expect(mutant.exitCode, mutant.output).toBe(1);
  expect(mutant.output).toContain('Expected');
}

function copiedCloseoutTest(directory: string, deliver: string, name: string) {
  const sourcePath = join(import.meta.dir, 'delivery-closeout.integration.test.ts');
  const source = readFileSync(sourcePath, 'utf8')
    .replace("from './deliver.ts'", `from ${JSON.stringify(deliver)}`)
    .replace(
      /from '((?:\.\.?\/)[^']+)'/g,
      (_match, specifier: string) =>
        `from ${JSON.stringify(resolve(dirname(sourcePath), specifier))}`,
    );
  const target = join(directory, `${name}.integration.test.ts`);
  writeFileSync(target, source);
  return target;
}

async function runExistingOracle(path: string, pattern: string) {
  const child = spawnWithHangGuard(['bun', 'test', path, '--test-name-pattern', pattern], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  return {
    exitCode,
    output: `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`,
  };
}

const generationMutation = await outcomeOf(async () => {
  await expectMutationFailure(
    'generation-fence',
    'execution-state.ts',
    ['record.generation === authority.generation', 'true'],
    `const state = subject.createExecutionStateStore({ stateDirectory: import.meta.dir + '/state', hostId: 'fixture' });
const first = await subject.acquireDispatch(state, { resource: 'issue:COR-9', runId: 'run', ownerId: 'owner' });
if (!first.granted) throw new Error(first.reason);
await subject.cancelDispatch(state, first.authority);
const replacement = await subject.acquireDispatch(state, { resource: 'issue:COR-9', runId: 'run', ownerId: 'owner' });
if (!replacement.granted) throw new Error(replacement.reason);
expect(() => subject.requireAuthority(state, first.authority)).toThrow('generation');`,
  );
});

const candidateHeadMutation = await outcomeOf(async () => {
  await expectMutationFailure(
    'candidate-head',
    'delivery-verification.ts',
    ['value.reviewedHead !== request.revision ||', 'false ||'],
    `const sha = (character: string) => character.repeat(40);
expect(() => subject.validateDeliveryMergeObservation({ route: 'pull-request', pullRequest: 1, reviewedHead: sha('d'), base: sha('b'), integrationTree: sha('c'), state: 'pending-provider-outcome' }, { revision: sha('a'), base: sha('b'), integrationTree: sha('c') })).toThrow('original request identity');`,
  );
});

const emptyJunitMutation = await outcomeOf(async () => {
  await expectMutationFailure(
    'empty-junit',
    'ci-evidence-workflow.ts',
    ['if (parsed.inventory.length === 0)', 'if (false)'],
    `expect(() => subject.validateJUnitArtifacts({ root: [new TextEncoder().encode('<testsuite/>')] }, ['root'])).toThrow('empty report');`,
  );
});

const trackerRecoveryMutation = await outcomeOf(async () => {
  const directory = fixtureDirectory();
  const pattern =
    'tracker state failure resumes state only and preserves independent pending release member';
  const baseline = await runExistingOracle(
    copiedCloseoutTest(
      directory,
      copiedSource(directory, 'deliver.ts'),
      'tracker-recovery-baseline',
    ),
    pattern,
  );
  expect(baseline.exitCode, baseline.output).toBe(0);
  const mutant = await runExistingOracle(
    copiedCloseoutTest(
      directory,
      copiedSource(directory, 'deliver.ts', [
        'operation?.closeout?.routeComplete === true',
        'false',
      ]),
      'tracker-recovery-mutant',
    ),
    pattern,
  );
  expect(mutant.exitCode, mutant.output).toBe(1);
  expect(mutant.output).toContain('Expected');
});

removeFixtures();

test('replays authority ownership, stale completion, duplicate registration, cancellation, and cleanup', () => {
  rethrow(authoritySchedule);
});

test('a copied production generation fence kills a removed generation comparison', () => {
  rethrow(generationMutation);
});

test('a copied production merge-observation validator kills wrong-head acceptance', () => {
  rethrow(candidateHeadMutation);
});

test('a copied production JUnit evaluator kills empty-report acceptance', () => {
  rethrow(emptyJunitMutation);
});

test('a copied recovery route kills a completed merge repeated after tracker failure', () => {
  rethrow(trackerRecoveryMutation);
});
