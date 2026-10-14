import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { createCaseList, parseShard, selectShard } from './static-playground-cases.ts';
import { runPreflight } from './static-playground-preflight.ts';
import { loadStaticHostConfiguration, startStaticServer } from './static-playground-server.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'static-playground');
const DRIVER = join(FIXTURES, 'stand-ins', 'lifecycle-driver.ts');
const CHECK = join(import.meta.dirname, 'check-static-playground.ts');

type GateRun = { exitCode: number; report: GateReport; stderr: string };

async function runGate(command: string[], environment: Record<string, string>): Promise<GateRun> {
  const output = await mkdtemp(join(tmpdir(), 'static-gate-test-'));
  try {
    const gate = Bun.spawn([...command, '--output', output], {
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([gate.exited, new Response(gate.stderr).text()]);
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

describe('static production gate over fixtures', () => {
  it('passes the good fixture with every credential-shaped variable removed', async () => {
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
    expect(report.peakResidentSetBytes).toBe(104_857_600);
    expect(report.exportDurationMilliseconds).toBe(1250);
  });

  it('fails a fixture whose required asset is missing, before any test runner starts', async () => {
    const { exitCode, report } = await runFixture('missing-asset');

    expect(exitCode).toBe(1);
    expect(report.preflightFailures).toContain(
      'required asset /assets/fixture/site.css answered 404',
    );
    expect(report.shardCaseCount).toBeNull();
  });

  it('fails a fixture whose documentation page was not prerendered', async () => {
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

  it('fails when a credential-shaped variable value appears in a served file', async () => {
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

  it('gives its children no credential-shaped variable, while still scanning for its value', async () => {
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

  it('scans served bytes only for secret values, not public deployment metadata', async () => {
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

  it('refuses an output directory inside the served directory', async () => {
    const served = await mkdtemp(join(tmpdir(), 'static-gate-served-'));
    try {
      const gate = Bun.spawn(
        [
          process.execPath,
          CHECK,
          '--directory',
          served,
          '--output',
          join(served, 'nested', 'report'),
          '--allow-source-mismatch',
        ],
        { env: readScrubbedEnvironment(), stdout: 'pipe', stderr: 'pipe' },
      );
      const [exitCode, stderr] = await Promise.all([gate.exited, new Response(gate.stderr).text()]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('must be outside the served directory');
      expect(await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: served }))).toEqual([]);
    } finally {
      await rm(served, { recursive: true, force: true });
    }
  });

  it('rejects the served directory itself as output and accepts a sibling', () => {
    const directory = join(FIXTURES, 'good');

    expect(() => assertOutputOutsideServedDirectory(directory, directory)).toThrow(
      'must be outside',
    );
    expect(() =>
      assertOutputOutsideServedDirectory(join(FIXTURES, 'good-report'), directory),
    ).not.toThrow();
  });

  it('fails when the export report is missing', async () => {
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

  it('fails when the report digest differs from the served directory', async () => {
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
    expect(
      report.preflightFailures.some((failure) => failure.includes('is not served digest')),
    ).toBe(true);
  });
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
      join('test-results', 'static-production', 'shard-2-of-8'),
    );
  });
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
