import { outcomeOf, rethrow } from '@lostgradient/testing';
import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  readScrubbedEnvironment,
  SECRET_ENVIRONMENT_NAME,
  SECRET_VALUE_NAME,
} from '../src/environment-configuration.ts';
import {
  assertOutputOutsideServedDirectory,
  type CaseResult,
  type GateReport,
  parseGateArguments,
  summarizeCaseResults,
} from './check-static-playground.ts';
import { parseExportReport } from './export-report.ts';
import {
  createCaseList,
  IN_PLACE_NAVIGATION_CASE_ID,
  parseShard,
  selectShard,
} from './static-playground-cases.ts';
import { runPreflight } from './static-playground-preflight.ts';
import { exitedWithin, interruptRunner } from './static-playground-processes.ts';
import { loadStaticHostConfiguration, startStaticServer } from './static-playground-server.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'static-playground');
const DRIVER = join(FIXTURES, 'stand-ins', 'lifecycle-driver.ts');
const CHECK = join(import.meta.dirname, 'check-static-playground.ts');

type GateRun = { exitCode: number; report: GateReport; stderr: string };

/** A stuck gate fails its scenario at this bound rather than leaking. */
const GATE_RUN_MILLISECONDS = 4_500;

type GateRunOptions = { guardMilliseconds?: number };

class GateHang extends Error {
  constructor(
    readonly stop: Awaited<ReturnType<typeof interruptRunner>>,
    readonly exitCode: number | null,
  ) {
    super('the gate did not exit within the hang guard');
  }
}

