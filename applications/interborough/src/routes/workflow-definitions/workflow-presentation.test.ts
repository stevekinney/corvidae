/** The words a catalog row carries: its list row, its segments, its steps and its trigger. */
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { joinCatalog } from '../../lib/workflow-catalog.ts';
import {
  codeDefinition,
  invalidFile,
  readyFile,
  sourceDefinition,
} from '../../lib/workflow-world.test-support.ts';
import {
  definitionDetails,
  hasDefinitionDetails,
  hasProblem,
  inSegment,
  internalCells,
  internalWords,
  rowSegment,
  scheduleLabel,
  schedulesSummary,
  schemaOf,
  segmentCounts,
  sortListRows,
  specCadence,
  stepLabel,
  triggerLabel,
  triggerSummary,
  workflowListRow,
} from './workflow-presentation.ts';

function listingOf(file: ReturnType<typeof readyFile>) {
  const { text: _text, schedule: _schedule, ...rest } = file;
  return rest;
}

const ZONE = 'America/Chicago';
const NOW = Date.parse('2026-11-02T10:46:00-06:00');

/** The catalog row of one file, with the engine's source for it when it loaded. */
function fileRow(file: ReturnType<typeof readyFile>) {
  const [row] = joinCatalog([sourceDefinition(file.id)], [listingOf(file)]);
  if (row === undefined) throw new Error(`No row for ${file.id}.`);
  return row;
}

const STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'One.' } },
  { kind: 'sleep', duration: '5m' },
  { kind: 'await-signal', signal: 'approve' },
  { kind: 'sleep', duration: '1m' },
];

const textsOf = (parts: readonly { readonly text: string }[]) => parts.map((part) => part.text);

describe('the segments of the list', () => {
  const rows = joinCatalog(
    [
      codeDefinition('order-processing'),
      codeDefinition('agentRun'),
      sourceDefinition('flaky', {
        state: 'failed',
        lastFailureCategory: 'resource',
        contract: null,
      }),
      sourceDefinition('plain'),
      sourceDefinition('stopped'),
    ],
    [
      listingOf(invalidFile('broken')),
      listingOf(readyFile('flaky', { paused: true })),
      listingOf(readyFile('plain')),
      listingOf(readyFile('stopped', { paused: true })),
    ],
  );
  // The types Interborough runs itself are never rows of the list, so they are never counted.
  const workflows = rows.filter((row) => !row.engine);
  const named = (name: string) => {
    const found = workflows.find((row) => row.name === name);
    if (found === undefined) throw new Error(`No row for ${name}.`);
    return found;
  };

  test('count the rows each shows, from the same rows: a problem is not also paused', () => {
    expect(segmentCounts(workflows)).toEqual({ all: 5, paused: 1, problems: 2 });
    for (const segment of ['all', 'paused', 'problems'] as const) {
      expect(workflows.filter((row) => inSegment(row, segment)).length).toBe(
        segmentCounts(workflows)[segment],
      );
    }
    expect(workflows.filter((row) => inSegment(row, 'paused')).map((row) => row.name)).toEqual([
      'stopped',
    ]);
    expect(workflows.filter((row) => inSegment(row, 'problems')).map((row) => row.name)).toEqual([
      'broken',
      'flaky',
    ]);
  });

  test('leave out the types the engine runs for itself, whatever the catalog holds', () => {
    expect(rows.map((row) => row.name)).toContain('agentRun');
    expect(segmentCounts(workflows).all).toBe(rows.length - 1);
  });

  test('read a source that failed to load, or an invalid file, as a problem and nothing else', () => {
    expect(hasProblem(named('broken'))).toBe(true);
    expect(hasProblem(named('flaky'))).toBe(true);
    expect(hasProblem(named('plain'))).toBe(false);
    expect(rowSegment(named('plain'))).toBeNull();
    expect(rowSegment(named('flaky'))).toBe('problems');
    expect(rowSegment(named('stopped'))).toBe('paused');
  });

  test('list a workflow that cannot load first, and keep the catalog’s order for the rest', () => {
    expect(sortListRows(workflows).map((row) => row.name)).toEqual([
      'broken',
      'flaky',
      'order-processing',
      'plain',
      'stopped',
    ]);
  });
});

