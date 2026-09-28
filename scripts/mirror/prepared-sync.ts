import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runCommand, type CommandRunner } from './packaging.ts';
import { git, provenanceTrailer, type SyncResult } from './sync.ts';
import { mirrorTargets, type MirrorTarget } from './target-definitions.ts';

export class PreparedSyncError extends Error {}

export const preparedSyncManifestFile = 'manifest.json';
export const preparedSyncBundleFile = 'verified.bundle';

const manifestVersion = 1;
const fullGitObject = /^[a-f0-9]{40}$/;
const sha256Digest = /^[a-f0-9]{64}$/;
const releaseWorkflowFiles = new Set(['release.yaml', 'release.yml']);
const releaseWorkflowDirectory = '.github/workflows';
const manifestKeys = [
  'version',
  'decision',
  'target',
  'corvidaeCommit',
  'snapshot',
  'baseBranch',
  'baseCommit',
  'changed',
  'workflowFile',
  'commit',
  'tree',
  'bundle',
] as const;
const bundleKeys = ['file', 'sha256'] as const;

export type PreparedSyncDecision = 'skip' | 'prepared';

export interface PreparedSyncBundle {
  file: typeof preparedSyncBundleFile;
  sha256: string;
}

export interface PreparedSyncManifest {
  version: typeof manifestVersion;
  decision: PreparedSyncDecision;
  target: MirrorTarget;
  corvidaeCommit: string;
  snapshot: boolean;
  baseBranch: string;
  baseCommit: string;
  changed: readonly string[];
  workflowFile?: string;
  commit?: string;
  tree: string;
  bundle: PreparedSyncBundle;
}

export interface VerifiedPreparedSync {
  manifest: PreparedSyncManifest;
  bundlePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0)
    throw new PreparedSyncError(`${context} contains unknown field ${extra[0]}`);
}

function assertFullGitObject(value: unknown, field: string): string {
  if (typeof value !== 'string' || !fullGitObject.test(value)) {
    throw new PreparedSyncError(`${field} must be a full lowercase Git object id`);
  }
  return value;
}

function assertSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !sha256Digest.test(value)) {
    throw new PreparedSyncError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PreparedSyncError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertChanged(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new PreparedSyncError('changed must be an array');
  return value.map((entry, index) => assertString(entry, `changed[${index}]`));
}

function assertTarget(value: unknown): MirrorTarget {
  if (typeof value === 'string' && (mirrorTargets as readonly string[]).includes(value)) {
    return value as MirrorTarget;
  }
  throw new PreparedSyncError(`target must be one of ${mirrorTargets.join(', ')}`);
}

function assertWorkflowFile(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && releaseWorkflowFiles.has(value)) return value;
  throw new PreparedSyncError('workflowFile must be release.yaml or release.yml');
}

function releaseWorkflowEntries(listing: string): { mode: string; type: string; file: string }[] {
  return listing
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+) (\w+) [a-f0-9]+\t(.+)$/);
      if (!match?.[1] || !match[2] || !match[3]) {
        throw new PreparedSyncError('Could not parse the prepared bundle workflow tree');
      }
      return { mode: match[1], type: match[2], file: match[3] };
    })
    .filter((entry) => releaseWorkflowFiles.has(entry.file));
}

async function fileSha256(path: string): Promise<string> {
  const data = Buffer.from(await Bun.file(path).arrayBuffer());
  return createHash('sha256').update(data).digest('hex');
}

function bundleManifest(value: unknown): PreparedSyncBundle {
  if (!isRecord(value)) throw new PreparedSyncError('bundle must be an object');
  assertKnownKeys(value, bundleKeys, 'bundle');
  const file = assertString(value['file'], 'bundle.file');
  if (file !== preparedSyncBundleFile) {
    throw new PreparedSyncError(`bundle.file must be ${preparedSyncBundleFile}`);
  }
  return { file, sha256: assertSha256(value['sha256'], 'bundle.sha256') };
}

