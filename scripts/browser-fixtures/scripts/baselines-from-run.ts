/**
 * `bun scripts/browser-fixtures/scripts/baselines-from-run.ts <run-id> [--write]` (COR-2457)
 *
 * Updates the committed Linux baselines from a `main.yml` run's failure artifact, with no
 * local Docker pass. The fixtures job uploads `playwright-fixtures-<shard>` on failure, and
 * the `*-actual.png` files in it come from the baseline renderer's own comparison. The
 * script downloads those artifacts, lists each actual with the baseline it would replace,
 * and copies only with `--write`. Look at the images before `--write`; see
 * `scripts/browser-fixtures/visual-baselines.md`.
 *
 * Playwright writes an actual at `<test-results>/<test>/<component>/<name>-actual.png`,
 * because the suite names a screenshot `[component, '<theme>-<viewport>-<fixture>.png']`
 * (`testing/testing/src/helpers/screenshot.ts`). The baseline is therefore
 * `LINUX_BASELINE_DIRECTORY/<component>/<name>.png`.
 *
 * Refuses, copying nothing, when the run's head SHA is not the current `HEAD`: an actual
 * from another commit would record that commit's rendering.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { LINUX_BASELINE_DIRECTORY, REPOSITORY_ROOT } from './baseline-provenance.ts';

export const ACTUAL_SUFFIX = '-actual.png';

/**
 * `<theme>-<viewport>-<fixture>`: the name the suite gives every screenshot. The viewport is one
 * of the three standard widths, or `touch`, the touch-pointer profile (`touch-profile.ts`), whose
 * baselines are `<slug>/<theme>-touch-assertion.png` (COR-2440).
 */
const SCREENSHOT_NAME = /^(?:light|dark)-(?:desktop|tablet|mobile|touch)-.+$/;
const COMPONENT_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export type PlannedCopy =
  | { kind: 'changed' | 'new'; actual: string; baseline: string }
  | { kind: 'unmatched'; actual: string; reason: string };

/**
 * Maps one actual, given by its path relative to the artifact, to the baseline it would
 * replace. `new` is an actual whose baseline does not exist yet; `unmatched` is one whose
 * path does not have the `<component>/<theme>-<viewport>-<fixture>-actual.png` shape, so
 * no baseline path can be derived without guessing.
 */
export function mapActual(
  actualPath: string,
  baselineExists: (baseline: string) => boolean,
): PlannedCopy {
  const segments = actualPath.split(/[\\/]/);
  const fileName = segments.at(-1) ?? '';
  const component = segments.at(-2);
  if (!fileName.endsWith(ACTUAL_SUFFIX)) {
    return { kind: 'unmatched', actual: actualPath, reason: 'not an -actual.png file' };
  }
  const name = fileName.slice(0, -ACTUAL_SUFFIX.length);
  if (component === undefined || !COMPONENT_SLUG.test(component)) {
    return { kind: 'unmatched', actual: actualPath, reason: 'no component directory' };
  }
  if (!SCREENSHOT_NAME.test(name)) {
    return {
      kind: 'unmatched',
      actual: actualPath,
      reason: 'name is not <theme>-<viewport>-<fixture>',
    };
  }
  const baseline = `${LINUX_BASELINE_DIRECTORY}/${component}/${name}.png`;
  return { kind: baselineExists(baseline) ? 'changed' : 'new', actual: actualPath, baseline };
}

export type HeadCheck = { ok: true } | { ok: false; message: string };

export function checkRunHead(runHeadSha: string, currentHead: string): HeadCheck {
  if (runHeadSha.trim() === currentHead.trim()) return { ok: true };
  return {
    ok: false,
    message: `The run built ${runHeadSha.trim()}, but HEAD is ${currentHead.trim()}. Check out the run's commit (or run main.yml on this branch) and try again. Nothing was copied.`,
  };
}

async function listActuals(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(ACTUAL_SUFFIX))
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .toSorted();
}

/** Plans every copy for the `-actual.png` files under `downloadDirectory`. */
export async function planBaselineCopies(
  downloadDirectory: string,
  repositoryRoot: string,
): Promise<PlannedCopy[]> {
  const exists = (baseline: string) => existsSync(join(repositoryRoot, baseline));
  const actuals = await listActuals(downloadDirectory);
  return actuals.map((actual) => mapActual(actual, exists));
}

/** Copies every changed and new actual over its baseline. Unmatched actuals are never copied. */
export async function writeBaselineCopies(
  plan: readonly PlannedCopy[],
  downloadDirectory: string,
  repositoryRoot: string,
): Promise<number> {
  let copied = 0;
  for (const entry of plan) {
    if (entry.kind === 'unmatched') continue;
    const target = resolve(repositoryRoot, entry.baseline);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(downloadDirectory, entry.actual), target);
    copied += 1;
  }
  return copied;
}

export function describePlan(plan: readonly PlannedCopy[], write: boolean): string {
  const lines = plan.map((entry) =>
    entry.kind === 'unmatched'
      ? `unmatched  ${entry.actual}  (${entry.reason})`
      : `${entry.kind.padEnd(9)}  ${entry.actual}  ->  ${entry.baseline}`,
  );
  const count = (kind: PlannedCopy['kind']) => plan.filter((entry) => entry.kind === kind).length;
  lines.push(
    '',
    `${count('changed')} changed, ${count('new')} new, ${count('unmatched')} unmatched.`,
    write ? 'Copied the changed and new actuals.' : 'Dry run: pass --write to copy.',
  );
  return lines.join('\n');
}

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'inherit' });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`${args.join(' ')} exited ${code}`);
  return output.trim();
}

async function main(argv: string[]): Promise<number> {
  const write = argv.includes('--write');
  const runId = argv.find((argument) => !argument.startsWith('--'));
  if (runId === undefined || !/^\d+$/.test(runId)) {
    console.error('Usage: baselines-from-run.ts <run-id> [--write]');
    return 2;
  }

  const [runHead, head] = await Promise.all([
    command(['gh', 'run', 'view', runId, '--json', 'headSha', '--jq', '.headSha']),
    command(['git', '-C', REPOSITORY_ROOT, 'rev-parse', 'HEAD']),
  ]);
  const headCheck = checkRunHead(runHead, head);
  if (!headCheck.ok) {
    console.error(headCheck.message);
    return 1;
  }

  const downloadDirectory = await mkdtemp(join(tmpdir(), `baselines-from-run-${runId}-`));
  await command([
    'gh',
    'run',
    'download',
    runId,
    '--pattern',
    'playwright-fixtures-*',
    '--dir',
    downloadDirectory,
  ]);

  const plan = await planBaselineCopies(downloadDirectory, REPOSITORY_ROOT);
  if (write) await writeBaselineCopies(plan, downloadDirectory, REPOSITORY_ROOT);
  console.log(describePlan(plan, write));
  console.log(`Artifacts: ${downloadDirectory}${sep}  (look at the images before --write)`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
