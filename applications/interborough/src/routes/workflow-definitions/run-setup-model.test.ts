/**
 * The run setup page's decisions outside the page: which workflows can be run from it, which
 * schemas become a form, how a refused input becomes field problems, and the footer's summary.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import type { WorkflowResolution } from '../../lib/workflow-catalog.ts';
import {
  actionOffReason,
  agentNames,
  cadenceSentence,
  firstMissingField,
  formSchemaOf,
  inputIssuesOf,
  inputWordsOf,
  missingRequiredField,
  runsAtLimit,
  runSetupIdentity,
  runSetupTarget,
  runSetupTrigger,
  shortDate,
  stepAgentsOf,
  summaryOf,
  takesNoInput,
} from './run-setup-model.ts';

const OBJECT_SCHEMA = { type: 'object', properties: { topic: { type: 'string' } } };

function code(inputSchema: unknown): WorkflowResolution {
  return {
    kind: 'code',
    definition: { contract: { inputSchema } } as never,
  };
}

function file(
  overrides: { state?: 'ready' | 'invalid'; paused?: boolean; inputSchema?: unknown },
  definitionSchema?: unknown,
): WorkflowResolution {
  return {
    kind: 'agent-authored',
    file: {
      state: overrides.state ?? 'ready',
      paused: overrides.paused ?? false,
      inputSchema: overrides.inputSchema ?? null,
    } as never,
    definition:
      definitionSchema === undefined
        ? undefined
        : ({ contract: { inputSchema: definitionSchema } } as never),
  };
}

describe('runSetupTarget', () => {
  test('lets a code-defined type run, with the schema its contract registered', () => {
    expect(runSetupTarget('order-processing', code(OBJECT_SCHEMA))).toEqual({
      status: 'ready',
      kind: 'code',
      schema: OBJECT_SCHEMA,
    });
  });

  test('lets a ready file that is not paused run, with the schema it declares', () => {
    expect(runSetupTarget('digest', file({ inputSchema: OBJECT_SCHEMA }))).toEqual({
      status: 'ready',
      kind: 'file',
      schema: OBJECT_SCHEMA,
    });
  });

  test('falls back to the engine’s contract for a file that declares none', () => {
    expect(runSetupTarget('digest', file({}, OBJECT_SCHEMA))).toMatchObject({
      status: 'ready',
      schema: OBJECT_SCHEMA,
    });
  });

  test('never lets a type the Bureau registers for itself run', () => {
    expect(runSetupTarget('agentRun', code(null))).toEqual({ status: 'engine' });
  });

  test('refuses an invalid file, and keeps a paused one’s form while saying it is paused', () => {
    expect(runSetupTarget('broken', file({ state: 'invalid' }))).toEqual({ status: 'invalid' });
    expect(runSetupTarget('later', file({ paused: true, inputSchema: OBJECT_SCHEMA }))).toEqual({
      status: 'paused',
      kind: 'file',
      schema: OBJECT_SCHEMA,
    });
  });
});

describe('takesNoInput', () => {
  test('is true only for a file that declares no input schema', () => {
    expect(takesNoInput('file', undefined)).toBe(true);
    expect(takesNoInput('file', OBJECT_SCHEMA)).toBe(false);
    // A type code registered may read an input its contract does not describe.
    expect(takesNoInput('code', undefined)).toBe(false);
  });
});

describe('actionOffReason', () => {
  test('names the action and what it waits for, and says nothing while loading or on', () => {
    expect(actionOffReason('paused', 'Start run')).toBe(
      'Start run is off while the workflow is paused.',
    );
    expect(actionOffReason('provider', 'Start run')).toBe(
      'Start run is off until a provider is connected.',
    );
    expect(actionOffReason('unloaded', 'Start run')).toBe(
      'Start run is off until the input form loads.',
    );
    expect(actionOffReason('invalid', 'Start run')).toBe(
      'Start run is off while the file can’t load.',
    );
    expect(actionOffReason('loading', 'Start run')).toBeNull();
    expect(actionOffReason(undefined, 'Start run')).toBeNull();
  });
});

describe('missingRequiredField', () => {
  const RELEASE = {
    type: 'object',
    properties: { branch: { type: 'string', title: 'Branch' }, since: { type: 'string' } },
    required: ['branch', 'since'],
  };

  test('names the first required field left empty, by its title or its key in words', () => {
    expect(missingRequiredField(RELEASE, { branch: '' })).toBe('Branch');
    expect(missingRequiredField(RELEASE, { branch: '  ' })).toBe('Branch');
    expect(missingRequiredField(RELEASE, undefined)).toBe('Branch');
    expect(missingRequiredField(RELEASE, { branch: 'main' })).toBe('Since');
  });

  test('gives the key a form marks as well as the name a person reads', () => {
    expect(firstMissingField(RELEASE, { branch: '' })).toEqual({ key: 'branch', name: 'Branch' });
    expect(firstMissingField(RELEASE, { branch: 'main' })).toEqual({ key: 'since', name: 'Since' });
    expect(firstMissingField(RELEASE, { branch: 'main', since: 'today' })).toBeUndefined();
  });

  test('says nothing when every required field holds something, or nothing is required', () => {
    expect(missingRequiredField(RELEASE, { branch: 'main', since: '2026-10-23' })).toBeUndefined();
    expect(missingRequiredField(OBJECT_SCHEMA, {})).toBeUndefined();
    expect(missingRequiredField(undefined, {})).toBeUndefined();
  });

  test('never reads a required key the properties only inherit', () => {
    expect(
      missingRequiredField({ type: 'object', properties: {}, required: ['toString'] }, {}),
    ).toBeUndefined();
  });
});

describe('runsAtLimit', () => {
  const running = (groups: { key: string | null; count: number }[], truncated = false) => ({
    groups,
    truncated,
  });

  test('is the cap when the runs going reach it', () => {
    expect(runsAtLimit(4, running([{ key: 'release-notes', count: 4 }]))).toBe(4);
    expect(
      runsAtLimit(
        4,
        running([
          { key: 'a', count: 3 },
          { key: 'b', count: 2 },
        ]),
      ),
    ).toBe(4);
  });

  test('leaves out the types the Bureau runs itself, which never take a slot', () => {
    expect(
      runsAtLimit(
        4,
        running([
          { key: 'release-notes', count: 3 },
          { key: 'agentRun', count: 5 },
        ]),
      ),
    ).toBeUndefined();
  });

  test('says nothing below the cap, or when either number is unknown', () => {
    expect(runsAtLimit(4, running([{ key: 'a', count: 3 }]))).toBeUndefined();
    expect(runsAtLimit(undefined, running([{ key: 'a', count: 9 }]))).toBeUndefined();
    expect(runsAtLimit(0, running([{ key: 'a', count: 9 }]))).toBeUndefined();
    expect(runsAtLimit('4', running([{ key: 'a', count: 9 }]))).toBeUndefined();
    expect(runsAtLimit(4, undefined)).toBeUndefined();
    expect(runsAtLimit(4, running([{ key: 'a', count: 9 }], true))).toBeUndefined();
  });
});

describe('stepAgentsOf and agentNames', () => {
  test('lists the agents the steps run, each once and sorted', () => {
    expect(
      stepAgentsOf([
        { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Write.' } },
        { kind: 'await-signal', signal: 'approve' },
        { kind: 'activity', handler: 'agent', input: { agent: 'tool-runner', message: 'Run.' } },
        { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Again.' } },
        { kind: 'activity', handler: 'shell', input: { agent: 'not-an-agent-step' } },
      ]),
    ).toEqual(['tool-runner', 'writer']);
    expect(stepAgentsOf(null)).toEqual([]);
    expect(stepAgentsOf(undefined)).toEqual([]);
  });

  test('names agents in a sentence', () => {
    expect(agentNames(['tool-runner'])).toBe('Tool runner');
    expect(agentNames(['tool-runner', 'writer'])).toBe('Tool runner and Writer');
    expect(agentNames([])).toBe('');
  });
});

describe('formSchemaOf', () => {
  test('draws a form from an object schema that has fields', () => {
    expect(formSchemaOf(OBJECT_SCHEMA)).toBe(OBJECT_SCHEMA);
  });

  test.each([
    ['no schema', undefined],
    ['null', null],
    ['an object schema with no fields', { type: 'object', properties: {} }],
    ['an object schema that names none', { type: 'object' }],
    ['an array', { type: 'array', items: { type: 'string' } }],
    ['a string', { type: 'string' }],
  ])('enters %s as JSON', (_name, schema) => {
    expect(formSchemaOf(schema)).toBeUndefined();
  });
});

/** A refusal as the Bureau's JSON-RPC answers it: the code is in the envelope's data. */
function refusal(data: Record<string, unknown>): HttpClientError {
  return new HttpClientError(400, 'invalid params', {
    data: { weftCode: 'InvalidParams', ...data },
  });
}

