import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PNG } from 'pngjs';

import {
  LINUX_BASELINE_DIRECTORY,
  PROVENANCE_FILE_NAME,
  REQUIRED_BASELINE_ARCHITECTURE,
  REQUIRED_OS_CODENAME,
  committedProvenanceProblems,
  createBaselineProvenance,
  dockerImageTagForPlaywrightVersion,
  parseBaselineProvenance,
  readRepositoryPins,
} from './baseline-provenance.ts';
import {
  WEB_SERVER_TIMEOUT_REPORT,
  failedTerminalScopeGuard,
  passed,
  playwrightReport,
} from './playwright-report.test-support.ts';
import {
  applyUpdateRun,
  manifestFixtureNames,
  readSuiteResults,
  type UpdateRun,
} from './update-snapshots-docker.ts';

describe('update-snapshots-docker helpers', () => {
  it('reads fixture names per component from the rendered manifest', () => {
    const manifest = JSON.stringify({
      entries: [
        { slug: 'button', fixtures: [{ name: 'primary' }, { name: 'assertion' }] },
        { slug: 'select', fixtures: [{ name: 'assertion' }] },
      ],
    });
    expect(manifestFixtureNames(manifest)).toEqual(
      new Map([
        ['button', ['primary', 'assertion']],
        ['select', ['assertion']],
      ]),
    );
  });

  it('summarizes the container JSON report, or reports none when the run produced none', () => {
    const directory = mkdtempSync(join(tmpdir(), 'update-snapshots-docker-'));
    expect(readSuiteResults(directory)).toBeUndefined();
    writeFileSync(
      join(directory, 'results.json'),
      JSON.stringify({ stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 1 }, suites: [] }),
    );
    expect(readSuiteResults(directory)).toEqual({
      expected: 3,
      unexpected: 0,
      flaky: 0,
      skipped: 1,
      failures: [],
      flakyTests: [],
      skippedTests: [],
      globalErrors: [],
      selected: 0,
      executed: 0,
      notRun: [],
    });
  });

  it('refuses a results file a crashed run left truncated', () => {
    const directory = mkdtempSync(join(tmpdir(), 'update-snapshots-docker-'));
    writeFileSync(join(directory, 'results.json'), '{"suites": [');
    expect(() => readSuiteResults(directory)).toThrow(
      'is not a complete Playwright JSON report; nothing is applied',
    );
  });
});

const SHA = 'a'.repeat(40);
const { playwrightVersion } = readRepositoryPins();
/** The renderer the lockfile pins, so the committed-provenance check accepts these records. */
const RENDERER = {
  playwrightVersion,
  osCodename: REQUIRED_OS_CODENAME,
  architecture: REQUIRED_BASELINE_ARCHITECTURE,
  dockerImageTag: dockerImageTagForPlaywrightVersion(playwrightVersion),
};
const COMMITTED_PROVENANCE = createBaselineProvenance({
  ...RENDERER,
  componentScope: 'all',
  renderedSourceSha: 'f'.repeat(40),
  suiteExitCode: 0,
});

/** A 10x10 PNG filled with one grey level. */
function png(level: number): Buffer {
  const image = new PNG({ width: 10, height: 10 });
  image.data.fill(level);
  for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;
  return PNG.sync.write(image);
}

function write(root: string, path: string, bytes: Buffer | string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

type Fixture = {
  run: UpdateRun;
  baselineDirectory: string;
  extractCommitted: (sha: string, destination: string) => void;
  output: { stdout: (text: string) => void; stderr: (text: string) => void };
  printed: () => string;
};

/**
 * A finished container run on disk, as `startRendererRun` leaves it, and a working tree whose
 * committed baselines are `chip/light-desktop-primary.png` and `chip/light-desktop-orphan.png`.
 */
function fixtureRun(options: {
  report: string | undefined;
  exitCode: number;
  regenerated: Record<string, Buffer>;
  accept?: boolean;
  forwarded?: string[];
  componentScope?: string;
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'update-snapshots-docker-run-'));
  const runDirectory = join(root, 'run');
  const outputDirectory = join(runDirectory, 'out');
  mkdirSync(join(outputDirectory, 'linux'), { recursive: true });
  if (options.report !== undefined) write(outputDirectory, 'results.json', options.report);
  for (const [path, bytes] of Object.entries(options.regenerated)) {
    write(join(outputDirectory, 'linux'), path, bytes);
  }
  write(
    outputDirectory,
    'regenerated.txt',
    Object.keys(options.regenerated)
      .map((path) => `${LINUX_BASELINE_DIRECTORY}/${path}\n`)
      .join(''),
  );
  // Provenance as the in-container writer would have recorded it.
  const rendered = createBaselineProvenance({
    ...RENDERER,
    componentScope: options.componentScope ?? 'all',
    renderedSourceSha: SHA,
    suiteExitCode: options.exitCode,
  });
  write(join(outputDirectory, 'linux'), PROVENANCE_FILE_NAME, JSON.stringify(rendered));

  const committed = {
    'chip/light-desktop-primary.png': png(255),
    'chip/light-desktop-orphan.png': png(0),
  };
  const baselineDirectory = join(root, 'working-tree');
  for (const [path, bytes] of Object.entries(committed)) write(baselineDirectory, path, bytes);
  // The working tree's full-run record, as the last full refresh committed it.
  write(
    baselineDirectory,
    PROVENANCE_FILE_NAME,
    `${JSON.stringify(COMMITTED_PROVENANCE, null, 2)}\n`,
  );

  const lines: string[] = [];
  return {
    run: {
      exitCode: options.exitCode,
      sha: SHA,
      runDirectory,
      acceptBehaviouralFailures: options.accept ?? false,
      forwarded: options.forwarded ?? [],
      componentScope: rendered.componentScope,
      results: readSuiteResults(outputDirectory),
      hostLoad: {
        start: { oneMinuteLoad: 80, logicalCpus: 12 },
        end: { oneMinuteLoad: 80, logicalCpus: 12 },
      },
    },
    baselineDirectory,
    extractCommitted: (sha, destination) => {
      expect(sha).toBe(SHA);
      for (const [path, bytes] of Object.entries(committed)) {
        write(join(destination, LINUX_BASELINE_DIRECTORY), path, bytes);
      }
    },
    output: { stdout: (text) => lines.push(text), stderr: (text) => lines.push(text) },
    printed: () => lines.join(''),
  };
}

