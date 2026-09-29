import {
  readReleaseWorkflowBunVersion,
  readWorkflowInstalls,
  resolveReleaseWorkflowFile,
} from './install-parity.ts';
import type { PrivateWorkspace, PublishedPackage } from './surface.ts';
import {
  buildVerifySteps,
  type PackagingTool,
  type VerifyEnvironment,
  type VerifyStep,
} from './verify-steps.ts';

/**
 * Renders `mirror-verify.yaml`: the one transform-emitted workflow whose verification operations
 * come from `verifyTarget`'s steps, plus the target's existing release workflow, unchanged.
 *
 * Everything a step needs that is environment-specific — where tools come from, where scratch
 * files go — is resolved once, in {@link createWorkflowVerifyEnvironment}, into the *rendered*
 * workflow environment: `bunx` invocations pinned to the exact versions corvidae's own `bun.lock`
 * carries (never a range — `bunx publint@^0.3.24` would resolve to whatever is newest at CI time,
 * a drift this module cannot see), and `${{ runner.temp }}` for the scratch directory a GitHub
 * Actions job always provides. `buildVerifySteps` itself never changes between this renderer and
 * `verifyTarget` (`sync.ts`) — only the environment passed into it does — so the ordered list of
 * jobs, their descriptions, working directories and command flags come from one function call
 * either caller could make, not two hand-written copies that happen to agree today.
 */

export const packagingToolPackage: Record<PackagingTool, string> = {
  publint: 'publint',
  attw: '@arethetypeswrong/cli',
};

/** A packaging tool's locked version, read from a `bun.lock` rather than a `package.json` range. */
export async function readLockedVersion(bunLockPath: string, packageName: string): Promise<string> {
  const text = await Bun.file(bunLockPath).text();
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = text.match(new RegExp(`"${escaped}":\\s*\\[\\s*"${escaped}@([^"]+)"`));
  if (!match?.[1]) {
    throw new Error(`bun.lock has no locked entry for ${packageName}`);
  }
  return match[1];
}

export interface WorkflowVerifyEnvironmentOptions {
  /** Locked `publint`/`@arethetypeswrong/cli` versions, read from corvidae's own `bun.lock`. */
  lockedVersions: Readonly<Record<PackagingTool, string>>;
}

/**
 * The environment `mirror-verify.yaml`'s steps resolve against: a target-relative directory is
 * already what GitHub Actions' `working-directory:` wants, so `resolveDirectory` is the identity;
 * `publint`/`attw` are fetched with `bunx` since the target does not carry them as its own
 * `devDependencies` — unlike `verifyTarget`'s local environment, this one always has registry
 * access, being GitHub-hosted CI, so there is nothing to keep offline here.
 */
export function createWorkflowVerifyEnvironment({
  lockedVersions,
}: WorkflowVerifyEnvironmentOptions): VerifyEnvironment {
  return {
    resolveDirectory: (targetRelativeDirectory) => targetRelativeDirectory,
    scratchDirectory: '${{ runner.temp }}/mirror-verify',
    // `bunx <package>@<version>` runs that package's binary: `publint` and `attw` each ship one
    // bin, so the package spec alone names it. Naming the binary again hands the tool a stray
    // positional argument — the seventh dry run's `publint publint --strict <tarball>` linted a
    // directory called `publint`, and attw would have opened a file called `attw`.
    toolCommand: (tool) => [
      'bunx',
      '--bun',
      `${packagingToolPackage[tool]}@${lockedVersions[tool]}`,
    ],
  };
}

export interface RenderMirrorVerifyWorkflowOptions {
  /** The staged clone, read to derive the release workflow's Bun pin and install line. */
  targetDirectory: string;
  /** Path to the `bun.lock` whose locked `publint`/`attw` versions the rendered workflow pins. */
  bunLockPath: string;
  published: readonly PublishedPackage[];
  privateWorkspaces: readonly PrivateWorkspace[];
  /**
   * Filename of the target's release workflow. Resolved from the clone when omitted, because the
   * spelling is the target's: weft and cinder carry `release.yaml`, agent-bureau `release.yml`.
   */
  releaseWorkflowFile?: string;
}

