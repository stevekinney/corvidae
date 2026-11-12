/**
 * Lists the processes agent sessions left behind in this repository's worktrees.
 *
 * A process belongs to the repository when its working directory is inside one of its worktrees
 * (`git worktree list --porcelain`) or its command line names a path inside one. Such a process is
 * listed, with its pid, age, memory, why it is listed, and its command, when its parent is pid 1
 * (whatever started it is gone), or when it is older than the threshold and runs the repository's
 * toolchain (Bun, Node, Turborepo, the type checkers, a Playwright browser). The age rule stops at
 * the toolchain because a live session's own processes (the agent, its shells, its MCP servers)
 * sit in a worktree for days and are nobody's leftovers. The audit itself, its ancestors (the
 * session running it) and Turborepo's daemon, which detaches by design and exits when idle, are
 * never listed.
 *
 * Without `--kill` nothing is touched, and the exit code is 1 when anything is listed. With
 * `--kill` exactly the listed orphans are stopped, each only while its start time still matches
 * the listing: SIGTERM, then SIGKILL for what is left after two seconds. An old process whose
 * parent is alive is listed and never stopped: its session may still be using it, so that is its
 * owner's call. Nothing is ever matched by name alone: other sessions run on this host.
 *
 * Usage: `bun scripts/agent-process-audit.ts [--older-than <hours>] [--kill]`
 */

import { readlinkSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { readProcessTable, type ProcessTable } from './bun-test-pool.ts';
import { ancestorsOf, processTableEnvironment } from './run-exclusively.ts';
import { footprintReader, type FootprintReader } from './test-watchdog.ts';

/** A process older than this is listed even while its parent lives. */
export const defaultOlderThanHours = 6;

export type AuditFinding = {
  readonly pid: number;
  readonly startedAt: string;
  readonly ageMilliseconds: number | undefined;
  readonly memoryBytes: number;
  readonly reasons: readonly string[];
  /** Whether its parent is pid 1; `--kill` stops no other process. */
  readonly orphaned: boolean;
  /** The worktree the process belongs to. */
  readonly worktree: string;
  readonly command: string;
};

/** The worktree roots in the output of `git worktree list --porcelain`. */
export function parseWorktreeRoots(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/** The working directory of each process in the output of `lsof -a -d cwd -Fpn`. */
export function parseWorkingDirectories(listing: string): Map<number, string> {
  const directories = new Map<number, string>();
  let pid: number | undefined;
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) directories.set(pid, line.slice(1));
  }
  return directories;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The longest root that `directory` is inside or that `command` names a path under. */
function owningWorktree(
  directory: string | undefined,
  command: string,
  roots: readonly string[],
): string | undefined {
  let owner: string | undefined;
  for (const root of roots) {
    const named = command.split(/\s+/).some((word) => {
      const start = word.indexOf(root);
      return start !== -1 && isInside(word.slice(start), root);
    });
    if (!named && (directory === undefined || !isInside(directory, root))) continue;
    if (owner === undefined || root.length > owner.length) owner = root;
  }
  return owner;
}

const toolchainPrograms = new Set([
  'bun',
  'bunx',
  'node',
  'turbo',
  'tsc',
  'svelte-check',
  'oxlint',
  'playwright',
]);

/** Whether the command runs the repository's toolchain: its programs, or a Playwright browser. */
function isToolchain(command: string): boolean {
  const program = command.split(/\s+/)[0] ?? '';
  return (
    toolchainPrograms.has(program.slice(program.lastIndexOf('/') + 1)) ||
    command.includes('/ms-playwright/')
  );
}

// `turbo daemon` detaches from the run that started it and exits by itself when idle.
const detachedByDesign = /(?:^|\/)turbo(?:\s+--skip-infer)?\s+daemon(?:\s|$)/;

export type AuditInput = {
  readonly table: ProcessTable;
  readonly workingDirectories: ReadonlyMap<number, string>;
  readonly roots: readonly string[];
  /** The audit's own pid and its ancestors, which are never listed. */
  readonly exempt: ReadonlySet<number>;
  readonly now: number;
  readonly olderThanMilliseconds: number;
  readonly readFootprint?: FootprintReader | undefined;
};

/** The processes of the repository's worktrees that are orphaned or older than the threshold. */
export function auditProcesses(input: AuditInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const [pid, entry] of input.table) {
    if (pid <= 1 || input.exempt.has(pid)) continue;
    const command = entry.command ?? '';
    if (detachedByDesign.test(command)) continue;
    const worktree = owningWorktree(input.workingDirectories.get(pid), command, input.roots);
    if (worktree === undefined) continue;
    const started = Date.parse(entry.startedAt);
    const ageMilliseconds = Number.isNaN(started) ? undefined : Math.max(0, input.now - started);
    const reasons: string[] = [];
    const orphaned = entry.parent === 1;
    if (orphaned) reasons.push('orphaned (parent is pid 1)');
    if (
      ageMilliseconds !== undefined &&
      ageMilliseconds > input.olderThanMilliseconds &&
      (orphaned || isToolchain(command))
    ) {
      reasons.push(`older than ${Math.round(input.olderThanMilliseconds / 3_600_000)} h`);
    }
    if (reasons.length === 0) continue;
    findings.push({
      pid,
      startedAt: entry.startedAt,
      ageMilliseconds,
      memoryBytes: Math.max(entry.residentBytes ?? 0, input.readFootprint?.(pid) ?? 0),
      reasons,
      orphaned,
      worktree,
      command,
    });
  }
  return findings.toSorted((left, right) => right.memoryBytes - left.memoryBytes);
}

