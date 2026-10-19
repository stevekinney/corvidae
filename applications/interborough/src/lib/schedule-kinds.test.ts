import { afterEach, describe, expect, test } from 'bun:test';

import type { HttpClient } from '@lostgradient/weft';

import { installBureauStub, StubFault, type BureauStub } from './bureau-stub.test-support.ts';
import { kindOf, loadScheduleOverlay, type ScheduleOverlay } from './schedule-kinds.ts';
import type { WorkflowFileListing } from './workflow-files.ts';

const FILE: WorkflowFileListing = {
  id: 'digest',
  state: 'ready',
  owner: 'anonymous:local',
  hash: 'hash-1',
  agent: 'assistant',
  paused: false,
  version: 'v1',
  problem: null,
};

const overlay = (overrides: Partial<ScheduleOverlay> = {}): ScheduleOverlay => ({
  agents: new Map([['daily', 'assistant']]),
  fileSchedules: new Map([['bureau-workflow-schedule:digest:1', 'digest']]),
  files: new Map([['digest', FILE]]),
  origins: new Map([
    ['order-processing', 'code'],
    ['digest', 'source'],
  ]),
  failed: false,
  ...overrides,
});

/** What the Bureau left unsaid when it did not answer either list. */
const BUREAU_DOWN = { agents: undefined, fileSchedules: undefined, files: undefined, failed: true };

describe('the kind of a schedule', () => {
  test('is of no known kind until the Bureau has said', () => {
    expect(kindOf({ id: 'a', workflowType: 'order-processing' }, undefined)).toEqual({
      kind: 'unknown',
    });
  });

  test('is an agent run when it starts agentRun, named when the Bureau names its agent', () => {
    expect(kindOf({ id: 'daily', workflowType: 'agentRun' }, overlay())).toEqual({
      kind: 'agent-run',
      agentName: 'assistant',
    });
    expect(kindOf({ id: 'hidden', workflowType: 'agentRun' }, overlay())).toEqual({
      kind: 'agent-run',
      agentName: null,
    });
  });

  test('is a workflow file’s only when the Bureau listed its id as one that runs no agent', () => {
    expect(
      kindOf({ id: 'bureau-workflow-schedule:digest:1', workflowType: 'digest' }, overlay()),
    ).toEqual({ kind: 'workflow-file', file: FILE });
  });

  test('is the engine’s when it starts a file’s type under another id, and the Bureau listed the file’s own', () => {
    expect(kindOf({ id: 'digest-every-hour', workflowType: 'digest' }, overlay())).toEqual({
      kind: 'code',
    });
  });

  test('is of no known kind when it starts a file’s type under another id, and the Bureau listed no schedule of the file’s', () => {
    expect(
      kindOf(
        { id: 'digest-every-hour', workflowType: 'digest' },
        overlay({ fileSchedules: new Map() }),
      ),
    ).toEqual({ kind: 'unknown' });
  });

  test('is still the engine’s for a type it holds as code when the Bureau answered neither list, so its writes do not wait on the Bureau', () => {
    expect(
      kindOf({ id: 'every-5', workflowType: 'order-processing' }, overlay(BUREAU_DOWN)),
    ).toEqual({
      kind: 'code',
    });
  });

  test('is of no known kind for a type the engine holds as a source when the Bureau answered neither list, because a source may be a file', () => {
    expect(
      kindOf(
        { id: 'bureau-workflow-schedule:digest:1', workflowType: 'digest' },
        overlay(BUREAU_DOWN),
      ),
    ).toEqual({ kind: 'unknown' });
    expect(kindOf({ id: 'x', workflowType: 'never-heard-of' }, overlay(BUREAU_DOWN))).toEqual({
      kind: 'unknown',
    });
  });

  test('is a file’s type with no known schedule, and so of no known kind, when only the Bureau’s schedules did not answer', () => {
    const partial = overlay({ agents: undefined, fileSchedules: undefined, failed: true });
    expect(
      kindOf({ id: 'bureau-workflow-schedule:digest:1', workflowType: 'digest' }, partial),
    ).toEqual({
      kind: 'unknown',
    });
    expect(kindOf({ id: 'every-5', workflowType: 'order-processing' }, partial)).toEqual({
      kind: 'code',
    });
    expect(kindOf({ id: 'daily', workflowType: 'agentRun' }, partial)).toEqual({
      kind: 'agent-run',
      agentName: null,
    });
  });

  test('is the engine’s for any other type', () => {
    expect(kindOf({ id: 'every-5', workflowType: 'order-processing' }, overlay())).toEqual({
      kind: 'code',
    });
  });
});