/** The extra `bun install` arguments after `--frozen-lockfile`, parsed from the release workflow's own install line. */
export function installArgumentsFrom(installCommandText: string): string[] {
  const tokens = installCommandText.trim().split(/\s+/);
  return tokens.filter(
    (token, index) =>
      !(index < 2 && (token === 'bun' || token === 'install')) && token !== '--frozen-lockfile',
  );
}

/**
 * A synthetic step outside `buildVerifySteps`'s shared list: `working-directory:` refuses to run
 * in a path that does not exist yet, unlike `verifyTarget`'s local run, where `packWorkspace`'s own
 * `mkdir` (and, empirically, `bun pm pack --destination` itself) already guarantee the equivalent
 * paths exist before anything reads or writes under them. The rendered workflow has no such
 * wrapper, so it creates both scratch subdirectories once, up front, rather than have each of the
 * steps that first touches one carry its own conditional `mkdir`.
 */
function renderScratchPreparationStep(scratchDirectory: string): string {
  return [
    '      - name: Prepare mirror-verify scratch directories',
    `        run: mkdir -p '${scratchDirectory}/tarballs' '${scratchDirectory}/consumer'`,
  ].join('\n');
}

/**
 * One argv element as a shell word. `VerifyStep.command` is real argv locally, so an element may
 * carry spaces or quotes (the relocate step's `bun -e` script does); those are single-quoted here.
 * A `${{ … }}` expression is replaced by GitHub before the shell sees the line, so it neither needs
 * quoting on its own nor breaks it inside quotes.
 */
export function shellWord(argument: string): string {
  if (/^[\w@%+=:,./-]+$/.test(argument.replaceAll(/\$\{\{[^}]*\}\}/g, 'x'))) return argument;
  return `'${argument.replaceAll("'", String.raw`'\''`)}'`;
}

// GitHub rejects a `run` expression above 21,000 characters before it starts any job. Leave room
// for YAML processing and future command growth rather than rendering right up to that limit.
const MAX_RUN_LENGTH = 16_000;
const FILE_DELIMITER = 'MIRROR_VERIFY_EOF';

/** One bounded run body rendered as a GitHub Actions step. */
function renderRunStep(description: string, cwd: string, runLines: readonly string[]): string {
  const lines = [`      - name: ${description}`, `        working-directory: ${cwd}`];
  if (runLines.length === 0) return lines.join('\n');
  const runLength = runLines.join('\n').length + 1;
  if (runLength > MAX_RUN_LENGTH) {
    throw new Error(`${description} exceeds the GitHub Actions run expression limit`);
  }
  // Every element here is one physical line — a multi-line heredoc body is split immediately
  // rather than pushed as one string carrying embedded `\n`s, because a YAML block scalar (`run:
  // |`) requires *every* line to carry its own indentation. Pushing a multi-line string and
  // indenting the array afterwards only indents each element's first line, leaving the rest at
  // column zero: valid-looking output that is not valid YAML (verified against a real parser
  // while building this — it broke exactly this way the first time).
  lines.push(
    '        run: |',
    ...runLines.map((line) => (line.length === 0 ? '' : `          ${line}`)),
  );
  return lines.join('\n');
}

/** Split a generated file into bounded append steps without changing its bytes or its order. */
function renderFileSteps(step: VerifyStep, path: string, contents: string): string[] {
  const rendered: string[] = [];
  const sourceLines = contents.replace(/\n$/, '').split('\n');
  let chunk: string[] = [];
  let chunkLength = 0;

  function flush(): void {
    if (chunk.length === 0) return;
    const redirect = rendered.length === 0 ? '>' : '>>';
    rendered.push(
      renderRunStep(`${step.description} (${path}, part ${rendered.length + 1})`, step.cwd, [
        `cat ${redirect} ${path} <<'${FILE_DELIMITER}'`,
        ...chunk,
        FILE_DELIMITER,
      ]),
    );
    chunk = [];
    chunkLength = 0;
  }

  for (const line of sourceLines) {
    const redirect = rendered.length === 0 ? '>' : '>>';
    const overhead =
      `cat ${redirect} ${path} <<'${FILE_DELIMITER}'`.length + FILE_DELIMITER.length + 2;
    if (chunk.length > 0 && overhead + chunkLength + line.length + 1 > MAX_RUN_LENGTH) flush();
    if (overhead + chunkLength + line.length + 1 > MAX_RUN_LENGTH) {
      throw new Error(`${step.description} has a file line longer than the Actions run limit`);
    }
    chunk.push(line);
    chunkLength += line.length + 1;
  }
  flush();
  return rendered;
}

