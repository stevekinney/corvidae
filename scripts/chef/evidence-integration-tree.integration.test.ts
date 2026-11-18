import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import {
  collectLocalEvidenceFromRequest,
  type CollectedEvidence,
  type VerificationRequest,
} from './evidence.ts';

const scratch = join(process.cwd(), 'tmp/chef/p05-tree-controls');
mkdirSync(scratch, { recursive: true });
const repository = mkdtempSync(join(scratch, 'git-history-'));

async function git(...arguments_: string[]): Promise<{ exitCode: number | null; stdout: string }> {
  const result = await runWithHangGuard(['git', ...arguments_], { cwd: repository });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
  };
}

async function requiredGit(...arguments_: string[]): Promise<string> {
  const result = await git(...arguments_);
  if (result.exitCode !== 0)
    throw new Error(`git ${arguments_.join(' ')} failed: ${result.stdout}`);
  return result.stdout;
}

async function tree(revision: string): Promise<string> {
  return requiredGit('rev-parse', `${revision}^{tree}`);
}

function request(base: string, revision: string, integrationTree: string): VerificationRequest {
  return {
    repository: 'acme/tree-controls',
    revision,
    base,
    integrationTree,
    environment: 'requested-only',
    plan: {
      version: 1,
      obligations: [
        {
          criterionId: 'P05-AC2',
          risk: 'root-scripts',
          commandOrProviderJob: 'bun writes declared JUnit',
          expectedInventory: ['tree-controls.integration.test.ts'],
          relevantInputs: ['input.txt'],
          environmentToolchain: 'Bun',
          executionBoundary: 'coordinator',
          producer: 'fixture',
          selectionReason: 'integration-tree control',
        },
      ],
      risks: {
        'root-scripts': 'covered',
        'shared-configuration': 'not-applicable',
        'transitive-consumers': 'not-applicable',
        'dynamic-entrypoints': 'not-applicable',
        authorization: 'not-applicable',
        'persistence-protocols': 'not-applicable',
        'installed-artifacts': 'not-applicable',
        'shared-ui-design': 'not-applicable',
        'automatic-deployment': 'not-applicable',
      },
      invalidatedBy: { assignment: 'fixture', context: 'fixture', policy: 'fixture' },
    },
    authority: { runId: 'run', ownerId: 'owner', resource: 'COR-2500', generation: 1 },
    operationId: 'tree-control',
    providerRuns: [],
    localRuns: [
      {
        obligation: 'P05-AC2:bun writes declared JUnit',
        argv: [
          'bun',
          '-e',
          'await Bun.write("tree-controls.xml", "<testsuite><testcase name=\\"tree-controls.integration.test.ts\\" /></testsuite>")',
        ],
        reportPaths: ['tree-controls.xml'],
      },
    ],
  };
}

function collect(value: VerificationRequest): CollectedEvidence {
  const text = JSON.stringify(value);
  const path = join(repository, 'verification-request.json');
  writeFileSync(path, text);
  return collectLocalEvidenceFromRequest(
    path,
    createHash('sha256').update(text).digest('hex'),
    undefined,
    repository,
  );
}

