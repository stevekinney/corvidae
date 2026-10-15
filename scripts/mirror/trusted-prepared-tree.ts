import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PolicyDocumentOverrides } from './surface.ts';
import {
  assertNoForeignCommits,
  cloneTarget,
  foreignCommitOwnership,
  git,
  stageSurface,
} from './sync.ts';
import type { MirrorTarget } from './target-definitions.ts';

export class TrustedPreparedTreeError extends Error {}

export type TrustedPreparedDecision = 'skip' | 'prepared';

export interface TrustedPreparedManifest {
  decision: TrustedPreparedDecision;
  target: MirrorTarget;
  corvidaeCommit: string;
  baseBranch: string;
  baseCommit: string;
  changed: readonly string[];
  tree: string;
}

export interface TrustedPreparedTreeOptions {
  corvidaeRoot: string;
  manifest: TrustedPreparedManifest;
  remote: string;
  expectedBaseBranch?: string;
  /** Fixture policy documents; see `PolicyDocumentOverrides`. */
  policyDocuments?: PolicyDocumentOverrides | undefined;
}

function fail(message: string): never {
  throw new TrustedPreparedTreeError(message);
}

function assertEqual(actual: string, expected: string, message: string): void {
  if (actual !== expected) fail(`${message}: expected ${expected}, found ${actual}`);
}

function stripOrigin(reference: string): string {
  const prefix = 'origin/';
  if (!reference.startsWith(prefix)) {
    fail(`The target default branch reference must start with ${prefix}`);
  }
  return reference.slice(prefix.length);
}

function assertSameEntries(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  if (actual.length !== expected.length) {
    fail(
      `${message}: expected ${expected.length} entrie(s), found ${actual.length}` +
        (actual[0] === undefined ? '' : `; first reconstructed entry: ${actual[0]}`),
    );
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      fail(`${message}: entry ${index + 1} differs`);
    }
  }
}

function guardedTreeEntries(listing: string): string[] {
  return listing
    .split('\0')
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => {
      const match = entry.match(/^(\d+) \w+ [a-f0-9]+\t(.+)$/);
      if (!match?.[1] || !match[2]) {
        fail('Could not parse the target tree before trusted reconstruction');
      }
      return match[1] === '120000' || match[1] === '160000' ? [match[2]] : [];
    });
}

async function assertTrustedSource(options: {
  corvidaeRoot: string;
  expectedCommit: string;
}): Promise<void> {
  const headOutput = await git(options.corvidaeRoot, 'rev-parse', 'HEAD');
  const head = headOutput.trim();
  assertEqual(
    head,
    options.expectedCommit,
    'Trusted corvidae checkout does not match the manifest',
  );
  const statusOutput = await git(options.corvidaeRoot, 'status', '--porcelain');
  const status = statusOutput.trim();
  if (status.length > 0) {
    fail('Trusted corvidae checkout must be clean before publish reconstruction');
  }
}

async function assertRemoteBase(options: {
  clone: string;
  manifest: TrustedPreparedManifest;
  expectedBaseBranch?: string;
}): Promise<void> {
  await git(options.clone, 'check-ref-format', `refs/heads/${options.manifest.baseBranch}`);
  if (options.expectedBaseBranch === undefined) {
    const defaultReferenceOutput = await git(
      options.clone,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    );
    const defaultBranch = stripOrigin(defaultReferenceOutput.trim());
    assertEqual(
      defaultBranch,
      options.manifest.baseBranch,
      'Prepared artifact base branch is not the target remote default branch',
    );
  } else {
    assertEqual(
      options.expectedBaseBranch,
      options.manifest.baseBranch,
      'Prepared artifact base branch does not match the workflow input',
    );
  }
  const baseHeadOutput = await git(
    options.clone,
    'rev-parse',
    `refs/remotes/origin/${options.manifest.baseBranch}`,
  );
  const baseHead = baseHeadOutput.trim();
  assertEqual(
    baseHead,
    options.manifest.baseCommit,
    options.expectedBaseBranch === undefined
      ? 'Prepared artifact base commit is not the target remote default HEAD'
      : 'Prepared artifact base commit is not the requested target branch HEAD',
  );
  const checkedOutHeadOutput = await git(options.clone, 'rev-parse', 'HEAD');
  const checkedOutHead = checkedOutHeadOutput.trim();
  assertEqual(
    checkedOutHead,
    options.manifest.baseCommit,
    'Trusted target clone did not check out the prepared artifact base commit',
  );
}

async function assertNoTrackedSpecialEntries(clone: string): Promise<void> {
  const listing = await git(clone, 'ls-tree', '-r', '-z', 'HEAD');
  const guarded = guardedTreeEntries(listing);
  if (guarded.length > 0) {
    fail(`Trusted reconstruction refuses target tracked symlink or gitlink ${guarded[0]}`);
  }
}

async function stagedTree(options: {
  clone: string;
  corvidaeRoot: string;
  manifest: TrustedPreparedManifest;
  policyDocuments: PolicyDocumentOverrides | undefined;
}): Promise<{ changed: readonly string[]; tree: string }> {
  await stageSurface({
    corvidaeRoot: options.corvidaeRoot,
    target: options.manifest.target,
    directory: options.clone,
    policyDocuments: options.policyDocuments,
  });
  const porcelain = await git(options.clone, 'status', '--porcelain');
  const changed = porcelain.split('\n').filter((line) => line.length > 0);
  if (changed.length > 0) await git(options.clone, 'add', '--all');
  const treeOutput = await git(options.clone, 'write-tree');
  const tree = treeOutput.trim();
  return { changed, tree };
}

export async function verifyTrustedPreparedTree({
  corvidaeRoot,
  manifest,
  remote,
  expectedBaseBranch,
  policyDocuments,
}: TrustedPreparedTreeOptions): Promise<void> {
  await assertTrustedSource({ corvidaeRoot, expectedCommit: manifest.corvidaeCommit });
  const root = await mkdtemp(join(tmpdir(), 'mirror-trusted-prepared-tree-'));
  const clone = join(root, 'target');
  try {
    await cloneTarget({ remote, directory: clone, branch: expectedBaseBranch });
    await assertRemoteBase({
      clone,
      manifest,
      ...(expectedBaseBranch === undefined ? {} : { expectedBaseBranch }),
    });
    await assertNoTrackedSpecialEntries(clone);
    await assertNoForeignCommits(
      clone,
      await foreignCommitOwnership({
        corvidaeRoot,
        target: manifest.target,
        clone,
        policyDocuments,
      }),
    );
    const expected = await stagedTree({ clone, corvidaeRoot, manifest, policyDocuments });
    assertSameEntries(
      expected.changed,
      manifest.changed,
      'Trusted reconstruction changed paths do not match the prepared artifact',
    );
    if (manifest.decision === 'skip' && expected.changed.length > 0) {
      fail('Skip artifact does not match the trusted reconstruction');
    }
    if (manifest.decision === 'prepared' && expected.changed.length === 0) {
      fail('Prepared artifact does not contain a trusted reconstruction diff');
    }
    assertEqual(
      expected.tree,
      manifest.tree,
      'Trusted reconstruction tree does not match the prepared artifact',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
