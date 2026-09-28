import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mirrorPlatformEnvironment } from './environment-configuration.ts';

import {
  readReleaseWorkflowBunVersion,
  readWorkflowInstalls,
  resolveReleaseWorkflowFile,
} from './install-parity.ts';
import { discoverWorkspaces } from './manifests.ts';
import { installArgumentsFrom } from './mirror-verify-workflow.ts';
import { readPackagePayload } from './package-payload.ts';
import { loadPackageSurface, type SurfaceExportsMap } from './package-surface.ts';
import {
  assertSucceeded,
  runCommand,
  verifyTarballFilename,
  type CommandRunner,
} from './packaging.ts';
import {
  committedPublicationManifest,
  objectRecord,
  readPublishedManifest,
  type PublishedRegistryPackage,
} from './registry-manifest.ts';
import type { PublishedPackage } from './surface.ts';
import type { VerifyEnvironment, VerifyStep, VerifyStepsInputs } from './verify-steps.ts';

type HistoricalBuildVerifySteps = (
  inputs: VerifyStepsInputs,
  environment: VerifyEnvironment,
) => readonly VerifyStep[];

async function historicalBuildVerifySteps(
  publishedSourceRoot: string,
): Promise<HistoricalBuildVerifySteps> {
  const recipePath = join(publishedSourceRoot, 'scripts/mirror/verify-steps.ts');
  if (!(await Bun.file(recipePath).exists()))
    throw new Error(`Historical build-step recipe is missing: ${recipePath}`);
  let module: { buildVerifySteps?: unknown };
  try {
    module = (await import(pathToFileURL(recipePath).href)) as { buildVerifySteps?: unknown };
  } catch (error) {
    throw new Error(`Historical build-step recipe could not be loaded: ${recipePath}`, {
      cause: error,
    });
  }
  if (typeof module.buildVerifySteps !== 'function')
    throw new Error(`Historical build-step recipe is incompatible: ${recipePath}`);
  return module.buildVerifySteps as HistoricalBuildVerifySteps;
}

export interface CleanPackageBuildOptions {
  targetRepositoryDirectory: string;
  gitHead: string;
  publishedSourceRoot: string;
  workspace: string;
  publicName: string;
  targetDirectory: string;
  runner?: CommandRunner;
  bunExecutable?: string;
}

