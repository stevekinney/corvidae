import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';

const scratchRoot = '/Users/stevekinney/Developer/corvidae/tmp/chef/2026-11-17-sdlc-14ef';
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixtureDirectory() {
  const directory = mkdtempSync(join(scratchRoot, 'p09-mutation-'));
  fixtures.push(directory);
  return directory;
}

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

function copiedRecoveryTest(directory: string, directMerge: string, name: string) {
  const sourcePath = join(import.meta.dir, 'delivery-recovery.integration.test.ts');
  const source = readFileSync(sourcePath, 'utf8')
    .replace("from './direct-merge.ts'", `from ${JSON.stringify(directMerge)}`)
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

test('a copied production generation fence kills a removed generation comparison', async () => {
  await expectMutationFailure(
    'generation-fence',
    'execution-state.ts',
    ['record.generation === authority.generation', 'true'],
    `const state = subject.createExecutionStateStore({ stateDirectory: ${JSON.stringify(
      join(tmpdir(), 'p09-generation-fence'),
    )}, hostId: 'fixture' });
const first = await subject.acquireDispatch(state, { resource: 'issue:COR-9', runId: 'run', ownerId: 'owner' });
if (!first.granted) throw new Error(first.reason);
await subject.cancelDispatch(state, first.authority);
const replacement = await subject.acquireDispatch(state, { resource: 'issue:COR-9', runId: 'run', ownerId: 'owner' });
if (!replacement.granted) throw new Error(replacement.reason);
expect(() => subject.requireAuthority(state, first.authority)).toThrow('generation');`,
  );
});

test('a copied production merge-observation validator kills wrong-head acceptance', async () => {
  await expectMutationFailure(
    'candidate-head',
    'delivery-verification.ts',
    ['value.reviewedHead !== request.revision ||', 'false ||'],
    `const sha = (character: string) => character.repeat(40);
expect(() => subject.validateDeliveryMergeObservation({ route: 'pull-request', pullRequest: 1, reviewedHead: sha('d'), base: sha('b'), integrationTree: sha('c'), state: 'pending-provider-outcome' }, { revision: sha('a'), base: sha('b'), integrationTree: sha('c') })).toThrow('original request identity');`,
  );
});

test('a copied production JUnit evaluator kills empty-report acceptance', async () => {
  await expectMutationFailure(
    'empty-junit',
    'ci-evidence-workflow.ts',
    ['if (parsed.inventory.length === 0)', 'if (false)'],
    `expect(() => subject.validateJUnitArtifacts({ root: [new TextEncoder().encode('<testsuite/>')] }, ['root'])).toThrow('empty report');`,
  );
});

test('a copied recovery route kills a completed merge repeated after closeout failure', async () => {
  const directory = fixtureDirectory();
  const pattern = 'resumes only branch deletion after a confirmed direct merge';
  const baseline = await runExistingOracle(
    copiedRecoveryTest(directory, copiedSource(directory, 'direct-merge.ts'), 'recovery-baseline'),
    pattern,
  );
  expect(baseline.exitCode, baseline.output).toBe(0);
  const mutant = await runExistingOracle(
    copiedRecoveryTest(
      directory,
      copiedSource(directory, 'direct-merge.ts', [
        '(await recoverDirectMerge(snapshot, partial, loaded)) ??',
        'undefined ??',
      ]),
      'recovery-mutant',
    ),
    pattern,
  );
  expect(mutant.exitCode, mutant.output).toBe(1);
  expect(mutant.output).toContain('Expected');
});
