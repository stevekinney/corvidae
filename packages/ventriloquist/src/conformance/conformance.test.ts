import { SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateEvidence,
  type EvidenceCell,
  type EvidenceReport,
} from '../../../../scripts/terminal/evidence-schema.ts';
import { REQUIRED_CELL_NAMES } from '../../scripts/check-conformance-hosts.ts';
import { scenarioTest, settleScenarios } from '../bun/bun-process.test-support.ts';
import {
  REQUIRED_CORPUS_FIXTURE_IDS,
  SUPPLEMENTARY_CORPUS_FIXTURE_IDS,
} from '../protocol/corpus/fixtures.ts';
import {
  BEHAVIOR_CASES,
  runCell,
  type CaseDefinition,
  type CellResult,
} from './conformance-cases.test-support.ts';
import { CONTROL_CASES } from './conformance-control-cases.test-support.ts';
import { CORPUS_CASES } from './conformance-corpus-cases.test-support.ts';
import { FAULT_CASES } from './conformance-fault-cases.test-support.ts';
import { descriptorStability } from './conformance-leak-cases.test-support.ts';
import { PAUSE_CASES } from './conformance-pause-cases.test-support.ts';
import { SESSION_CASES } from './conformance-session-cases.test-support.ts';
import { SOURCE_CASES } from './conformance-source-cases.test-support.ts';
import {
  HOST_CELL,
  PROCESS_MODES,
  TRANSPORT_PATHS,
  check,
  type CellMode,
  type ProcessMode,
  type TransportPath,
} from './conformance.test-support.ts';

const packageRoot = join(import.meta.dir, '../..');
const repositoryRoot = join(packageRoot, '../..');
const reportPath = join(packageRoot, 'test-results/conformance.json');
const schemaPath = join(repositoryRoot, 'scripts/terminal/evidence.schema.json');

/**
 * The matrix owner key is `conformance`. Controls come first in the matrix, and their cells are
 * read before any other: a control that does not behave as expected means a later failure cannot
 * be interpreted. Every other family runs the same behavior through the in-memory path and the
 * real Bun WebSocket path, against real `Bun.spawn` pipe and PTY processes.
 */
const FAMILIES: readonly { readonly family: string; readonly cases: readonly CaseDefinition[] }[] =
  [
    { family: 'control', cases: CONTROL_CASES },
    { family: 'behavior', cases: BEHAVIOR_CASES },
    { family: 'corpus', cases: CORPUS_CASES },
    { family: 'sources', cases: SOURCE_CASES },
    { family: 'pause', cases: PAUSE_CASES },
    { family: 'faults', cases: FAULT_CASES },
    { family: 'session', cases: SESSION_CASES },
  ];

type Cell = {
  readonly id: string;
  readonly family: string;
  /** The family whose two paths a parity cell compares. */
  readonly compares?: string;
  readonly path: TransportPath | 'both';
  readonly mode: CellMode;
  readonly definition: string;
};

const cellId = (parts: string[]): string => [HOST_CELL, ...parts].join(':');

const MATRIX: Cell[] = FAMILIES.flatMap(({ family, cases }) =>
  cases.flatMap((definition) =>
    (definition.paths ?? TRANSPORT_PATHS).flatMap((path) =>
      definition.modes.map((mode) => ({
        id: cellId([family, path, mode, definition.id]),
        family,
        path,
        mode,
        definition: definition.id,
      })),
    ),
  ),
);
const LEAK_CELLS: Cell[] = TRANSPORT_PATHS.flatMap((path) =>
  PROCESS_MODES.map((mode) => ({
    id: cellId(['leaks', path, mode, 'descriptor-stability']),
    family: 'leaks',
    path,
    mode,
    definition: 'descriptor-stability',
  })),
);
const PARITY_CELLS: Cell[] = FAMILIES.flatMap(({ family, cases }) =>
  cases
    .filter((definition) => definition.comparable !== false && definition.paths === undefined)
    .flatMap((definition) =>
      definition.modes.map((mode) => ({
        id: cellId(['parity', family, mode, definition.id]),
        family: 'parity',
        compares: family,
        path: 'both' as const,
        mode,
        definition: definition.id,
      })),
    ),
);
const EXPECTED_CELL_IDS = [...MATRIX, ...LEAK_CELLS, ...PARITY_CELLS].map((cell) => cell.id);

const definitions = new Map(
  FAMILIES.flatMap(({ cases }) => cases.map((definition) => [definition.id, definition] as const)),
);