export function parsePreparedSyncManifest(value: unknown): PreparedSyncManifest {
  if (!isRecord(value)) throw new PreparedSyncError('Prepared sync manifest must be an object');
  assertKnownKeys(value, manifestKeys, 'manifest');
  if (value['version'] !== manifestVersion)
    throw new PreparedSyncError(`manifest.version must be ${manifestVersion}`);
  const rawDecision = value['decision'];
  if (rawDecision !== 'skip' && rawDecision !== 'prepared') {
    throw new PreparedSyncError('decision must be skip or prepared');
  }
  const decision: PreparedSyncDecision = rawDecision;
  const snapshot =
    value['snapshot'] === true
      ? true
      : value['snapshot'] === false
        ? false
        : (() => {
            throw new PreparedSyncError('snapshot must be a boolean');
          })();
  const workflowFile =
    value['workflowFile'] === undefined ? undefined : assertWorkflowFile(value['workflowFile']);
  const manifest = {
    version: manifestVersion as typeof manifestVersion,
    decision,
    target: assertTarget(value['target']),
    corvidaeCommit: assertFullGitObject(value['corvidaeCommit'], 'corvidaeCommit'),
    snapshot,
    baseBranch: assertString(value['baseBranch'], 'baseBranch'),
    baseCommit: assertFullGitObject(value['baseCommit'], 'baseCommit'),
    changed: assertChanged(value['changed']),
    ...(workflowFile === undefined ? {} : { workflowFile }),
  };
  if (manifest.snapshot && manifest.workflowFile === undefined) {
    throw new PreparedSyncError('snapshot artifacts must name the release workflow file');
  }
  if (!manifest.snapshot && manifest.workflowFile !== undefined) {
    throw new PreparedSyncError('workflowFile is only valid for snapshot artifacts');
  }
  if (decision === 'skip') {
    if (value['commit'] !== undefined) {
      throw new PreparedSyncError('skip artifacts must not carry a separate commit field');
    }
    if (manifest.changed.length !== 0)
      throw new PreparedSyncError('skip artifacts must be unchanged');
    return {
      ...manifest,
      tree: assertFullGitObject(value['tree'], 'tree'),
      bundle: bundleManifest(value['bundle']),
    };
  }
  const bundle = bundleManifest(value['bundle']);
  return {
    ...manifest,
    commit: assertFullGitObject(value['commit'], 'commit'),
    tree: assertFullGitObject(value['tree'], 'tree'),
    bundle,
  };
}

export async function readPreparedSyncManifest(path: string): Promise<PreparedSyncManifest> {
  try {
    return parsePreparedSyncManifest(JSON.parse(await Bun.file(path).text()));
  } catch (error) {
    if (error instanceof PreparedSyncError) throw error;
    throw new PreparedSyncError(error instanceof Error ? error.message : String(error));
  }
}

async function createBundle(options: {
  directory: string;
  artifactDirectory: string;
  commit: string;
}): Promise<PreparedSyncBundle> {
  const bundlePath = join(options.artifactDirectory, preparedSyncBundleFile);
  const headResult = await git(options.directory, 'rev-parse', 'HEAD');
  const head = headResult.trim();
  if (head !== options.commit) {
    throw new PreparedSyncError('Prepared sync bundle must be created from the verified HEAD');
  }
  await rm(bundlePath, { force: true });
  await git(options.directory, 'bundle', 'create', bundlePath, 'HEAD');
  return { file: preparedSyncBundleFile, sha256: await fileSha256(bundlePath) };
}

export async function writePreparedSyncArtifact(options: {
  artifactDirectory: string;
  result: SyncResult;
  corvidaeCommit: string;
  snapshot: boolean;
  workflowFile?: string | undefined;
}): Promise<PreparedSyncManifest> {
  if (!isAbsolute(options.artifactDirectory)) {
    throw new PreparedSyncError('Prepared sync artifact directory must be absolute');
  }
  if (options.result.decision !== 'skip' && options.result.decision !== 'prepared') {
    throw new PreparedSyncError('Prepared sync artifacts can only be written from prepare mode');
  }
  await mkdir(options.artifactDirectory, { recursive: true });
  const bundledCommit =
    options.result.decision === 'prepared'
      ? assertFullGitObject(options.result.commit, 'commit')
      : assertFullGitObject(options.result.baseCommit, 'baseCommit');
  const tree = await git(options.result.directory, 'show', '-s', '--format=%T', bundledCommit);
  const bundledTree = assertFullGitObject(tree.trim(), 'tree');
  const bundle = await createBundle({
    directory: options.result.directory,
    artifactDirectory: options.artifactDirectory,
    commit: bundledCommit,
  });
  const workflowFile = options.snapshot ? assertWorkflowFile(options.workflowFile) : undefined;
  if (options.snapshot && workflowFile === undefined) {
    throw new PreparedSyncError('snapshot artifacts must name the release workflow file');
  }
  const common = {
    version: manifestVersion as typeof manifestVersion,
    target: options.result.target,
    corvidaeCommit: assertFullGitObject(options.corvidaeCommit, 'corvidaeCommit'),
    snapshot: options.snapshot,
    baseBranch: options.result.baseBranch,
    baseCommit: assertFullGitObject(options.result.baseCommit, 'baseCommit'),
    changed: options.result.changed,
    tree: bundledTree,
    bundle,
    ...(workflowFile === undefined ? {} : { workflowFile }),
  };
  const manifest =
    options.result.decision === 'skip'
      ? ({ ...common, decision: 'skip' } satisfies PreparedSyncManifest)
      : ({
          ...common,
          decision: 'prepared',
          commit: bundledCommit,
        } satisfies PreparedSyncManifest);
  await Bun.write(
    join(options.artifactDirectory, preparedSyncManifestFile),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );
  return manifest;
}

