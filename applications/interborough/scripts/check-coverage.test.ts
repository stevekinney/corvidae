import { describe, expect, it } from 'bun:test';

import {
  aggregateByArea,
  areaForFile,
  overallTotals,
  percentage,
  renderAreaTable,
  uiCoverageRecords,
  type AreaCoverage,
  type FileCoverage,
} from './check-coverage.ts';

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

describe('renderAreaTable', () => {
  it('renders a header row plus one row per area, sorted', () => {
    const current = new Map<string, AreaCoverage>([
      ['src/lib', { linesFound: 10, linesHit: 10, functionsFound: 2, functionsHit: 2 }],
      ['src/app', { linesFound: 4, linesHit: 2, functionsFound: 1, functionsHit: 1 }],
    ]);

    const lines = renderAreaTable(current);
    expect(lines).toEqual([
      'area | lines | functions',
      'src/app | 50.00% | 100.00%',
      'src/lib | 100.00% | 100.00%',
    ]);
  });

  it('renders only the header for a run that measured nothing', () => {
    expect(renderAreaTable(new Map())).toEqual(['area | lines | functions']);
  });
});