const scratch = mkdtempSync(join(tmpdir(), 'ventriloquist-conformance-'));
// A report left by an earlier run must never be mistaken for this one's, even if this run dies first.
rmSync(reportPath, { force: true });

const results = new Map<string, CellResult>();

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function record(id: string, body: () => Promise<CellResult>): Promise<void> {
  let result: CellResult;
  try {
    result = await body();
  } catch (error) {
    // A cell that throws is a failed cell with the reason on record, never a missing one.
    const reason = error instanceof Error ? error.message : String(error);
    result = { checks: [check(`the cell ran to completion (${reason})`, false)], signature: [] };
  }
  results.set(id, result);
  for (const entry of result.checks) expect(entry.ok, `${id}: ${entry.label}`).toBe(true);
}

// Real processes and sockets run one cell after another at module scope, off Bun's per-test
// clock, because a child's boot on a loaded host would otherwise time a test out. Controls run first.
for (const cell of MATRIX) {
  scenarioTest(cell.id, () =>
    record(cell.id, () =>
      runCell(
        definitions.get(cell.definition) as CaseDefinition,
        cell.path as TransportPath,
        cell.mode,
        scratch,
      ),
    ),
  );
}
for (const cell of LEAK_CELLS) {
  scenarioTest(cell.id, () =>
    record(cell.id, () =>
      descriptorStability(cell.path as TransportPath, cell.mode as ProcessMode, scratch),
    ),
  );
}
await settleScenarios();

/** The two paths must tell the same story: the same kinds of message, in the same order, and the same close code. */
function parityResult(cell: Cell): CellResult {
  const direct = results.get(
    cellId([cell.compares as string, 'direct', cell.mode, cell.definition]),
  );
  const websocket = results.get(
    cellId([cell.compares as string, 'websocket', cell.mode, cell.definition]),
  );
  const same = JSON.stringify(direct?.signature) === JSON.stringify(websocket?.signature);
  return {
    checks: [
      check('both paths ran', direct !== undefined && websocket !== undefined),
      check(
        `both paths told the same story (${direct?.signature.join(' > ')} | ${websocket?.signature.join(' > ')})`,
        same,
      ),
    ],
    signature: [],
  };
}

for (const cell of PARITY_CELLS) {
  test(cell.id, () => {
    const parity = parityResult(cell);
    results.set(cell.id, parity);
    for (const entry of parity.checks) expect(entry.ok, entry.label).toBe(true);
  });
}

// Reading the commit starts a real `git` process, so it happens once at module scope.
const sourceSha = ((): string => {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  return result.stdout.toString().trim();
})();

const versions = {
  bun: Bun.version,
  platform: `${process.platform}/${process.arch}`,
  kernel: release(),
};

function buildCell(id: string): EvidenceCell {
  const result = results.get(id) ?? { checks: [check('the cell ran', false)], signature: [] };
  const passed = result.checks.length > 0 && result.checks.every((entry) => entry.ok);
  return {
    id,
    passed,
    observations: [
      ...result.checks.map((entry) => `${entry.ok ? 'pass' : 'FAIL'}: ${entry.label}`),
      ...(result.notes ?? []).map((note) => `scope: ${note}`),
    ],
    versions,
    metrics: {
      checksEvaluated: { value: result.checks.length, unit: 'checks' },
      checksFailed: { value: result.checks.filter((entry) => !entry.ok).length, unit: 'checks' },
    },
  };
}

