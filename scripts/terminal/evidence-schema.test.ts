import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const schemaPath = join(import.meta.dir, 'evidence.schema.json');

type Report = {
  schemaVersion?: unknown;
  reportKind?: unknown;
  sourceSha?: unknown;
  runId?: unknown;
  observedAt?: unknown;
  expectedCellIds?: unknown;
  cells?: unknown;
  passed?: unknown;
};

function validate(report: Report): string[] {
  const errors: string[] = [];
  if (report.schemaVersion !== 1) errors.push('schemaVersion');
  if (report.reportKind !== 'runtime' && report.reportKind !== 'engine') errors.push('reportKind');
  for (const field of ['sourceSha', 'runId', 'observedAt'] as const) {
    if (typeof report[field] !== 'string' || report[field].length === 0) errors.push(field);
  }
  if (!Array.isArray(report.expectedCellIds) || report.expectedCellIds.length === 0) {
    errors.push('expectedCellIds');
  }
  if (!Array.isArray(report.cells) || report.cells.length === 0) errors.push('cells');
  const expected = new Set(report.expectedCellIds as string[]);
  const actual = Array.isArray(report.cells)
    ? report.cells.map((cell) => (cell as { id?: unknown }).id)
    : [];
  if (actual.some((id) => typeof id !== 'string')) errors.push('cell id');
  if (new Set(actual).size !== actual.length) errors.push('duplicate cell');
  if (expected.size !== actual.length || actual.some((id) => !expected.has(id as string)))
    errors.push('cell completeness');
  if (report.passed !== true && report.passed !== false) errors.push('passed');
  return errors;
}

const validReport = {
  schemaVersion: 1,
  reportKind: 'runtime',
  sourceSha: '9ad3663',
  runId: 'test-run',
  observedAt: new Date().toISOString(),
  expectedCellIds: ['launch'],
  cells: [{ id: 'launch', passed: true, observations: [] }],
  passed: true,
};

describe('terminal evidence schema', () => {
  test('the committed schema is valid JSON Schema metadata', async () => {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as Record<string, unknown>;
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['required']).toEqual(
      expect.arrayContaining(['schemaVersion', 'cells', 'passed']),
    );
  });

  test('accepts a complete report', () => {
    expect(validate(validReport)).toEqual([]);
  });

  test('rejects a missing required cell', () => {
    expect(validate({ ...validReport, cells: [] })).toContain('cells');
    expect(
      validate({ ...validReport, cells: [{ id: 'other', passed: true, observations: [] }] }),
    ).toContain('cell completeness');
  });

  test('rejects duplicate cells', () => {
    expect(
      validate({
        ...validReport,
        expectedCellIds: ['launch', 'launch'],
        cells: [
          { id: 'launch', passed: true, observations: [] },
          { id: 'launch', passed: true, observations: [] },
        ],
      }),
    ).toContain('duplicate cell');
  });

  test('rejects an invalid top-level result', () => {
    expect(validate({ ...validReport, passed: 'yes' })).toContain('passed');
  });
});