async function apply(fixture: Fixture): Promise<number> {
  return applyUpdateRun(
    fixture.run,
    { baselineDirectory: fixture.baselineDirectory, extractCommitted: fixture.extractCommitted },
    fixture.output,
  );
}

function baseline(fixture: Fixture, path: string): Buffer | undefined {
  const target = join(fixture.baselineDirectory, path);
  return existsSync(target) ? readFileSync(target) : undefined;
}

function provenance(fixture: Fixture) {
  return parseBaselineProvenance(
    readFileSync(join(fixture.baselineDirectory, PROVENANCE_FILE_NAME), 'utf8'),
  );
}

const DELETION_WORDING = /delet\w*.*orphan|orphan.*delet/i;

/** A scoped run never says it deleted an orphan, in its report or on stdout (COR-1574). */
function expectNoDeletionWording(fixture: Fixture): void {
  const report = readFileSync(
    join(fixture.run.runDirectory, 'report', 'baseline-diff-report.md'),
    'utf8',
  );
  for (const text of [report, fixture.printed()]) {
    expect(text.split('\n').filter((line) => DELETION_WORDING.test(line))).toEqual([]);
  }
  expect(report).toContain('## Kept orphans without a rename partner');
}

describe('applying an update run (COR-1537)', () => {
  it('writes nothing and deletes nothing after a webServer timeout, even with the flag', async () => {
    // The 2026-10-15 run: exit 1, a report with no suites and one top-level error, nothing
    // regenerated, and provenance written because the suite "completed".
    const fixture = fixtureRun({
      report: WEB_SERVER_TIMEOUT_REPORT,
      exitCode: 1,
      regenerated: {},
      accept: true,
    });
    expect(await apply(fixture)).not.toBe(0);
    expect(baseline(fixture, 'chip/light-desktop-primary.png')).toEqual(png(255));
    expect(baseline(fixture, 'chip/light-desktop-orphan.png')).toEqual(png(0));
    expect(provenance(fixture)).toEqual(COMMITTED_PROVENANCE);
    expect(fixture.printed()).toContain('did not complete normally');
    expect(fixture.printed()).toContain('config.webServer');
  });

  it('writes nothing and deletes nothing when the run left no results file', async () => {
    const fixture = fixtureRun({ report: undefined, exitCode: 0, regenerated: {} });
    expect(await apply(fixture)).not.toBe(0);
    expect(baseline(fixture, 'chip/light-desktop-orphan.png')).toEqual(png(0));
    expect(fixture.printed()).toContain('no Playwright report');
  });

  it('writes nothing and deletes nothing when most selected tests never ran', async () => {
    const fixture = fixtureRun({
      report: playwrightReport([
        passed('light-desktop-primary'),
        ...Array.from({ length: 40 }, (_, index) => ({ title: `case ${index}`, results: [] })),
      ]),
      exitCode: 1,
      regenerated: { 'chip/light-desktop-primary.png': png(128) },
      accept: true,
    });
    expect(await apply(fixture)).not.toBe(0);
    expect(baseline(fixture, 'chip/light-desktop-primary.png')).toEqual(png(255));
    expect(baseline(fixture, 'chip/light-desktop-orphan.png')).toEqual(png(0));
    expect(fixture.printed()).toContain('40 of 41 selected tests never ran');
  });

  it('deletes no orphan when a complete run regenerated no baseline at all', async () => {
    const fixture = fixtureRun({
      report: playwrightReport([passed('behaviour only')]),
      exitCode: 0,
      regenerated: {},
    });
    expect(await apply(fixture)).not.toBe(0);
    expect(baseline(fixture, 'chip/light-desktop-primary.png')).toEqual(png(255));
    expect(baseline(fixture, 'chip/light-desktop-orphan.png')).toEqual(png(0));
    expect(fixture.printed()).toContain('regenerated no baseline');
  });

  it('writes changed baselines but keeps orphans when the run was scoped', async () => {
    for (const scope of [{ forwarded: ['--grep', 'chip'] }, { componentScope: 'chip' }]) {
      const fixture = fixtureRun({
        report: playwrightReport([passed('light-desktop-primary')]),
        exitCode: 0,
        regenerated: { 'chip/light-desktop-primary.png': png(128) },
        ...scope,
      });
      expect(await apply(fixture)).toBe(0);
      expect(baseline(fixture, 'chip/light-desktop-primary.png')).toEqual(png(128));
      expect(baseline(fixture, 'chip/light-desktop-orphan.png')).toEqual(png(0));
      expect(fixture.printed()).toContain('kept 1 orphan');
      expectNoDeletionWording(fixture);
    }
  });

  it('still writes changed baselines and deletes genuine orphans after a complete full run', async () => {
    const fixture = fixtureRun({
      report: playwrightReport([passed('light-desktop-primary')]),
      exitCode: 0,
      regenerated: { 'chip/light-desktop-primary.png': png(128) },
    });
    expect(await apply(fixture)).toBe(0);
    expect(baseline(fixture, 'chip/light-desktop-primary.png')).toEqual(png(128));
    expect(baseline(fixture, 'chip/light-desktop-orphan.png')).toBeUndefined();
    expect(baseline(fixture, PROVENANCE_FILE_NAME)).toBeDefined();
    expect(fixture.printed()).toContain(
      'Applied 1 baselines and provenance.json; deleted 1 orphans',
    );
  });
});

