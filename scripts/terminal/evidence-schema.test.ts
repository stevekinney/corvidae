import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyBrowserFailure } from './engine-probe.ts';
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
          expectedCellIds: ['@xterm/xterm:launch'],
          cells: [{ ...validReport.cells[0], id: '@xterm/xterm:launch' }],
          candidates: [
            {
              name: '@xterm/xterm',
              version: '6.0.0',
              passed: true,
              status: 'ready',
              cells: [validReport.cells[0]],
            },
          ],
          selectedEngine: { name: '@xterm/xterm', version: '6.0.0' },
        },
        'engine',
      ),
    ).toEqual([]);
  });

  test('requires complete workload definitions for resource evidence', () => {
    const observed = {
      durationMilliseconds: 1,
      sampleCount: 1,
      warmupCount: 0,
      metrics: { duration: { value: 1, unit: 'milliseconds' } },
      raw: { fixture: true },
    };
    const controlObserved = {
      ...observed,
      durationMilliseconds: 0.5,
      raw: { fixture: 'control' },
    };
    const workload = {
      fixtureId: 'fixture',
      environment: { hardware: 'arm64/darwin', runtime: 'Bun 1.4.2' },
      plan: {
        durationMilliseconds: 1,
        sampleCount: 1,
        warmupCount: 0,
        method: 'control fixture',
        target: { metric: 'duration', unit: 'milliseconds', comparator: 'eq' as const, value: 1 },
      },
      control: { passed: true, observed: controlObserved },
      observed,
    };
    const resource = {
      ...validReport,
      reportKind: 'resource' as const,
      expectedCellIds: ['fixture'],
      cells: [{ ...validReport.cells[0], id: 'fixture', workload }],
    };
    expect(validateEvidence(resource, 'resource')).toEqual([]);
    expect(
      validateEvidence(
        {
          ...resource,
          cells: [
            {
              ...resource.cells[0],
              workload: { ...workload, control: { passed: true, observed } },
            },
          ],
        },
        'resource',
      ),
    ).toContain('control observation identical');
    expect(
      validateEvidence(
        { ...resource, cells: [{ ...resource.cells[0], workload: undefined }] },
        'resource',
      ),
    ).toContain('workload definition');
    expect(
      validateEvidence(
        {
          ...resource,
          cells: [
            {
              ...resource.cells[0],
              workload: { ...workload, observed: { ...observed, durationMilliseconds: 0 } },
            },
          ],
        },
        'resource',
      ),
    ).toContain('workload definition');
    expect(
      validateEvidence(
        {
          ...resource,
          cells: [
            {
              ...resource.cells[0],
              workload: { ...workload, observed: { ...observed, sampleCount: 2 } },
            },
          ],
        },
        'resource',
      ),
    ).toContain('observed sample count mismatch');
    expect(
      validateEvidence(
        {
          ...resource,
          cells: [{ ...resource.cells[0], metrics: { measured: { value: 2, unit: 'boolean' } } }],
        },
        'resource',
      ),
    ).toContain('observed metrics mismatch');
    expect(
      validateEvidence(
        {
          ...resource,
          cells: [
            {
              ...resource.cells[0],
              workload: {
                ...workload,
                plan: { ...workload.plan, target: { ...workload.plan.target, unit: 'bytes' } },
              },
            },
          ],
        },
        'resource',
      ),
    ).toContain('target unit mismatch');
    expect(
      validateEvidence(
        {
          ...resource,
          cells: [
            {
              ...resource.cells[0],
              workload: { ...workload, control: { passed: false, observed } },
            },
          ],
        },
        'resource',
      ),
    ).toContain('workload definition');
  });

  test('rejects false browser assertions and cleanup fact or event mutations', () => {
    const assetEvidence = {
      origin: 'http://127.0.0.1:1234',
      csp: "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'",
      requests: [
        { method: 'GET', url: 'http://127.0.0.1:1234/', path: '/' },
        { method: 'GET', url: 'http://127.0.0.1:1234/candidate.css', path: '/candidate.css' },
        { method: 'GET', url: 'http://127.0.0.1:1234/probe.js', path: '/probe.js' },
      ],
      responses: [
        { url: 'http://127.0.0.1:1234/', status: 200, contentType: 'text/html' },
        { url: 'http://127.0.0.1:1234/candidate.css', status: 200, contentType: 'text/css' },
        { url: 'http://127.0.0.1:1234/probe.js', status: 200, contentType: 'text/javascript' },
      ],
      failures: [],
    };
    const plan = {
      durationMilliseconds: 1_000,
      sampleCount: 1,
      warmupCount: 0,
      method: 'fixture',
      target: { metric: 'assertion', unit: 'boolean', comparator: 'eq' as const, value: 1 },
    };
    const browserWorkload = {
      fixtureId: 'browser-assets-and-csp',
      environment: { hardware: 'arm64/darwin', runtime: 'Bun 1.4.2', browser: 'Chromium' },
      plan,
      control: {
        passed: true as const,
        observed: {
          durationMilliseconds: 2,
          sampleCount: 1,
          warmupCount: 0,
          metrics: { assertion: { value: 1, unit: 'boolean' } },
          raw: { assetEvidence, passed: true, control: true },
        },
      },
      observed: {
        durationMilliseconds: 2,
        sampleCount: 1,
        warmupCount: 0,
        metrics: { assertion: { value: 1, unit: 'boolean' } },
        raw: { assetEvidence, passed: true },
      },
    };
    const browserReport = {
      ...validReport,
      reportKind: 'resource' as const,
      expectedCellIds: ['browser-assets-and-csp'],
      cells: [
        {
          ...validReport.cells[0],
          id: 'browser-assets-and-csp',
          metrics: { assertion: { value: 1, unit: 'boolean' } },
          workload: browserWorkload,
        },
      ],
    };
    expect(
      validateEvidence(
        {
          ...browserReport,
          cells: [
            {
              ...browserReport.cells[0],
              workload: {
                ...browserWorkload,
                observed: { ...browserWorkload.observed, raw: { assetEvidence, passed: false } },
              },
            },
          ],
        },
        'resource',
      ),
    ).toContain('browser asset evidence');
    const cleanup = {
      state: 'complete' as const,
      quarantined: false,
      facts: {
        authorityRevoked: true,
        controlCapacityReserved: true,
        userQueueCanceled: true,
        processGroupSignaled: true,
        parentExited: true,
        descendantObservedGone: true,
        handlesClosed: true,
      },
    };
    const cleanupWorkload = {
      ...browserWorkload,
      fixtureId: 'cleanup-order',
      plan: {
        ...plan,
        target: {
          metric: 'cleanup',
          unit: 'milliseconds',
          comparator: 'lte' as const,
          value: 5_000,
        },
      },
      control: {
        ...browserWorkload.control,
        observed: {
          ...browserWorkload.control.observed,
          metrics: { cleanup: { value: 2, unit: 'milliseconds' } },
          raw: {
            events: [
              'authority-revoked',
              'control-reserved-and-queue-canceled',
              'process-group-signaled',
              'handles-closed-and-descendant-observed',
            ],
            cleanup,
          },
        },
      },
      observed: {
        ...browserWorkload.observed,
        metrics: { cleanup: { value: 2, unit: 'milliseconds' } },
        raw: {
          events: [
            'authority-revoked',
            'control-reserved-and-queue-canceled',
            'process-group-signaled',
            'handles-closed-and-descendant-observed',
          ],
          cleanup,
        },
      },
    };
    const cleanupReport = {
      ...browserReport,
      expectedCellIds: ['cleanup-order'],
      cells: [
        {
          ...browserReport.cells[0],
          id: 'cleanup-order',
          metrics: { cleanup: { value: 2, unit: 'milliseconds' } },
          workload: cleanupWorkload,
        },
      ],
    };
    expect(
      validateEvidence(
        {
          ...cleanupReport,
          cells: [
            {
              ...cleanupReport.cells[0],
              workload: {
                ...cleanupWorkload,
                observed: {
                  ...cleanupWorkload.observed,
                  raw: { ...cleanupWorkload.observed.raw, events: ['process-group-signaled'] },
                },
              },
            },
          ],
        },
        'resource',
      ),
    ).toContain('cleanup raw evidence');
  });

  test('committed schema rejects hostile candidate structures before semantic checks', async () => {
    const committedSchema = JSON.parse(await readFile(schemaPath, 'utf8'));
    const validator = new Ajv2020({ allErrors: true, strict: false });
    addFormats(validator);
    const validate = validator.compile(committedSchema);
    const engineReport = {
      ...validReport,
      reportKind: 'engine',
      expectedCellIds: ['@xterm/xterm:launch'],
      cells: [{ ...validReport.cells[0], id: '@xterm/xterm:launch' }],
      candidates: [
        {
          name: '@xterm/xterm',
          version: '6.0.0',
          passed: true,
          status: 'ready',
          cells: [validReport.cells[0]],
        },
      ],
      selectedEngine: { name: '@xterm/xterm', version: '6.0.0' },
    };

    expect(validate(engineReport)).toBe(true);
    expect(
      validate({
        ...engineReport,
        candidates: [{ ...engineReport.candidates[0], cells: [null] }],
      }),
    ).toBe(false);
    expect(
      validate({
        ...engineReport,
        candidates: [{ ...engineReport.candidates[0], status: 'broken' }],
      }),
    ).toBe(false);
    expect(
      validate({
        ...engineReport,
        candidates: [
          { ...engineReport.candidates[0], cells: [{ ...validReport.cells[0], extra: true }] },
        ],
      }),
    ).toBe(false);
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
    expect(validateEvidence({ ...validReport, sourceSha: 'short' }, 'runtime')).toContain(
      'schema constraints',
    );
    expect(validateEvidence({ ...validReport, observedAt: 'not-a-date' }, 'runtime')).toContain(
      'schema constraints',
    );
    expect(
      validateEvidence(
        {
          ...validReport,
          cells: [{ ...validReport.cells[0], versions: { bun: '1.4.1' } }],
        },
        'runtime',
      ),
    ).toContain('runtime bun version');
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

  test('rejects unresolved candidates and failed or missing selections', () => {
    const candidate = {
      name: '@xterm/xterm',
      version: '6.0.0',
      passed: true,
      status: 'ready',
      cells: [validReport.cells[0]],
    };
    const engine = {
      ...validReport,
      reportKind: 'engine',
      expectedCellIds: ['@xterm/xterm:launch'],
      cells: [{ ...validReport.cells[0], id: '@xterm/xterm:launch' }],
      candidates: [candidate],
      selectedEngine: { name: '@xterm/xterm', version: '6.0.0' },
      passed: true,
    };
    expect(
      validateEvidence(
        { ...engine, candidates: [{ ...candidate, status: 'unavailable' }], passed: false },
        'engine',
      ),
    ).toEqual([]);
    expect(
      validateEvidence(
        { ...engine, candidates: [{ ...candidate, passed: false }], passed: true },
        'engine',
      ),
    ).toContain('candidate passed consistency');
    expect(
      validateEvidence(
        { ...engine, candidates: [{ ...candidate, passed: false }], passed: false },
        'engine',
      ),
    ).toContain('selected engine failed');
    expect(
      validateEvidence(
        {
          ...engine,
          selectedEngine: { name: '@xterm/xterm', version: '6.0.0' },
          candidates: [],
          passed: false,
        },
        'engine',
      ),
    ).toContain('selected engine candidates');
    expect(
      validateEvidence(
        {
          ...engine,
          candidates: [{ ...candidate, cells: [null] }],
          passed: false,
          selectedEngine: null,
        },
        'engine',
      ),
    ).toContain('candidate shape');
    expect(
      validateEvidence(
        {
          ...engine,
          cells: [{ ...validReport.cells[0], id: '@xterm/xterm:launch', passed: false }],
          passed: false,
        },
        'engine',
      ),
    ).toContain('candidate cell disagreement');
  });

  test('serializes browser failure phase in the Bun context', async () => {
    const requests = ['/'];
    const diagnostics = ['console:info:fixture'];
    const result = await classifyBrowserFailure(
      async () => ({ phase: 'after-init' }),
      new Error('TimeoutError: forced probe failure'),
      requests,
      diagnostics,
    );

    expect(result.status).toBe('unavailable');
    expect(result.requests).toBe(requests);
    expect(result.diagnostics).toContain('phase:{"phase":"after-init"}');
    expect(result.cells['input-return-semantics']?.observation).toContain(
      'unavailable:timeout:{"phase":"after-init"}',
    );
  });
});
