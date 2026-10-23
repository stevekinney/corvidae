/**
 * The Workflows area's data: the list that joins the engine's definitions with the Bureau's
 * workflow files, the answer to which of the two a type belongs to, the schedules that start a
 * type, and what a file's actions are.
 */
import { rejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  availableActions,
  defaultSignalName,
  isEngineType,
  joinCatalog,
  loadCatalog,
  loadCodeActivity,
  resolveWorkflow,
  startingSchedules,
} from './workflow-catalog.ts';
import { parseWorkflowText } from './workflow-files.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  invalidFile,
  readyFile,
  runFixture,
  scheduleFixture,
  sourceDefinition,
  workflowFaults,
  type WorkflowStub,
} from './workflow-world.test-support.ts';

let stub: WorkflowStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function listingOf(file: ReturnType<typeof readyFile>) {
  const { text: _text, schedule: _schedule, ...rest } = file;
  return rest;
}

describe('the list', () => {
  test('is every definition and every Bureau file, joined on the file identifier', () => {
    const rows = joinCatalog(
      [codeDefinition('order-processing'), sourceDefinition('digest')],
      [listingOf(readyFile('digest'))],
    );
    expect(rows.map((row) => [row.name, row.kind])).toEqual([
      ['digest', 'agent-authored'],
      ['order-processing', 'code'],
    ]);
    // The row for the file is the file's: one row for the name, not one for each side.
    expect(rows).toHaveLength(2);
  });

  test('leaves out a source with no Bureau file, so it reads the same before and after a restart', () => {
    const rows = joinCatalog(
      [codeDefinition('order-processing'), sourceDefinition('deleted-yesterday')],
      [],
    );
    expect(rows.map((row) => row.name)).toEqual(['order-processing']);
  });

  test('lists a Bureau file the engine has no definition for, which an invalid file never has', () => {
    const rows = joinCatalog(
      [],
      [listingOf(invalidFile('broken')), listingOf(readyFile('not-applied-yet'))],
    );
    expect(rows.map((row) => row.name)).toEqual(['broken', 'not-applied-yet']);
  });

  test('carries an invalid file’s message, its issues, and nothing a ready file would', () => {
    const [row] = joinCatalog([], [listingOf(invalidFile('broken'))]);
    expect(row?.file?.state).toBe('invalid');
    expect(row?.problem?.message).toBe('The document is not a workflow.');
    expect(row?.problem?.issues).toEqual([
      { path: 'trigger.spec', message: 'Not a schedule specification.' },
    ]);
  });

  test('carries the category of a source that failed to load', () => {
    const rows = joinCatalog(
      [
        sourceDefinition('flaky', {
          state: 'failed',
          lastFailureCategory: 'timeout',
          contract: null,
          description: null,
        }),
      ],
      [listingOf(readyFile('flaky'))],
    );
    expect(rows[0]?.failure).toBe('timeout');
    // A source that loaded has no failure to show.
    expect(
      joinCatalog([sourceDefinition('fine')], [listingOf(readyFile('fine'))])[0]?.failure,
    ).toBeNull();
  });

  test('gives every Bureau file the agent-authored kind, with its agent when it has one', () => {
    const rows = joinCatalog(
      [sourceDefinition('with-agent'), sourceDefinition('without-agent')],
      [
        listingOf(readyFile('with-agent', { agent: 'writer' })),
        listingOf(readyFile('without-agent', { agent: null })),
      ],
    );
    expect(rows.map((row) => [row.kind, row.agent])).toEqual([
      ['agent-authored', 'writer'],
      ['agent-authored', null],
    ]);
  });

  test('gives a code-defined type no agent and no file', () => {
    const [row] = joinCatalog([codeDefinition('order-processing')], []);
    expect(row).toMatchObject({ kind: 'code', agent: null, file: null, problem: null });
    expect(row?.description).toBe('The order-processing workflow.');
  });

  test('describes a file in its own words, and a code type in the engine’s', () => {
    const rows = joinCatalog(
      [codeDefinition('order-processing'), sourceDefinition('digest')],
      [listingOf(readyFile('digest', { description: 'Writes the digest.' }))],
    );
    expect(rows.map((row) => [row.name, row.description])).toEqual([
      ['digest', 'Writes the digest.'],
      ['order-processing', 'The order-processing workflow.'],
    ]);
  });

  test('describes a file with none of its own by nothing the engine did not say', () => {
    const [row] = joinCatalog(
      [sourceDefinition('digest', { description: null })],
      [listingOf(readyFile('digest'))],
    );
    expect(row?.description).toBeNull();
  });

  test('carries a file’s trigger and the Bureau’s counts of its instances, and none for a code type', () => {
    const runs = { active: 2, last24Hours: 9, lastRunAt: '2026-10-23T11:00:00.000Z' };
    const rows = joinCatalog(
      [codeDefinition('order-processing')],
      [listingOf(readyFile('digest', { runs, trigger: { kind: 'signal', name: 'go' } }))],
    );
    expect(rows.map((row) => [row.name, row.trigger, row.runs])).toEqual([
      ['digest', { kind: 'signal', name: 'go' }, runs],
      ['order-processing', null, null],
    ]);
  });

  test('marks the types the Bureau registers for itself, and only those', () => {
    const rows = joinCatalog(
      [
        codeDefinition('agentRun'),
        codeDefinition('durableHeartbeatTick'),
        codeDefinition('goalRun'),
        codeDefinition('order-processing'),
      ],
      [],
    );
    expect(rows.map((row) => [row.name, row.engine])).toEqual([
      ['agentRun', true],
      ['durableHeartbeatTick', true],
      ['goalRun', true],
      ['order-processing', false],
    ]);
    expect(isEngineType('agentRun')).toBe(true);
    expect(isEngineType('digest')).toBe(false);
  });

  test('is ordered by name', () => {
    const names = joinCatalog(
      [codeDefinition('b'), codeDefinition('a')],
      [listingOf(readyFile('c'))],
    ).map((row) => row.name);
    expect(names).toEqual(['a', 'b', 'c']);
  });
});

