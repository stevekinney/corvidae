/**
 * What a row of the Schedules list says, from what the engine and the Bureau say of a schedule:
 * the status word, the next run, line two kind first with a reason straight after the kind, a
 * phone's third line, and the order the rows are listed in. The sample world's four schedules and
 * the one outside it (a deleted workflow) are each a case.
 */
import { describe, expect, test } from 'bun:test';

import type { ScheduleSummary } from '@lostgradient/weft';

import type { ScheduleAttention } from '../../lib/bureau-attention.ts';
import type { AgentSummary } from '../../lib/bureau-client.ts';
import type { ScheduleOverlay } from '../../lib/schedule-kinds.ts';
import type { WorkflowFileListing } from '../../lib/workflow-files.ts';
import { browserTimeZone } from './cadence.ts';
import {
  agentsOfSteps,
  scheduleRowOf,
  sortScheduleRows,
  typesNeedingSavedSteps,
  type RowSegment,
  type ScheduleRow,
  type ScheduleRowContext,
} from './schedule-row-model.ts';

/** Monday, Nov 2, 2026, 10:46 in the viewer's zone. */
const NOW = Date.parse('2026-11-02T16:46:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = browserTimeZone();

function schedule(
  overrides: Partial<ScheduleSummary> & Pick<ScheduleSummary, 'id'>,
): ScheduleSummary {
  return {
    workflowType: 'agentRun',
    status: 'active',
    cronExpression: '0 8 * * *',
    timeZone: ZONE,
    overlap: 'skip',
    revision: 1,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    missedFireCount: 0,
    skippedCount: 0,
    nextFireAt: NOW + DAY,
    queuedRuns: [],
    ...overrides,
  } as ScheduleSummary;
}

function file(id: string, overrides: Partial<WorkflowFileListing> = {}): WorkflowFileListing {
  return {
    id,
    state: 'ready',
    owner: 'anonymous:local',
    hash: 'hash',
    title: null,
    description: null,
    agent: null,
    paused: false,
    inputSchema: null,
    outputSchema: null,
    version: 'v1',
    trigger: { kind: 'schedule', spec: '0 8 * * *' },
    steps: null,
    problem: null,
    runs: null,
    ...overrides,
  };
}

const AGENTS: AgentSummary[] = [
  { name: 'assistant', displayName: 'assistant' },
  { name: 'tool-runner', displayName: 'tool-runner' },
] as AgentSummary[];

function overlay(parts: Partial<ScheduleOverlay> = {}): ScheduleOverlay {
  return {
    agents: new Map(),
    inputs: new Map(),
    statuses: new Map(),
    blockers: new Map(),
    fileSchedules: new Map(),
    files: new Map(),
    origins: undefined,
    failed: false,
    ...parts,
  };
}

function context(parts: Partial<ScheduleRowContext> = {}): ScheduleRowContext {
  return {
    overlay: overlay(),
    agents: AGENTS,
    attention: { missedRuns: new Map(), noProvider: false },
    definitionNames: new Set(['agentRun']),
    modelAgents: new Set(),
    workflowAgents: new Map(),
    now: NOW,
    ...parts,
  };
}

const text = (segments: readonly RowSegment[]): string =>
  segments.map((segment) => segment.map((part) => part.text).join('')).join(' · ');

/** Daily summary: Assistant, every day, four missed runs since Oct 30. */
function dailySummary() {
  const summary = schedule({
    id: 'daily',
    description: 'Daily summary',
    cronExpression: '0 9 * * *',
    timeZone: 'UTC',
    missedFireCount: 4,
    lastFireAt: NOW - 4 * DAY,
  });
  const attention: ScheduleAttention = {
    missedRuns: new Map([['daily', { count: 4, since: NOW - 3 * DAY }]]),
    noProvider: true,
  };
  return { summary, attention, overlay: overlay({ agents: new Map([['daily', 'assistant']]) }) };
}

describe('a schedule that runs an agent', () => {
  test('says Missed runs · 4 in line one, the kind first in line two, and no provider blocker for a scripted agent', () => {
    const { summary, attention, overlay: bureau } = dailySummary();
    const row = scheduleRowOf(summary, context({ overlay: bureau, attention }));
    expect(row.title).toBe('Daily summary');
    expect(row.statusWord).toBe('Missed runs · 4');
    expect(row.statusKey).toBe('missed');
    expect(row.blockers).toEqual([]);
    expect(text(row.lineTwo)).toMatch(
      /^Workflow · Chat with an agent · Assistant · Every day at \d{1,2}:00 (AM|PM)/,
    );
    expect(row.next.text).toMatch(/^Next /);
    expect(row.next.tone).toBeUndefined();
  });

  test('on a phone the third line says what was missed and since when, then the cadence', () => {
    const { summary, attention, overlay: bureau } = dailySummary();
    const row = scheduleRowOf(summary, context({ overlay: bureau, attention }));
    expect(text(row.phoneLineTwo)).toBe('Workflow · Chat with an agent · Assistant');
    expect(text(row.phoneLineThree)).toMatch(/^Missed 4 times since [A-Z][a-z]{2} \d{1,2}$/);
    expect(row.phoneCadence).toMatch(/^every day at /);
  });

  test('names the agent by its display name', () => {
    const { summary, attention, overlay: bureau } = dailySummary();
    const row = scheduleRowOf(
      summary,
      context({
        overlay: bureau,
        attention,
        agents: [{ name: 'assistant', displayName: 'Assistant' } as AgentSummary],
      }),
    );
    expect(text(row.lineTwo)).toContain('· Assistant ·');
  });

  test('without the Bureau’s attention list, the missed runs are what the engine counted since it last fired', () => {
    const { summary } = dailySummary();
    const missedAfterFire = { ...summary, lastMissedFireAt: NOW - DAY };
    const row = scheduleRowOf(
      missedAfterFire,
      context({
        attention: undefined,
        overlay: overlay({ agents: new Map([['daily', 'assistant']]) }),
      }),
    );
    expect(row.statusWord).toBe('Missed runs · 4');
    expect(row.missedSince).toBeUndefined();
    expect(text(row.phoneLineThree)).toBe('Missed 4 times');
    const caughtUp = scheduleRowOf(
      { ...summary, lastMissedFireAt: NOW - 5 * DAY },
      context({
        attention: undefined,
        overlay: overlay({ agents: new Map([['daily', 'assistant']]) }),
      }),
    );
    expect(caughtUp.statusKey).toBe('active');
  });

  test('is blocked by a missing provider only when the agent names a model', () => {
    const { summary, overlay: bureau } = dailySummary();
    const noProvider: ScheduleAttention = { missedRuns: new Map(), noProvider: true };
    const scripted = scheduleRowOf(summary, context({ overlay: bureau, attention: noProvider }));
    expect(scripted.blockers).toEqual([]);
    const model = scheduleRowOf(
      summary,
      context({ overlay: bureau, attention: noProvider, modelAgents: new Set(['assistant']) }),
    );
    expect(model.blockers).toEqual([{ kind: 'provider' }]);
    expect(text(model.lineTwo)).toContain('won’t run until a provider is connected');
    expect(model.next).toMatchObject({ tone: 'warning' });
    expect(model.next.text).toMatch(/^Due .* · won’t start$/);
    const connected = scheduleRowOf(
      summary,
      context({
        overlay: bureau,
        attention: { missedRuns: new Map(), noProvider: false },
        modelAgents: new Set(['assistant']),
      }),
    );
    expect(connected.blockers).toEqual([]);
  });
});

describe('a schedule that is a workflow file’s trigger', () => {
  const release = () => {
    const summary = schedule({
      id: 'bureau-workflow-schedule:release-notes:1',
      description: 'Release notes digest',
      workflowType: 'release-notes',
      cronExpression: '0 11 * * 5',
      lastFireAt: NOW - 3 * DAY,
    });
    const releaseFile = file('release-notes', {
      title: 'Release notes',
      trigger: { kind: 'schedule', spec: '0 11 * * 5', input: { branch: 'main' } },
      steps: [{ handler: 'agent', input: { agent: 'assistant' } }],
    });
    return {
      summary,
      bureau: overlay({
        files: new Map([['release-notes', releaseFile]]),
        fileSchedules: new Map([[summary.id, 'release-notes']]),
      }),
    };
  };

  test('says where it is defined in place of the agent when the file feeds each run a fixed input', () => {
    const { summary, bureau } = release();
    const row = scheduleRowOf(
      summary,
      context({ overlay: bureau, definitionNames: new Set(['release-notes']) }),
    );
    expect(row.kind.kind).toBe('workflow-file');
    expect(text(row.lineTwo)).toMatch(
      /^Workflow · Release notes · Every Friday at .* · From a workflow file$/,
    );
    expect(row.statusWord).toBe('Active');
    // On a phone the file's own words carry the cadence (row 10x): "every Friday", not "Fridays".
    expect(row.phoneCadence).toMatch(/^every Friday at \d{1,2}:00 (AM|PM)$/);
  });

  test('says its cadence as a phone says every other schedule’s when no fixed input is fed', () => {
    const { summary, bureau } = release();
    const noInput = file('release-notes', {
      title: 'Release notes',
      trigger: { kind: 'schedule', spec: '0 11 * * 5' },
      steps: [{ handler: 'agent', input: { agent: 'assistant' } }],
    });
    const row = scheduleRowOf(
      summary,
      context({
        overlay: { ...bureau, files: new Map([['release-notes', noInput]]) },
        definitionNames: new Set(['release-notes']),
      }),
    );
    expect(row.phoneCadence).toMatch(/^Fridays at \d{1,2}:00 (AM|PM)$/);
  });

  test('names the agents its steps run when the file feeds it no input', () => {
    const { summary, bureau } = release();
    const triage = file('release-notes', {
      title: 'Release notes',
      trigger: { kind: 'schedule', spec: '0 11 * * 5' },
      steps: [
        { handler: 'agent', input: { agent: 'assistant' } },
        { handler: 'agent', input: { agent: 'tool-runner' } },
        { handler: 'agent', input: { agent: 'assistant' } },
      ],
    });
    const row = scheduleRowOf(
      summary,
      context({
        overlay: { ...bureau, files: new Map([['release-notes', triage]]) },
        definitionNames: new Set(['release-notes']),
      }),
    );
    expect(text(row.lineTwo)).toContain(
      'Workflow · Release notes · Assistant, Tool runner · Every Friday',
    );
    expect(row.agentIds).toEqual(['assistant', 'tool-runner']);
  });

  test('a paused one says Paused and no next run, an em dash on a phone', () => {
    const { summary, bureau } = release();
    const row = scheduleRowOf(
      { ...summary, status: 'paused' },
      context({
        overlay: { ...bureau, statuses: new Map([[summary.id, 'paused']]) },
        definitionNames: new Set(['release-notes']),
      }),
    );
    expect(row.statusWord).toBe('Paused');
    expect(row.next).toEqual({ text: 'No next run' });
    expect(row.nextPhone).toEqual({ text: '—' });
  });

  test('whose file can’t load stays Active, says so in red straight after the kind, and won’t start', () => {
    const { summary, bureau } = release();
    const broken = file('release-notes', { state: 'invalid', trigger: null });
    const row = scheduleRowOf(
      // The engine holds the schedule paused; the Bureau reads it as the Active schedule it was.
      (({ lastFireAt: _lastFireAt, ...rest }) => ({ ...rest, status: 'paused' as const }))(summary),
      context({
        overlay: {
          ...bureau,
          files: new Map([['release-notes', broken]]),
          statuses: new Map([[summary.id, 'active']]),
          blockers: new Map([[summary.id, { workflow: 'release-notes', message: 'bad' }]]),
        },
        definitionNames: new Set(),
        workflowAgents: new Map([['release-notes', ['tool-runner']]]),
        modelAgents: new Set(['tool-runner']),
        attention: { missedRuns: new Map(), noProvider: true },
      }),
    );
    expect(row.status).toBe('active');
    expect(row.statusWord).toBe('Active');
    expect(row.blockers).toEqual([
      { kind: 'cannot-load', workflowType: 'release-notes', label: 'Release notes' },
    ]);
    // One reason on a desktop row, the file; the provider is the second, on the schedule's page.
    expect(text(row.lineTwo)).toMatch(
      /^Workflow · release-notes can’t load · Tool runner · Every Friday at /,
    );
    expect(row.lineTwo[1]).toEqual([
      { text: 'release-notes', monospace: true },
      { text: ' can’t load', tone: 'danger' },
    ]);
    expect(row.next.tone).toBe('warning');
    // A phone says both reasons on its third line, the workflow first, and the cadence last.
    expect(row.phoneLineThree).toEqual([
      [{ text: 'Release notes can’t load', tone: 'danger' }],
      [{ text: 'won’t run until a provider is connected' }],
    ]);
  });
});

describe('a schedule whose workflow was deleted', () => {
  test('is Can’t find workflow, names the identifier, and has no next run', () => {
    const summary = schedule({
      id: 'cleanup',
      description: 'Weekly cleanup',
      workflowType: 'weekly-cleanup',
      cronExpression: '0 2 * * 0',
      status: 'paused',
      lastFireAt: NOW - 8 * DAY,
    });
    const row = scheduleRowOf(
      summary,
      context({
        overlay: overlay(),
        definitionNames: new Set(['agentRun']),
        workflowAgents: new Map([['weekly-cleanup', ['tool-runner']]]),
      }),
    );
    expect(row.statusWord).toBe("Can't find workflow");
    expect(row.statusKey).toBe('cannot-find');
    expect(row.status).toBe('paused');
    expect(row.lineTwo[1]).toEqual([
      { text: 'weekly-cleanup', monospace: true },
      { text: ' was deleted' },
    ]);
    expect(text(row.lineTwo)).toMatch(
      /^Workflow · weekly-cleanup was deleted · Tool runner · Every Sunday at /,
    );
    expect(row.next).toEqual({ text: 'No next run' });
  });

  test('is not told apart from a workflow the engine has not yet said it holds', () => {
    const summary = schedule({ id: 'x', workflowType: 'weekly-cleanup' });
    const unknown = scheduleRowOf(summary, context({ definitionNames: undefined }));
    expect(unknown.statusKey).toBe('active');
    expect(unknown.blockers).toEqual([]);
  });
});

describe('which workflows need their last saved version to name their agents', () => {
  test('lists the types whose file can’t load or is gone, once each', () => {
    const summaries = [
      schedule({ id: 'a', workflowType: 'order-refund' }),
      schedule({ id: 'b', workflowType: 'order-refund' }),
      schedule({ id: 'c', workflowType: 'weekly-cleanup' }),
      schedule({ id: 'd', workflowType: 'release-notes' }),
      schedule({ id: 'e', workflowType: 'agentRun' }),
    ];
    const types = typesNeedingSavedSteps(summaries, {
      overlay: overlay({
        files: new Map([
          ['order-refund', file('order-refund', { state: 'invalid' })],
          ['release-notes', file('release-notes')],
        ]),
      }),
      definitionNames: new Set(['agentRun', 'release-notes']),
    });
    expect(types).toEqual(['order-refund', 'weekly-cleanup']);
  });

  test('reads the agents of agent steps, in order, once each', () => {
    expect(
      agentsOfSteps([
        { handler: 'agent', input: { agent: 'tool-runner' } },
        { kind: 'await-signal', signal: 'approve' },
        { handler: 'agent', input: { agent: 'assistant' } },
        { handler: 'agent', input: { agent: 'tool-runner' } },
        { handler: 'agent', input: 'not an object' },
        { handler: 'tool', input: { agent: 'ignored' } },
      ]),
    ).toEqual(['tool-runner', 'assistant']);
    expect(agentsOfSteps(null)).toEqual([]);
  });
});

describe('the order of the rows', () => {
  const rowFor = (id: string, overrides: Partial<ScheduleSummary>, missed = false): ScheduleRow =>
    scheduleRowOf(
      schedule({ id, description: id, ...overrides }),
      context({
        attention: {
          missedRuns: missed ? new Map([[id, { count: 2, since: NOW - DAY }]]) : new Map(),
          noProvider: false,
        },
      }),
    );

  test('a schedule that missed runs first, then active ones soonest first, then the paused', () => {
    const rows = [
      rowFor('paused', { status: 'paused' }),
      rowFor('later', { nextFireAt: NOW + 5 * DAY }),
      rowFor('missed', { nextFireAt: NOW + 9 * DAY }, true),
      rowFor('sooner', { nextFireAt: NOW + HOUR }),
    ];
    expect(sortScheduleRows(rows).map((row) => row.id)).toEqual([
      'missed',
      'sooner',
      'later',
      'paused',
    ]);
  });

  test('on a phone the list is a set by name, as the list pattern’s phone frame draws it (row 10v)', () => {
    const rows = [
      rowFor('Weekly refund audit', { nextFireAt: NOW + HOUR }),
      rowFor('Inbox triage', { status: 'paused' }),
      rowFor('Release notes digest', { nextFireAt: NOW + 4 * DAY }),
      rowFor('Daily summary', { nextFireAt: NOW + DAY }, true),
    ];
    expect(sortScheduleRows(rows, { phone: true }).map((row) => row.id)).toEqual([
      'Daily summary',
      'Inbox triage',
      'Release notes digest',
      'Weekly refund audit',
    ]);
    // Wider rows keep the groups: missed, then soonest, then paused.
    expect(sortScheduleRows(rows).map((row) => row.id)).toEqual([
      'Daily summary',
      'Weekly refund audit',
      'Release notes digest',
      'Inbox triage',
    ]);
  });

  test('schedules in the same group sort by name when nothing says which is next', () => {
    const rows = [
      rowFor('beta', { status: 'paused', nextFireAt: null }),
      rowFor('alpha', { status: 'paused', nextFireAt: null }),
    ];
    expect(sortScheduleRows(rows).map((row) => row.id)).toEqual(['alpha', 'beta']);
  });
});

describe('the next run', () => {
  const row = (nextFireAt: number | null) =>
    scheduleRowOf(schedule({ id: 'n', nextFireAt }), context());

  test('names the day with its date, and says today for a run later today', () => {
    expect(row(NOW + 3 * DAY).next.text).toMatch(
      /^Next [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/,
    );
    expect(row(NOW + 2 * 60_000).next.text).toMatch(
      /^Next today \d{1,2}:\d{2} (AM|PM)$|^Next [A-Z]/,
    );
  });

  test('a schedule with nothing coming says there is no next run', () => {
    expect(row(null).next).toEqual({ text: 'No next run' });
  });

  test('on a phone tomorrow is named by its weekday alone and a later day keeps its date (row 10w)', () => {
    expect(row(NOW + DAY).nextPhone.text).toMatch(/^Next Tue \d{1,2}:\d{2} (AM|PM)$/);
    // The same run on a wider row says its calendar day, as the board draws it.
    expect(row(NOW + DAY).next.text).toMatch(/^Next Tue Nov 3, \d{1,2}:\d{2} (AM|PM)$/);
    expect(row(NOW + 4 * DAY).nextPhone.text).toMatch(/^Next Fri Nov 6, \d{1,2}:\d{2} (AM|PM)$/);
    expect(row(NOW + 2 * 60_000).nextPhone.text).toMatch(/^Next today \d{1,2}:\d{2} (AM|PM)$/);
  });
});
