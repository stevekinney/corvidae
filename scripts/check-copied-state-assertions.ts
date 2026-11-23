/**
 * Require a browser spec that reads CopyButton's copied state to stop the page's timers first.
 *
 * CopyButton sets `data-cinder-copied` after a copy and clears it on a real `setTimeout` after
 * `confirmDuration` (1.5s by default, 2s in the chat footer). A spec that clicks and then polls for
 * the attribute races that timer: under load the round trips between the click and the first poll
 * outlast it, the state clears before anything reads it, and the assertion waits out the hang guard
 * for an element that never returns (COR-2644, `editors-chat.playwright.ts` in the Docker runner).
 * `freezePageTimers(page)` from `@lostgradient/testing/playwright/page-timers` pauses the page
 * clock before the click, so the reset timer stays pending until the test reads the state.
 *
 * The guard flags each code line (not a `//` or `*` comment line) of a Playwright spec
 * (`*.playwright.ts`, `*.spec.ts`) that names `data-cinder-copied` in a file that never calls
 * `freezePageTimers(`. It does not check that the call comes before the click; that order stays
 * the author's responsibility. Runs from `lint:guards`.
 */

import { join } from 'node:path';

const root = join(import.meta.dir, '..');

const SPEC_FILE = /\.(?:playwright|spec)\.ts$/u;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/u;

/** The 1-based lines of `source` that read the copied state without the file freezing timers. */
export function unfrozenCopiedStateReads(source: string): number[] {
  if (source.includes('freezePageTimers(')) return [];
  const found: number[] = [];
  source.split('\n').forEach((line, index) => {
    if (line.includes('data-cinder-copied') && !COMMENT_LINE.test(line)) found.push(index + 1);
  });
  return found;
}

function scannedFiles(): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
  });
  if (listed.exitCode !== 0) throw new Error('git ls-files failed');
  return listed.stdout
    .toString()
    .split('\n')
    .filter((file) => SPEC_FILE.test(file));
}

async function main(): Promise<void> {
  let failures = 0;
  const files = scannedFiles();
  for (const file of files) {
    const handle = Bun.file(join(root, file));
    if (!(await handle.exists())) continue;
    for (const line of unfrozenCopiedStateReads(await handle.text())) {
      failures += 1;
      process.stderr.write(
        `check-copied-state-assertions — ${file}:${line}: CopyButton clears \`data-cinder-copied\` on a timer that can fire before this assertion polls (COR-2644). Call \`freezePageTimers(page)\` from \`@lostgradient/testing/playwright/page-timers\` before the click.\n`,
      );
    }
  }
  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`check-copied-state-assertions — OK (${files.length} specs).\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-copied-state-assertions failed:', error);
    process.exitCode = 1;
  });
}