describe('a component-scoped refresh (COR-1574)', () => {
  const scopedGuardRun = () =>
    fixtureRun({
      report: playwrightReport([passed('chip › light-desktop-primary'), failedTerminalScopeGuard]),
      exitCode: 1,
      regenerated: { 'chip/light-desktop-primary.png': png(128) },
      componentScope: 'chip',
    });

  it('applies a scoped run whose only failure is the terminal guard, then passes the provenance check', async () => {
    const fixture = scopedGuardRun();
    expect(await apply(fixture)).toBe(0);
    expect(baseline(fixture, 'chip/light-desktop-primary.png')).toEqual(png(128));
    expect(baseline(fixture, 'chip/light-desktop-orphan.png')).toEqual(png(0));
    expect(fixture.printed()).toContain('terminal scope guard');
    expect(fixture.printed()).toContain(
      'Applied 1 baselines and provenance.json (component renders for chip); kept 1 orphans',
    );
    expectNoDeletionWording(fixture);

    // The full-run record stays; the scoped render is added beside it.
    const applied = provenance(fixture);
    expect(applied).toEqual({
      ...COMMITTED_PROVENANCE,
      componentRenders: { chip: { renderedSourceSha: SHA, suiteExitCode: 1 } },
    });
    // The same check `baseline-provenance.test.ts` runs on the committed record.
    expect(committedProvenanceProblems(applied, playwrightVersion)).toEqual([]);
  });

  it('still blocks the terminal guard failure on a full run', async () => {
    const fixture = fixtureRun({
      report: playwrightReport([passed('chip › light-desktop-primary'), failedTerminalScopeGuard]),
      exitCode: 1,
      regenerated: { 'chip/light-desktop-primary.png': png(128) },
    });
    expect(await apply(fixture)).toBe(1);
    expect(baseline(fixture, 'chip/light-desktop-primary.png')).toEqual(png(255));
    expect(baseline(fixture, 'chip/light-desktop-orphan.png')).toEqual(png(0));
    expect(provenance(fixture)).toEqual(COMMITTED_PROVENANCE);
    expect(fixture.printed()).toContain('--accept-behavioural-failures');
  });

  it('refuses a scoped render onto a working tree with no full-run provenance', async () => {
    const fixture = scopedGuardRun();
    rmSync(join(fixture.baselineDirectory, PROVENANCE_FILE_NAME));
    expect(await apply(fixture)).toBe(1);
    expect(baseline(fixture, 'chip/light-desktop-primary.png')).toEqual(png(255));
    expect(fixture.printed()).toContain('does not exist');
  });

  it('refuses a run whose provenance records a different component scope', async () => {
    const fixture = scopedGuardRun();
    fixture.run = { ...fixture.run, componentScope: ['button'] };
    expect(await apply(fixture)).toBe(1);
    expect(baseline(fixture, 'chip/light-desktop-primary.png')).toEqual(png(255));
    expect(fixture.printed()).toContain('was not written by this run');
  });
});
