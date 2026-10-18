import { describe, expect, it } from 'bun:test';

import {
  aggregateByArea,
  areaForFile,
  findRegressions,
  overallTotals,
  percentage,
  renderAreaTable,
  resolveBaselineForPlatform,
  uiCoverageRecords,
  type FileCoverage,
} from './check-coverage.ts';
import {
  coverageMeasurementPlatform,
  type AreaCoverage,
  type CoverageBaseline,
} from './coverage-baseline.ts';

describe('areaForFile', () => {
  it('buckets a src/routes/<domain> file by its domain', () => {
    expect(areaForFile('src/routes/workflows/list/workflow-list.svelte')).toBe(
      'src/routes/workflows',
    );
    expect(areaForFile('src/routes/storage/storage-client.ts')).toBe('src/routes/storage');
  });

  it('buckets a direct src/<segment> file by that segment', () => {
    expect(areaForFile('src/lib/faults.ts')).toBe('src/lib');
    expect(areaForFile('src/app/shell/topbar.svelte')).toBe('src/app');
  });

  it('buckets a top-level src/ file as "src"', () => {
    expect(areaForFile('src/main.ts')).toBe('src');
  });

  it('buckets non-src top-level directories by their own name', () => {
    expect(areaForFile('fixtures/workflows.ts')).toBe('fixtures');
    expect(areaForFile('scripts/check-coverage.ts')).toBe('scripts');
    expect(areaForFile('tests/setup.ts')).toBe('tests');
  });
});

describe('uiCoverageRecords', () => {
  it('keeps this application’s files under the paths the floors were recorded with', () => {
    const files = [
      'src/lib/client.ts',
      'src/main.ts',
      'tests/setup.ts',
      'fixtures/workflows.ts',
      'scripts/browser/server.ts',
      'scripts/check-coverage.ts',
    ];
    expect(
      uiCoverageRecords(files.map((file) => createCoverageRecord(file))).map(
        (record) => record.file,
      ),
    ).toEqual(files);
  });

  it('drops sibling-workspace, absolute, and node_modules records', () => {
    expect(
      uiCoverageRecords([
        createCoverageRecord('../../packages/weft/src/index.ts'),
        createCoverageRecord('../../packages/weft/src/testing/promise-outcome.test-support.ts'),
        createCoverageRecord('../../components/cinder/src/index.ts'),
        createCoverageRecord('/tmp/outside.ts'),
        createCoverageRecord('node_modules/pkg/index.ts'),
      ]),
    ).toEqual([]);
  });
});

function createCoverageRecord(file: string): FileCoverage {
  return { file, linesFound: 1, linesHit: 1, functionsFound: 1, functionsHit: 1 };
}

describe('aggregateByArea', () => {
  it('sums per-file records into per-area totals', () => {
    const records: FileCoverage[] = [
      { file: 'src/lib/a.ts', linesFound: 10, linesHit: 5, functionsFound: 2, functionsHit: 1 },
      { file: 'src/lib/b.ts', linesFound: 4, linesHit: 4, functionsFound: 1, functionsHit: 1 },
      {
        file: 'src/routes/workers/index.ts',
        linesFound: 6,
        linesHit: 3,
        functionsFound: 2,
        functionsHit: 0,
      },
    ];

    const areas = aggregateByArea(records);
    expect(areas.get('src/lib')).toEqual({
      linesFound: 14,
      linesHit: 9,
      functionsFound: 3,
      functionsHit: 2,
    });
    expect(areas.get('src/routes/workers')).toEqual({
      linesFound: 6,
      linesHit: 3,
      functionsFound: 2,
      functionsHit: 0,
    });
  });

  it('returns an empty map for no records', () => {
    expect(aggregateByArea([])).toEqual(new Map());
  });
});

describe('overallTotals', () => {
  it('sums every record into one total', () => {
    const records: FileCoverage[] = [
      { file: 'a.ts', linesFound: 10, linesHit: 5, functionsFound: 2, functionsHit: 1 },
      { file: 'b.ts', linesFound: 4, linesHit: 4, functionsFound: 1, functionsHit: 1 },
    ];
    expect(overallTotals(records)).toEqual({
      linesFound: 14,
      linesHit: 9,
      functionsFound: 3,
      functionsHit: 2,
    });
  });

  it('returns all-zero totals for no records', () => {
    expect(overallTotals([])).toEqual({
      linesFound: 0,
      linesHit: 0,
      functionsFound: 0,
      functionsHit: 0,
    });
  });
});

describe('percentage', () => {
  it('computes hit/found as a percentage', () => {
    expect(percentage(1, 2)).toBe(50);
    expect(percentage(3, 4)).toBe(75);
  });

  it('treats zero found as vacuously 100% covered', () => {
    expect(percentage(0, 0)).toBe(100);
  });
});