describe('inputIssuesOf', () => {
  test('puts each issue on the field its path names, relative to the input', () => {
    const error = refusal({
      issues: [
        { path: ['input', 'topic'], message: 'Too short.' },
        { path: ['input', 'tags', 1], message: 'Not a string.' },
      ],
    });
    expect(inputIssuesOf(error)).toEqual([
      { path: ['topic'], message: 'Too short.' },
      { path: ['tags', 1], message: 'Not a string.' },
    ]);
  });

  test('reads an issue that is about the input as a whole as the empty path', () => {
    expect(
      inputIssuesOf(refusal({ issues: [{ path: ['input'], message: 'Must be an object.' }] })),
    ).toEqual([{ path: [], message: 'Must be an object.' }]);
  });

  test('keeps a path that is already relative, as the engine answers', () => {
    expect(inputIssuesOf(refusal({ issues: [{ path: ['topic'], message: 'Required.' }] }))).toEqual(
      [{ path: ['topic'], message: 'Required.' }],
    );
  });

  test('reads the engine’s REST refusal, which carries the code on the error itself', () => {
    const error = new HttpClientError(400, 'invalid params', {
      faultCode: 'InvalidParams',
      data: { issues: [{ path: ['topic'], message: 'Required.' }] },
    });
    expect(inputIssuesOf(error)).toEqual([{ path: ['topic'], message: 'Required.' }]);
  });

  test('is null for any other failure', () => {
    expect(inputIssuesOf(new Error('boom'))).toBeNull();
    expect(
      inputIssuesOf(new HttpClientError(404, 'nope', { data: { weftCode: 'NotFound' } })),
    ).toBeNull();
    expect(inputIssuesOf(refusal({}))).toBeNull();
    expect(inputIssuesOf(refusal({ issues: [{ path: ['x'] }, 'text'] }))).toBeNull();
  });
});

