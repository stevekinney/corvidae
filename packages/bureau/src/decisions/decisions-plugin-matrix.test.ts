/**
 * COR-2204 — the decision half of the outcome matrix (`tmp/chef/briefs/COR-2204-matrix.md`): what
 * `Bureau.decisions.decide` does with `requireKinds`, a refusal, a failure, an abort and a record
 * that cannot be written. One table, one entry per matrix row, each titled with its row number and
 * the matrix's source column. A row marked "unchanged" there pins what `main` already did; every
 * other row asserts the new result.
 *
 * Every model here is a double, and nothing waits on a clock: a held model settles when the test
 * releases it, and a wait for a call goes through `waitUntil`.
 */
import { type BackendDescriptor, type GenerateFunction } from '@lostgradient/operative';
import { createMockGenerate } from '@lostgradient/operative/testing';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';
import type { Conversation } from 'conversationalist/testing';

import type { Bureau } from '../bureau-types/facade.ts';
import { createBureau } from '../create-bureau.ts';
import { ModelPolicyDeniedError } from '../file-agent-generate.ts';
import {
  catalogRow,
  decisionHarness,
  failingModel,
  FALLBACK_ROW,
  heldModel,
  type MatrixRow,
  scriptedModel,
  settle,
  stillPending,
} from '../testing/decision-harness.test-support.ts';
import { createVendorCatalog } from '../testing/vendor-catalog.test-support';

const bureaus: Bureau[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const BOOLEAN = { kind: 'boolean', question: 'q' } as const;
const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,63}$/;
const answersTrue = () => async () => ({ content: '{"answer": true}' });

/** The code of a rejection, or `undefined` when the call resolved. */
function codeOf(result: Awaited<ReturnType<typeof settle>>): unknown {
  return 'rejected' in result ? (result.rejected as { code?: unknown }).code : undefined;
}

function expectRefusal(h: ReturnType<typeof decisionHarness>, reason = 'NOT_CONFIGURED') {
  expect(h.audits).toHaveLength(1);
  expect(h.audits[0]?.detail).toMatchObject({ kind: 'boolean', outcome: 'refused', reason });
  expect(h.published().map(({ outcome }) => outcome)).toEqual(['refused']);
}

/** The catalog row `decisions.model: 'acme/judge'` names. */
const chosenRow = (overrides: Partial<BackendDescriptor> = {}) =>
  catalogRow({ provider: 'acme', model: 'judge', ...overrides });

