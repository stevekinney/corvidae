/**
 * Tests for `scripts/check-dashboard-size.ts` against fixture directories: how each of the two
 * numbers is measured, and the exit code on either side of each limit. The real build's own check
 * runs in `build-dashboard.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  budgetViolations,
  DISK_BUDGET_BYTES,
  GZIP_BUDGET_BYTES,
  measureDashboard,
  runCheckDashboardSizeCommand,
} from './check-dashboard-size.ts';

const INDEX_HTML = '<!doctype html><title>Weft</title><div id="app"></div>';

type CommandResult = { exitCode: number; log: string[]; error: string[] };

async function check(directory: string): Promise<CommandResult> {
  const log: string[] = [];
  const error: string[] = [];
  const exitCode = await runCheckDashboardSizeCommand([directory], {
    log: (line) => log.push(line),
    error: (line) => error.push(line),
  });
  return { exitCode, log, error };
}

describe('check-dashboard-size', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'weft-dashboard-size-'));
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'index.html'), INDEX_HTML);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('counts every file on disk and gzips only JavaScript, CSS and HTML, one file at a time', async () => {
    const script = 'console.log("dashboard");'.repeat(200);
    const styles = 'body { color: red; }'.repeat(200);
    const binary = randomBytes(4096);
    writeFileSync(join(directory, 'assets', 'app-abc12345.js'), script);
    writeFileSync(join(directory, 'assets', 'app-def67890.css'), styles);
    writeFileSync(join(directory, 'assets', 'onig-0123abcd.wasm'), binary);

    const gzipped = (text: string) =>
      Bun.gzipSync(new TextEncoder().encode(text), { level: 9 }).byteLength;
    expect(await measureDashboard(directory)).toEqual({
      directory,
      files: 4,
      diskBytes: INDEX_HTML.length + script.length + styles.length + binary.byteLength,
      gzipBytes: gzipped(INDEX_HTML) + gzipped(script) + gzipped(styles),
    });
  });

  it('exits 0 within budget', async () => {
    writeFileSync(join(directory, 'assets', 'app-abc12345.js'), 'console.log(1);');

    const result = await check(directory);

    expect(result.exitCode).toBe(0);
    expect(result.error).toEqual([]);
    expect(result.log).toHaveLength(1);
    expect(result.log[0]).toContain(`of ${DISK_BUDGET_BYTES} bytes on disk`);
    expect(result.log[0]).toContain(`of ${GZIP_BUDGET_BYTES} bytes gzipped`);
  });

  it('exits non-zero on a fixture larger than the disk budget', async () => {
    // Not gzipped, so only the disk limit is exceeded.
    writeFileSync(join(directory, 'assets', 'onig-0123abcd.wasm'), randomBytes(DISK_BUDGET_BYTES));

    const result = await check(directory);

    expect(result.exitCode).toBe(1);
    expect(result.error).toEqual([
      `Dashboard over budget: ${DISK_BUDGET_BYTES + INDEX_HTML.length} bytes on disk exceeds the budget of ${DISK_BUDGET_BYTES} bytes.`,
    ]);

    // The script itself, as `bun scripts/check-dashboard-size.ts <directory>` runs it.
    const child = Bun.spawnSync([
      'bun',
      join(import.meta.dir, 'check-dashboard-size.ts'),
      directory,
    ]);
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain('Dashboard over budget');
  });

  it('exits non-zero on a fixture larger than the gzipped budget', async () => {
    // Random bytes do not compress, so this script alone is over the gzipped limit.
    const script = randomBytes(GZIP_BUDGET_BYTES).toString('latin1');
    writeFileSync(join(directory, 'assets', 'app-abc12345.js'), script, 'latin1');

    const result = await check(directory);
    const size = await measureDashboard(directory);

    expect(size.diskBytes).toBeLessThan(DISK_BUDGET_BYTES);
    expect(size.gzipBytes).toBeGreaterThan(GZIP_BUDGET_BYTES);
    expect(result.exitCode).toBe(1);
    expect(result.error).toEqual([
      `Dashboard over budget: ${size.gzipBytes} gzipped bytes of JavaScript, CSS and HTML exceeds the budget of ${GZIP_BUDGET_BYTES} bytes.`,
    ]);
  });

  it('reports both limits when both are exceeded', () => {
    expect(
      budgetViolations({
        directory,
        files: 1,
        diskBytes: DISK_BUDGET_BYTES + 1,
        gzipBytes: GZIP_BUDGET_BYTES + 1,
      }),
    ).toHaveLength(2);
    expect(
      budgetViolations({
        directory,
        files: 1,
        diskBytes: DISK_BUDGET_BYTES,
        gzipBytes: GZIP_BUDGET_BYTES,
      }),
    ).toEqual([]);
  });

  it('exits non-zero when the directory holds no built dashboard', async () => {
    rmSync(join(directory, 'index.html'));

    const result = await check(directory);

    expect(result.exitCode).toBe(1);
    expect(result.error).toEqual([
      `${directory} has no index.html. Build the dashboard first with \`bun scripts/build-dashboard.ts\`.`,
    ]);
  });
});
