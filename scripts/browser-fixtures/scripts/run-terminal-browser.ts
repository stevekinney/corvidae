/**
 * `bun run test:browser:terminal [-- playwright args]`
 *
 * Runs only the terminal Playwright files (`tests/terminal-*.playwright.ts`) in Chromium, Firefox
 * and WebKit through the browser-fixtures harness. It lists the selection first and fails when a
 * required cell is absent, runs it, and fails again if any selected test did not pass. The checks
 * are in `terminal-browser-selection.ts`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { TERMINAL_FIXTURE_NAMES } from '../src/fixtures/terminal/scenarios.ts';
import {
  flattenReport,
  resultProblems,
  selectionProblems,
  TERMINAL_FILE_FILTER,
  TERMINAL_PROJECTS,
  terminalEnvironment,
  titlesByFile,
  type PlaywrightReport,
  type TitleManifest,
} from './terminal-browser-selection.ts';

const root = resolve(import.meta.dirname, '..', '..', '..');
const configuration = resolve(root, 'scripts', 'browser-fixtures', 'playwright.config.ts');
const selection = [
  ...TERMINAL_PROJECTS.flatMap((project) => [`--project=${project}`]),
  TERMINAL_FILE_FILTER,
];
const manifestPath = resolve(import.meta.dirname, 'terminal-browser-titles.json');

function playwright(args: string[], environment: Record<string, string> = {}) {
  return Bun.spawn(
    [process.execPath, '--bun', 'playwright', 'test', '--config', configuration, ...args],
    {
      cwd: root,
      env: { ...terminalEnvironment(process.env), ...environment },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
}

async function main(): Promise<number> {
  const prepare = Bun.spawn(
    [process.execPath, resolve(root, 'scripts/browser-fixtures/scripts/prepare-manifest.ts')],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await prepare.exited) !== 0) return 1;

  const listing = playwright([...selection, '--list', '--reporter=json']);
  const listed = await new Response(listing.stdout).text();
  if ((await listing.exited) !== 0) {
    process.stderr.write(`Listing the terminal selection failed:\n${listed}\n`);
    return 1;
  }
  const selected = flattenReport(JSON.parse(listed) as PlaywrightReport);
  if (Bun.argv.includes('--write-manifest')) {
    // Recording is a reviewed edit: the file lists every test the terminal proof must run.
    await Bun.write(manifestPath, `${JSON.stringify(titlesByFile(selected), null, 2)}\n`);
    process.stdout.write(`Recorded the terminal test titles in ${manifestPath}.\n`);
    return 0;
  }
  const recorded = JSON.parse(await readFile(manifestPath, 'utf8')) as TitleManifest;
  const missing = selectionProblems(selected, TERMINAL_FIXTURE_NAMES.length, recorded);
  if (missing.length > 0) {
    process.stderr.write(
      `The terminal browser selection is incomplete:\n- ${missing.join('\n- ')}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Selected ${selected.length} terminal tests in ${TERMINAL_PROJECTS.join(', ')}.\n`,
  );

  const directory = await mkdtemp(join(tmpdir(), 'terminal-browser-'));
  const reportPath = join(directory, 'results.json');
  try {
    const extra = Bun.argv.slice(2).filter((argument) => argument !== '--write-manifest');
    const run = Bun.spawn(
      [
        process.execPath,
        '--bun',
        'playwright',
        'test',
        '--config',
        configuration,
        ...selection,
        '--reporter=list,json',
        ...extra,
      ],
      {
        cwd: root,
        env: { ...terminalEnvironment(process.env), PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    const status = await run.exited;
    if (status !== 0) return status;
    const ran = flattenReport(JSON.parse(await readFile(reportPath, 'utf8')) as PlaywrightReport);
    // Extra arguments narrow the run; what ran must still be part of the selection and pass.
    const problems = resultProblems(selected, ran, { subset: extra.length > 0 });
    if (problems.length > 0) {
      process.stderr.write(
        `The terminal browser run did not match its selection:\n- ${problems.join('\n- ')}\n`,
      );
      return 1;
    }
    process.stdout.write(`All ${ran.length} selected terminal tests passed.\n`);
    return 0;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

process.exitCode = await main();