function describeAge(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return 'unknown age';
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48
    ? `${hours} h ${minutes % 60} min`
    : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** One finding as one line. */
export function describeFinding(finding: AuditFinding): string {
  const megabytes = Math.round(finding.memoryBytes / 1024 ** 2);
  const command =
    finding.command.length > 200 ? `${finding.command.slice(0, 200)}…` : finding.command;
  return `pid ${finding.pid}, ${describeAge(finding.ageMilliseconds)}, ${megabytes} MB, ${finding.reasons.join(' and ')}, in ${finding.worktree}: ${command}`;
}

function readWorkingDirectories(table: ProcessTable): Map<number, string> {
  if (process.platform === 'linux') {
    const directories = new Map<number, string>();
    for (const pid of table.keys()) {
      try {
        directories.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // Another user's process, or one that has exited.
      }
    }
    return directories;
  }
  // `lsof` exits 1 when it could not read some process, and still lists the rest.
  const listing = Bun.spawnSync(['lsof', '-a', '-d', 'cwd', '-Fpn'], {
    env: processTableEnvironment(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return parseWorkingDirectories(listing.stdout.toString());
}

function readWorktreeRoots(): string[] | undefined {
  const listing = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return listing.exitCode === 0 ? parseWorktreeRoots(listing.stdout.toString()) : undefined;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

const killGraceMilliseconds = 2000;

/** Stops exactly `findings`, each only while its start time still matches; resolves to the survivors. */
async function stop(findings: readonly AuditFinding[]): Promise<AuditFinding[]> {
  const living = (): AuditFinding[] => {
    const table = readProcessTable();
    if (table === undefined) return [];
    return findings.filter((finding) => table.get(finding.pid)?.startedAt === finding.startedAt);
  };
  for (const finding of living()) signal(finding.pid, 'SIGTERM');
  for (let waited = 0; waited < killGraceMilliseconds && living().length > 0; waited += 100) {
    await Bun.sleep(100);
  }
  for (const finding of living()) signal(finding.pid, 'SIGKILL');
  await Bun.sleep(100);
  return living();
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { 'older-than': { type: 'string' }, kill: { type: 'boolean' } },
    strict: true,
  });
  const hours = Number(values['older-than'] ?? defaultOlderThanHours);
  if (!(hours > 0)) {
    process.stderr.write('--older-than must be a positive number of hours\n');
    return 64;
  }
  const roots = readWorktreeRoots();
  const table = readProcessTable();
  if (roots === undefined || table === undefined) {
    process.stderr.write(
      'agent-process-audit: could not read the worktrees or the process table\n',
    );
    return 2;
  }
  const parents = new Map<number, number>();
  for (const [pid, entry] of table) if (entry.parent !== undefined) parents.set(pid, entry.parent);
  const findings = auditProcesses({
    table,
    workingDirectories: readWorkingDirectories(table),
    roots,
    exempt: new Set([process.pid, ...ancestorsOf(process.pid, parents)]),
    now: Date.now(),
    olderThanMilliseconds: hours * 3_600_000,
    readFootprint: footprintReader(),
  });
  if (findings.length === 0) {
    process.stdout.write(
      `agent-process-audit: no orphaned process and none older than ${hours} h in ${roots.length} worktree(s)\n`,
    );
    return 0;
  }
  for (const finding of findings) process.stdout.write(`${describeFinding(finding)}\n`);
  const total = findings.reduce((sum, finding) => sum + finding.memoryBytes, 0);
  process.stdout.write(
    `agent-process-audit: ${findings.length} process(es) holding ${(total / 1024 ** 3).toFixed(1)} GiB\n`,
  );
  if (values.kill !== true) {
    process.stdout.write(
      'agent-process-audit: nothing was stopped; pass --kill to stop exactly the orphans listed\n',
    );
    return 1;
  }
  const orphans = findings.filter((finding) => finding.orphaned);
  const survivors = await stop(orphans);
  process.stdout.write(
    `agent-process-audit: stopped ${orphans.length - survivors.length} of ${orphans.length} orphan(s)\n`,
  );
  for (const survivor of survivors) process.stdout.write(`still running: pid ${survivor.pid}\n`);
  const parented = findings.filter((finding) => !finding.orphaned);
  for (const finding of parented) {
    process.stdout.write(
      `not stopped, its parent is alive: pid ${finding.pid}; end its session or stop it yourself\n`,
    );
  }
  return survivors.length + parented.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
