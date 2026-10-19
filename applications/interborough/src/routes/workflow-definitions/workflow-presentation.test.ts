/** The words and badges a catalog row carries: what is badged, and what is left out. */
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { joinCatalog } from '../../lib/workflow-catalog.ts';
import {
  codeDefinition,
  invalidFile,
  readyFile,
  sourceDefinition,
} from '../../lib/workflow-world.test-support.ts';
import { rowBadges, scheduleLabel, stepLabel, triggerLabel } from './workflow-presentation.ts';

function listingOf(file: ReturnType<typeof readyFile>) {
  const { text: _text, schedule: _schedule, ...rest } = file;
  return rest;
}

describe('the badges of a row', () => {
  test('are none for a code-defined type', () => {
    const [row] = joinCatalog([codeDefinition('order-processing')], []);
    expect(row === undefined ? undefined : rowBadges(row)).toEqual([]);
  });

  test('are agent-authored, and the owning agent, for a file that names one', () => {
    const [row] = joinCatalog([sourceDefinition('digest')], [listingOf(readyFile('digest'))]);
    expect(row === undefined ? undefined : rowBadges(row).map((badge) => badge.label)).toEqual([
      WORKFLOW_COPY.agentAuthoredBadge,
      WORKFLOW_COPY.owner('writer'),
    ]);
  });

  test('leave the owning agent out when the file names none', () => {
    const [row] = joinCatalog(
      [sourceDefinition('digest')],
      [listingOf(readyFile('digest', { agent: null }))],
    );
    expect(row === undefined ? undefined : rowBadges(row).map((badge) => badge.label)).toEqual([
      WORKFLOW_COPY.agentAuthoredBadge,
    ]);
  });

  test('add the invalid badge for a file the Bureau cannot use', () => {
    const [row] = joinCatalog([], [listingOf(invalidFile('broken'))]);
    expect(row === undefined ? undefined : rowBadges(row).map((badge) => badge.label)).toEqual([
      WORKFLOW_COPY.agentAuthoredBadge,
      WORKFLOW_COPY.invalidBadge,
    ]);
  });

  test('add the paused badge for a paused file, and the failure for a source that failed', () => {
    const [row] = joinCatalog(
      [
        sourceDefinition('digest', {
          state: 'failed',
          lastFailureCategory: 'resource',
          contract: null,
        }),
      ],
      [listingOf(readyFile('digest', { paused: true }))],
    );
    const labels = row === undefined ? [] : rowBadges(row).map((badge) => badge.label);
    expect(labels).toContain(WORKFLOW_COPY.pausedBadge);
    expect(labels).toContain(WORKFLOW_COPY.sourceFailed('resource'));
  });
});

describe('a step, a trigger, and a schedule in words', () => {
  test('names an agent step by its agent and message', () => {
    expect(
      stepLabel({ kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Hi' } }),
    ).toBe(WORKFLOW_COPY.steps.agent('writer', 'Hi'));
  });

  test('names a sleep, a wait for a signal, and any other activity', () => {
    expect(stepLabel({ kind: 'sleep', duration: '5m' })).toBe(WORKFLOW_COPY.steps.sleep('5m'));
    expect(stepLabel({ kind: 'sleep', duration: 30 })).toBe(WORKFLOW_COPY.steps.sleep('30'));
    expect(stepLabel({ kind: 'await-signal', signal: 'approve' })).toBe(
      WORKFLOW_COPY.steps.awaitSignal('approve'),
    );
    expect(stepLabel({ kind: 'activity', handler: 'other' })).toBe(
      WORKFLOW_COPY.steps.activity('other'),
    );
    expect(stepLabel({ kind: 'mystery' })).toBe(WORKFLOW_COPY.steps.unknown('mystery'));
  });

  test('names a schedule trigger by its spec and overlap, and a signal trigger by its name', () => {
    expect(triggerLabel({ kind: 'schedule', spec: '1h', overlap: 'queue' })).toBe(
      WORKFLOW_COPY.triggers.schedule('1h', 'queue'),
    );
    expect(triggerLabel({ kind: 'schedule', spec: '1h' })).toBe(
      WORKFLOW_COPY.triggers.schedule('1h', null),
    );
    expect(triggerLabel({ kind: 'signal', name: 'begin' })).toBe(
      WORKFLOW_COPY.triggers.signal('begin'),
    );
    expect(triggerLabel({ kind: 'other' })).toBe(WORKFLOW_COPY.triggers.unknown('other'));
  });

  test('names a schedule by its cadence, and an interval by its length', () => {
    expect(scheduleLabel({ cronExpression: '*/5 * * * *' })).toContain('5');
    expect(scheduleLabel({ intervalMs: 3_600_000 })).toBeTruthy();
  });
});