/** Only platform settings reach target build tools; publisher credentials and injected Git config do not. */
function buildEnvironment(bunExecutable: string): Record<string, string | undefined> {
  const environment = mirrorPlatformEnvironment();
  return {
    ...environment,
    PATH: `${dirname(bunExecutable)}:${environment['PATH'] ?? ''}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_USERCONFIG: '/dev/null',
  };
}

async function publishedPackages(
  checkout: string,
  publishedSourceRoot: string,
): Promise<PublishedPackage[]> {
  const surface = await loadPackageSurface(
    join(publishedSourceRoot, 'scripts/mirror/package-surface.json'),
  );
  const workspaces = await discoverWorkspaces(checkout);
  const published: PublishedPackage[] = [];
  for (const candidate of workspaces) {
    const sourceEntry = Object.entries(surface.packages).find(
      ([, entry]) => entry.publicName === candidate.name,
    );
    if (!sourceEntry || candidate.manifest['private'] === true) continue;
    const [workspace, entry] = sourceEntry;
    const version = candidate.manifest['version'];
    if (typeof version !== 'string')
      throw new Error(`${candidate.name}: missing committed version`);
    const scripts = objectRecord(candidate.manifest['scripts']);
    if (Object.values(scripts).some((value) => typeof value !== 'string'))
      throw new Error(`${candidate.name}: invalid committed scripts`);
    published.push({
      workspace,
      directory: candidate.directory,
      publicName: candidate.name,
      version,
      entry: { ...entry, build: { ...entry.build, scripts: scripts as Record<string, string> } },
      exports: objectRecord(candidate.manifest['exports'] ?? {}) as SurfaceExportsMap,
      files: Array.isArray(entry.files) ? entry.files : [],
      dependsOn: [],
    });
  }
  const names = new Set(published.map((entry) => entry.publicName));
  for (const entry of published) {
    const candidate = workspaces.find((item) => item.name === entry.publicName)!;
    entry.dependsOn = [
      ...new Set(
        ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'].flatMap(
          (field) =>
            Object.keys(objectRecord(candidate.manifest[field] ?? {})).filter(
              (name) => names.has(name) && name !== entry.publicName,
            ),
        ),
      ),
    ];
  }
  return published;
}

/** Reproduce the release artifact at its exact Git revision with the historical packing policy. */
export async function buildCleanPublishedPackage({
  targetRepositoryDirectory,
  gitHead,
  publishedSourceRoot,
  workspace,
  publicName,
  targetDirectory,
  runner = runCommand,
  bunExecutable = process.execPath,
}: CleanPackageBuildOptions): Promise<PublishedRegistryPackage> {
  if (!/^[a-f0-9]{40}$/.test(gitHead))
    throw new Error('Clean package build requires a full commit SHA');
  const executable = Bun.which(bunExecutable);
  if (!executable) throw new Error(`Bun executable is unavailable: ${bunExecutable}`);
  const environment = buildEnvironment(executable);
  const scratch = await mkdtemp(join(tmpdir(), 'corvidae-clean-package-'));
  const checkout = join(scratch, 'target');
  const run: CommandRunner = (command, options) =>
    runner(command, { ...options, env: environment });
  const execute = async (command: readonly string[], cwd: string, description: string) => {
    const result = await run(command, { cwd });
    assertSucceeded(result, description);
    return result.stdout.trim();
  };
  try {
    await execute(
      [
        'git',
        '-c',
        'core.hooksPath=/dev/null',
        'clone',
        '--no-hardlinks',
        '--no-checkout',
        '--',
        targetRepositoryDirectory,
        checkout,
      ],
      scratch,
      'clone target',
    );
    await execute(
      ['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', gitHead],
      checkout,
      'checkout exact gitHead',
    );
    if ((await execute(['git', 'rev-parse', 'HEAD'], checkout, 'read target revision')) !== gitHead)
      throw new Error('Clean build checkout revision mismatch');
    if (await execute(['git', 'status', '--porcelain'], checkout, 'check clean target'))
      throw new Error('Target checkout is not clean');
    const workflow = await resolveReleaseWorkflowFile(checkout);
    const version = await readReleaseWorkflowBunVersion(checkout, workflow);
    const actualVersion = await execute(
      [executable, '--version'],
      checkout,
      'check pinned Bun runtime',
    );
    if (actualVersion !== version)
      throw new Error(
        `Target release pins Bun ${version}, but ${executable} reports ${actualVersion}`,
      );
    const workflowInstalls = await readWorkflowInstalls(checkout);
    const installs = workflowInstalls.filter((entry) => entry.file === workflow);
    const commands = [
      ...new Set(installs.map((entry) => JSON.stringify(installArgumentsFrom(entry.command)))),
    ];
    if (commands.length !== 1)
      throw new Error(`${workflow}: expected one unambiguous release install command`);
    const installArguments = installArgumentsFrom(installs[0]!.command);
    const published = await publishedPackages(checkout, publishedSourceRoot);
    const requested = published.find(
      (entry) =>
        entry.workspace === workspace &&
        entry.publicName === publicName &&
        entry.directory === targetDirectory,
    );
    if (!requested)
      throw new Error(`${workspace}: historical surface and committed package identity disagree`);
    await mkdir(join(scratch, 'tarballs'));
    const buildVerifySteps = await historicalBuildVerifySteps(publishedSourceRoot);
    const steps = buildVerifySteps(
      {
        installCommand: ['bun', 'install', '--frozen-lockfile', ...installArguments],
        published,
        privateWorkspaces: [],
      },
      {
        resolveDirectory: (directory) => join(checkout, directory),
        scratchDirectory: scratch,
        toolCommand: (tool) => [tool],
      },
    );
    for (const step of steps) {
      if (!['install', 'build', 'prepack', 'pack', 'pack-relocate'].includes(step.kind)) continue;
      const entry = published.find((candidate) => candidate.publicName === step.publicName);
      const manifestPath = join(step.cwd, 'package.json');
      let originalManifest: Buffer | undefined;
      try {
        if (step.kind === 'pack' && entry?.entry.build.packedBy === 'files') {
          // The release resolves workspace versions from manifests; Bun pack can read stale lockfile versions.
          originalManifest = await readFile(manifestPath);
          const normalized = await committedPublicationManifest(
            checkout,
            gitHead,
            entry.directory,
            run,
          );
          await writeFile(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`);
        }
        await execute(
          step.command[0] === 'bun' ? [executable, ...step.command.slice(1)] : step.command,
          step.cwd,
          step.description,
        );
      } finally {
        // Later pack scripts require a clean Git checkout when binding gitHead into their staged manifest.
        if (originalManifest !== undefined) await writeFile(manifestPath, originalManifest);
      }
    }
    const archive = new Uint8Array(
      await Bun.file(join(scratch, 'tarballs', verifyTarballFilename(publicName))).arrayBuffer(),
    );
    return {
      manifest: await readPublishedManifest(archive, publicName, requested.version),
      payload: await readPackagePayload(archive),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