function isolatedGitEnvironment(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const environment = Object.fromEntries(
    Object.entries(base).filter(([name]) => !name.startsWith('GIT_')),
  );
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function verifyBundleIdentity(options: {
  bundlePath: string;
  manifest: PreparedSyncManifest;
  environment: Record<string, string | undefined>;
  run: CommandRunner;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mirror-prepared-sync-'));
  const repository = join(root, 'repository.git');
  const environment = isolatedGitEnvironment(options.environment);
  const expectedCommit =
    options.manifest.decision === 'prepared'
      ? (options.manifest.commit as string)
      : options.manifest.baseCommit;
  const runGit = async (cwd: string, arguments_: readonly string[]) => {
    const result = await options.run(['git', ...arguments_], { cwd, env: environment });
    if (result.exitCode !== 0) {
      throw new PreparedSyncError(
        `Prepared sync Git verification failed: ${arguments_[0]} (exit ${result.exitCode})`,
      );
    }
    return result.stdout.trim();
  };
  try {
    await runGit(root, ['check-ref-format', `refs/heads/${options.manifest.baseBranch}`]);
    await runGit(root, ['init', '--bare', '--template=', repository]);
    await runGit(repository, [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--no-auto-gc',
      options.bundlePath,
      'HEAD:refs/heads/verified',
    ]);
    const imported = await runGit(repository, ['rev-parse', 'refs/heads/verified']);
    if (imported !== expectedCommit) {
      throw new PreparedSyncError('Prepared bundle commit does not match the manifest');
    }
    const tree = await runGit(repository, ['show', '-s', '--format=%T', imported]);
    if (tree !== options.manifest.tree) {
      throw new PreparedSyncError('Prepared bundle tree does not match the manifest');
    }
    if (options.manifest.snapshot) {
      const listing = await runGit(repository, [
        'ls-tree',
        `refs/heads/verified:${releaseWorkflowDirectory}`,
      ]);
      const workflows = releaseWorkflowEntries(listing);
      if (workflows.length !== 1) {
        throw new PreparedSyncError(
          'Prepared snapshot bundle must carry exactly one release workflow file',
        );
      }
      const workflow = workflows[0];
      if (workflow === undefined) {
        throw new PreparedSyncError(
          'Prepared snapshot bundle must carry exactly one release workflow file',
        );
      }
      if (
        workflow.file !== options.manifest.workflowFile ||
        workflow.type !== 'blob' ||
        !workflow.mode.startsWith('100')
      ) {
        throw new PreparedSyncError(
          'Prepared snapshot release workflow file does not match the imported bundle',
        );
      }
    }
    if (options.manifest.decision === 'prepared') {
      const ancestry = await options.run(
        ['git', 'merge-base', '--is-ancestor', options.manifest.baseCommit, imported],
        { cwd: repository, env: environment },
      );
      if (ancestry.exitCode !== 0) {
        throw new PreparedSyncError('Prepared bundle commit is not descended from the base commit');
      }
      const trailerValues = await runGit(repository, [
        'log',
        '-1',
        `--format=%(trailers:key=${provenanceTrailer},valueonly)`,
        imported,
      ]);
      const trailers = trailerValues.split('\n').filter((line) => line.length > 0);
      if (trailers.length !== 1 || trailers[0] !== options.manifest.corvidaeCommit) {
        throw new PreparedSyncError('Prepared bundle does not carry the expected corvidae trailer');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function verifyPreparedSyncArtifact(options: {
  artifactDirectory: string;
  expectedTarget: MirrorTarget;
  expectedCorvidaeCommit: string;
  expectedSnapshot: boolean;
  environment?: Record<string, string | undefined>;
  run?: CommandRunner;
}): Promise<VerifiedPreparedSync> {
  if (!isAbsolute(options.artifactDirectory)) {
    throw new PreparedSyncError('Prepared sync artifact directory must be absolute');
  }
  const manifest = await readPreparedSyncManifest(
    join(options.artifactDirectory, preparedSyncManifestFile),
  );
  if (manifest.target !== options.expectedTarget) {
    throw new PreparedSyncError('Prepared sync target does not match the workflow input');
  }
  if (
    manifest.corvidaeCommit !==
    assertFullGitObject(options.expectedCorvidaeCommit, 'expectedCorvidaeCommit')
  ) {
    throw new PreparedSyncError('Prepared sync source commit does not match the workflow input');
  }
  if (manifest.snapshot !== options.expectedSnapshot) {
    throw new PreparedSyncError('Prepared sync snapshot flag does not match the workflow input');
  }
  const bundlePath = join(options.artifactDirectory, manifest.bundle.file);
  const digest = await fileSha256(bundlePath);
  if (digest !== manifest.bundle.sha256) {
    throw new PreparedSyncError('Prepared bundle digest does not match the manifest');
  }
  await verifyBundleIdentity({
    bundlePath,
    manifest,
    environment: options.environment ?? Bun.env,
    run: options.run ?? runCommand,
  });
  return { manifest, bundlePath };
}
