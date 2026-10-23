import { describe, expect, it } from 'bun:test';

import { buildInspectorModel, foldEvents, isStaleInspection, type Inspection } from './model.ts';

function inspection(overrides: Partial<Inspection> = {}): Inspection {
  return {
    schemaVersion: 'bureau.task-inspection.v1',
    taskId: 'run-1',
    canCancel: true,
    task: {
      id: 'run-1',
      agentName: 'worker',
      owner: 'o',
      status: 'working',
      finishReason: null,
      statusMessage: null,
      createdAt: 'a',
      updatedAt: 'b',
      cleanup: null,
      openWaits: [],
    },
    liveness: {
      status: 'running',
      assessment: 'healthy',
      reachability: 'reachable',
      progress: 'progressing',
      revision: 3,
      cancellable: true,
      evidence: [
        { source: 'transport-keepalive', at: 1 },
        { source: 'tool-progress', at: 2 },
        { source: 'task-attempt-heartbeat', at: 3 },
      ],
    },
    children: [{ runId: 'c1', agentName: 'child', status: 'running', assessment: 'healthy' }],
    ...overrides,
  };
}

describe('the run inspector model', () => {
  it('keeps transport heartbeat out of progress evidence', () => {
    const model = buildInspectorModel(inspection(), []);
    expect(model.progressEvidence.map((entry) => entry.source)).toEqual(['tool-progress']);
    expect(model.livenessSignals.map((entry) => entry.source)).toEqual([
      'transport-keepalive',
      'task-attempt-heartbeat',
    ]);
  });

  it('states an unobserved run rather than inventing a liveness', () => {
    const model = buildInspectorModel(inspection({ liveness: null }), []);
    expect(model.liveness.available).toBe(false);
    expect(model.liveness.assessment).toBe('not observed by this process');
    expect(model.abort.available).toBe(false);
  });

  it('reports a declared wait, or the open waits when none is declared', () => {
    const declared = inspection();
    const withWait = {
      ...declared,
      liveness: {
        ...declared.liveness!,
        declaredWait: { reason: 'review', wakeCondition: 'a reviewer resolves it' },
      },
    };
    expect(buildInspectorModel(withWait, []).liveness.wait).toBe('review: a reviewer resolves it');
    const open = inspection({
      task: { ...declared.task, openWaits: [{ kind: 'tool-approval', reviewId: 'r' }] },
    });
    expect(buildInspectorModel(open, []).liveness.wait).toBe('waiting on 1 tool-approval');
  });

  it('folds the answer, a gap, and a removal out of the event stream', () => {
    expect(
      foldEvents([
        { kind: 'task.status', artifact: { text: 'done', truncated: true } },
        { kind: 'task.gap', requestedCursor: '1', firstRetainedCursor: '9' },
      ]),
    ).toEqual({
      stream: { kind: 'gap', requestedCursor: '1', firstRetainedCursor: '9' },
      result: { text: 'done', truncated: true },
    });
    expect(foldEvents([{ kind: 'task.removed' }]).stream).toEqual({ kind: 'removed' });
  });

  it('follows cleanup acknowledgement after an abort', () => {
    const base = inspection();
    const cleaning = inspection({
      task: { ...base.task, status: 'canceled', cleanup: 'cleanup-pending' },
    });
    expect(buildInspectorModel(cleaning, []).abort).toMatchObject({
      state: 'cleaning-up',
      available: false,
    });
    const cleaned = inspection({
      task: { ...base.task, status: 'canceled', cleanup: 'cleaned-up' },
    });
    expect(buildInspectorModel(cleaned, []).abort.state).toBe('cleaned-up');
  });

  it('treats a snapshot with a lower liveness revision as stale', () => {
    const newer = inspection();
    const older = inspection({ liveness: { ...newer.liveness!, revision: 1 } });
    expect(isStaleInspection(newer, older)).toBe(true);
    expect(isStaleInspection(older, newer)).toBe(false);
    expect(isStaleInspection(undefined, older)).toBe(false);
    expect(isStaleInspection(newer, inspection({ liveness: null }))).toBe(false);
  });

  it('offers no abort to a caller who may not cancel, or when the host cannot be called', () => {
    expect(buildInspectorModel(inspection({ canCancel: false }), []).abort.available).toBe(false);
    expect(buildInspectorModel(inspection(), [], false).abort.available).toBe(false);
    expect(buildInspectorModel(inspection(), []).abort.available).toBe(true);
  });
});
