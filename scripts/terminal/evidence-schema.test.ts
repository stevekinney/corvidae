import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateEvidence } from './evidence-schema.ts';

const schemaPath = join(import.meta.dir, 'evidence.schema.json');
const validReport = {
  schemaVersion: 1,
  reportKind: 'runtime',
  sourceSha: '9ad3663',
  runId: 'test-run',
  observedAt: new Date().toISOString(),
  expectedCellIds: ['launch'],
  cells: [
    {
      id: 'launch',
      passed: true,
      observations: [],
      versions: { bun: '1.4.2' },
      metrics: { duration: { value: 1, unit: 'milliseconds' } },
    },
  ],
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

  test('accepts a complete generated-shaped report', () => {
    expect(validateEvidence(validReport, 'runtime')).toEqual([]);
    expect(
      validateEvidence(
        {
          ...validReport,
          reportKind: 'engine',
          expectedCellIds: ['candidate:launch'],
          cells: [{ ...validReport.cells[0], id: 'candidate:launch' }],
          selectedEngine: { name: '@xterm/xterm', version: '6.0.0' },
        },
        'engine',
      ),
    ).toEqual([]);
  });

  test('rejects missing, unexpected, and duplicate cells', () => {
    expect(validateEvidence({ ...validReport, cells: [] }, 'runtime')).toContain('missing cell');
    expect(
      validateEvidence(
        { ...validReport, cells: [{ ...validReport.cells[0], id: 'other' }] },
        'runtime',
      ),
    ).toContain('unexpected cell');
    expect(
      validateEvidence({ ...validReport, expectedCellIds: ['launch', 'launch'] }, 'runtime'),
    ).toContain('expectedCellIds');
  });

  test('rejects bad types, missing units or versions, and inconsistent results', () => {
    expect(validateEvidence({ ...validReport, passed: false }, 'runtime')).toContain(
      'passed consistency',
    );
    expect(
      validateEvidence(
        { ...validReport, cells: [{ ...validReport.cells[0], versions: {} }] },
        'runtime',
      ),
    ).toContain('cell versions');
    expect(
      validateEvidence(
        { ...validReport, cells: [{ ...validReport.cells[0], metrics: {} }] },
        'runtime',
      ),
    ).toContain('cell metrics');
    expect(
      validateEvidence(
        {
          ...validReport,
          cells: [{ ...validReport.cells[0], metrics: { duration: { value: 1, unit: '' } } }],
        },
        'runtime',
      ),
    ).toContain('cell metrics');
  });
});
