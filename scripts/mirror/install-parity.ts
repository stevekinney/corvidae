import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Keep the mirror's verification install honest about the target's real one.
 *
 * COR-1278: `verifyTarget` installed the staged tree with `--ignore-scripts`, while every one of
 * weft's own CI jobs installs without it. The flag was added for an unrelated reason — stopping
 * the target's husky `prepare` from arming hooks before the sync's own commit — and it silently
 * took `better-sqlite3`'s `install` script with it, so the staged tree carried the package fully
 * requirable but with no compiled `better_sqlite3.node`. The mirror then verified a tree that no
 * consumer, and not even the target's own CI, would ever produce, and reported it green until an
 * integration test happened to construct a database.
 *
 * The lesson generalizes past that one flag: a verification step that installs differently from
 * the environment it claims to prove is worse than no verification step, because it converts an
 * unknown into a false assurance. So the flags the mirror installs with are checked against the
 * flags the target's own workflows install with, read from the clone at sync time rather than
 * copied into a constant here. A constant would be one more thing to remember to update, and the
 * whole failure mode is a divergence nobody noticed.
 *
 * @module mirror/install-parity
 */

/** One `bun install` invocation found in a target workflow. */
export interface WorkflowInstall {
  /** Workflow file it came from, relative to `.github/workflows`. */
  readonly file: string;
  /** The command text, from `bun install` to end of line. */
  readonly command: string;
  /** Flag names it passes, without values: `--linker=isolated` reads as `--linker`. */
  readonly flags: readonly string[];
}

/** What a parity check established, so an unverifiable target is visible rather than silent. */
export interface InstallParity {
  /** The verification install's command text. */
  readonly command: string;
  /** Workflow installs the parity was checked against; empty when the target has no workflows. */
  readonly checkedAgainst: readonly string[];
}

/** Raised when the mirror would install differently from the target's own CI. */
export class InstallParityError extends Error {}

/**
 * Flags that suppress part of an install and can therefore never be waived by a caller.
 *
 * `allowedExtraFlags` exists for run-scoped arguments that change how a package is *fetched*
 * without changing what ends up built — `--offline`, which the offline tests pass to prove no
 * registry was reached. Letting that escape hatch also cover a flag that skips build steps would
 * reintroduce exactly the defect this module exists to catch, so the two sets are disjoint by
 * construction: a suppressing flag passes only when the target's own install passes it too.
 */
const neverWaivable: ReadonlySet<string> = new Set([
  '--ignore-scripts',
  '--no-optional',
  '--omit',
  '--production',
]);

/** The flag name in `token`, without its value. */
function flagName(token: string): string | undefined {
  if (!token.startsWith('--')) return undefined;
  const separator = token.indexOf('=');
  return separator === -1 ? token : token.slice(0, separator);
}

/** Flag names in a command line, in order, without values. */
export function installFlags(command: readonly string[] | string): readonly string[] {
  const tokens = typeof command === 'string' ? command.split(/\s+/) : command;
  return tokens
    .map((token) => flagName(token))
    .filter((name): name is string => name !== undefined);
}

/**
 * Every `bun install` in one workflow file.
 *
 * Deliberately a line scan rather than a YAML parse: a workflow's `run:` body is an opaque shell
 * string to YAML, so parsing the document still leaves the command to read as text, and the extra
 * dependency would buy nothing. A line is taken from `bun install` to its end, which is what a
 * single-line `run:` step is; a multi-line install with a continuation is not something either
 * target writes, and would show up here as a shorter command rather than a wrong one.
 */
export function extractWorkflowInstalls(file: string, contents: string): WorkflowInstall[] {
  const installs: WorkflowInstall[] = [];
  for (const line of contents.split('\n')) {
    // A commented-out install is not an install the target runs, and letting one through would
    // make the gate *weaker* rather than noisier: every flag found here joins the reference set
    // the mirror's own command is checked against, so `# we used to pass --ignore-scripts` would
    // quietly authorize passing it for real. A subset check is only as strong as its reference.
    if (line.trimStart().startsWith('#')) continue;
    const start = line.indexOf('bun install');
    if (start === -1) continue;
    const command = line.slice(start).trim();
    installs.push({ file, command, flags: installFlags(command) });
  }
  return installs;
}

/** Every `bun install` across a clone's `.github/workflows`. */
export async function readWorkflowInstalls(directory: string): Promise<WorkflowInstall[]> {
  const workflows = join(directory, '.github', 'workflows');
  let entries: string[];
  try {
    entries = await readdir(workflows);
  } catch {
    return [];
  }

  const installs: WorkflowInstall[] = [];
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const contents = await Bun.file(join(workflows, entry)).text();
    installs.push(...extractWorkflowInstalls(entry, contents));
  }
  return installs;
}

/** The two spellings GitHub Actions accepts for the same workflow file, in the order probed. */
const releaseWorkflowNames = ['release.yaml', 'release.yml'] as const;