/** One shared verification operation, sometimes rendered as multiple bounded Actions steps. */
function renderStep(step: VerifyStep): string[] {
  const rendered = Object.entries(step.files ?? {}).flatMap(([path, contents]) =>
    renderFileSteps(step, path, contents),
  );
  if (step.command.length > 0 || rendered.length === 0) {
    rendered.push(
      renderRunStep(
        step.description,
        step.cwd,
        step.command.length > 0 ? [step.command.map(shellWord).join(' ')] : [],
      ),
    );
  }
  return rendered;
}

/**
 * Render `mirror-verify.yaml` for one target's staged clone.
 *
 * `on: pull_request` is the workflow this replaces (`ci.yaml`, retired for weft; `ci.yml` for
 * agent-bureau): a mirror sync opens a pull request against the target, so the jobs that used to
 * gate a pull request there now gate it here instead. `merge_group` is carried over from that same
 * retired CI workflow rather than from the release workflow, which triggers on a tag push and has
 * never used a merge queue — every target's CI/release split confirms `merge_group` belongs to the
 * PR gate, not the release workflow, so this workflow keeps it even though it is not literally
 * reading it off the release workflow.
 */
export async function renderMirrorVerifyWorkflow({
  targetDirectory,
  bunLockPath,
  published,
  privateWorkspaces,
  releaseWorkflowFile,
}: RenderMirrorVerifyWorkflowOptions): Promise<string> {
  // Resolved once and reused for both reads. Resolving it twice would be the defect this replaced
  // in a new shape: the `find` below has to look for the same filename the pin was read from, or
  // the rendered install silently loses the release workflow's own arguments.
  const releaseWorkflow =
    releaseWorkflowFile ?? (await resolveReleaseWorkflowFile(targetDirectory));
  const bunVersion = await readReleaseWorkflowBunVersion(targetDirectory, releaseWorkflow);
  const workflowInstalls = await readWorkflowInstalls(targetDirectory);
  const releaseInstall = workflowInstalls.find((install) => install.file === releaseWorkflow);
  const installArguments = releaseInstall ? installArgumentsFrom(releaseInstall.command) : [];
  const installCommand = ['bun', 'install', '--frozen-lockfile', ...installArguments];

  const lockedVersions: Record<PackagingTool, string> = {
    publint: await readLockedVersion(bunLockPath, 'publint'),
    attw: await readLockedVersion(bunLockPath, '@arethetypeswrong/cli'),
  };
  const environment = createWorkflowVerifyEnvironment({ lockedVersions });
  const steps = buildVerifySteps(
    { installCommand, published, privateWorkspaces, installArguments },
    environment,
  );

  // Inserted after `install` (`steps[0]`) and before everything that reads or writes under a
  // scratch subdirectory — see `renderScratchPreparationStep`'s own comment for why this is not
  // part of `buildVerifySteps`'s shared list.
  const [installStep, ...remainingSteps] = steps;
  const rendered = [
    ...(installStep ? renderStep(installStep) : []),
    renderScratchPreparationStep(environment.scratchDirectory),
    ...remainingSteps.flatMap(renderStep),
  ].join('\n\n');

  return [
    "# Generated by corvidae's mirror transform (COR-1286). Do not edit by hand: a sync overwrites",
    "# this file every run. Its operations come from verifyTarget's steps (scripts/mirror/verify-steps.ts",
    "# in corvidae), rendered for this target's own CI so a pull request the mirror opens carries",
    '# the same verification the sync already ran before opening it.',
    'name: mirror-verify',
    '',
    'on:',
    '  pull_request:',
    '  merge_group:',
    // The release workflow's pre-publish gate calls this workflow rather than restating its steps
    // (COR-1286 D4), so a tag is verified by the same jobs a pull request is.
    '  workflow_call:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v7',
    '',
    '      - name: Setup Bun',
    '        uses: oven-sh/setup-bun@v2',
    '        with:',
    `          bun-version: ${bunVersion}`,
    '',
    rendered,
    '',
  ].join('\n');
}