describe('loading the list', () => {
  test('follows the engine’s pages and the Bureau’s to the end', async () => {
    stub = installWorkflowWorld(
      emptyWorld({
        definitions: [codeDefinition('order-processing'), sourceDefinition('digest')],
        files: [readyFile('digest')],
      }),
    );
    stub.on('weft.workflows.definitions.list', (params) =>
      params['offset'] === undefined || params['offset'] === 0
        ? {
            definitions: [codeDefinition('order-processing')].map(
              ({ contractHash: _a, contract: _b, ...summary }) => summary,
            ),
            nextOffset: 1,
          }
        : {
            definitions: [sourceDefinition('digest')].map(
              ({ contractHash: _a, contract: _b, ...summary }) => summary,
            ),
          },
    );
    const rows = await loadCatalog(stub.client);
    expect(rows.map((row) => row.name)).toEqual(['digest', 'order-processing']);
    expect(stub.callsTo('weft.workflows.definitions.list')).toHaveLength(2);
  });
});

describe('which service a type belongs to', () => {
  const world = () =>
    emptyWorld({
      definitions: [codeDefinition('order-processing'), sourceDefinition('digest')],
      files: [readyFile('digest'), invalidFile('broken')],
    });

  test('is code when only the engine knows it', async () => {
    stub = installWorkflowWorld(world());
    const resolved = await resolveWorkflow(stub.client, 'order-processing');
    expect(resolved?.kind).toBe('code');
  });

  test('is agent-authored, with its definition, when the Bureau has the file and the engine loaded it', async () => {
    stub = installWorkflowWorld(world());
    const resolved = await resolveWorkflow(stub.client, 'digest');
    expect(resolved?.kind).toBe('agent-authored');
    if (resolved?.kind !== 'agent-authored') throw new Error('expected an agent-authored type');
    expect(resolved.file.id).toBe('digest');
    expect(resolved.definition?.origin).toBe('source');
  });

  test('is agent-authored with no definition section when the engine has no definition yet', async () => {
    stub = installWorkflowWorld(
      emptyWorld({ definitions: [], files: [readyFile('not-applied-yet')] }),
    );
    const resolved = await resolveWorkflow(stub.client, 'not-applied-yet');
    if (resolved?.kind !== 'agent-authored') throw new Error('expected an agent-authored type');
    expect(resolved.definition).toBeUndefined();
  });

  test('has no definition section for an invalid file, even when the engine still holds an older one', async () => {
    stub = installWorkflowWorld(
      emptyWorld({ definitions: [sourceDefinition('broken')], files: [invalidFile('broken')] }),
    );
    const resolved = await resolveWorkflow(stub.client, 'broken');
    if (resolved?.kind !== 'agent-authored') throw new Error('expected an agent-authored type');
    expect(resolved.file.state).toBe('invalid');
    expect(resolved.definition).toBeUndefined();
  });

  test('is not found when neither service knows it', async () => {
    stub = installWorkflowWorld(world());
    expect(await resolveWorkflow(stub.client, 'nobody')).toBeUndefined();
  });

  test('is not found when the Bureau has no file and the engine holds only a source, before a restart', async () => {
    stub = installWorkflowWorld(
      emptyWorld({ definitions: [sourceDefinition('deleted-yesterday')], files: [] }),
    );
    expect(await resolveWorkflow(stub.client, 'deleted-yesterday')).toBeUndefined();
  });

  test('is not found after a restart too, when the engine no longer has the source', async () => {
    stub = installWorkflowWorld(emptyWorld({ definitions: [], files: [] }));
    expect(await resolveWorkflow(stub.client, 'deleted-yesterday')).toBeUndefined();
  });

  test('is not found for a name the engine refuses as malformed, as the Bureau does', async () => {
    stub = installWorkflowWorld(world());
    stub.on('weft.workflows.definitions.get', () => {
      throw workflowFaults.invalidParams();
    });
    stub.on('bureau.workflows.get', () => {
      throw workflowFaults.notFound('workflow foo.bar');
    });
    expect(await resolveWorkflow(stub.client, 'foo.bar')).toBeUndefined();
  });

  test('is a failure, not a missing type, when the engine breaks', async () => {
    stub = installWorkflowWorld(world());
    stub.on('weft.workflows.definitions.get', () => {
      throw workflowFaults.unavailable();
    });
    expect(await rejectionOf(resolveWorkflow(stub.client, 'digest'))).toBeInstanceOf(
      HttpClientError,
    );
  });

  test('is a failure, not a missing type, when the Bureau breaks', async () => {
    stub = installWorkflowWorld(world());
    stub.on('bureau.workflows.get', () => {
      throw workflowFaults.unavailable();
    });
    expect(await rejectionOf(resolveWorkflow(stub.client, 'digest'))).toBeInstanceOf(
      HttpClientError,
    );
  });
});

