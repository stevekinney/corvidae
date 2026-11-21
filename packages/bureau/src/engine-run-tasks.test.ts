/**
 * COR-2531 — the engine's own runs, listed as tasks, carry why a failed one failed (the engine's
 * `failedStep` and error code) and the activity a running one is retrying, and a listing hands the
 * `failedStep` and `retrying` filters to the engine's own list.
 */
import type { WorkflowState, WorkflowSummary } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createEngineRunTasks, type EngineRunTaskEngine } from './engine-run-tasks';

const NOW = Date.UTC(2026, 10, 21, 12);

function summary(change: Partial<WorkflowSummary> & Pick<WorkflowSummary, 'id'>): WorkflowSummary {
  return {
    type: 'release-notes',
    status: 'running',
    version: '1',
    createdAt: NOW,
    updatedAt: NOW,
    ...change,
  };
}

function stateOf(run: WorkflowSummary, change: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: run.id,
    type: run.type,
    status: run.status,
    input: null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    versionTuple: { workflowVersion: '1' },
    ...change,
  } as WorkflowState;
}

/** The engine's runs as `list` answers them, and the filters each list asked with. */
function fakeEngine(
  runs: readonly WorkflowSummary[],
  states: Record<string, Partial<WorkflowState>>,
) {
  const asked: unknown[] = [];
  const engine: EngineRunTaskEngine = {
    list: async (filter?: { type?: string }) => {
      asked.push(filter);
      return { items: runs.filter((run) => run.type === filter?.type), nextCursor: undefined };
    },
    get: async (id: string) => {
      const run = runs.find((candidate) => candidate.id === id);
      return run === undefined ? null : stateOf(run, states[id]);
    },
    getEvents: async () => [],
    getScheduleProvenance: async () => null,
  } as unknown as EngineRunTaskEngine;
  return { engine, asked };
}

function tasksOf(engine: EngineRunTaskEngine) {
  return createEngineRunTasks({
    engine: () => engine,
    workflowTypes: async () => ['release-notes'],
    revisionSteps: async () => undefined,
    ownerOfInstance: async () => 'api-key:alice',
    ownerOfSchedule: async () => undefined,
    deploymentOwner: () => 'owner',
    diagnose: () => undefined,
  });
}

describe('the engine’s runs as tasks (COR-2531)', () => {
  it('shows a failed run’s step and error code from the engine, and no tool call or kind', async () => {
    const failed = summary({ id: 'failed-run', status: 'failed' });
    const { engine } = fakeEngine([failed], {
      'failed-run': {
        error: 'the card network refused the charge',
        errorCode: 'WorkflowTimeoutError',
        failedStep: { index: 3, label: 'charge-card' },
      },
    });

    const [view] = await tasksOf(engine).list();
    expect(view?.status).toBe('failed');
    expect(view?.failure).toEqual({
      step: { index: 3, label: 'charge-card' },
      errorCode: 'WorkflowTimeoutError',
      errorKind: null,
      toolCall: null,
    });
    expect(view?.retrying).toBeNull();
  });

  it('shows only a code that is a member of the engine’s own list, never text set as one', async () => {
    const failed = summary({ id: 'failed-run', status: 'failed' });
    const { engine } = fakeEngine([failed], {
      'failed-run': {
        errorCode: 'card 4111 refused' as never,
        failedStep: { index: 0, label: 'charge-card' },
      },
    });

    const [view] = await tasksOf(engine).list();
    expect(view?.failure).toEqual({
      step: { index: 0, label: 'charge-card' },
      errorCode: null,
      errorKind: null,
      toolCall: null,
    });
  });

  it('shows no failure for a failed run the engine recorded nothing for, or for a run that did not fail', async () => {
    const old = summary({ id: 'old-failure', status: 'failed' });
    const finished = summary({ id: 'finished', status: 'completed' });
    const { engine } = fakeEngine([old, finished], {});

    const views = await tasksOf(engine).list();
    expect(views.map((view) => [view.id, view.failure]).toSorted()).toEqual([
      ['finished', null],
      ['old-failure', null],
    ]);
  });

  it('shows the activity a running run is retrying, and only while it runs', async () => {
    const retrying = summary({
      id: 'retrying-run',
      retrying: { activity: 'charge-card', attempt: 3 },
    });
    const ended = summary({
      id: 'ended-run',
      status: 'failed',
      retrying: { activity: 'charge-card', attempt: 2 },
    });
    const { engine } = fakeEngine([retrying, ended], {});

    const views = await tasksOf(engine).list();
    const byId = new Map(views.map((view) => [view.id, view]));
    expect(byId.get('retrying-run')?.retrying).toEqual({ label: 'charge-card', attempt: 3 });
    expect(byId.get('ended-run')?.retrying).toBeNull();
  });

  it('hands the failedStep and retrying filters to the engine’s list, and only those it was given', async () => {
    const { engine, asked } = fakeEngine([], {});
    const tasks = tasksOf(engine);

    await tasks.list();
    await tasks.list({ failedStep: 'charge-card', retrying: false });
    await tasks.list({ retrying: true });

    const releaseNotes = asked.filter(
      (filter) => (filter as { type?: string }).type === 'release-notes',
    );
    expect(releaseNotes).toEqual([
      { type: 'release-notes', limit: 100 },
      { type: 'release-notes', limit: 100, failedStep: 'charge-card', retrying: false },
      { type: 'release-notes', limit: 100, retrying: true },
    ]);
  });
});