const RELEASE_SCHEMA = {
  type: 'object',
  properties: { branch: { type: 'string' }, since: { type: 'string', format: 'date' } },
  required: ['branch'],
};
const DAILY = { cron: '0 9 * * *', timeZone: 'America/Chicago' } as const;

describe('shortDate', () => {
  test('says an ISO date as a month and a day', () => {
    expect(shortDate('2026-10-23')).toBe('Oct 23');
    expect(shortDate('2026-11-02')).toBe('Nov 2');
  });

  test.each(['', 'soon', '2026-13-01', '10/23/2026'])('says nothing of %j', (text) => {
    expect(shortDate(text)).toBeUndefined();
  });
});

describe('inputWordsOf', () => {
  test('reads the branch, and the date the run counts from', () => {
    expect(inputWordsOf(RELEASE_SCHEMA, { branch: 'main', since: '2026-10-23' })).toEqual({
      on: 'on main',
      since: 'since Oct 23',
    });
  });

  test('says from the last release while the schema has a since that is empty or missing', () => {
    const words = { on: 'on main', since: WORKFLOW_COPY.runSetup.inputWords.sinceLastRelease };
    expect(inputWordsOf(RELEASE_SCHEMA, { branch: 'main' })).toEqual(words);
    expect(inputWordsOf(RELEASE_SCHEMA, { branch: 'main', since: '' })).toEqual(words);
  });

  test('says nothing of a since the schema does not declare', () => {
    expect(inputWordsOf({ type: 'object', properties: { branch: {} } }, { branch: 'dev' })).toEqual(
      { on: 'on dev' },
    );
  });

  test.each([
    ['no branch', { since: '2026-10-23' }],
    ['a blank branch', { branch: '  ' }],
    ['a branch that is not text', { branch: 3 }],
    ['an input that is not an object', [1]],
    ['no input', undefined],
  ])('says nothing for %s', (_name, value) => {
    expect(inputWordsOf(RELEASE_SCHEMA, value)).toBeUndefined();
  });
});

describe('cadenceSentence', () => {
  test('reads a time of day with its zone, in the builder’s words', () => {
    expect(cadenceSentence(DAILY)).toBe('every day at 9:00 AM Central time');
    expect(cadenceSentence({ cron: '0 9 * * 1-5', timeZone: 'America/Chicago' })).toBe(
      'weekdays at 9:00 AM Central time',
    );
  });

  test('leaves the zone off when asked, for a schedule that is only mentioned', () => {
    expect(cadenceSentence(DAILY, { zone: false })).toBe('every day at 9:00 AM');
  });

  test('names no zone for an interval, which counts elapsed time', () => {
    expect(cadenceSentence({ every: { unit: 'minutes', count: 15 }, timeZone: 'UTC' })).toBe(
      'every 15 minutes',
    );
    expect(cadenceSentence({ every: { unit: 'hours', count: 1 }, timeZone: 'UTC' })).toBe(
      'every hour',
    );
  });
});

