/**
 * Hold Weft's prebuilt dashboard to its size budget.
 *
 * Run from the `@lostgradient/weft` package after `bun scripts/build-dashboard.ts`:
 * `bun scripts/check-dashboard-size.ts [directory]`. The directory defaults to `dashboard/` at
 * the package root. It exits 0 when the dashboard is within both limits and 1 otherwise, or when
 * the directory holds no `index.html`.
 *
 * The limits and the way each is measured are the owner's decision in
 * `documentation/weft-ui-public-surface.md` (COR-1447), under "Size budget":
 *
 * - at most {@link DISK_BUDGET_BYTES} bytes on disk: the sum of the `stat` sizes of every file
 *   under the directory;
 * - at most {@link GZIP_BUDGET_BYTES} bytes gzipped: the sum, over every `.js`, `.css` and `.html`
 *   file, of `Bun.gzipSync(bytes, { level: 9 }).byteLength`, each file compressed on its own,
 *   which is what a server pays when it compresses each response.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** At most this many bytes on disk under the dashboard directory. */
export const DISK_BUDGET_BYTES = 4_500_000;

/** At most this many gzipped bytes of JavaScript, CSS and HTML under the dashboard directory. */
export const GZIP_BUDGET_BYTES = 850_000;

const GZIPPED_EXTENSIONS = /\.(?:js|css|html)$/;

const DEFAULT_DIRECTORY = fileURLToPath(new URL('../dashboard', import.meta.url));

export type DashboardSize = {
  readonly directory: string;
  readonly files: number;
  readonly diskBytes: number;
  readonly gzipBytes: number;
};

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
}

/** Measure a dashboard directory the way the budget defines its two numbers. */
export async function measureDashboard(directory: string): Promise<DashboardSize> {
  let diskBytes = 0;
  let gzipBytes = 0;
  const files = await listFiles(directory);
  for (const path of files) {
    const stats = await stat(path);
    diskBytes += stats.size;
    if (GZIPPED_EXTENSIONS.test(path)) {
      const bytes = await Bun.file(path).bytes();
      gzipBytes += Bun.gzipSync(bytes, { level: 9 }).byteLength;
    }
  }
  return { directory, files: files.length, diskBytes, gzipBytes };
}

/** Every limit `size` exceeds, as a sentence each; empty when it is within budget. */
export function budgetViolations(size: DashboardSize): string[] {
  const violations: string[] = [];
  if (size.diskBytes > DISK_BUDGET_BYTES) {
    violations.push(
      `${size.diskBytes} bytes on disk exceeds the budget of ${DISK_BUDGET_BYTES} bytes`,
    );
  }
  if (size.gzipBytes > GZIP_BUDGET_BYTES) {
    violations.push(
      `${size.gzipBytes} gzipped bytes of JavaScript, CSS and HTML exceeds the budget of ${GZIP_BUDGET_BYTES} bytes`,
    );
  }
  return violations;
}

/** The command-line entry; returns the exit code. */
export async function runCheckDashboardSizeCommand(
  argv: readonly string[],
  output: { log: (line: string) => void; error: (line: string) => void } = console,
): Promise<number> {
  const directory = argv[0] ?? DEFAULT_DIRECTORY;
  if (!(await Bun.file(join(directory, 'index.html')).exists())) {
    output.error(
      `${directory} has no index.html. Build the dashboard first with \`bun scripts/build-dashboard.ts\`.`,
    );
    return 1;
  }
  const size = await measureDashboard(directory);
  const where = relative(process.cwd(), directory) || '.';
  output.log(
    `${where}: ${size.files} files, ${size.diskBytes} of ${DISK_BUDGET_BYTES} bytes on disk, ${size.gzipBytes} of ${GZIP_BUDGET_BYTES} bytes gzipped`,
  );
  const violations = budgetViolations(size);
  for (const violation of violations) output.error(`Dashboard over budget: ${violation}.`);
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await runCheckDashboardSizeCommand(Bun.argv.slice(2));