describe('a row of the list', () => {
  test('is titled from its file, with the identifier beside it, the day it last ran at the right, and its steps and counts under it', () => {
    const row = fileRow(
      readyFile('release-notes', {
        title: 'Release notes',
        steps: STEPS,
        runs: { active: 0, last24Hours: 1, lastRunAt: '2026-10-30T10:07:00-05:00' },
      }),
    );
    const model = workflowListRow(row, undefined, NOW, ZONE);
    expect(model.name).toBe('release-notes');
    expect(model.title).toBe('Release notes');
    expect(model.statusWord).toBeNull();
    expect(model.date).toBe('Oct 30');
    expect(textsOf(model.line)).toEqual(['4 steps', '1 run in 24 hours']);
  });

  test('shows a file with no title by its identifier alone', () => {
    expect(workflowListRow(fileRow(readyFile('plain')), undefined, NOW, ZONE).title).toBeNull();
    expect(
      workflowListRow(fileRow(readyFile('blank', { title: '   ' })), undefined, NOW, ZONE).title,
    ).toBeNull();
  });

  test('says "Never run" at the right edge, and says nothing of runs under the title', () => {
    const model = workflowListRow(
      fileRow(readyFile('quiet', { steps: STEPS.slice(0, 3) })),
      undefined,
      NOW,
      ZONE,
    );
    expect(model.date).toBe(WORKFLOW_COPY.list.neverRun);
    expect(textsOf(model.line)).toEqual(['3 steps']);
  });

  test('shows the clock for a run today and the day, with the year when it is not this one, for an older run', () => {
    const at = (lastRunAt: string) =>
      workflowListRow(
        fileRow(readyFile('dated', { runs: { active: 0, last24Hours: 0, lastRunAt } })),
        undefined,
        NOW,
        ZONE,
      ).date;
    expect(at('2026-11-02T09:15:00-06:00')).toBe('9:15 AM');
    expect(at('2026-10-24T09:15:00-05:00')).toBe('Oct 24');
    expect(at('2025-12-31T09:15:00-06:00')).toBe('Dec 31, 2025');
  });

  test('says when the run in progress began at the right edge, and leads the line under the title with Running', () => {
    const model = workflowListRow(
      fileRow(
        readyFile('release-notes', {
          steps: STEPS,
          runs: { active: 1, last24Hours: 2, lastRunAt: '2026-11-02T10:45:00-06:00' },
        }),
      ),
      undefined,
      NOW,
      ZONE,
    );
    expect(model.date).toBe('Started 10:45 AM');
    expect(model.line.map((part) => part.status)).toEqual(['Running', undefined, undefined]);
    expect(textsOf(model.line)).toEqual(['Running', '4 steps', '2 runs in 24 hours']);
    // A run does not change the workflow's own status.
    expect(model.statusWord).toBeNull();
  });

  test('has Paused in its status column when its file is paused', () => {
    const model = workflowListRow(
      fileRow(readyFile('triage-inbox', { paused: true, steps: STEPS.slice(0, 3) })),
      undefined,
      NOW,
      ZONE,
    );
    expect(model.statusWord).toBe('Paused');
  });

  test('has Can’t load for a file the Bureau cannot use, with its file and its problem under the identifier and no counts', () => {
    const [row] = joinCatalog([], [listingOf(invalidFile('order-refund'))]);
    if (row === undefined) throw new Error('No row for order-refund.');
    const model = workflowListRow(row, undefined, NOW, ZONE);
    expect(model.statusWord).toBe("Can't load");
    expect(model.title).toBeNull();
    expect(model.date).toBe(WORKFLOW_COPY.list.neverRun);
    expect(textsOf(model.line)).toEqual(['order-refund.json', 'The document is not a workflow.']);
    expect(model.line[1]?.testId).toBe('workflow-problem');
  });

  test('has Can’t load for a source the engine failed to load, and keeps what the file says', () => {
    const [row] = joinCatalog(
      [
        sourceDefinition('flaky', {
          state: 'failed',
          lastFailureCategory: 'resource',
          contract: null,
        }),
      ],
      [listingOf(readyFile('flaky', { steps: STEPS.slice(0, 2), paused: true }))],
    );
    if (row === undefined) throw new Error('No row for flaky.');
    const model = workflowListRow(row, undefined, NOW, ZONE);
    // A failed source is Can't load before it is Paused.
    expect(model.statusWord).toBe("Can't load");
    expect(textsOf(model.line)).toEqual([WORKFLOW_COPY.sourceFailed('resource'), '2 steps']);
  });

  test('leaves a code-defined type’s date and counts blank until the engine says, and blank when it would not', () => {
    const [row] = joinCatalog([codeDefinition('order-processing')], []);
    if (row === undefined) throw new Error('No row for order-processing.');
    const waiting = workflowListRow(row, undefined, NOW, ZONE);
    expect(waiting.date).toBeNull();
    expect(waiting.line).toEqual([]);
    // A count the engine would not give is left out, never shown as zero or as never run.
    const failed = workflowListRow(row, { runs: null, schedules: null }, NOW, ZONE);
    expect(failed.date).toBeNull();
    expect(failed.line).toEqual([]);
    const counted = workflowListRow(
      row,
      {
        runs: { active: 0, last24Hours: 3, lastRunAt: '2026-11-02T08:00:00-06:00' },
        schedules: null,
      },
      NOW,
      ZONE,
    );
    expect(counted.date).toBe('8:00 AM');
    expect(textsOf(counted.line)).toEqual(['3 runs in 24 hours']);
  });

  test('counts one step and one run in the singular', () => {
    const model = workflowListRow(
      fileRow(
        readyFile('single', {
          steps: STEPS.slice(0, 1),
          runs: { active: 0, last24Hours: 1, lastRunAt: '2026-11-02T08:00:00-06:00' },
        }),
      ),
      undefined,
      NOW,
      ZONE,
    );
    expect(textsOf(model.line)).toEqual(['1 step', '1 run in 24 hours']);
  });
});

