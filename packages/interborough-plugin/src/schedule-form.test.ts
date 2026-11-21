/**
 * COR-2545 — the state of a schedule form, shared by the Interborough schedule page and the
 * schedule editor panel: what each field shows of a schedule, what a draft is refused for, the
 * calls a save makes in order, and the field a Bureau fault belongs to.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  emptyScheduleDraft,
  scheduleCreateArguments,
  scheduleDraftErrors,
  scheduleDraftOf,
  scheduleFaultFieldErrors,
  scheduleSavePlan,
  scheduleSpecText,
  scheduleUpdateFields,
  type ScheduleFormSource,
} from './schedule-form.ts';

const agentSchedule: ScheduleFormSource = {
  id: 's1',
  revision: 3,
  status: 'active',
  description: 'Morning summary',
  cronExpression: '0 9 * * *',
  intervalMs: null,
  timeZone: 'America/New_York',
  target: { kind: 'agent', agentName: 'writer' },
};

const intervalSchedule: ScheduleFormSource = {
  ...agentSchedule,
  cronExpression: null,
  intervalMs: 90_000,
  timeZone: 'UTC',
  target: { kind: 'workflow', workflowType: 'kit:echo' },
};

describe('what a draft shows of a schedule', () => {
  it('reads a cron expression as it is and an interval as the largest exact duration', () => {
    expect(scheduleSpecText(agentSchedule)).toBe('0 9 * * *');
    expect(scheduleSpecText({ ...intervalSchedule, intervalMs: 86_400_000 })).toBe('1d');
    expect(scheduleSpecText({ ...intervalSchedule, intervalMs: 7_200_000 })).toBe('2h');
    expect(scheduleSpecText({ ...intervalSchedule, intervalMs: 300_000 })).toBe('5m');
    expect(scheduleSpecText(intervalSchedule)).toBe('90s');
    expect(scheduleSpecText({ ...intervalSchedule, intervalMs: 1_500 })).toBe('1500ms');
  });

  it('starts a draft on the schedule as it is, paused when it is paused', () => {
    expect(scheduleDraftOf({ ...agentSchedule, status: 'paused' })).toEqual({
      spec: '0 9 * * *',
      timeZone: 'America/New_York',
      targetKind: 'agent',
      target: 'writer',
      input: '',
      workflowInput: '',
      description: 'Morning summary',
      paused: true,
    });
  });
});

describe('what a draft is refused for', () => {
  it('asks a new schedule for its cadence, its target and an agent’s text', () => {
    expect(scheduleDraftErrors(emptyScheduleDraft())).toEqual({
      spec: 'Say when it runs: a cron expression, or a duration such as 6h.',
      target: 'Choose an agent.',
      input: 'Say what each run sends the agent.',
    });
  });

  it('asks a workflow for valid JSON input and no text', () => {
    const draft = { ...emptyScheduleDraft(), targetKind: 'workflow' as const, target: 'kit:echo' };
    expect(scheduleDraftErrors({ ...draft, spec: '1h' })).toEqual({});
    expect(scheduleDraftErrors({ ...draft, spec: '1h', workflowInput: '{oops' })).toEqual({
      workflowInput: 'The input must be valid JSON.',
    });
  });

  it('asks no text of a schedule that keeps its agent, since a view never carries the full text', () => {
    const draft = scheduleDraftOf(agentSchedule);
    expect(scheduleDraftErrors(draft, agentSchedule)).toEqual({});
    // A workflow made to run an agent has no text to keep.
    const switched = {
      ...scheduleDraftOf(intervalSchedule),
      targetKind: 'agent' as const,
      target: 'writer',
    };
    expect(scheduleDraftErrors(switched, intervalSchedule).input).toBe(
      'Say what each run sends the agent.',
    );
  });

  it('holds the description to the Bureau’s limit', () => {
    const draft = { ...scheduleDraftOf(agentSchedule), description: 'x'.repeat(2_001) };
    expect(scheduleDraftErrors(draft, agentSchedule).description).toBe(
      'Use at most 2000 characters.',
    );
  });
});

describe('the arguments of a create', () => {
  it('names the cadence, the agent and its text, and a zone and description only when given', () => {
    expect(
      scheduleCreateArguments({
        ...emptyScheduleDraft(),
        spec: ' 6h ',
        target: ' writer ',
        input: 'Say hello',
      }),
    ).toEqual({ spec: '6h', agentName: 'writer', input: 'Say hello' });
    expect(
      scheduleCreateArguments({
        ...emptyScheduleDraft('Europe/Paris'),
        spec: '0 9 * * *',
        target: 'writer',
        input: 'Hi',
        description: ' Daily ',
      }),
    ).toEqual({
      spec: '0 9 * * *',
      agentName: 'writer',
      input: 'Hi',
      description: 'Daily',
      timeZone: 'Europe/Paris',
    });
  });

  it('names a workflow and its parsed JSON input, never an agent’s text', () => {
    expect(
      scheduleCreateArguments({
        ...emptyScheduleDraft(),
        spec: '1h',
        targetKind: 'workflow',
        target: 'kit:echo',
        input: 'ignored',
        workflowInput: '{"team":"core"}',
      }),
    ).toEqual({ spec: '1h', workflowType: 'kit:echo', workflowInput: { team: 'core' } });
  });
});

describe('the calls a save makes', () => {
  it('makes a new schedule with one create, then pauses it when it is to start paused', () => {
    const draft = { ...emptyScheduleDraft(), spec: '1h', target: 'writer', input: 'Hi' };
    expect(scheduleSavePlan(draft).map((call) => call.tool)).toEqual(['bureau.schedules.create']);
    expect(scheduleSavePlan({ ...draft, paused: true }).map((call) => call.tool)).toEqual([
      'bureau.schedules.create',
      'bureau.schedules.pause',
    ]);
  });

  it('makes no call when nothing changed', () => {
    expect(scheduleSavePlan(scheduleDraftOf(agentSchedule), agentSchedule)).toEqual([]);
  });

  it('changes only the pause when only the pause changed, with no update and so no new revision', () => {
    const plan = scheduleSavePlan(
      { ...scheduleDraftOf(agentSchedule), paused: true },
      agentSchedule,
    );
    expect(plan).toEqual([{ tool: 'bureau.schedules.pause', arguments: {} }]);
    const resumed = scheduleSavePlan(
      { ...scheduleDraftOf({ ...agentSchedule, status: 'paused' }), paused: false },
      { ...agentSchedule, status: 'paused' },
    );
    expect(resumed.map((call) => call.tool)).toEqual(['bureau.schedules.resume']);
  });

  it('updates, then pauses, resending the cadence it has when only the target changed', () => {
    const plan = scheduleSavePlan(
      { ...scheduleDraftOf(agentSchedule), target: 'editor', paused: true },
      agentSchedule,
    );
    expect(plan).toEqual([
      {
        tool: 'bureau.schedules.update',
        arguments: { spec: '0 9 * * *', agentName: 'editor' },
      },
      { tool: 'bureau.schedules.pause', arguments: {} },
    ]);
  });

  it('sends the zone and the description only when they changed, and the new cadence as typed', () => {
    const plan = scheduleSavePlan(
      {
        ...scheduleDraftOf(agentSchedule),
        spec: ' 0 10 * * * ',
        timeZone: 'Europe/Paris',
        description: ' Evening ',
      },
      agentSchedule,
    );
    expect(plan).toEqual([
      {
        tool: 'bureau.schedules.update',
        arguments: { spec: '0 10 * * *', timeZone: 'Europe/Paris', description: 'Evening' },
      },
    ]);
  });

  it('moves a workflow to an agent with the agent and its text, and an agent to a workflow with neither', () => {
    const toAgent = scheduleSavePlan(
      {
        ...scheduleDraftOf(intervalSchedule),
        targetKind: 'agent',
        target: 'writer',
        input: 'Hello',
      },
      intervalSchedule,
    );
    expect(toAgent).toEqual([
      {
        tool: 'bureau.schedules.update',
        arguments: { spec: '90s', agentName: 'writer', input: 'Hello' },
      },
    ]);
    const toWorkflow = scheduleSavePlan(
      {
        ...scheduleDraftOf(agentSchedule),
        targetKind: 'workflow',
        target: 'kit:echo',
        input: 'stale text',
      },
      agentSchedule,
    );
    expect(toWorkflow).toEqual([
      {
        tool: 'bureau.schedules.update',
        arguments: { spec: '0 9 * * *', workflowType: 'kit:echo' },
      },
    ]);
  });
});

describe('the update an app form sends', () => {
  it('always sends the cadence, and the rest only where it differs', () => {
    const initial = { spec: '1h', timeZone: 'UTC', description: 'a', overlap: 'skip' as const };
    expect(scheduleUpdateFields(initial, initial)).toEqual({ spec: '1h' });
    expect(
      scheduleUpdateFields(initial, {
        spec: '2h',
        timeZone: 'Europe/Paris',
        description: ' b ',
        overlap: 'allow',
      }),
    ).toEqual({ spec: '2h', timeZone: 'Europe/Paris', description: 'b', overlap: 'allow' });
    // An interval has no zone to change.
    expect(scheduleUpdateFields(initial, { ...initial, timeZone: undefined })).toEqual({
      spec: '1h',
    });
  });
});

describe('the field a Bureau fault belongs to', () => {
  it('reads the first segment of each issue’s path as the argument that caused it', () => {
    expect(
      scheduleFaultFieldErrors({
        issues: [
          { path: ['spec'], message: 'Not a cron expression', code: 'custom' },
          { path: ['agentName'], message: 'No such agent', code: 'custom' },
          { path: ['timeZone'], message: 'Unknown zone', code: 'custom' },
          { path: ['spec'], message: 'a second one is ignored', code: 'custom' },
        ],
      }),
    ).toEqual({
      spec: 'Not a cron expression',
      target: 'No such agent',
      timeZone: 'Unknown zone',
    });
  });

  it('shows no field for an issue about an argument the form does not have, or for no issues', () => {
    expect(scheduleFaultFieldErrors({ issues: [{ path: ['scheduleId'], message: 'x' }] })).toEqual(
      {},
    );
    expect(scheduleFaultFieldErrors({ issues: [{ path: ['constructor'], message: 'x' }] })).toEqual(
      {},
    );
    expect(scheduleFaultFieldErrors({ currentRevision: 4 })).toEqual({});
    expect(scheduleFaultFieldErrors(undefined)).toEqual({});
  });
});

describe('who imports it', () => {
  const root = join(import.meta.dir, '..', '..', '..');
  const specifier = '@lostgradient/interborough-plugin/schedule-form';

  it('is imported by the app’s schedule form state and by the schedule editor panel (COR-2545)', async () => {
    const app = await Bun.file(
      join(
        root,
        'applications/interborough/src/routes/schedules/agent-schedule-form-state.svelte.ts',
      ),
    ).text();
    expect(app).toContain(specifier);
    const panel = await Bun.file(
      join(root, 'plugins/inspectors/src/schedule-editor/app.ts'),
    ).text();
    expect(panel).toContain(specifier);
  });

  it('is the only definition of a schedule form: no file of the inspectors plugin defines its own', async () => {
    const directory = join(root, 'plugins/inspectors/src');
    const offenders: string[] = [];
    for await (const file of new Bun.Glob('**/*.{ts,svelte}').scan(directory)) {
      if (file.endsWith('.test.ts')) continue;
      const source = await Bun.file(join(directory, file)).text();
      // A form state is a class or a type of a draft, or the functions that make a save's calls.
      if (
        /\bclass\s+\w*Schedule\w*Form\w*/i.test(source) ||
        /\b(type|interface)\s+Schedule(Draft|Form\w*)\s*[={<]/.test(source) ||
        /\bfunction\s+(scheduleSavePlan|scheduleDraftErrors|scheduleCreateArguments|scheduleUpdateFields)\b/.test(
          source,
        ) ||
        /schedule-form/i.test(file)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