const ROWS: readonly MatrixRow[] = [
  {
    row: 16,
    source: 'Rev, AC2',
    title:
      'requireKinds boolean, a registered model lacking boolean: refused before any model call',
    async run() {
      const { model, calls } = scriptedModel('a', { kinds: new Set(['choice']) });
      const h = decisionHarness({
        models: { m: model },
        model: 'm',
        rows: [FALLBACK_ROW],
        generate: answersTrue,
      });
      const result = await settle(
        h.decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean'] }),
      );
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expect(calls).toHaveLength(0);
      expect(h.generateCalls).toEqual([]);
      expectRefusal(h);
    },
  },
  {
    row: 17,
    source: 'Rev',
    title:
      'requireKinds, the chosen row answers by adapter: refused, only a native answerer is accepted',
    async run() {
      const row = chosenRow({});
      const control = decisionHarness({
        model: 'acme/judge',
        rows: [row, FALLBACK_ROW],
        generate: answersTrue,
      });
      await control.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(control.audits[0]?.detail).toMatchObject({ row: 'acme/judge', path: 'adapter' });

      const h = decisionHarness({
        model: 'acme/judge',
        rows: [row, FALLBACK_ROW],
        generate: answersTrue,
      });
      const result = await settle(
        h.decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean'] }),
      );
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expect(h.generateCalls).toEqual([]);
      expectRefusal(h);
    },
  },
  {
    row: 18,
    source: 'Rev',
    title:
      'requireKinds, a native answerer whose kinds include every listed kind: answered natively',
    async run() {
      const { model, calls } = scriptedModel(true);
      const h = decisionHarness({ models: { m: model }, model: 'm' });
      const decision = await h.decisions.decide(BOOLEAN, {
        taskId: 'run-1',
        requireKinds: ['boolean', 'choice'],
      });
      expect(decision.value).toBe(true);
      expect(calls).toHaveLength(1);
      expect(h.audits[0]?.detail).toMatchObject({ outcome: 'answered', path: 'native' });
    },
  },
  {
    row: 19,
    source: 'Rev',
    title: 'requireKinds, a native answerer lacking one listed kind: refused, no model call',
    async run() {
      const { model, calls } = scriptedModel(true, { kinds: new Set(['boolean']) });
      const h = decisionHarness({
        models: { m: model },
        model: 'm',
        rows: [FALLBACK_ROW],
        generate: answersTrue,
      });
      const result = await settle(
        h.decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean', 'choice'] }),
      );
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expect(calls).toHaveLength(0);
      expect(h.generateCalls).toEqual([]);
      expectRefusal(h);
    },
  },
  {
    row: 20,
    source: 'Rev, O12',
    title: 'requireKinds, a native catalog row: the kinds of the model that answers decide it',
    async run() {
      const row = catalogRow({
        provider: 'typesafe',
        model: 'jev',
        structuredOutput: false,
        decisions: { kinds: ['boolean'], only: true },
      } as never);
      const served = scriptedModel(true, { kinds: new Set(['boolean']), name: 'jev' });
      const answered = decisionHarness({
        model: 'typesafe/jev',
        rows: [row],
        decideModel: () => served.model,
      });
      await answered.decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean'] });
      expect(answered.audits[0]?.detail).toMatchObject({ outcome: 'answered', path: 'native' });

      // The row declares `boolean`, but the model the host builds for it does not serve it: the
      // object that answers is the one whose kinds are read.
      const narrow = scriptedModel(true, { kinds: new Set(['choice']), name: 'jev' });
      const refused = decisionHarness({
        model: 'typesafe/jev',
        rows: [row],
        decideModel: () => narrow.model,
      });
      const result = await settle(
        refused.decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean'] }),
      );
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expect(narrow.calls).toHaveLength(0);
      expectRefusal(refused);
    },
  },
  {
    row: 21,
    source: 'Rev',
    title:
      'requireKinds, the row declares the kind but the host supplied no models.decide: refused',
    async run() {
      const row = catalogRow({
        provider: 'typesafe',
        model: 'jev',
        decisions: { kinds: ['boolean'], only: false },
      } as never);
      const control = decisionHarness({
        model: 'typesafe/jev',
        rows: [row],
        generate: answersTrue,
      });
      await control.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(control.audits[0]?.detail).toMatchObject({ path: 'adapter' });

      const h = decisionHarness({ model: 'typesafe/jev', rows: [row], generate: answersTrue });
      const result = await settle(
        h.decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean'] }),
      );
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expect(h.generateCalls).toEqual([]);
      expectRefusal(h);
    },
  },
  {
    row: 22,
    source: 'Rev, AC2',
    title: 'requireKinds boolean, a decision-only row lacking boolean: refused, no fallback call',
    async run() {
      const row = catalogRow({
        provider: 'typesafe',
        model: 'jev',
        structuredOutput: false,
        decisions: { kinds: ['choice'], only: true },
      } as never);
      const control = decisionHarness({
        model: 'typesafe/jev',
        rows: [row, FALLBACK_ROW],
        generate: answersTrue,
      });
      await control.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(control.audits[0]?.detail).toMatchObject({ path: 'fallback' });

      const h = decisionHarness({
        model: 'typesafe/jev',
        rows: [row, FALLBACK_ROW],
        generate: answersTrue,
      });
      const result = await settle(
        h.decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean'] }),
      );
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expect(h.generateCalls).toEqual([]);
      expectRefusal(h);
    },
  },
  {
    row: 23,
    source: 'Rev',
    title: 'requireKinds on Bureau.decisions.decide: the same refusal, recorded on the trail',
    async run() {
      const { model, calls } = scriptedModel('a', { kinds: new Set(['choice']) });
      const generated: string[] = [];
      const reply = createMockGenerate([{ content: '{"answer":true}', toolCalls: [] }]);
      const bureau = await createBureau({
        storage: new MemoryStorage(),
        durable: false,
        models: {
          catalog: createVendorCatalog().descriptors,
          generate: (descriptor): GenerateFunction => {
            generated.push(`${descriptor.provider}/${descriptor.model}`);
            return (context) => reply(context);
          },
        },
        decisions: { models: { m: model }, model: 'm' },
      });
      bureaus.push(bureau);
      const result = await settle(
        bureau.decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean'] }),
      );
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expect(calls).toHaveLength(0);
      expect(generated).toEqual([]);
      const records = await bureau.internals.auditTrail!.query({ type: 'decision.made' });
      expect(records.map((record) => record.detail)).toEqual([
        expect.objectContaining({ outcome: 'refused', reason: 'NOT_CONFIGURED' }),
      ]);
    },
  },
  {
    row: 24,
    source: 'main',
    title: 'requireKinds absent, the model lacks the kind: the fallback answers',
    async run() {
      const { model, calls } = scriptedModel('a', { kinds: new Set(['choice']) });
      const h = decisionHarness({
        models: { m: model },
        model: 'm',
        rows: [FALLBACK_ROW],
        generate: answersTrue,
      });
      await h.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(calls).toHaveLength(0);
      expect(h.generateCalls).toEqual(['anthropic/claude-haiku-5-5']);
      expect(h.audits[0]?.detail).toMatchObject({ outcome: 'answered', path: 'fallback' });
    },
  },
  {
    row: 25,
    source: 'main, Rev',
    title: 'the model policy forbids the chosen row: refused naming the row, event with no path',
    async run() {
      const h = decisionHarness({
        rows: [FALLBACK_ROW],
        generate: answersTrue,
        modelPolicy: { deployment: { deniedModels: ['claude-haiku-5-5'] }, policyRevision: 3 },
      });
      const result = await settle(h.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect('rejected' in result && result.rejected).toBeInstanceOf(ModelPolicyDeniedError);
      expect(h.generateCalls).toEqual([]);
      expect(h.audits[0]?.detail).toMatchObject({
        outcome: 'refused',
        row: 'anthropic/claude-haiku-5-5',
      });
      expect(h.published()).toEqual([
        {
          kind: 'boolean',
          outcome: 'refused',
          row: 'anthropic/claude-haiku-5-5',
          path: undefined,
          taskId: 'run-1',
        },
      ]);
    },
  },
  {
    row: 26,
    source: 'main, Rev',
    title: 'nothing can answer: NOT_CONFIGURED, a refused record, an event with no row',
    async run() {
      const h = decisionHarness();
      const result = await settle(h.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expectRefusal(h);
      expect(h.published()[0]).toMatchObject({ row: undefined, path: undefined });
    },
  },
  {
    row: 27,
    source: 'main, Rev',
    title: 'a provider key absent: the fallback answers, and with requireKinds the call is refused',
    async run() {
      const absent = chosenRow({ availability: 'unavailable' });
      const h = decisionHarness({
        model: 'acme/judge',
        rows: [absent, FALLBACK_ROW],
        generate: answersTrue,
      });
      await h.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(h.audits[0]?.detail).toMatchObject({
        row: 'anthropic/claude-haiku-5-5',
        path: 'fallback',
      });

      const required = decisionHarness({
        model: 'acme/judge',
        rows: [absent, FALLBACK_ROW],
        generate: answersTrue,
      });
      const result = await settle(
        required.decisions.decide(BOOLEAN, { taskId: 'run-1', requireKinds: ['boolean'] }),
      );
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expect(required.generateCalls).toEqual([]);
    },
  },
  {
    row: 28,
    source: 'main',
    title: 'a key saved then removed mid-call: the call answers on the row chosen at its start',
    async run() {
      const absent = chosenRow({ availability: 'unavailable' });
      const saved = { ...absent, availability: 'available' } as typeof absent;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = decisionHarness({
        model: 'acme/judge',
        rows: [absent, FALLBACK_ROW],
        generate: (row) => async () => {
          if (row.provider === 'acme') await gate;
          return { content: '{"answer": true}' };
        },
      });
      h.setRows([saved, FALLBACK_ROW]);
      const inFlight = h.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      await waitUntil(() => h.generateCalls.includes('acme/judge'), { message: 'the call starts' });
      h.setRows([absent, FALLBACK_ROW]);
      release();
      await inFlight;
      await h.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(
        h.audits.map((audit) => `${String(audit.detail['row'])} ${String(audit.detail['path'])}`),
      ).toEqual(['acme/judge adapter', 'anthropic/claude-haiku-5-5 fallback']);
    },
  },
  {
    row: 29,
    source: 'main',
    title: 'no row available at all: NOT_CONFIGURED and a refused record',
    async run() {
      const h = decisionHarness({
        model: 'acme/judge',
        rows: [
          chosenRow({ availability: 'unavailable' }),
          { ...FALLBACK_ROW, availability: 'unavailable' },
        ],
        generate: answersTrue,
      });
      const result = await settle(h.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect(codeOf(result)).toBe('NOT_CONFIGURED');
      expectRefusal(h);
    },
  },
  {
    row: 30,
    source: 'main',
    title:
      'decisions.model changed mid-call: the first model answers and records, the next call uses the new one',
    async run() {
      const first = heldModel({ honorSignal: false });
      const second = scriptedModel(false, { name: 'second' });
      const h = decisionHarness({
        models: { first: first.model, second: second.model },
        model: 'first',
      });
      const during = h.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      await waitUntil(() => first.calls.length === 1, { message: 'the first model is asked' });
      h.settings['decisions.model'] = 'second';
      first.release();
      const inFlight = await during;
      expect(inFlight.value).toBe(true);
      const next = await h.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(next.value).toBe(false);
      expect(h.audits.map((audit) => audit.detail['row'])).toEqual([
        'hostprov/held',
        'hostprov/second',
      ]);
    },
  },
  {
    row: 31,
    source: 'main, Rev',
    title:
      'a provider throws with an identifier code: the same error, an error record, an event with no reason',
    async run() {
      const thrown = Object.assign(new Error('down'), { code: 'PROVIDER_DOWN' });
      const h = decisionHarness({ models: { m: failingModel(thrown) }, model: 'm' });
      const result = await settle(h.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect('rejected' in result && result.rejected).toBe(thrown);
      expect(h.audits[0]?.detail).toMatchObject({ outcome: 'error', reason: 'PROVIDER_DOWN' });
      expect(h.published()).toEqual([
        { kind: 'boolean', outcome: 'error', row: 'failing', path: 'native', taskId: 'run-1' },
      ]);
    },
  },
  {
    row: 32,
    source: 'main, run rule',
    title:
      'a provider throws with a free-text code: the text is on the audit record only, never on the event',
    async run() {
      const text = 'key sk-CANARY rejected';
      const h = decisionHarness({
        models: { m: failingModel(Object.assign(new Error('down'), { code: text })) },
        model: 'm',
      });
      await settle(h.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect(h.audits[0]?.detail['reason']).toBe(text);
      expect(JSON.stringify(h.published())).not.toContain('CANARY');
    },
  },
  {
    row: 33,
    source: 'main',
    title:
      'a provider throws a TypeError with no code, or a string: the reason is its name, or Error',
    async run() {
      const typeError = decisionHarness({
        models: { m: failingModel(new TypeError('bad')) },
        model: 'm',
      });
      await settle(typeError.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect(typeError.audits[0]?.detail['reason']).toBe('TypeError');
      const text = decisionHarness({ models: { m: failingModel('boom') }, model: 'm' });
      await settle(text.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect(text.audits[0]?.detail['reason']).toBe('Error');
    },
  },
  {
    row: 34,
    source: 'main, Rev',
    title:
      'a fallback answer that fails its schema twice: DecisionSchemaError after two calls on one row',
    async run() {
      const h = decisionHarness({
        rows: [FALLBACK_ROW],
        generate: () => async () => ({ content: 'not json' }),
      });
      const result = await settle(h.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect('rejected' in result && (result.rejected as Error).name).toBe('DecisionSchemaError');
      expect(h.generateCalls).toEqual(['anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5-5']);
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]?.detail).toMatchObject({
        outcome: 'error',
        reason: 'DecisionSchemaError',
      });
    },
  },
  {
    row: 35,
    source: 'O10',
    title: 'a native answer outside the request is returned unvalidated and recorded answered',
    async run() {
      const choice = {
        kind: 'choice',
        question: 'q',
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
      } as const;
      for (const [request, value] of [
        [BOOLEAN, 'yes'],
        [choice, 'z'],
        [{ kind: 'scale', question: 'q', levels: ['low', 'high'] } as const, 9],
      ] as const) {
        const h = decisionHarness({ models: { m: scriptedModel(value).model }, model: 'm' });
        const decision = await h.decisions.decide(request, { taskId: 'run-1' });
        expect(decision.value).toBe(value);
        expect(h.audits[0]?.detail).toMatchObject({ outcome: 'answered' });
      }
    },
  },
  {
    row: 36,
    source: 'O10 (coordinator decision)',
    title:
      'a native model that resolves null leaves an error record and event with an identifier reason',
    async run() {
      const h = decisionHarness({
        models: {
          m: {
            name: 'm',
            kinds: scriptedModel(true).model.kinds,
            decide: async () => null as never,
          },
        },
        model: 'm',
      });
      const result = await settle(h.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect('rejected' in result).toBe(true);
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]?.detail).toMatchObject({ outcome: 'error' });
      expect(String(h.audits[0]?.detail['reason'])).toMatch(IDENTIFIER);
      expect(h.published().map(({ outcome }) => outcome)).toEqual(['error']);
    },
  },
  {
    row: 38,
    source: 'main, Rev',
    title:
      'a provider rejects with the signal’s TimeoutError reason: an error record naming TimeoutError',
    async run() {
      const held = heldModel({ honorSignal: true });
      const h = decisionHarness({ models: { m: held.model }, model: 'm' });
      const controller = new AbortController();
      const call = settle(
        h.decisions.decide(BOOLEAN, { taskId: 'run-1', signal: controller.signal }),
      );
      await waitUntil(() => held.calls.length === 1, { message: 'the model is asked' });
      controller.abort(new DOMException('deadline', 'TimeoutError'));
      expect('rejected' in (await call)).toBe(true);
      expect(h.audits[0]?.detail).toMatchObject({ outcome: 'error', reason: 'TimeoutError' });
      held.release();
    },
  },
  {
    row: 39,
    source: 'main',
    title:
      'the answered record cannot be written: the audit error is thrown and nothing is published',
    async run() {
      const failure = new Error('trail down');
      const h = decisionHarness({
        models: { m: scriptedModel(true).model },
        model: 'm',
        audit: async () => {
          throw failure;
        },
      });
      const result = await settle(h.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect('rejected' in result && result.rejected).toBe(failure);
      expect(h.published()).toEqual([]);
    },
  },
  {
    row: 40,
    source: 'main',
    title:
      'the failure record cannot be written: the provider’s error is thrown and the event is published',
    async run() {
      const thrown = Object.assign(new Error('x'), { code: 'PROVIDER_DOWN' });
      const h = decisionHarness({
        models: { m: failingModel(thrown) },
        model: 'm',
        audit: async () => {
          throw new Error('trail down');
        },
      });
      const result = await settle(h.decisions.decide(BOOLEAN, { taskId: 'run-1' }));
      expect('rejected' in result && result.rejected).toBe(thrown);
      expect(h.published().map(({ outcome }) => outcome)).toEqual(['error']);
    },
  },
  {
    row: 41,
    source: 'main, O3 (the plugin host refuses; Bureau’s own decide is unchanged)',
    title:
      'Bureau.decisions.decide with a signal aborted before the call: a model that ignores it answers',
    async run() {
      const { model, calls } = scriptedModel(true);
      const h = decisionHarness({ models: { m: model }, model: 'm' });
      const decision = await h.decisions.decide(BOOLEAN, {
        taskId: 'run-1',
        signal: AbortSignal.abort(),
      });
      expect(decision.value).toBe(true);
      expect(calls).toHaveLength(1);
      expect(h.audits[0]?.detail).toMatchObject({ outcome: 'answered' });
    },
  },
  {
    row: 42,
    source: 'main, Rev',
    title:
      'a fallback call with a signal aborted before it: AbortError, no generate call, an error record',
    async run() {
      const h = decisionHarness({ rows: [FALLBACK_ROW], generate: answersTrue });
      const result = await settle(
        h.decisions.decide(BOOLEAN, { taskId: 'run-1', signal: AbortSignal.abort() }),
      );
      expect('rejected' in result && (result.rejected as Error).name).toBe('AbortError');
      expect(h.generateCalls).toEqual([]);
      expect(h.audits[0]?.detail).toMatchObject({ outcome: 'error', reason: 'AbortError' });
      expect(h.published().map(({ outcome }) => outcome)).toEqual(['error']);
    },
  },
  {
    row: 43,
    source: 'main, Rev, O8',
    title:
      'the signal aborts during a call the model honours: AbortError, an error record that keeps outcome error',
    async run() {
      const held = heldModel({ honorSignal: true });
      const h = decisionHarness({ models: { m: held.model }, model: 'm' });
      const controller = new AbortController();
      const call = settle(
        h.decisions.decide(BOOLEAN, { taskId: 'run-1', signal: controller.signal }),
      );
      await waitUntil(() => held.calls.length === 1, { message: 'the model is asked' });
      controller.abort();
      const result = await call;
      expect('rejected' in result && (result.rejected as Error).name).toBe('AbortError');
      expect(h.audits[0]?.detail).toMatchObject({ outcome: 'error', reason: 'AbortError' });
      expect(h.published().map(({ outcome }) => outcome)).toEqual(['error']);
      held.release();
    },
  },
  {
    row: 44,
    source: 'main',
    title:
      'the signal aborts during a call the model ignores: still pending, abandoned by the caller’s race',
    async run() {
      const held = heldModel({ honorSignal: false });
      const h = decisionHarness({ models: { m: held.model }, model: 'm' });
      const controller = new AbortController();
      const call = h.decisions.decide(BOOLEAN, { taskId: 'run-1', signal: controller.signal });
      await waitUntil(() => held.calls.length === 1, { message: 'the model is asked' });
      controller.abort();
      expect(await stillPending(call)).toBe(true);
      held.release();
      await call;
    },
  },
  {
    row: 45,
    source: 'main, Rev',
    title:
      'the signal aborts after the provider answered, while the record is written: the call resolves answered',
    async run() {
      let started!: () => void;
      const auditStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = decisionHarness({
        models: { m: scriptedModel(true).model },
        model: 'm',
        audit: async () => {
          started();
          await gate;
        },
      });
      const controller = new AbortController();
      const call = h.decisions.decide(BOOLEAN, { taskId: 'run-1', signal: controller.signal });
      await auditStarted;
      controller.abort();
      release();
      const answered = await call;
      expect(answered.value).toBe(true);
      expect(h.published().map(({ outcome }) => outcome)).toEqual(['answered']);
    },
  },
  {
    row: 49,
    source: 'main',
    title:
      'the fallback’s schema retry: the second call uses the same row, with the correction appended, one record',
    async run() {
      const conversations: number[] = [];
      let call = 0;
      const h = decisionHarness({
        rows: [FALLBACK_ROW],
        generate: () => async (request) => {
          call += 1;
          conversations.push((request.conversation as Conversation).getMessages().length);
          return { content: call === 1 ? 'not json' : '{"answer": true}' };
        },
      });
      const retried = await h.decisions.decide(BOOLEAN, { taskId: 'run-1' });
      expect(retried.value).toBe(true);
      expect(h.generateCalls).toEqual(['anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5-5']);
      expect(conversations[1]!).toBeGreaterThan(conversations[0]!);
      expect(h.audits).toHaveLength(1);
    },
  },
  {
    row: 50,
    source: 'main, Rev',
    title:
      'a goal validator re-run asks again: each call writes its own record under the goal run id',
    async run() {
      const first = scriptedModel(true, { name: 'first' });
      const second = scriptedModel(false, { name: 'second' });
      const h = decisionHarness({
        models: { first: first.model, second: second.model },
        model: 'first',
      });
      await h.decisions.decide(BOOLEAN, { taskId: 'goal-1' });
      h.settings['decisions.model'] = 'second';
      await h.decisions.decide(BOOLEAN, { taskId: 'goal-1' });
      expect(h.audits.map((audit) => audit.runId)).toEqual(['goal-1', 'goal-1']);
      expect(h.audits.map((audit) => audit.detail['row'])).toEqual([
        'hostprov/first',
        'hostprov/second',
      ]);
    },
  },
];

describe('COR-2204 decision matrix: Bureau.decisions.decide', () => {
  for (const { row, source, title, run } of ROWS) {
    it(`R${row} [${source}] ${title}`, () => run());
  }
});