describe('the internal workflows', () => {
  test('are named in the words Interborough gives the types it knows, and by their identifier in words otherwise', () => {
    expect(internalWords('agentRun', 'Engine words.')).toEqual({
      title: 'Chat with an agent',
      description: WORKFLOW_COPY.internal.types.agentRun.description,
    });
    expect(internalWords('durableHeartbeatTick', null).title).toBe('Schedule tick');
    expect(internalWords('someFutureTick', 'Ticks.')).toEqual({
      title: 'Some Future Tick',
      description: 'Ticks.',
    });
    // A type with no words of either kind has none to show, and the page says so.
    expect(internalWords('someFutureTick', null).description).toBeNull();
    // An inherited property name is not a known type.
    expect(internalWords('constructor', null).description).toBeNull();
  });

  test('say how many runs and when the last began, blank for a read the engine would not give, never zero', () => {
    const iso = (text: string) => new Date(text).toISOString();
    expect(
      internalCells({ runs: 6, lastRunAt: iso('2026-11-02T10:42:00-06:00') }, NOW, ZONE),
    ).toEqual({ runs: '6', lastRun: 'Today, 10:42 AM' });
    expect(
      internalCells({ runs: 8, lastRunAt: iso('2026-10-30T10:07:00-05:00') }, NOW, ZONE),
    ).toEqual({ runs: '8', lastRun: 'Oct 30, 10:07 AM' });
    expect(internalCells({ runs: 0, lastRunAt: null }, NOW, ZONE)).toEqual({
      runs: '0',
      lastRun: WORKFLOW_COPY.internal.neverRun,
    });
    expect(internalCells(null, NOW, ZONE)).toEqual({ runs: null, lastRun: null });
    expect(internalCells(undefined, NOW, ZONE)).toEqual({ runs: null, lastRun: null });
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

describe('a schedule trigger’s spec in words', () => {
  test('reads a duration as an interval, in the units the Bureau accepts', () => {
    expect(specCadence('24h')).toEqual({ intervalMs: 86_400_000 });
    expect(specCadence('1h')).toEqual({ intervalMs: 3_600_000 });
    expect(specCadence('30 seconds')).toEqual({ intervalMs: 30_000 });
    expect(specCadence('5m')).toEqual({ intervalMs: 300_000 });
    expect(specCadence('1.5h')).toEqual({ intervalMs: 5_400_000 });
    expect(specCadence('250ms')).toEqual({ intervalMs: 250 });
    expect(specCadence('2 days')).toEqual({ intervalMs: 172_800_000 });
  });

  test('reads anything else as a cron expression', () => {
    expect(specCadence(' 0 6 * * * ')).toEqual({ cronExpression: '0 6 * * *' });
    expect(specCadence('@daily')).toEqual({ cronExpression: '@daily' });
  });

  test('says the same words the schedules area says', () => {
    expect(triggerSummary({ kind: 'schedule', spec: '1h' })).toEqual({
      kind: 'schedule',
      words: 'Every hour',
    });
    expect(triggerSummary({ kind: 'schedule', spec: '24h' })).toEqual({
      kind: 'schedule',
      words: 'Every day',
    });
    expect(triggerSummary({ kind: 'schedule', spec: '0 6 * * *' })).toEqual({
      kind: 'schedule',
      words: 'Every day at 06:00',
    });
  });

  test('names a signal trigger by its signal, and says nothing for a trigger it cannot read', () => {
    expect(triggerSummary({ kind: 'signal', name: 'deploy' })).toEqual({
      kind: 'signal',
      name: 'deploy',
    });
    expect(triggerSummary({ kind: 'other' })).toBeNull();
    expect(triggerSummary({ kind: 'schedule' })).toBeNull();
    expect(triggerSummary(null)).toBeNull();
  });

  test('says the schedules of a code-defined type: none, one in words, or several by count', () => {
    expect(schedulesSummary(null)).toBeNull();
    expect(schedulesSummary([])).toBeNull();
    expect(schedulesSummary([{ intervalMs: 3_600_000 }])).toEqual({
      kind: 'schedule',
      words: 'Every hour',
    });
    expect(schedulesSummary([{ intervalMs: 3_600_000 }, { cronExpression: '0 6 * * *' }])).toEqual({
      kind: 'schedule',
      words: WORKFLOW_COPY.list.schedules(2),
    });
  });
});

describe('the details of a type', () => {
  test('keep only what the contract declares, so nothing is padded with “None”', () => {
    const bare = definitionDetails(
      codeDefinition('bare', {
        signals: null,
        updates: null,
        queries: null,
        contract: null,
      }),
      [],
    );
    expect(bare).toEqual({ signals: [], updates: [], queries: [] });
    expect(hasDefinitionDetails(bare)).toBe(false);
  });

  test('keep the signals, updates, and queries it declares', () => {
    const full = definitionDetails(codeDefinition('full', { updates: ['bump'] }), ['approve']);
    expect(full.signals).toEqual(['approve']);
    expect(full.updates).toEqual(['bump']);
    expect(full.queries).toEqual(['progress']);
    expect(hasDefinitionDetails(full)).toBe(true);
    expect(
      hasDefinitionDetails(
        definitionDetails(
          codeDefinition('only-signals', {
            signals: null,
            updates: null,
            queries: null,
            contract: null,
          }),
          ['approve'],
        ),
      ),
    ).toBe(true);
  });
});

describe('the schema a workflow is held to', () => {
  const declared = { type: 'object', properties: { id: { type: 'string' } } };

  test('is the file’s own when it declares one, before the engine’s contract', () => {
    expect(schemaOf(declared, codeDefinition('typed'), 'inputSchema')).toBe(declared);
  });

  test('is the engine’s contract when the file declares none', () => {
    expect(schemaOf(null, codeDefinition('typed'), 'inputSchema')).toEqual({
      type: 'object',
      properties: { orderId: { type: 'string' } },
    });
    expect(schemaOf(undefined, codeDefinition('typed'), 'outputSchema')).toEqual({
      type: 'object',
      properties: { shipped: { type: 'boolean' } },
    });
  });

  test('is nothing when neither declares one', () => {
    expect(schemaOf(null, undefined, 'inputSchema')).toBeUndefined();
    expect(
      schemaOf(null, codeDefinition('bare', { contract: null }), 'inputSchema'),
    ).toBeUndefined();
    expect(
      schemaOf(
        null,
        codeDefinition('null-schema', { contract: { inputSchema: null } }),
        'inputSchema',
      ),
    ).toBeUndefined();
  });
});
