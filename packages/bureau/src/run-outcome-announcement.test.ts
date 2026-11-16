import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import type { CatalogRunRecoveryLoad } from './catalog-run-recovery-record';
import type { CatalogRunSettlement } from './catalog-run-settlement';
import { createCatalogTaskSettler } from './catalog-task-settlement';
import { RunFailedOutcomeEvent } from './events';
import { announceRunOutcome, type RunOutcomeAnnouncement } from './run-outcome-announcement';
import { createRunOutcomeDetails } from './run-outcome-details';
import { createTaskRegistry, type TaskRecord, type TaskSettlement } from './task-registry';

function announcer() {
  const details = createRunOutcomeDetails();
  const sent: Array<{ type: string } & Record<string, unknown>> = [];
  const target: RunOutcomeAnnouncement = {
    details,
    dispatch: (event) => {
      sent.push(event as never);
    },
  };
  return {
    details,
    sent,
    announce: (record: Pick<TaskRecord, 'taskId' | 'settled'>) =>
      announceRunOutcome(record, target),
  };
}

function settled(overrides: Partial<TaskSettlement> = {}): TaskSettlement {
  return {
    at: '2026-11-15T00:00:00.000Z',
    status: 'completed',
    finishReason: 'stop-condition',
    message: null,
    ...overrides,
  };
}

describe('announceRunOutcome (COR-2095)', () => {
  it.each([
    ['completed', 'run.completed'],
    ['failed', 'run.error'],
    ['canceled', 'run.aborted'],
  ] as const)(
    'announces one outcome for a %s task, then run.settled with its status',
    (status, outcome) => {
      const { sent, announce } = announcer();

      announce({ taskId: 'run-1', settled: settled({ status, finishReason: 'x' }) });

      expect(sent.map((event) => event.type)).toEqual([outcome, 'run.settled']);
      expect(sent[1]).toMatchObject({ runId: 'run-1', status, finishReason: 'x' });
    },
  );

  it('gives a failure with no finish reason the finish reason error, and leaves run.settled’s out', () => {
    const { sent, announce } = announcer();

    announce({ taskId: 'run-1', settled: settled({ status: 'failed', finishReason: null }) });

    expect(sent[0]).toMatchObject({ type: 'run.error', finishReason: 'error' });
    expect(sent[1]?.['finishReason']).toBeUndefined();
  });

  it('puts what the live RunErrorEvent said on run.error, once', () => {
    const { sent, details, announce } = announcer();
    details.record('run-1', { step: 4, error: { code: 'TRIPWIRE', kind: 'policy' } });

    announce({
      taskId: 'run-1',
      settled: settled({ status: 'failed', finishReason: 'tripwire', message: 'x' }),
    });

    const failure = sent[0] as unknown as RunFailedOutcomeEvent;
    expect(failure).toBeInstanceOf(RunFailedOutcomeEvent);
    expect(failure).toMatchObject({ step: 4, errorCode: 'TRIPWIRE', errorKind: 'policy' });
    expect(details.size()).toBe(0);
  });

  it('carries no message, whatever the settlement holds', () => {
    const { sent, announce } = announcer();

    announce({
      taskId: 'run-1',
      settled: settled({
        status: 'failed',
        finishReason: 'error',
        message: 'token=abc the provider said something',
      }),
    });

    expect(sent[0]).not.toHaveProperty('message');
    expect(JSON.stringify(sent[0])).not.toContain('abc');
  });

  it('publishes a code that is not an identifier as UNKNOWN, and a kind that is not an enum member not at all', () => {
    const { sent, details, announce } = announcer();
    details.record('run-1', {
      step: 1,
      error: { code: 'rate limited, try later', kind: 'a free-text kind' },
    });

    announce({ taskId: 'run-1', settled: settled({ status: 'failed', finishReason: 'error' }) });

    expect(sent[0]).toMatchObject({ errorCode: 'UNKNOWN' });
    expect((sent[0] as unknown as RunFailedOutcomeEvent).errorKind).toBeUndefined();
  });

  it('takes the detail of a run that did not fail, so no entry outlives its announcement', () => {
    const { details, announce } = announcer();
    details.record('run-1', { step: 1, error: { code: 'E', kind: 'k' } });

    announce({ taskId: 'run-1', settled: settled() });

    expect(details.size()).toBe(0);
  });

  it('announces nothing for a record that is not settled', () => {
    const { sent, announce } = announcer();

    announce({ taskId: 'run-1', settled: undefined });

    expect(sent).toEqual([]);
  });
});

describe('a recovered subordinate run with no task record (COR-2095)', () => {
  const settlement: CatalogRunSettlement = {
    runId: 'agent-run-1',
    agentName: 'asker',
    status: 'completed',
    finishReason: 'stop-condition',
    message: null,
    content: 'the answer',
    recovered: true,
  };
  const claim: CatalogRunRecoveryLoad = {
    status: 'found',
    record: {
      schemaVersion: 1,
      agentName: 'asker',
      definitionRevision: 0,
      input: 'which environment?',
      principal: 'api-key:alice',
      taskOrigin: { kind: 'agent', parentRunId: 'run-p', agentName: 'planner' },
    },
  };

  it('is admitted, settled and announced once: one outcome kind, then run.settled', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const { sent, announce } = announcer();
    const registry = createTaskRegistry({
      kv: textValueStore(new MemoryStorage()),
      clock: runtime.clock,
      identifiers: runtime.identifiers,
      onSettled: async (record) => announce(record),
      host: {
        liveTask: () => undefined,
        liveTasksOfContexts: () => new Map(),
        pendingReviews: () => [],
        currentIncarnation: async () => undefined,
        abort: () => 'not-found',
        cancelChild: async () => 'not-found',
        cancelDurable: async () => ({ status: 'already-terminal' }),
        sleep: async () => undefined,
      },
      diagnose: () => undefined,
    });
    const settler = createCatalogTaskSettler({
      tasks: registry,
      loadRecoveryRecord: async () => claim,
      durableCreatedAt: async () => '2026-10-17T12:00:00.000Z',
      isChildRun: async () => false,
      now: runtime.clock.nowISO,
      ownerOf: (principal) => principal ?? 'anonymous:local',
      originatingMessage: (input) => (typeof input === 'string' ? input : undefined),
    });

    await settler(settlement);
    await settler(settlement);
    await registry.flush();

    expect(sent.map((event) => event.type)).toEqual(['run.completed', 'run.settled']);
    expect(sent[0]).toMatchObject({ runId: 'agent-run-1', finishReason: 'stop-condition' });
  });
});