/** The engine, which holds one type as code and one as a source. */
const engine = {
  operations: {
    'weft.workflows.definitions.list': async () => ({
      definitions: [
        { name: 'order-processing', origin: 'code' },
        { name: 'digest', origin: 'source' },
      ],
      nextOffset: undefined,
    }),
  },
} as unknown as HttpClient;

describe('what the Bureau knows of the schedules', () => {
  let stub: BureauStub | undefined;
  afterEach(() => {
    stub?.restore();
    stub = undefined;
  });

  test('separates the schedules that run an agent from those that run none, by id', async () => {
    const view = (id: string, workflowType: string, agentName: string | null) => ({
      id,
      owner: 'anonymous:local',
      agentName,
      workflowType,
      description: null,
      cronExpression: '0 9 * * *',
      intervalMs: null,
      status: 'active',
      overlap: 'skip',
      revision: 1,
      nextFireAt: null,
      lastFireAt: null,
      missedFireCount: 0,
      skippedCount: 0,
      createdAt: '2026-10-19T08:00:00.000Z',
      updatedAt: '2026-10-19T08:00:00.000Z',
    });
    stub = installBureauStub({
      'bureau.schedules.list': () => ({
        schedules: [
          view('daily', 'agentRun', 'assistant'),
          view('bureau-workflow-schedule:digest:1', 'digest', null),
        ],
        nextOffset: null,
      }),
      'bureau.workflows.list': () => ({ workflows: [FILE], nextOffset: null }),
    });

    const loaded = await loadScheduleOverlay(engine);

    expect([...(loaded.agents ?? [])]).toEqual([['daily', 'assistant']]);
    expect([...(loaded.fileSchedules ?? [])]).toEqual([
      ['bureau-workflow-schedule:digest:1', 'digest'],
    ]);
    expect([...(loaded.files?.keys() ?? [])]).toEqual(['digest']);
    expect(loaded.failed).toBe(false);
    // The engine is asked how it holds its types only when the Bureau's files did not answer.
    expect(loaded.origins).toBeUndefined();
  });

  test('reads how the engine holds each type when the Bureau’s files did not answer', async () => {
    stub = installBureauStub({
      'bureau.schedules.list': () => ({ schedules: [], nextOffset: null }),
      'bureau.workflows.list': () => {
        throw new StubFault('Unavailable', 503, 'Down.');
      },
    });

    const loaded = await loadScheduleOverlay(engine);

    expect(loaded.files).toBeUndefined();
    expect([...(loaded.origins ?? [])]).toEqual([
      ['order-processing', 'code'],
      ['digest', 'source'],
    ]);
    expect(loaded.failed).toBe(true);
  });

  test('keeps what answered when a list did not, and says the Bureau failed', async () => {
    stub = installBureauStub({
      'bureau.schedules.list': () => {
        throw new StubFault('Unavailable', 503, 'Down.');
      },
      'bureau.workflows.list': () => ({ workflows: [FILE], nextOffset: null }),
    });

    const loaded = await loadScheduleOverlay(engine);

    expect(loaded.agents).toBeUndefined();
    expect(loaded.fileSchedules).toBeUndefined();
    expect([...(loaded.files?.keys() ?? [])]).toEqual(['digest']);
    expect(loaded.failed).toBe(true);
  });
});
