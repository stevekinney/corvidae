import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  validateEvidence,
  type EvidenceCell,
  type EvidenceReport,
} from '../../../../scripts/terminal/evidence-schema.ts';
import type { CleanupOutcome } from '../protocol/messages.ts';
import {
  createScriptedIterable,
  createScriptedStream,
  createScriptedSubscription,
  type ReleaseBehavior,
} from './fixtures/scripted-sources.ts';
import type { OutputSource } from './session-types.ts';
import { createHarness, flush, startAndAttach } from './session.test-support.ts';

const packageRoot = join(import.meta.dir, '../..');
const repositoryRoot = join(packageRoot, '../..');
const reportPath = join(packageRoot, 'test-results/cleanup.json');
const schemaPath = join(repositoryRoot, 'scripts/terminal/evidence.schema.json');
const CLEANUP_DEADLINE_MILLISECONDS = 5_000;

/**
 * Every cell of the cleanup matrix: an owned or a borrowed source released with each of the three
 * outcomes. A cell passes only when every variant it names ended with exactly the outcome it claims.
 */
const EXPECTED_CELL_IDS = [
  'cleanup-owned-complete',
  'cleanup-owned-incomplete',
  'cleanup-owned-unknown',
  'cleanup-borrowed-complete',
  'cleanup-borrowed-incomplete',
  'cleanup-borrowed-unknown',
] as const;

type Variant = {
  readonly label: string;
  readonly expected: CleanupOutcome;
  build(): { readonly source: OutputSource; releaseCalls(): number };
};

const stream = (cancel: ReleaseBehavior, expected: CleanupOutcome): Variant => ({
  label: `owned stream, cancel ${cancel}`,
  expected,
  build: () => {
    const scripted = createScriptedStream('pty', { cancel });
    return { source: scripted.source, releaseCalls: () => scripted.cancelCount };
  },
});

const iterable = (behavior: ReleaseBehavior, expected: CleanupOutcome): Variant => ({
  label: `owned iterator, return() ${behavior}`,
  expected,
  build: () => {
    const scripted = createScriptedIterable('stdout', { return: behavior });
    return { source: scripted.source, releaseCalls: () => scripted.returnCount };
  },
});

const subscription = (
  unsubscribe: ReleaseBehavior | 'throw',
  expected: CleanupOutcome,
): Variant => ({
  label: `borrowed subscription, unsubscribe ${unsubscribe}`,
  expected,
  build: () => {
    const scripted = createScriptedSubscription('stdout', { unsubscribe });
    return { source: scripted.source, releaseCalls: () => scripted.unsubscribeCount };
  },
});

const MATRIX: Record<(typeof EXPECTED_CELL_IDS)[number], readonly Variant[]> = {
  'cleanup-owned-complete': [stream('resolve', 'complete'), iterable('resolve', 'complete')],
  'cleanup-owned-incomplete': [
    stream('reject', 'incomplete'),
    stream('absent', 'incomplete'),
    iterable('reject', 'incomplete'),
    iterable('absent', 'incomplete'),
  ],
  'cleanup-owned-unknown': [stream('hang', 'unknown'), iterable('hang', 'unknown')],
  'cleanup-borrowed-complete': [subscription('resolve', 'complete')],
  'cleanup-borrowed-incomplete': [
    subscription('reject', 'incomplete'),
    subscription('throw', 'incomplete'),
  ],
  'cleanup-borrowed-unknown': [subscription('hang', 'unknown')],
};

async function observe(variant: Variant) {
  const { source, releaseCalls } = variant.build();
  const harness = createHarness({ backend: false, sources: [source] });
  await startAndAttach(harness, 'read-only');
  const closing = harness.session.dispose();
  await flush();
  harness.clock.advance(CLEANUP_DEADLINE_MILLISECONDS);
  const summary = await closing;
  const matched =
    summary.cleanup === variant.expected &&
    summary.quarantined === (variant.expected !== 'complete') &&
    harness.session.snapshot.cleanup.kind === 'finished' &&
    harness.clock.pendingTimers === 0;
  return {
    matched,
    releaseCalls: releaseCalls(),
    line: `${variant.label}: ${summary.cleanup}${summary.quarantined ? ', quarantined' : ''}`,
  };
}

async function buildCell(id: (typeof EXPECTED_CELL_IDS)[number]): Promise<EvidenceCell> {
  const variants = MATRIX[id];
  const observed = [];
  for (const variant of variants) observed.push(await observe(variant));
  return {
    id,
    passed: observed.every((entry) => entry.matched),
    observations: observed.map((entry) => entry.line),
    versions: { bun: Bun.version },
    metrics: {
      variantsObserved: { value: observed.length, unit: 'variants' },
      releaseCalls: {
        value: observed.reduce((sum, entry) => sum + entry.releaseCalls, 0),
        unit: 'calls',
      },
    },
  };
}

function sourceSha(): string {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repositoryRoot });
  return result.stdout.toString().trim();
}

async function buildReport(): Promise<EvidenceReport> {
  const cells: EvidenceCell[] = [];
  for (const id of EXPECTED_CELL_IDS) cells.push(await buildCell(id));
  return {
    schemaVersion: 1,
    reportKind: 'runtime',
    sourceSha: sourceSha(),
    runId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    expectedCellIds: [...EXPECTED_CELL_IDS],
    cells,
    passed: cells.every((cell) => cell.passed),
  };
}

function structuralErrors(report: unknown): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
  return validate(report)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
}

describe('cleanup evidence report', () => {
  test('writes test-results/cleanup.json covering every outcome for owned and borrowed sources', async () => {
    const report = await buildReport();
    mkdirSync(join(packageRoot, 'test-results'), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const written = JSON.parse(readFileSync(reportPath, 'utf8')) as EvidenceReport;
    expect(structuralErrors(written)).toEqual([]);
    expect(validateEvidence(written, 'runtime')).toEqual([]);
    expect(written.expectedCellIds).toEqual([...EXPECTED_CELL_IDS]);
    expect(written.cells.map((cell) => cell.id)).toEqual([...EXPECTED_CELL_IDS]);
    for (const cell of written.cells) {
      expect(cell.observations.length, cell.id).toBeGreaterThan(0);
      expect(cell.passed, `${cell.id}: ${cell.observations.join('; ')}`).toBe(true);
    }
    expect(written.passed).toBe(true);
  });

  test('reports only measured metrics, never a constant the test itself sets', async () => {
    const report = await buildReport();
    for (const cell of report.cells) {
      expect(Object.keys(cell.metrics), cell.id).not.toContain('fakeClockElapsed');
    }
  });

  test('fails when a required cell is missing, duplicated or unexpected', async () => {
    const report = await buildReport();
    for (const id of EXPECTED_CELL_IDS) {
      const without = { ...report, cells: report.cells.filter((cell) => cell.id !== id) };
      expect(validateEvidence(without, 'runtime'), id).toContain('missing cell');
    }
    const first = report.cells[0] as EvidenceCell;
    expect(validateEvidence({ ...report, cells: [...report.cells, first] }, 'runtime')).toContain(
      'duplicate cell',
    );
    expect(
      validateEvidence(
        { ...report, cells: [...report.cells, { ...first, id: 'extra' }] },
        'runtime',
      ),
    ).toContain('unexpected cell');
  });

  test('records a cell as failed when the outcome it observed is not the one it claims', async () => {
    const wrong = await observe({ ...stream('reject', 'complete') });
    expect(wrong.matched).toBe(false);
  });
});