describe('the schedules that start a type', () => {
  test('are the active and the paused ones, and never a cancelled generation', () => {
    const kept = startingSchedules([
      scheduleFixture('bureau-workflow-schedule:digest:1', 'digest', { status: 'cancelled' }),
      scheduleFixture('bureau-workflow-schedule:digest:2', 'digest', { status: 'paused' }),
      scheduleFixture('bureau-workflow-schedule:digest:3', 'digest', { status: 'active' }),
    ]);
    expect(kept.map((schedule) => [schedule.id, schedule.status])).toEqual([
      ['bureau-workflow-schedule:digest:2', 'paused'],
      ['bureau-workflow-schedule:digest:3', 'active'],
    ]);
  });
});

describe('what a file can be asked to do', () => {
  test('is pause, resume, delete, edit, and send signal for a file that loaded', () => {
    expect(availableActions(listingOf(readyFile('digest')))).toEqual({
      pause: true,
      resume: true,
      delete: true,
      edit: true,
      signal: true,
    });
  });

  test('is delete and edit for an invalid file with a hash', () => {
    expect(availableActions(listingOf(invalidFile('broken')))).toEqual({
      pause: false,
      resume: false,
      delete: true,
      edit: true,
      signal: false,
    });
  });

  test('is nothing for an invalid file with no hash, which cannot be read', () => {
    expect(availableActions(listingOf(invalidFile('broken', { hash: null })))).toEqual({
      pause: false,
      resume: false,
      delete: false,
      edit: false,
      signal: false,
    });
  });
});