/**
 * Which of the two spellings this clone's release workflow actually uses.
 *
 * `release.yaml` was a default parameter until COR-1287, which is the same class of mistake this
 * module was written to catch one layer down: a constant standing in for something that is only
 * true of the targets that existed when it was written. weft and cinder spell it `release.yaml`,
 * the since-retired stevekinney/agent-bureau target spelled it `release.yml`, GitHub Actions accepts both, and a default
 * that guesses wrong does not fail cleanly — `readWorkflowInstalls` finds the install line under
 * the real name, the `find` for `releaseWorkflowFile` misses it, and the rendered workflow
 * silently loses the release workflow's install arguments. So the name is read off the clone, for
 * the reason the module header gives: the whole failure mode is a divergence nobody noticed.
 *
 * Both present is an error rather than a preference. Two release workflows is a fact about the
 * target nobody has ruled on, and picking one would make the mirror pin its Bun version and
 * install flags to whichever this function happened to probe first.
 */
export async function resolveReleaseWorkflowFile(directory: string): Promise<string> {
  const present: string[] = [];
  for (const name of releaseWorkflowNames) {
    if (await Bun.file(join(directory, '.github', 'workflows', name)).exists()) present.push(name);
  }
  if (present.length === 1) return present[0] as string;
  if (present.length === 0) {
    throw new InstallParityError(
      `This clone carries neither ${releaseWorkflowNames.join(' nor ')}; cannot read a release workflow's bun-version pin`,
    );
  }
  throw new InstallParityError(
    `This clone carries both ${present.join(' and ')}; which one is the release workflow has to be ruled on rather than guessed`,
  );
}

/**
 * The `bun-version:` an `oven-sh/setup-bun` step pins in one workflow file, read directly rather
 * than assumed.
 *
 * COR-1286's `mirror-verify.yaml` has to pin the same Bun version the target's own release
 * workflow does — reading it here, the way `readWorkflowInstalls` already reads the release
 * workflow's install line, is what lets the renderer generalize past weft's `1.4.2` to whatever a
 * target's release workflow pins next, without this module needing to know either value ahead of
 * time. A line scan again, for the reason `extractWorkflowInstalls` gives: the value is inside a
 * `run:`/`with:` block that YAML treats as opaque text or a scalar, so parsing the document still
 * leaves this to read as text.
 *
 * `file` is optional and resolved from the clone when it is omitted, so no caller has to carry a
 * per-target filename. Passing one explicitly is still how a fixture names a workflow that is not
 * a release workflow at all.
 */
export async function readReleaseWorkflowBunVersion(
  directory: string,
  workflowFile?: string,
): Promise<string> {
  const file = workflowFile ?? (await resolveReleaseWorkflowFile(directory));
  const path = join(directory, '.github', 'workflows', file);
  const contents = await Bun.file(path)
    .text()
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  if (contents === undefined) {
    throw new InstallParityError(
      `${file} does not exist in this clone; cannot read its bun-version pin`,
    );
  }
  const match = contents.match(/bun-version:\s*['"]?([^'"\n#]+)/);
  if (!match?.[1]) {
    throw new InstallParityError(`${file} has no \`bun-version:\` pin for oven-sh/setup-bun`);
  }
  return match[1].trim();
}

export interface InstallParityOptions {
  /** The install the mirror is about to run. */
  readonly command: readonly string[];
  /** Installs read from the target's workflows. */
  readonly workflowInstalls: readonly WorkflowInstall[];
  /** Run-scoped flags the harness adds that the target has no reason to carry. */
  readonly allowedExtraFlags?: readonly string[] | undefined;
}

/**
 * Refuse a verification install that suppresses something the target's own install does not.
 *
 * Subset, not equality: the target passing a flag the mirror omits is the target's business, and
 * `--linker=isolated` is already supplied through the run's own arguments. What must not happen
 * is the mirror passing a flag no CI job passes, because that is the mirror proving a tree that
 * does not exist anywhere else.
 *
 * A target with no workflows is not an error — the test fixtures have none — but it is not a pass
 * either. It returns an empty `checkedAgainst`, so the sync's result records that nothing was
 * compared rather than implying a clean comparison.
 */
export function assertInstallParity({
  command,
  workflowInstalls,
  allowedExtraFlags = [],
}: InstallParityOptions): InstallParity {
  const text = command.join(' ');
  const parity: InstallParity = {
    command: text,
    checkedAgainst: workflowInstalls.map((install) => `${install.file}: ${install.command}`),
  };
  if (workflowInstalls.length === 0) return parity;

  const targetFlags = new Set(workflowInstalls.flatMap((install) => install.flags));
  const waivable = new Set(allowedExtraFlags.filter((flag) => !neverWaivable.has(flag)));
  const divergent = [
    ...new Set(
      installFlags(command).filter((flag) => !targetFlags.has(flag) && !waivable.has(flag)),
    ),
  ];
  if (divergent.length === 0) return parity;

  throw new InstallParityError(
    `The mirror's verification install passes ${divergent.join(', ')}, which no install in the ` +
      `target's own workflows passes. Verifying a tree the target would never build is how ` +
      `COR-1278 shipped an uncompiled native binding past a green sync.\n` +
      `  mirror:  ${text}\n` +
      workflowInstalls.map((install) => `  ${install.file}: ${install.command}`).join('\n'),
  );
}