async function runGate(
  command: string[],
  environment: Record<string, string>,
  options: GateRunOptions = {},
): Promise<GateRun> {
  const output = await mkdtemp(join(tmpdir(), 'static-gate-test-'));
  try {
    const gate = spawnWithHangGuard([...command, '--output', output], {
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let stdout = '';
    void (async () => {
      for await (const chunk of gate.stdout) stdout += new TextDecoder().decode(chunk);
    })();
    const exitCode = await exitedWithin(gate, options.guardMilliseconds ?? GATE_RUN_MILLISECONDS);
    if (exitCode === undefined) {
      // Stop it the way a reader's Ctrl-C would, so its own cleanup runs, then kill anything
      // still attributable to its run directory; never SIGKILL the driver alone.
      const runDirectory = /run directory (\S+)/.exec(stdout)?.[1];
      const stop = await interruptRunner(gate, runDirectory, { graceMilliseconds: 1_000 });
      throw new GateHang(stop, gate.exitCode);
    }
    const stderr = await new Response(gate.stderr).text();
    const report = (await Bun.file(join(output, 'report.json')).json()) as GateReport;
    return { exitCode, report, stderr };
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

/** The fixture run with a stand-in test runner, so no browser is involved. */
function runFixture(fixture: string, environment = readScrubbedEnvironment()): Promise<GateRun> {
  return runGate([process.execPath, DRIVER, '--fixture', fixture], environment);
}

/**
 * Each scenario below starts a real gate or Bun process, so it runs once at module scope, where
 * Bun applies no per-test timeout, and its test rethrows the recorded outcome.
 */
const goodFixturePassesWithoutCredentials = await outcomeOf(async () => {
  const scrubbedEnvironment = readScrubbedEnvironment();
  expect(
    Object.keys(scrubbedEnvironment).filter((name) => SECRET_ENVIRONMENT_NAME.test(name)),
  ).toEqual([]);

  const { exitCode, report } = await runFixture('good', scrubbedEnvironment);

  expect(report.preflightFailures).toEqual([]);
  expect(exitCode).toBe(0);
  expect(report.servedDigest).toBe(report.buildDigest);
  expect(report.caseCount).toBe(6);
  expect(report.passedCount).toBe(6);
  // Stopping our own server at teardown is not a server death.
  expect(report.failurePhase).toBeNull();
  expect(report.inFlightCases).toEqual([]);
  expect(report.diagnosis).toBeNull();
  expect(report.peakResidentSetBytes).toBe(104_857_600);
  expect(report.exportDurationMilliseconds).toBe(1250);
});

const missingAssetFailsBeforeRunner = await outcomeOf(async () => {
  const { exitCode, report } = await runFixture('missing-asset');

  expect(exitCode).toBe(1);
  expect(report.preflightFailures).toContain(
    'required asset /assets/fixture/site.css answered 404',
  );
  expect(report.shardCaseCount).toBeNull();
});

const brokenPrerenderFails = await outcomeOf(async () => {
  const { exitCode, report } = await runFixture('broken-prerender');

  expect(exitCode).toBe(1);
  expect(report.preflightFailures).toEqual(
    expect.arrayContaining([
      '/page/button has no prerendered content',
      '/page/button has 0 h1 elements, not exactly one',
    ]),
  );
  expect(report.shardCaseCount).toBeNull();
});

const leakedTokenFailsTheGate = await outcomeOf(async () => {
  const leakingEnvironment = {
    ...readScrubbedEnvironment(),
    STATIC_FIXTURE_TOKEN: 'prerendered component page',
  };

  const { exitCode, report } = await runFixture('good', leakingEnvironment);

  expect(exitCode).toBe(1);
  expect(report.preflightFailures).toEqual([
    'served file page/button/index.html contains the value of STATIC_FIXTURE_TOKEN',
  ]);
});

const childrenInheritNoCredentials = await outcomeOf(async () => {
  const record = await mkdtemp(join(tmpdir(), 'static-gate-environment-'));
  try {
    const parentEnvironment = {
      ...readScrubbedEnvironment(),
      STATIC_GATE_CHILD_TOKEN: 'a value no fixture file contains',
      VERCEL_ENV: 'preview',
    };
    const environmentRecord = join(record, 'child-secrets.json');

    const { exitCode, report } = await runGate(
      [process.execPath, DRIVER, '--fixture', 'good', '--environment-record', environmentRecord],
      parentEnvironment,
    );

    expect(exitCode).toBe(0);
    expect(report.preflightFailures).toEqual([]);
    expect(await Bun.file(environmentRecord).json()).toEqual([]);
  } finally {
    await rm(record, { recursive: true, force: true });
  }
});

const onlySecretValuesAreScanned = await outcomeOf(async () => {
  // The good fixture's prose says "production". `VERCEL_ENV` is stripped from children but is
  // not a secret, so it must not fail the leak scan; a real token value in served bytes must.
  const metadataOnly = await runFixture('good', {
    ...readScrubbedEnvironment(),
    VERCEL_ENV: 'production',
  });
  const realToken = await runFixture('good', {
    ...readScrubbedEnvironment(),
    VERCEL_ENV: 'production',
    VERCEL_OIDC_TOKEN: 'static production gate',
  });

  expect(metadataOnly.report.preflightFailures).toEqual([]);
  expect(metadataOnly.exitCode).toBe(0);
  expect(realToken.exitCode).toBe(1);
  expect(realToken.report.preflightFailures).toContain(
    'served file index.html contains the value of VERCEL_OIDC_TOKEN',
  );
});

const connectionStringPasswordIsScanned = await outcomeOf(async () => {
  // The good fixture's component page says "prerendered component page".
  const leaking = await runFixture('good', {
    ...readScrubbedEnvironment(),
    DATABASE_URL: 'postgres://playground:prerendered%20component%20page@db.example/app',
  });
  const notLeaking = await runFixture('good', {
    ...readScrubbedEnvironment(),
    DATABASE_URL: 'postgres://playground:never-served-password@db.example/app',
  });

  expect(leaking.exitCode).toBe(1);
  expect(leaking.report.preflightFailures).toEqual([
    'served file page/button/index.html contains the value of DATABASE_URL',
  ]);
  expect(notLeaking.exitCode).toBe(0);
});

const nestedOutputDirectoryIsRefused = await outcomeOf(async () => {
  const served = await mkdtemp(join(tmpdir(), 'static-gate-served-'));
  try {
    const gate = spawnWithHangGuard(
      [
        process.execPath,
        CHECK,
        '--directory',
        served,
        '--output',
        join(served, 'nested', 'report'),
        '--allow-source-mismatch',
      ],
      {
        env: readScrubbedEnvironment(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const exitCode = await exitedWithin(gate, GATE_RUN_MILLISECONDS);
    if (exitCode === undefined) gate.kill('SIGKILL');
    const stderr = await new Response(gate.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('must be outside the served directory');
    expect(await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: served }))).toEqual([]);
  } finally {
    await rm(served, { recursive: true, force: true });
  }
});

const hungGateStopsGracefully = await outcomeOf(async () => {
  // The stand-in test runner hangs, so the gate never finishes on its own.
  const outcome = await runGate(
    [process.execPath, DRIVER, '--fixture', 'good', '--mode', 'hang'],
    readScrubbedEnvironment(),
    { guardMilliseconds: 1_500 },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(outcome).toBeInstanceOf(GateHang);
  const hang = outcome as GateHang;
  expect(hang.stop).toEqual({ survivors: [], runnerExited: true });
  // 130 is the gate's own exit for SIGINT: it ran its cleanup, rather than being SIGKILLed.
  expect(hang.exitCode).toBe(130);
});

const lateDiagnosticFailsTheCase = await outcomeOf(async () => {
  // A console error that arrives after a case's last assertion still reaches the reporter.
  const { exitCode, report } = await runGate(
    [process.execPath, DRIVER, '--fixture', 'good', '--late-diagnostic'],
    readScrubbedEnvironment(),
  );

  expect(exitCode).toBe(1);
  expect(report.failedCases.map((failure) => failure.diagnostics)).toEqual([
    ['console error: a late failure'],
  ]);
});

const missingExportReportFails = await outcomeOf(async () => {
  const { exitCode, report } = await runGate(
    [
      process.execPath,
      CHECK,
      '--directory',
      join(FIXTURES, 'good'),
      '--export-report',
      join(FIXTURES, 'absent.export-report.json'),
      '--allow-source-mismatch',
    ],
    readScrubbedEnvironment(),
  );

  expect(exitCode).toBe(1);
  expect(report.diagnosis).toContain('absent.export-report.json is missing');
});

const digestMismatchFails = await outcomeOf(async () => {
  const { exitCode, report } = await runGate(
    [
      process.execPath,
      CHECK,
      '--directory',
      join(FIXTURES, 'good'),
      '--export-report',
      join(FIXTURES, 'missing-asset.export-report.json'),
      '--allow-source-mismatch',
    ],
    readScrubbedEnvironment(),
  );

  expect(exitCode).toBe(1);
  expect(report.preflightFailures.some((failure) => failure.includes('is not served digest'))).toBe(
    true,
  );
});

const defaultOutputAvoidsPlaywrightDirectories = await outcomeOf(async () => {
  // Playwright empties its `outputDir` (default `test-results/`) before each run, so a gate
  // report written inside it is destroyed by the next `test:browser`.
  const playgroundRoot = join(import.meta.dirname, '..');
  // The configuration deletes `NO_COLOR` from its process when loaded, so read it in a child
  // rather than let that leak into this file's gate runs.
  const loaded = await runWithHangGuard(
    [
      process.execPath,
      '-e',
      "const { default: c } = await import('./playwright.config.ts'); console.log(JSON.stringify([c.outputDir ?? null, ...(c.projects ?? []).map((p) => p.outputDir ?? null)]))",
    ],
    { cwd: playgroundRoot },
  );
  expect(loaded.exitCode).toBe(0);
  const [configured, ...projects] = JSON.parse(loaded.stdout.toString()) as (string | null)[];
  // Playwright's own default when a configuration names no `outputDir`.
  const cleaned = [configured ?? 'test-results', ...projects]
    .filter((directory) => directory !== null)
    .map((directory) => resolve(playgroundRoot, directory));
  const overlaps = (first: string, second: string): boolean =>
    [relative(first, second), relative(second, first)].some(
      (path) => path === '' || (!path.startsWith('..') && !isAbsolute(path)),
    );

  for (const output of [
    parseGateArguments([]).output,
    parseGateArguments(['--shard', '2/8']).output,
  ]) {
    for (const directory of cleaned) {
      expect({ output, directory, overlaps: overlaps(output, directory) }).toEqual({
        output,
        directory,
        overlaps: false,
      });
    }
  }
});

describe('credential-shaped environment names', () => {
  it('scrubs every secret-value name from child environments, not only the narrower leak-scan set', () => {
    // Each of these names is a secret that the served-byte leak scan already recognizes;
    // a child process must never inherit one.
    for (const name of [
      'MIRROR_APP_PRIVATE_KEY',
      'GPG_PASSPHRASE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GITHUB_TOKEN',
      'DATABASE_PASSWORD',
      'STRIPE_API_KEY',
      'SESSION_SECRET',
    ]) {
      expect(SECRET_VALUE_NAME.test(name)).toBe(true);
      expect(SECRET_ENVIRONMENT_NAME.test(name)).toBe(true);
    }
  });

  it('keeps public deployment metadata out of the leak scan while still scrubbing it from children', () => {
    expect(SECRET_ENVIRONMENT_NAME.test('VERCEL_ENV')).toBe(true);
    expect(SECRET_VALUE_NAME.test('VERCEL_ENV')).toBe(false);
  });
});

describe('static production gate over fixtures', () => {
  it('passes the good fixture with every credential-shaped variable removed', () =>
    rethrow(goodFixturePassesWithoutCredentials));

  it('fails a fixture whose required asset is missing, before any test runner starts', () =>
    rethrow(missingAssetFailsBeforeRunner));

  it('fails a fixture whose documentation page was not prerendered', () =>
    rethrow(brokenPrerenderFails));

  it('fails when a credential-shaped variable value appears in a served file', () =>
    rethrow(leakedTokenFailsTheGate));

  it('gives its children no credential-shaped variable, while still scanning for its value', () =>
    rethrow(childrenInheritNoCredentials));

  it('scans served bytes only for secret values, not public deployment metadata', () =>
    rethrow(onlySecretValuesAreScanned));

  it.each([
    ['VERCEL_ENV', false],
    ['VERCEL_URL', false],
    ['VERCEL_OIDC_TOKEN', true],
    ['VERCEL_AUTOMATION_BYPASS_SECRET', true],
    ['ANTHROPIC_API_KEY', true],
    ['DATABASE_PASSWORD', true],
  ] as const)('treats %s as a secret value: %s', (name, secret) => {
    expect(SECRET_VALUE_NAME.test(name)).toBe(secret);
    expect(SECRET_ENVIRONMENT_NAME.test(name)).toBe(true);
  });

  it('fails when the password of a connection string appears in a served file', () =>
    rethrow(connectionStringPasswordIsScanned));

  it('refuses an output directory inside the served directory', () =>
    rethrow(nestedOutputDirectoryIsRefused));

  it('rejects the served directory itself as output and accepts a sibling', () => {
    const directory = join(FIXTURES, 'good');

    expect(() => assertOutputOutsideServedDirectory(directory, directory)).toThrow(
      'must be outside',
    );
    expect(() =>
      assertOutputOutsideServedDirectory(join(FIXTURES, 'good-report'), directory),
    ).not.toThrow();
  });

  it('stops a gate that outlives its hang guard gracefully, leaving nothing behind', () =>
    rethrow(hungGateStopsGracefully));

  it('fails a case that passed but recorded a browser diagnostic', () =>
    rethrow(lateDiagnosticFailsTheCase));

  it('fails when the export report is missing', () => rethrow(missingExportReportFails));

  it('fails when the report digest differs from the served directory', () =>
    rethrow(digestMismatchFails));
});

describe('preflight inventory and source checks', () => {
  async function preflightWith(changes: Record<string, unknown>, head = 'a'.repeat(40)) {
    const directory = join(FIXTURES, 'good');
    const report = parseExportReport({
      ...(await Bun.file(join(FIXTURES, 'good.export-report.json')).json()),
      ...changes,
    });
    const configuration = await loadStaticHostConfiguration();
    const server = startStaticServer({ directory, configuration });
    try {
      const result = await runPreflight({
        directory,
        origin: server.origin,
        report,
        configuration,
        allowSourceMismatch: false,
        secretEntries: [],
        git: (args) => (args[0] === 'rev-parse' ? head : ''),
      });
      return result.failures;
    } finally {
      await server.stop();
    }
  }

  const clean = { sourceSha: 'a'.repeat(40), dirty: false };

  it('accepts a clean report recorded at HEAD', async () => {
    expect(await preflightWith(clean)).toEqual([]);
  });

  it.each([
    [{ ...clean, sourceSha: null }, 'export report source SHA is null'],
    [
      { ...clean, sourceSha: 'b'.repeat(40) },
      `export report source SHA ${'b'.repeat(40)} is not HEAD ${'a'.repeat(40)}`,
    ],
    [{ ...clean, dirty: true }, 'export report was recorded from a dirty tree'],
    [{ ...clean, nodeEnv: 'development' }, 'export report NODE_ENV is development, not production'],
    [{ ...clean, nodeEnv: null }, 'export report NODE_ENV is null, not production'],
    [
      { ...clean, routes: ['/', '/page/button', '/page/alert'] },
      'sitemap lists 2 routes; the report lists 3',
    ],
    [{ ...clean, routes: ['/'] }, '2 route HTML files are served; the report lists 1'],
  ])('fails %j', async (changes, failure) => {
    expect(await preflightWith(changes)).toContain(failure);
  });
});

describe('case counts (the in-place navigation case)', () => {
  // 211 documentation routes and `/`, as the exported site has: 211 x 2 views x 2 widths plus 2
  // landing cases is 846 route cases, and the in-place navigation case makes 847.
  const routes = [
    '/',
    '/page/button',
    '/page/chat',
    ...Array.from({ length: 209 }, (_unused, index) => `/page/component-${index}`),
  ];
  const result = (caseId: string, status = 'passed'): CaseResult => ({
    caseId,
    status,
    errors: status === 'passed' ? [] : ['expect(locator).toBeVisible() failed'],
    diagnostics: [],
    screenshot: null,
  });

  it('lists the in-place navigation case once, so the whole list counts every test the spec runs', () => {
    const cases = createCaseList(routes);

    expect(cases).toHaveLength(847);
    expect(cases.filter((testCase) => testCase.id === IN_PLACE_NAVIGATION_CASE_ID)).toHaveLength(1);
  });

  it('places the in-place navigation case in exactly one shard', () => {
    const cases = createCaseList(routes);
    const holders = [1, 2, 3, 4, 5, 6, 7, 8].filter((index) =>
      selectShard(cases, { index, count: 8 }).some(
        (testCase) => testCase.id === IN_PLACE_NAVIGATION_CASE_ID,
      ),
    );

    expect(holders).toHaveLength(1);
  });

  it('counts 847 cases with one failure listed and 846 passed', () => {
    const cases = createCaseList(routes);
    const failing = '/page/component-7 playground 1440px';
    const results = cases.map((testCase) =>
      result(testCase.id, testCase.id === failing ? 'failed' : 'passed'),
    );

    const summary = summarizeCaseResults(cases, results);
    expect(cases).toHaveLength(847);
    expect(summary.passed).toBe(846);
    expect(summary.failed.map((failure) => failure.caseId)).toEqual([failing]);
    expect(summary.missing).toEqual([]);
  });

  it('never counts a result outside the case list as a pass, and fails it instead', () => {
    const cases = createCaseList(['/']);
    const stray = result('a test the case list does not name');

    const summary = summarizeCaseResults(cases, [
      result('/ page 1440px'),
      result('/ page 390px'),
      stray,
    ]);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toEqual([
      { ...stray, status: 'unexpected', errors: ['the case list does not name this test'] },
    ]);
  });
});

describe('case list and shards', () => {
  const routes = ['/', '/page/button', '/page/alert', '/page/table-row', '/about'];

  it('crosses component routes with both views and other routes with one page, at both widths', () => {
    const cases = createCaseList(routes);

    expect(cases).toHaveLength(3 * 2 * 2 + 2 * 2);
    expect(cases.map((testCase) => testCase.id)).toContain('/page/button playground 390px');
    expect(cases.map((testCase) => testCase.id)).toContain('/ page 1440px');
    expect(cases.map((testCase) => testCase.id)).toEqual(
      cases.map((testCase) => testCase.id).toSorted(),
    );
  });

  it.each([1, 3, 8])('splits the list into %i shards whose union is the whole list', (count) => {
    const cases = createCaseList(routes);
    const shards = Array.from({ length: count }, (_unused, index) =>
      selectShard(cases, { index: index + 1, count }),
    );
    const union = shards.flat().map((testCase) => testCase.id);

    expect(union.toSorted()).toEqual(cases.map((testCase) => testCase.id).toSorted());
    expect(new Set(union).size).toBe(union.length);
  });

  it.each(['0/3', '4/3', '1/0', 'one/two', '1'])('rejects the shard %s', (value) => {
    expect(() => parseShard(value)).toThrow('--shard must be');
  });

  it('defaults to the build directory, one shard, and four recorded workers', () => {
    const options = parseGateArguments([]);

    expect(options.directory.endsWith(join('playground', 'build'))).toBe(true);
    expect(options.exportReportPath.endsWith(join('build-report', 'export-report.json'))).toBe(
      true,
    );
    expect(options.shard).toEqual({ index: 1, count: 1 });
    expect(options.workers).toBe(4);
    expect(options.allowSourceMismatch).toBe(false);
    expect(parseGateArguments(['--shard', '2/8']).output).toEndWith(
      join('production-gate-results', 'shard-2-of-8'),
    );
  });

  it('keeps the default output out of every directory the development Playwright run cleans', () =>
    rethrow(defaultOutputAvoidsPlaywrightDirectories));
});

describe('case evidence', () => {
  const cases = createCaseList(['/']);
  const passed = (caseId: string): CaseResult => ({
    caseId,
    status: 'passed',
    errors: [],
    diagnostics: [],
    screenshot: null,
  });

  it('names failing cases with their diagnostics and screenshot', () => {
    const failure: CaseResult = {
      caseId: '/ page 390px',
      status: 'failed',
      errors: ['expected no console errors'],
      diagnostics: ['console error: boom'],
      screenshot: '/output/screenshots/page-390.png',
    };

    expect(summarizeCaseResults(cases, [passed('/ page 1440px'), failure])).toEqual({
      passed: 1,
      failed: [failure],
      missing: [],
    });
  });

  it('counts a passed result with browser diagnostics as failed', () => {
    const late: CaseResult = { ...passed('/ page 390px'), diagnostics: ['pageerror: boom'] };

    expect(summarizeCaseResults(cases, [passed('/ page 1440px'), late])).toEqual({
      passed: 1,
      failed: [late],
      missing: [],
    });
  });

  it('reports a case with no result, or with two, as missing', () => {
    expect(summarizeCaseResults(cases, [passed('/ page 1440px'), passed('/ page 1440px')])).toEqual(
      {
        passed: 2,
        failed: [],
        missing: ['/ page 1440px', '/ page 390px'],
      },
    );
  });
});