function buildReport(ids: readonly string[] = EXPECTED_CELL_IDS): EvidenceReport {
  const cells = ids.map(buildCell);
  return {
    schemaVersion: 1,
    reportKind: 'runtime',
    sourceSha,
    runId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    expectedCellIds: [...ids],
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

describe('the conformance matrix', () => {
  test('runs only on a host the contract supports', () => {
    expect(['darwin', 'linux']).toContain(process.platform);
    expect(['x64', 'arm64']).toContain(process.arch);
  });

  test('covers every case the issue lists, on both paths and in both modes', () => {
    const covered = EXPECTED_CELL_IDS.join(' ');
    for (const required of REQUIRED_CELL_NAMES) {
      expect(covered, required).toContain(required);
    }
    for (const path of TRANSPORT_PATHS) {
      for (const mode of PROCESS_MODES) {
        expect(covered).toContain(`:behavior:${path}:${mode}:output-bytes`);
        for (const id of [...REQUIRED_CORPUS_FIXTURE_IDS, ...SUPPLEMENTARY_CORPUS_FIXTURE_IDS]) {
          expect(covered, id).toContain(`:corpus:${path}:${mode}:corpus-${id}`);
        }
      }
    }
  });

  test('labels a script-backed cell as scripted, never as a pipe or a PTY', () => {
    for (const name of [
      'lost-acknowledgement',
      'fifo-full-keeps-control-capacity',
      'default-operation-capacity',
      'input-over-budget',
      'control-unknown-cleanup',
      'control-incomplete-cleanup',
      'control-missing-parse-completion',
      'control-late-callback-after-close',
      'control-revoked-input-during-paste',
      'control-leak-detectors',
      'owned-source-release',
      'hanging-cancellation',
      'output-overflow',
    ]) {
      const ids = EXPECTED_CELL_IDS.filter((id) => id.endsWith(`:${name}`));
      expect(ids.length, name).toBeGreaterThan(0);
      for (const id of ids) expect(id, id).toMatch(/:scripted:/);
    }
  });

  test('records which combinations a narrower case covers, and why', () => {
    const report = buildReport();
    const notes = (name: string) =>
      report.cells
        .filter((cell) => cell.id.includes(`:${name}`) && !cell.id.includes(':parity:'))
        .flatMap((cell) => cell.observations.filter((line) => line.startsWith('scope: ')));
    expect(notes('exit-before-attach').join()).toContain('direct path only');
    expect(notes('output-after-exit-before-eof').join()).toContain('pipe only');
    expect(notes('eof-without-exit').join()).toContain('pipe only');
    expect(notes('lost-acknowledgement').join()).toContain('scripted backend');
  });

  test('runs the controls before any other cell', () => {
    const order = EXPECTED_CELL_IDS.map((id) => id.split(':')[1]);
    expect(order[0]).toBe('control');
    expect(order.lastIndexOf('control')).toBeLessThan(order.indexOf('behavior'));
  });
});

describe('the conformance evidence report', () => {
  test('writes test-results/conformance.json covering every cell, controls first', () => {
    const report = buildReport();
    mkdirSync(join(packageRoot, 'test-results'), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const written = JSON.parse(readFileSync(reportPath, 'utf8')) as EvidenceReport;
    expect(structuralErrors(written)).toEqual([]);
    expect(validateEvidence(written, 'runtime')).toEqual([]);
    expect(written.cells.map((cell) => cell.id)).toEqual(EXPECTED_CELL_IDS);
    // The controls are read first: if one failed, nothing below it can be interpreted.
    const controls = written.cells.filter((cell) => cell.id.split(':')[1] === 'control');
    for (const cell of controls) {
      expect(cell.passed, `control ${cell.id}: ${cell.observations.join(' | ')}`).toBe(true);
    }
    for (const cell of written.cells) {
      expect(cell.passed, `${cell.id}: ${cell.observations.join(' | ')}`).toBe(true);
    }
    expect(written.passed).toBe(true);
  });

  test('records the versions and the host cell it ran on', () => {
    for (const cell of buildReport().cells) {
      expect(cell.id.startsWith(`${HOST_CELL}:`), cell.id).toBe(true);
      expect(Object.keys(cell.versions).toSorted(), cell.id).toEqual(['bun', 'kernel', 'platform']);
      expect(cell.metrics['checksEvaluated']?.value, cell.id).toBeGreaterThan(0);
    }
  });

  test('fails when a required cell is missing, duplicated or unexpected', () => {
    const report = buildReport();
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

  test('records a cell as failed when a check did not hold, and the report as failed', () => {
    const id = EXPECTED_CELL_IDS[0] as string;
    const original = results.get(id) as CellResult;
    results.set(id, { checks: [...original.checks, check('impossible', false)], signature: [] });
    try {
      const report = buildReport();
      expect(report.cells[0]?.passed).toBe(false);
      expect(report.cells[0]?.observations).toContain('FAIL: impossible');
      expect(report.passed).toBe(false);
      // The report is internally consistent even though it failed: a failure is evidence too.
      expect(validateEvidence(report, 'runtime')).toEqual([]);
    } finally {
      results.set(id, original);
    }
  });

  test('records a cell that never ran as failed, never as passing', () => {
    const report = buildReport([...EXPECTED_CELL_IDS, 'never-ran']);
    const cell = report.cells.at(-1) as EvidenceCell;
    expect(cell.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  test('records a wrong runtime version as invalid evidence', () => {
    const report = buildReport();
    const first = report.cells[0] as EvidenceCell;
    const wrong = {
      ...report,
      cells: [
        { ...first, versions: { ...first.versions, bun: '0.0.0' } },
        ...report.cells.slice(1),
      ],
    };
    expect(validateEvidence(wrong, 'runtime')).toContain('runtime bun version');
  });
});