describe('findRegressions', () => {
  it('reports no regressions when current matches baseline exactly', () => {
    const baseline = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 10, functionsFound: 2, functionsHit: 2 }],
    ]);
    expect(findRegressions(baseline, baseline)).toEqual([]);
  });

  it('reports no regressions when current coverage improves', () => {
    const baseline = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 5, functionsFound: 2, functionsHit: 1 }],
    ]);
    const current = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 8, functionsFound: 2, functionsHit: 2 }],
    ]);
    expect(findRegressions(current, baseline)).toEqual([]);
  });

  it('reports a line regression', () => {
    const baseline = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 10, functionsFound: 2, functionsHit: 2 }],
    ]);
    const current = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 5, functionsFound: 2, functionsHit: 2 }],
    ]);
    expect(findRegressions(current, baseline)).toEqual([
      { area: 'src/lib', metric: 'lines', currentPercentage: 50, baselinePercentage: 100 },
    ]);
  });

  it('reports a function regression independently of lines', () => {
    const baseline = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 10, functionsFound: 4, functionsHit: 4 }],
    ]);
    const current = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 10, functionsFound: 4, functionsHit: 1 }],
    ]);
    expect(findRegressions(current, baseline)).toEqual([
      { area: 'src/lib', metric: 'functions', currentPercentage: 25, baselinePercentage: 100 },
    ]);
  });

  it('does not gate an area missing from the current run (skipped, not failed)', () => {
    const baseline = new Map<string, AreaCoverage>([
      [
        'src/routes/removed-domain',
        { linesFound: 10, linesHit: 10, functionsFound: 2, functionsHit: 2 },
      ],
    ]);
    expect(findRegressions(new Map(), baseline)).toEqual([]);
  });

  it('does not gate a new area with no baseline entry', () => {
    const current = new Map<string, AreaCoverage>([
      [
        'src/routes/new-domain',
        { linesFound: 10, linesHit: 0, functionsFound: 2, functionsHit: 0 },
      ],
    ]);
    expect(findRegressions(current, new Map())).toEqual([]);
  });
});

describe('renderAreaTable', () => {
  it('renders a header row plus one row per union of current/baseline areas, sorted', () => {
    const current = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 10, functionsFound: 2, functionsHit: 2 }],
      ['src/app', { linesFound: 4, linesHit: 2, functionsFound: 1, functionsHit: 1 }],
    ]);
    const baseline = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 10, functionsFound: 2, functionsHit: 2 }],
    ]);

    const lines = renderAreaTable(current, baseline);
    expect(lines[0]).toBe('area | lines | functions | baseline lines | baseline functions');
    expect(lines[1]).toBe('src/app | 50.00% | 100.00% | (new) | (new)');
    expect(lines[2]).toBe('src/lib | 100.00% | 100.00% | 100.00% | 100.00%');
  });

  it('marks a baselined area missing from the current run as (missing)', () => {
    const baseline = new Map<string, AreaCoverage>([
      ['src/routes/removed', { linesFound: 10, linesHit: 10, functionsFound: 2, functionsHit: 2 }],
    ]);
    const lines = renderAreaTable(new Map(), baseline);
    expect(lines[1]).toBe('src/routes/removed | (missing) | (missing) | 100.00% | 100.00%');
  });
});

describe('resolveBaselineForPlatform', () => {
  // Two areas besides OVERALL, so bootstrap mode has more than one entry to sort.
  const areas = new Map<string, AreaCoverage>([
    ['OVERALL', { linesFound: 14, linesHit: 11, functionsFound: 3, functionsHit: 3 }],
    ['src/lib', { linesFound: 10, linesHit: 8, functionsFound: 2, functionsHit: 2 }],
    ['src/app', { linesFound: 4, linesHit: 3, functionsFound: 1, functionsHit: 1 }],
  ]);
  const recorded: CoverageBaseline = {
    measuredAt: '2026-08-10T00:00:00.000Z',
    overall: { linesFound: 10, linesHit: 8, functionsFound: 2, functionsHit: 2 },
    areas: { 'src/lib': { linesFound: 10, linesHit: 8, functionsFound: 2, functionsHit: 2 } },
  };

  it('returns the recorded baseline for a platform that has one', () => {
    const result = resolveBaselineForPlatform(areas, 'darwin', { darwin: recorded, linux: null });
    expect(result.platform).toBe('darwin');
    expect(result.baseline).toBe(recorded);
  });

  it('returns a null baseline (bootstrap mode) for a platform with none recorded', () => {
    const result = resolveBaselineForPlatform(areas, 'linux', { darwin: recorded, linux: null });
    expect(result.platform).toBe('linux');
    expect(result.baseline).toBeNull();
  });

  it('returns a null baseline for an unrecognized platform', () => {
    const result = resolveBaselineForPlatform(areas, null, { darwin: recorded, linux: recorded });
    expect(result.baseline).toBeNull();
    expect(result.platform).toBe(process.platform);
  });
});

describe('coverageMeasurementPlatform', () => {
  it('recognizes the current platform (this suite only runs on darwin or linux)', () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error(`Unsupported test platform: ${process.platform}`);
    }
    expect(coverageMeasurementPlatform()).toBe(process.platform);
  });
});

describe('resolveBaselineForPlatform — default arguments', () => {
  it('resolves the real recorded baseline for the running platform (or bootstrap-null)', () => {
    const areas = new Map<string, AreaCoverage>([
      ['OVERALL', { linesFound: 1, linesHit: 1, functionsFound: 1, functionsHit: 1 }],
    ]);
    const result = resolveBaselineForPlatform(areas);
    // darwin has a recorded baseline; linux is in bootstrap until its first
    // CI measurement is pasted in — both are valid resolutions here.
    expect(result.platform).toBe(process.platform);
    if (result.baseline !== null) {
      expect(result.baseline.overall.linesFound).toBeGreaterThan(0);
    }
  });
});