const scenarios = await (async () => {
  await requiredGit('init', '-q', '--initial-branch=fixture-root');
  await requiredGit('config', 'user.name', 'Tree control');
  await requiredGit('config', 'user.email', 'tree-control@example.test');
  writeFileSync(join(repository, 'input.txt'), 'input\n');
  writeFileSync(join(repository, 'shared.txt'), 'root\n');
  await requiredGit('add', '.');
  await requiredGit('commit', '-q', '-m', 'root');
  const root = await requiredGit('rev-parse', 'HEAD');

  await requiredGit('switch', '-q', '-c', 'ancestor-head');
  writeFileSync(join(repository, 'ancestor.txt'), 'ancestor\n');
  await requiredGit('add', 'ancestor.txt');
  await requiredGit('commit', '-q', '-m', 'ancestor head');
  const ancestorHead = await requiredGit('rev-parse', 'HEAD');
  const ancestorMerge = await requiredGit('merge-tree', '--write-tree', root, ancestorHead);
  const ancestor = collect(request(root, ancestorHead, ancestorMerge));

  await requiredGit('switch', '-q', '-c', 'divergent-base', root);
  writeFileSync(join(repository, 'base.txt'), 'base\n');
  await requiredGit('add', 'base.txt');
  await requiredGit('commit', '-q', '-m', 'divergent base');
  const divergentBase = await requiredGit('rev-parse', 'HEAD');
  await requiredGit('switch', '-q', '-c', 'divergent-head', root);
  writeFileSync(join(repository, 'head.txt'), 'head\n');
  await requiredGit('add', 'head.txt');
  await requiredGit('commit', '-q', '-m', 'divergent head');
  const divergentHead = await requiredGit('rev-parse', 'HEAD');
  const divergentMerge = await requiredGit(
    'merge-tree',
    '--write-tree',
    divergentBase,
    divergentHead,
  );
  const divergentHeadTree = await tree(divergentHead);
  const divergent = collect(request(divergentBase, divergentHead, divergentMerge));

  await requiredGit('switch', '-q', '-c', 'conflict-base', root);
  writeFileSync(join(repository, 'shared.txt'), 'base\n');
  await requiredGit('add', 'shared.txt');
  await requiredGit('commit', '-q', '-m', 'conflict base');
  const conflictBase = await requiredGit('rev-parse', 'HEAD');
  await requiredGit('switch', '-q', '-c', 'conflict-head', root);
  writeFileSync(join(repository, 'shared.txt'), 'head\n');
  await requiredGit('add', 'shared.txt');
  await requiredGit('commit', '-q', '-m', 'conflict head');
  const conflictHead = await requiredGit('rev-parse', 'HEAD');
  const conflictMerge = await git('merge-tree', '--write-tree', conflictBase, conflictHead);
  const conflict = collect(request(conflictBase, conflictHead, '0'.repeat(40)));

  await requiredGit('switch', '-q', 'ancestor-head');
  const missingBase = 'f'.repeat(40);
  const missing = collect(request(missingBase, ancestorHead, '1'.repeat(40)));

  return {
    ancestor: {
      ancestorExit: await git('merge-base', '--is-ancestor', root, ancestorHead),
      headTree: await tree(ancestorHead),
      mergeTree: ancestorMerge,
      receipt: ancestor,
    },
    divergent: { headTree: divergentHeadTree, mergeTree: divergentMerge, receipt: divergent },
    conflict: { merge: conflictMerge, receipt: conflict },
    missing: { requestedIdentity: '1'.repeat(40), receipt: missing },
  };
})();

test('admits a default local receipt when the requested base is an ancestor', () => {
  expect(scenarios.ancestor.ancestorExit.exitCode).toBe(0);
  expect(scenarios.ancestor.mergeTree).toBe(scenarios.ancestor.headTree);
  expect(scenarios.ancestor.receipt.records[0]?.status).toBe('pass');
});

test('retains a conflict-free divergent integration obligation as pending', () => {
  expect(scenarios.divergent.mergeTree).not.toBe(scenarios.divergent.headTree);
  expect(scenarios.divergent.receipt.records[0]?.checkedTree).toBe(scenarios.divergent.headTree);
  expect(scenarios.divergent.receipt.records[0]?.integrationTree).toBe(
    scenarios.divergent.mergeTree,
  );
  expect(scenarios.divergent.receipt.records[0]?.status).toBe('pending');
});

test('does not promote conflict output to an integration identity', () => {
  expect(scenarios.conflict.merge.exitCode).not.toBe(0);
  expect(scenarios.conflict.merge.stdout.split('\n')[0]).toMatch(/^[0-9a-f]{40}$/);
  expect(scenarios.conflict.receipt.records[0]?.integrationTree).toBe('');
  expect(scenarios.conflict.receipt.records[0]?.status).toBe('pending');
});

test('keeps a missing base pending without copying the requested identity', () => {
  expect(scenarios.missing.receipt.records[0]?.integrationTree).toBe('');
  expect(scenarios.missing.receipt.records[0]?.integrationTree).not.toBe(
    scenarios.missing.requestedIdentity,
  );
  expect(scenarios.missing.receipt.records[0]?.status).toBe('pending');
});