describe('runSetupIdentity', () => {
  test('names a file by its title, with the identifier beside it, and says what it is for', () => {
    const resolution = file({}) as Extract<WorkflowResolution, { kind: 'agent-authored' }>;
    const titled: WorkflowResolution = {
      ...resolution,
      file: { ...resolution.file, title: ' Release notes ', description: 'Collects changes.' },
    };
    expect(runSetupIdentity('release-notes', titled)).toEqual({
      name: 'Release notes',
      titled: true,
      description: 'Collects changes.',
    });
  });

  test('names a file with no title, and a code type, by their identifier alone', () => {
    expect(runSetupIdentity('order-refund', file({}))).toEqual({
      name: 'order-refund',
      titled: false,
      description: null,
    });
    expect(runSetupIdentity('order-processing', code(OBJECT_SCHEMA))).toMatchObject({
      name: 'order-processing',
      titled: false,
    });
  });

  test('names a workflow that has not loaded by its identifier', () => {
    expect(runSetupIdentity('digest', undefined)).toEqual({
      name: 'digest',
      titled: false,
      description: null,
    });
  });
});

describe('runSetupTrigger', () => {
  function withTrigger(trigger: Record<string, unknown> | null): WorkflowResolution {
    const resolution = file({}) as Extract<WorkflowResolution, { kind: 'agent-authored' }>;
    return { ...resolution, file: { ...resolution.file, trigger } };
  }

  test('names the signal that starts a file', () => {
    expect(runSetupTrigger(withTrigger({ kind: 'signal', name: 'message-received' }))).toEqual({
      kind: 'signal',
      name: 'message-received',
    });
  });

  test('reads a schedule trigger’s cadence as a header says it', () => {
    const summary = runSetupTrigger(withTrigger({ kind: 'schedule', spec: '0 11 * * 5' }));
    expect(summary?.kind).toBe('schedule');
    // The day is the viewer's reading of the next fire, so only its shape is fixed.
    expect(summary).toMatchObject({ words: expect.stringMatching(/^every [A-Z][a-z]+day at /) });
  });

  test('says nothing for a code type, an unloaded workflow, or a trigger it cannot read', () => {
    expect(runSetupTrigger(code(OBJECT_SCHEMA))).toBeNull();
    expect(runSetupTrigger(undefined)).toBeNull();
    expect(runSetupTrigger(withTrigger(null))).toBeNull();
  });
});

describe('summaryOf', () => {
  const form = (value: unknown) => ({ mode: 'form', value }) as const;

  test('says a run starts right away, with the input in plain words', () => {
    const summary = (value: unknown) =>
      summaryOf({
        name: 'Release notes',
        when: 'now',
        cadence: DAILY,
        schema: RELEASE_SCHEMA,
        input: form(value),
      });
    expect(summary({ branch: 'main', since: '2026-10-23' })).toBe(
      'Runs once, right away, on main since Oct 23.',
    );
    expect(summary({ branch: '' })).toBe('Runs once, right away.');
    expect(summary(undefined)).toBe(WORKFLOW_COPY.runSetup.summaryNow());
  });

  test('says a run waits for one of the runs going at the concurrency limit (59a)', () => {
    const summary = (value: unknown) =>
      summaryOf({
        name: 'Release notes',
        when: 'now',
        cadence: DAILY,
        schema: RELEASE_SCHEMA,
        input: form(value),
        queuedBehind: 4,
      });
    expect(summary({ branch: 'main', since: '2026-10-23' })).toBe(
      'Runs once, when one of the 4 finishes, on main since Oct 23.',
    );
    expect(summary(undefined)).toBe('Runs once, when one of the 4 finishes.');
  });

  test('says what a schedule creates, with the input and the cadence in plain words', () => {
    expect(
      summaryOf({
        name: 'Release notes',
        when: 'schedule',
        cadence: DAILY,
        schema: RELEASE_SCHEMA,
        input: form({ branch: 'main' }),
      }),
    ).toBe(
      'Creates a schedule that runs Release notes on main, from the last release, every day at 9:00 AM Central time.',
    );
  });

  test('reads a schedule with no input words as the workflow and the cadence', () => {
    expect(
      summaryOf({
        name: 'digest',
        when: 'schedule',
        cadence: { every: { unit: 'minutes', count: 15 }, timeZone: 'America/Los_Angeles' },
        schema: undefined,
        input: form(undefined),
      }),
    ).toBe('Creates a schedule that runs digest, every 15 minutes.');
  });

  test('points at the JSON while it holds the input, and says to fix it while it does not parse', () => {
    const base = { name: 'Release notes', cadence: DAILY, schema: RELEASE_SCHEMA } as const;
    expect(summaryOf({ ...base, when: 'now', input: { mode: 'json', valid: true } })).toBe(
      'Runs once, right away, with the JSON above.',
    );
    expect(summaryOf({ ...base, when: 'schedule', input: { mode: 'json', valid: true } })).toBe(
      'Creates a schedule that runs Release notes with the JSON above, every day at 9:00 AM Central time.',
    );
    for (const when of ['now', 'schedule'] as const) {
      expect(summaryOf({ ...base, when, input: { mode: 'json', valid: false } })).toBe(
        'Fix the JSON above to run.',
      );
    }
  });
});
