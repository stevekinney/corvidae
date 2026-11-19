/**
 * Allow one dispatcher of `main.yml` on a branch: `bun scripts/chef/targeted-run.ts`.
 *
 * Workers dispatched full `main.yml` runs by hand twice against the rule (runs 44108166839 and
 * 44114059046), and each full run is about 19 jobs that targeted runs then queue behind for 60 to 90
 * minutes. `targeted-run.ts` sends a plan to `main.yml` only when the plan requires a full run, so
 * a raw `gh workflow run main.yml` (or the same words as an argument list) in `scripts/` or in the
 * agent definitions and workflows fails here. A sentence that says not to run it (`never`,
 * `do not`, `don't` or `not use`, then the command before the next full stop) is allowed, as are `targeted-run.ts`, its test, and this guard
 * with its test. The coordinator documents under `.agents/skills/` are not scanned: they may name
 * the command only as a prohibition, and a reader there is a human. Runs from `lint:guards`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCANNED_DIRECTORIES = [
  'scripts',
  '.claude/agents',
  '.codex/agents',
  '.claude/workflows',
];

const SCANNED_EXTENSIONS = /\.(?:ts|js|md|toml|json|ya?ml|sh)$/u;

export const EXEMPT_FILES = new Set([
  'scripts/chef/targeted-run.ts',
  'scripts/chef/targeted-run.test.ts',
  'scripts/check-workflow-dispatch.ts',
  'scripts/check-workflow-dispatch.test.ts',
]);

const DISPATCH =
  "\\bgh\\s+workflow\\s+run\\s+['\"]?main\\.yml\\b|['\"]workflow['\"]\\s*,\\s*['\"]run['\"]\\s*,\\s*['\"]main\\.yml['\"]";
const RAW_DISPATCH = new RegExp(DISPATCH, 'u');
// A prohibition covers a dispatch only in its own sentence: no full stop between the two.
const PROHIBITED = new RegExp(
  `\\b(?:never|do not|don't|not use)\\b[^.\\n]*?(?:${DISPATCH})`,
  'iu',
);

/** The 1-based lines of `source` that dispatch `main.yml` directly without saying not to. */
export function rawDispatches(source: string): number[] {
  const found: number[] = [];
  source.split('\n').forEach((line, index) => {
    if (RAW_DISPATCH.test(line.replace(PROHIBITED, ''))) found.push(index + 1);
  });
  return found;
}

function filesUnder(root: string, directory: string): string[] {
  const entries = (() => {
    try {
      return readdirSync(join(root, directory), { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  return entries.flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) return [];
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return filesUnder(root, path);
    return entry.isFile() && SCANNED_EXTENSIONS.test(entry.name) ? [path] : [];
  });
}

/** Every `file:line` under `root` that dispatches `main.yml` directly; `root` defaults to the repository. */
export function scanForRawDispatch(root: string): { file: string; line: number }[] {
  const violations: { file: string; line: number }[] = [];
  for (const file of SCANNED_DIRECTORIES.flatMap((directory) => filesUnder(root, directory))) {
    if (EXEMPT_FILES.has(file)) continue;
    for (const line of rawDispatches(readFileSync(join(root, file), 'utf8')))
      violations.push({ file, line });
  }
  return violations;
}

function main(): void {
  const root = join(import.meta.dir, '..');
  const violations = scanForRawDispatch(root);
  for (const { file, line } of violations)
    process.stderr.write(
      `check-workflow-dispatch — ${file}:${line}: a raw \`gh workflow run main.yml\`. Run \`bun scripts/chef/targeted-run.ts\`, the one dispatcher of main.yml on a branch.\n`,
    );
  if (violations.length > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write('check-workflow-dispatch — OK.\n');
}

if (import.meta.main) main();