describe('the signal a form starts with', () => {
  const documentOf = (trigger: unknown, steps: unknown) =>
    parseWorkflowText(JSON.stringify({ name: 'x', trigger, steps }));

  test('is the trigger’s signal name when the trigger is a signal', () => {
    expect(
      defaultSignalName(
        documentOf({ kind: 'signal', name: 'begin' }, [{ kind: 'await-signal', signal: 'later' }]),
      ),
    ).toBe('begin');
  });

  test('is the first awaited signal name when the trigger is not a signal', () => {
    expect(
      defaultSignalName(
        documentOf({ kind: 'schedule', spec: '1h' }, [
          { kind: 'sleep', duration: '1m' },
          { kind: 'await-signal', signal: 'approve' },
          { kind: 'await-signal', signal: 'finish' },
        ]),
      ),
    ).toBe('approve');
  });

  test('is empty when the workflow names no signal at all, or cannot be read', () => {
    expect(defaultSignalName(documentOf({ kind: 'schedule', spec: '1h' }, []))).toBe('');
    expect(defaultSignalName(undefined)).toBe('');
  });
});

describe('the activity of a code-defined type', () => {
  const NOW = Date.parse('2026-10-23T12:00:00.000Z');
  const MINUTE = 60_000;

  test('is counted from the engine’s own totals: the unfinished, the last day’s, and the newest', async () => {
    stub = installWorkflowWorld(
      emptyWorld({
        runs: [
          runFixture('a', 'order-processing', {
            createdAt: NOW - 10 * MINUTE,
            status: 'completed',
          }),
          runFixture('b', 'order-processing', { createdAt: NOW - 20 * MINUTE, status: 'running' }),
          runFixture('c', 'order-processing', {
            createdAt: NOW - 30 * MINUTE,
            status: 'suspended',
          }),
          runFixture('d', 'order-processing', { createdAt: NOW - 2 * 86_400_000 }),
          runFixture('e', 'other', { createdAt: NOW - MINUTE }),
        ],
        schedules: [scheduleFixture('every-5', 'order-processing')],
      }),
    );
    const activity = await loadCodeActivity(stub.client, ['order-processing'], NOW);
    expect(activity.get('order-processing')?.runs).toEqual({
      active: 2,
      last24Hours: 3,
      lastRunAt: new Date(NOW - 10 * MINUTE).toISOString(),
    });
    expect(activity.get('order-processing')?.schedules).toHaveLength(1);
    // One total at a time: it never asks the engine for more than a page of one.
    for (const call of stub.callsTo('weft.workflows.list')) expect(call.params['limit']).toBe(1);
  });

  test('says a type that has never run has not, with no newest', async () => {
    stub = installWorkflowWorld(emptyWorld());
    const activity = await loadCodeActivity(stub.client, ['quiet'], NOW);
    expect(activity.get('quiet')?.runs).toEqual({ active: 0, last24Hours: 0, lastRunAt: null });
    expect(activity.get('quiet')?.schedules).toEqual([]);
  });

  test('leaves out a cancelled schedule generation', async () => {
    stub = installWorkflowWorld(
      emptyWorld({
        schedules: [
          scheduleFixture('live', 'order-processing'),
          scheduleFixture('retired', 'order-processing', { status: 'cancelled' }),
        ],
      }),
    );
    const activity = await loadCodeActivity(stub.client, ['order-processing'], NOW);
    expect(activity.get('order-processing')?.schedules).toHaveLength(1);
  });

  test('has null for what the engine would not give, and still gives the rest', async () => {
    stub = installWorkflowWorld(emptyWorld({ schedules: [scheduleFixture('live', 'a')] }));
    stub.on('weft.workflows.list', () => {
      throw workflowFaults.unavailable();
    });
    const activity = await loadCodeActivity(stub.client, ['a'], NOW);
    expect(activity.get('a')?.runs).toBeNull();
    expect(activity.get('a')?.schedules).toHaveLength(1);

    stub.world.failSchedules = true;
    const failed = await loadCodeActivity(stub.client, ['a'], NOW);
    expect(failed.get('a')).toEqual({ runs: null, schedules: null });
  });
});
