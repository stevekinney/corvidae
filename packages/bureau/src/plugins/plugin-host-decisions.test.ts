/**
 * COR-2204 — `host.decisions.decide`, the decision call a plugin makes, against the outcome matrix
 * (`tmp/chef/briefs/COR-2204-matrix.md`). One table, one entry per matrix row, each titled with its
 * row number and the matrix's source column. Every row opens a real Bureau that loads a plugin and
 * calls the host the plugin was given, so a row asserts the principal the Bureau binds, what the
 * trail records and what the event feed carries.
 *
 * Every decision model is a double, and nothing waits on a clock: a held model settles when the
 * test releases it, and a wait for a call goes through `waitUntil`.
 */
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { projectBureauEvent } from '../bureau-event-feed';
import { DEFAULT_DECISIONS_PER_TASK } from '../decisions/create-decisions';
import {
  heldModel,
  type MatrixRow,
  scriptedModel,
  settle,
  stillPending,
} from '../testing/decision-harness.test-support.ts';
import {
  disposePluginBureaus,
  eventFields,
  openPluginBureau,
} from '../testing/plugin-decisions.test-support.ts';
import { lateHostApi } from './plugin-registry';
import { PluginHostDisposedError } from './plugin-event-publish';
import { PluginNeedsSetupError } from './plugin-secret-gate';
import type { BureauPluginSecrets } from './plugin-types';

afterEach(disposePluginBureaus);

const BOOLEAN = { kind: 'boolean', question: 'q' } as const;
const UUID = /^decision:[0-9a-f-]{36}$/;

/** A plugin loaded over a Bureau whose one registered decision model answers `value`. */
async function openAnswering(
  value: unknown = true,
  extra: Parameters<typeof openPluginBureau>[0] = {},
) {
  const scripted = scriptedModel(value);
  const opened = await openPluginBureau({
    ...extra,
    bureau: { decisions: { models: { m: scripted.model }, model: 'm' }, ...extra.bureau },
  });
  return { ...opened, calls: scripted.calls };
}

function codeOf(result: Awaited<ReturnType<typeof settle>>): unknown {
  return 'rejected' in result ? (result.rejected as { code?: unknown }).code : undefined;
}

/** Nothing was asked, recorded or published. */
async function expectNothingHappened(opened: Awaited<ReturnType<typeof openAnswering>>) {
  expect(opened.calls).toHaveLength(0);
  expect(await opened.records()).toEqual([]);
  expect(opened.events).toEqual([]);
}

const MALFORMED: readonly (readonly [string, unknown])[] = [
  ['undefined', undefined],
  ['null', null],
  ['a string', 'is it?'],
  ['an empty object', {}],
  ['no question', { kind: 'boolean' }],
  ['a blank question', { kind: 'boolean', question: '  ' }],
  ['a non-text context', { kind: 'boolean', question: 'q', context: 5 }],
  [
    'a choice with one option',
    { kind: 'choice', question: 'q', options: [{ key: 'a', label: 'A' }] },
  ],
  [
    'a repeated key',
    {
      kind: 'choice',
      question: 'q',
      options: [
        { key: 'a', label: 'A' },
        { key: 'a', label: 'B' },
      ],
    },
  ],
  [
    'a blank label',
    {
      kind: 'choice',
      question: 'q',
      options: [
        { key: 'a', label: '' },
        { key: 'b', label: 'B' },
      ],
    },
  ],
  ['options that are not an array', { kind: 'choice', question: 'q', options: 'ab' }],
  ['a scale with one level', { kind: 'scale', question: 'q', levels: ['low'] }],
  ['a scale with a repeated level', { kind: 'scale', question: 'q', levels: ['low', 'low'] }],
  ['structured without a schema', { kind: 'structured', question: 'q' }],
  [
    'structured with a plain object',
    { kind: 'structured', question: 'q', schema: { type: 'object' } },
  ],
  ['an unknown kind', { kind: 'vibes', question: 'q' }],
];

/** The scenario rows 56 and 57 share: 25 calls under one task, all in flight at once. */
async function twentyFiveAtOnce() {
  const held = heldModel({ honorSignal: false });
  const opened = await openPluginBureau({
    bureau: { decisions: { models: { m: held.model }, model: 'm' } },
  });
  const host = opened.startHost();
  const calls = Array.from({ length: 25 }, () =>
    settle(host.decisions.decide(BOOLEAN, { taskId: 'run-1' })),
  );
  await waitUntil(() => held.calls.length === 25, { message: 'all 25 calls reach the model' });
  held.release();
  return { opened, outcomes: await Promise.all(calls), inFlight: held.calls.length };
}

