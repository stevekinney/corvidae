/**
 * Ban `gh run watch` in agent instructions, tooling and documentation.
 *
 * On 2026-11-17 loops of `gh run watch` from many sessions drained the account's 5000-call GitHub
 * API limit to zero: it polls every few seconds and each poll costs calls. Wait with
 * `bun scripts/chef/wait-run.ts <run id>`, which makes one call per interval and backs off to the
 * rate limit's reset. A line that says not to use the command (it holds `never`, `do not`,
 * `don't` or `not use`) is allowed, as are this guard and its test. Runs from `lint:guards`.
 */

import { join } from 'node:path';

const root = join(import.meta.dir, '..');

export const SCANNED_DIRECTORIES = ['.agents', '.claude', '.codex', 'scripts', 'documentation'];

const EXEMPT_FILES = new Set([
  'scripts/check-gh-run-watch.ts',
  'scripts/check-gh-run-watch.test.ts',
]);
const PROHIBITION = /\bnever\b|\bdo not\b|\bdon't\b|\bnot use\b/iu;

/** The 1-based lines of `source` that use `gh run watch` without saying not to. */
export function watchUses(source: string): number[] {
  const found: number[] = [];
  source.split('\n').forEach((line, index) => {
    if (/\bgh\s+run\s+watch\b/u.test(line) && !PROHIBITION.test(line)) found.push(index + 1);
  });
  return found;
}

function scannedFiles(): string[] {
  const listed = Bun.spawnSync(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCANNED_DIRECTORIES],
    { cwd: root },
  );
  if (listed.exitCode !== 0) throw new Error('git ls-files failed');
  return listed.stdout
    .toString()
    .split('\n')
    .filter((file) => file !== '' && !EXEMPT_FILES.has(file));
}

async function main(): Promise<void> {
  let failures = 0;
  const files = scannedFiles();
  for (const file of files) {
    const handle = Bun.file(join(root, file));
    if (!(await handle.exists())) continue;
    for (const line of watchUses(await handle.text())) {
      failures += 1;
      process.stderr.write(
        `check-gh-run-watch — ${file}:${line}: \`gh run watch\` drained the GitHub API limit (2026-11-17). Wait with \`bun scripts/chef/wait-run.ts <run id>\`.\n`,
      );
    }
  }
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`check-gh-run-watch — OK (${files.length} files).\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-gh-run-watch failed:', error);
    process.exitCode = 1;
  });
}