const ROWS: readonly MatrixRow[] = [
  {
    row: 1,
    source: 'Rev',
    title:
      'the host start receives has decisions.decide beside agents, goals, publish and schedules',
    async run() {
      const { startHost } = await openAnswering();
      expect(Object.keys(startHost()).toSorted()).toEqual([
        'agents',
        'decisions',
        'goals',
        'publish',
        'schedules',
      ]);
      expect(typeof startHost().decisions.decide).toBe('function');
    },
  },
  {
    row: 2,
    source: 'Rev, main',
    title:
      'decide on the setup-time host rejects before the bind with no record, and forwards after it',
    async run() {
      let early: ReturnType<typeof settle> | undefined;
      const opened = await openAnswering(true, {
        duringSetup: (host) => {
          early = settle(host.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
        },
      });
      const result = await early!;
      expect('rejected' in result && (result.rejected as Error).message).toBe(
        'The host of plugin "demo" has not started yet.',
      );
      await expectNothingHappened(opened);

      // The standalone late host rejects the same way, with no decisions behind it.
      const late = lateHostApi('demo');
      const lateRejection = await rejectionOf(
        late.api.decisions.decide(BOOLEAN, { taskId: 'run-1' }),
      );
      expect((lateRejection as Error).message).toBe(
        'The host of plugin "demo" has not started yet.',
      );

      await opened.setupHost().decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(await opened.records()).toHaveLength(1);
    },
  },
  {
    row: 4,
    source: 'Rev, Constraints',
    title: 'any plugin call records principal plugin:<name> and hands the model the same principal',
    async run() {
      const { startHost, records, calls } = await openAnswering();
      await startHost().decisions.decide(BOOLEAN, { taskId: 'run-1' });
      const [record] = await records();
      expect(record?.principal).toBe('plugin:demo');
      expect(calls[0]?.options).toMatchObject({ principal: 'plugin:demo' });
    },
  },
  {
    row: 5,
    source: 'Rev',
    title: 'a principal an untyped caller passes is dropped: the record says plugin:<name>',
    async run() {
      const { startHost, records, calls } = await openAnswering();
      await startHost().decisions.decide(BOOLEAN, {
        taskId: 'run-1',
        principal: 'agent-run:x',
      } as never);
      const [record] = await records();
      expect(record?.principal).toBe('plugin:demo');
      expect(calls[0]?.options).toMatchObject({ principal: 'plugin:demo' });
    },
  },
  {
    row: 6,
    source: 'O1',
    title: 'a routingId an untyped caller passes is dropped: the record carries none',
    async run() {
      const { startHost, records } = await openAnswering();
      await startHost().decisions.decide(BOOLEAN, {
        taskId: 'run-1',
        routingId: 'route-1',
      } as never);
      const [record] = await records();
      expect(record?.detail).not.toHaveProperty('routingId');
    },
  },
  {
    row: 7,
    source: 'main',
    title: 'a running plugin and a needs-setup plugin are each bound a host',
    async run() {
      const running = await openAnswering();
      expect(running.startHost().agents.list()).toEqual([]);
      const needsSetup = await openAnswering(true, {
        secret: 'DEMO_KEY',
        pluginSecrets: { get: async () => undefined, watch: () => () => undefined },
      });
      expect(needsSetup.startHost().agents.list()).toEqual([]);
    },
  },
  {
    row: 8,
    source: 'Rev (taskId comes from the caller)',
    title: 'a taskId naming a run the plugin did not start is accepted as given',
    async run() {
      const { startHost, records, events } = await openAnswering();
      await startHost().decisions.decide(BOOLEAN, { taskId: 'some-finished-or-unknown-run' });
      const [record] = await records();
      expect(record?.runId).toBe('some-finished-or-unknown-run');
      expect(events[0]?.taskId).toBe('some-finished-or-unknown-run');
    },
  },
  {
    row: 9,
    source: 'main',
    title: 'no taskId: the record is filed under decision:<uuid> and the event names no task',
    async run() {
      const { startHost, records, events } = await openAnswering();
      await startHost().decisions.decide(BOOLEAN);
      const [record] = await records();
      expect(record?.runId).toMatch(UUID);
      expect(events[0]?.taskId).toBeUndefined();
    },
  },
  {
    row: 10,
    source: 'O1',
    title: 'an empty or non-string taskId rejects BAD_REQUEST with no record, event or model call',
    async run() {
      const opened = await openAnswering();
      for (const taskId of ['', 42, null, {}]) {
        const result = await settle(
          opened.startHost().decisions.decide(BOOLEAN, { taskId } as never),
        );
        expect(codeOf(result)).toBe('BAD_REQUEST');
      }
      await expectNothingHappened(opened);
    },
  },
  {
    row: 11,
    source: 'Constraints, Rev',
    title: 'no scope is checked: a plugin that declares none still decides',
    async run() {
      const { startHost, records } = await openAnswering();
      await startHost().decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(await records()).toHaveLength(1);
    },
  },
  {
    row: 12,
    source: 'main (DT:138, a malformed request writes no record)',
    title:
      'a malformed request rejects BAD_REQUEST through the host with no record, event or model call',
    async run() {
      const opened = await openAnswering();
      for (const [name, shape] of MALFORMED) {
        const result = await settle(
          opened.startHost().decisions.decide(shape as never, { taskId: 'run-1' }),
        );
        expect([name, codeOf(result)]).toEqual([name, 'BAD_REQUEST']);
      }
      await expectNothingHappened(opened);
    },
  },
  {
    row: 13,
    source: 'main, Rev',
    title:
      'a valid boolean, choice, scale and structured request is answered and recorded with the plugin principal',
    async run() {
      const cases = [
        { kind: 'boolean', question: 'q', context: 'c' },
        {
          kind: 'choice',
          question: 'q',
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
        },
        { kind: 'scale', question: 'q', levels: ['low', 'high'] },
        { kind: 'structured', question: 'q', schema: z.object({ ok: z.boolean() }) },
      ] as const;
      for (const request of cases) {
        const { startHost, records, events } = await openAnswering('answer');
        await startHost().decisions.decide(request, { taskId: 'run-1' });
        const [record] = await records();
        expect(record?.principal).toBe('plugin:demo');
        expect(record?.detail).toMatchObject({
          kind: request.kind,
          provider: 'hostprov',
          model: 'host-model',
          outcome: 'answered',
          row: 'hostprov/host-model',
          path: 'native',
        });
        if (request.kind === 'structured') {
          expect(record?.detail['schemaSha256']).toMatch(/^[0-9a-f]{64}$/);
        } else {
          expect(record?.detail).not.toHaveProperty('schemaSha256');
        }
        expect(events.map(eventFields)).toEqual([
          {
            kind: request.kind,
            outcome: 'answered',
            row: 'hostprov/host-model',
            path: 'native',
            taskId: 'run-1',
          },
        ]);
      }
    },
  },
  {
    row: 14,
    source: 'O1',
    title:
      'a signal that is not an AbortSignal rejects BAD_REQUEST with no record, event or model call',
    async run() {
      const opened = await openAnswering();
      for (const signal of [{ aborted: true }, 'abort', 1, null]) {
        const result = await settle(
          opened.startHost().decisions.decide(BOOLEAN, { taskId: 'run-1', signal } as never),
        );
        expect(codeOf(result)).toBe('BAD_REQUEST');
      }
      await expectNothingHappened(opened);
      await opened.startHost().decisions.decide(BOOLEAN, {
        taskId: 'run-1',
        signal: new AbortController().signal,
      });
      expect(opened.calls).toHaveLength(1);
    },
  },
  {
    row: 15,
    source: 'O1',
    title:
      'requireKinds that is not an array, names an unknown kind, or is empty rejects BAD_REQUEST',
    async run() {
      const opened = await openAnswering();
      for (const requireKinds of ['boolean', ['vibes'], [], [1], null, new Set(['boolean'])]) {
        const result = await settle(
          opened.startHost().decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds } as never),
        );
        expect(codeOf(result)).toBe('BAD_REQUEST');
      }
      await expectNothingHappened(opened);
      await opened
        .startHost()
        .decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean'] });
      expect(opened.calls).toHaveLength(1);
    },
  },
  {
    row: 37,
    source: 'O3 (no host deadline)',
    title: 'a provider that never settles leaves the call pending: the host adds no deadline',
    async run() {
      const held = heldModel({ honorSignal: false });
      const { startHost } = await openPluginBureau({
        bureau: { decisions: { models: { m: held.model }, model: 'm' } },
      });
      const call = startHost().decisions.decide(BOOLEAN, { taskId: 'run-1' });
      await waitUntil(() => held.calls.length === 1, { message: 'the model is asked' });
      expect(await stillPending(call)).toBe(true);
      held.release();
      await call;
    },
  },
  {
    row: 41,
    source: 'O3',
    title:
      'a signal aborted before the call rejects AbortError through the host, with no record or model call',
    async run() {
      const opened = await openAnswering();
      const result = await settle(
        opened
          .startHost()
          .decisions.decide(BOOLEAN, { taskId: 'run-1', signal: AbortSignal.abort() }),
      );
      expect('rejected' in result && (result.rejected as Error).name).toBe('AbortError');
      await expectNothingHappened(opened);
    },
  },
  {
    row: 46,
    source: 'O3',
    title: 'Bureau disposed while a call is in flight: the shutdown signal reaches the model',
    async run() {
      const held = heldModel({ honorSignal: true });
      const { bureau, startHost } = await openPluginBureau({
        bureau: { decisions: { models: { m: held.model }, model: 'm' } },
      });
      const call = settle(startHost().decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      await waitUntil(() => held.calls.length === 1, { message: 'the model is asked' });
      await bureau.dispose();
      expect('rejected' in (await call)).toBe(true);
      expect(held.calls[0]?.signal?.aborted).toBe(true);
      held.release();
    },
  },
  {
    row: 47,
    source: 'O3',
    title:
      'a call after the Bureau is disposed rejects PluginHostDisposedError, checked before the options',
    async run() {
      const opened = await openAnswering();
      await opened.bureau.dispose();
      const error = await rejectionOf(
        opened.startHost().decisions.decide(BOOLEAN, { taskId: 'run-1' }),
      );
      expect(error).toBeInstanceOf(PluginHostDisposedError);
      expect(error).toMatchObject({ name: 'PluginHostDisposedError', plugin: 'demo' });
      const malformed = await rejectionOf(
        opened.startHost().decisions.decide(BOOLEAN, { taskId: '' }),
      );
      expect(malformed).toBeInstanceOf(PluginHostDisposedError);
      expect(opened.calls).toHaveLength(0);
    },
  },
  {
    row: 56,
    source: 'O5',
    title: '25 concurrent calls from one plugin all run at once and each writes a record',
    async run() {
      const { opened, outcomes, inFlight } = await twentyFiveAtOnce();
      expect(inFlight).toBe(25);
      expect(outcomes.every((outcome) => 'resolved' in outcome)).toBe(true);
      expect(await opened.records()).toHaveLength(25);
    },
  },
  {
    row: 57,
    source: 'O5',
    title:
      'decisions.maximumPerTask counts the decide tool only: 25 plugin calls under one taskId are not refused',
    async run() {
      const { outcomes } = await twentyFiveAtOnce();
      expect(DEFAULT_DECISIONS_PER_TASK).toBeLessThan(25);
      expect(outcomes.filter((outcome) => 'rejected' in outcome)).toEqual([]);
    },
  },
  {
    row: 58,
    source: 'Rev (lateHostApi gains decisions), main',
    title: 'a disabled plugin’s host rejects has not started yet: no record, no model call',
    async run() {
      let early: ReturnType<typeof settle> | undefined;
      const opened = await openAnswering(true, {
        enabled: false,
        duringSetup: (host) => {
          early = settle(host.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
        },
      });
      const result = await early!;
      expect('rejected' in result && (result.rejected as Error).message).toBe(
        'The host of plugin "demo" has not started yet.',
      );
      await expectNothingHappened(opened);
    },
  },
  {
    row: 60,
    source: 'O2',
    title:
      'a needs-setup plugin’s decide rejects PluginNeedsSetupError with no record or model call, then works once the secret is saved',
    async run() {
      const values = new Map<string, string>();
      const watchers = new Set<() => void>();
      const pluginSecrets: BureauPluginSecrets = {
        get: async (key) => values.get(key),
        watch: (_key, listener) => {
          watchers.add(listener);
          return () => watchers.delete(listener);
        },
      };
      const opened = await openAnswering(true, { secret: 'DEMO_KEY', pluginSecrets });
      const refused = await rejectionOf(
        opened.startHost().decisions.decide(BOOLEAN, { taskId: 'run-1' }),
      );
      expect(refused).toBeInstanceOf(PluginNeedsSetupError);
      await expectNothingHappened(opened);

      values.set('DEMO_KEY', 'secret-value');
      for (const listener of watchers) listener();
      await waitUntil(
        async () => {
          const result = await settle(
            opened.startHost().decisions.decide(BOOLEAN, { taskId: 'run-1' }),
          );
          return 'resolved' in result;
        },
        { message: 'the plugin leaves needs-setup' },
      );
      const [record] = await opened.records();
      expect(record?.principal).toBe('plugin:demo');
    },
  },
  {
    row: 66,
    source: 'main, run rule',
    title:
      'the decision.made event is { kind, outcome, row, path, taskId }, never a reason or a principal',
    async run() {
      const { startHost, events } = await openAnswering();
      await startHost().decisions.decide(BOOLEAN, { taskId: 'run-1' });
      const payload = projectBureauEvent(events[0]!)?.payload ?? {};
      expect(Object.keys(payload).toSorted()).toEqual(['kind', 'outcome', 'path', 'row', 'taskId']);
      expect(JSON.stringify(payload)).not.toContain('plugin:demo');
    },
  },
];

describe('COR-2204 decision matrix: host.decisions.decide', () => {
  for (const { row, source, title, run } of ROWS) {
    it(`R${row} [${source}] ${title}`, () => run());
  }
});
