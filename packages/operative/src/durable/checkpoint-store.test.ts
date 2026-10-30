import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createCheckpointStore } from './checkpoint-store';
import { UnsupportedCheckpointRecordVersionError } from './checkpoint-version';
import type { RunCursor, StepRecord } from './types';

/** In-memory text-value store for tests, backed by Weft's MemoryStorage. */
const createStore = () => textValueStore(new MemoryStorage());

/** A full {@link RunCursor} at `step` with zeroed run-level accumulators. */
const cursor = (step: number): RunCursor => ({
  schemaVersion: 2,
  step,
  totalUsage: { prompt: 0, completion: 0, total: 0 },
  lastContent: '',
  lastParts: [],
  finalRowIsReplacement: false,
  schemaAttempts: 0,
  lastAppliedConfigVersion: 0,
});

describe('createCheckpointStore', () => {
  describe('cursor', () => {
    it('round-trips a cursor', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('run-1', cursor(3));
      expect(await store.loadCursor('run-1')).toEqual(cursor(3));
    });

    it('returns null for a run with no cursor', async () => {
      const store = createCheckpointStore(createStore());
      expect(await store.loadCursor('missing')).toBeNull();
    });

    it('overwrites the cursor on re-save', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('run-1', cursor(1));
      await store.saveCursor('run-1', cursor(5));
      expect(await store.loadCursor('run-1')).toEqual(cursor(5));
    });

    it('defaults lastAppliedConfigVersion to 0 on loadCursor for a persisted current-version cursor that lacks it (not only through loadCheckpoint)', async () => {
      // Regression: the normalization added for `loadCheckpoint` lived only
      // in that method, so a caller using the public `loadCursor()` directly
      // (bypassing `loadCheckpoint`) still got a cursor missing this field.
      const withoutConfigVersion = {
        schemaVersion: 2 as const,
        step: 2,
        totalUsage: { prompt: 10, completion: 5, total: 15 },
        lastContent: 'partial',
        lastParts: [{ type: 'text' as const, text: 'partial' }],
        finalRowIsReplacement: false,
        schemaAttempts: 1,
      };
      const underlying = createStore();
      await underlying.set('durable-run:run-1:cursor', JSON.stringify(withoutConfigVersion));

      const store = createCheckpointStore(underlying);
      expect(await store.loadCursor('run-1')).toEqual({
        ...withoutConfigVersion,
        lastAppliedConfigVersion: 0,
      });
    });
  });

  describe('conversation snapshot', () => {
    it('round-trips a conversation snapshot through Conversation.from with deep-equal history', async () => {
      const store = createCheckpointStore(createStore());

      const conversation = new Conversation(createConversationHistory({ id: 'conv-1' }));
      conversation.appendUserMessage('Hello');
      conversation.appendAssistantMessage('Hi there');
      const original = conversation.snapshot();

      await store.saveConversation('run-1', original);
      const loaded = await store.loadConversation('run-1');

      expect(loaded).not.toBeNull();
      // Rehydrate and re-snapshot: the tree and lineage must survive even though
      // a new envelope gets its own creation time and integrity digest.
      const rehydrated = Conversation.from(loaded!);
      const restored = rehydrated.snapshot();
      expect(restored.nodes).toEqual(original.nodes);
      expect(restored.currentPath).toEqual(original.currentPath);
      expect(restored.controllerRevision).toBe(original.controllerRevision);
      expect(restored.lineage).toEqual(original.lineage);
      expect(rehydrated.getMessages()).toEqual(conversation.getMessages());
    });

    it('returns null when no conversation has been persisted', async () => {
      const store = createCheckpointStore(createStore());
      expect(await store.loadConversation('missing')).toBeNull();
    });
  });

  describe('step records', () => {
    const makeStep = (step: number, final = false): StepRecord => ({
      schemaVersion: 2,
      step,
      content: `step ${step}`,
      parts: [{ type: 'text', text: `step ${step}` }],
      toolCalls: [],
      results: [],
      usage: { prompt: 10, completion: 5, total: 15 },
      final,
    });

    it('round-trips a single step record', async () => {
      const store = createCheckpointStore(createStore());
      const record = makeStep(0, true);
      await store.saveStep('run-1', record);
      expect(await store.loadSteps('run-1')).toEqual([record]);
    });

    it('returns step records in step order regardless of write order', async () => {
      const store = createCheckpointStore(createStore());
      // Write out of order; zero-padded keys must still list in numeric order.
      await store.saveStep('run-1', makeStep(2));
      await store.saveStep('run-1', makeStep(0));
      await store.saveStep('run-1', makeStep(1));

      const steps = await store.loadSteps('run-1');
      expect(steps.map((s) => s.step)).toEqual([0, 1, 2]);
    });

    it('keeps double-digit steps in numeric order (zero-padding guard)', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveStep('run-1', makeStep(10));
      await store.saveStep('run-1', makeStep(2));
      const steps = await store.loadSteps('run-1');
      expect(steps.map((s) => s.step)).toEqual([2, 10]);
    });

    it('returns an empty array for a run with no steps', async () => {
      const store = createCheckpointStore(createStore());
      expect(await store.loadSteps('missing')).toEqual([]);
    });
  });

  describe('strict reads of malformed persisted data', () => {
    const malformedStep = 'durable-run:run-1:step:0000000001';

    async function failure(read: () => Promise<unknown>): Promise<unknown> {
      try {
        await read();
      } catch (error) {
        return error;
      }
      return undefined;
    }

    it('rejects a malformed cursor in strict mode and reads it as absent otherwise', async () => {
      const underlying = createStore();
      await underlying.set('durable-run:run-1:cursor', '{not json');
      const store = createCheckpointStore(underlying);

      expect(await failure(() => store.loadCursor('run-1', { strict: true }))).toBeInstanceOf(
        Error,
      );
      expect(await failure(() => store.loadCheckpoint('run-1', { strict: true }))).toBeInstanceOf(
        Error,
      );
      expect(await store.loadCursor('run-1')).toBeNull();
      const tolerant = await store.loadCheckpoint('run-1');
      expect(tolerant.cursor.step).toBe(0);
    });

    it('rejects a malformed step record in strict mode and skips it otherwise', async () => {
      const underlying = createStore();
      await underlying.set(
        'durable-run:run-1:step:0000000000',
        JSON.stringify({ schemaVersion: 2, step: 0, content: '', parts: [] }),
      );
      await underlying.set(malformedStep, '{not json');
      const store = createCheckpointStore(underlying);

      expect(await failure(() => store.loadSteps('run-1', { strict: true }))).toBeInstanceOf(Error);
      const tolerant = await store.loadSteps('run-1');
      expect(tolerant.map((record) => record.step)).toEqual([0]);
    });

    it('rejects a malformed transcript in strict mode and reads it as absent otherwise', async () => {
      const underlying = createStore();
      await underlying.set('durable-run:run-1:transcript', '{not json');
      const store = createCheckpointStore(underlying);

      expect(await failure(() => store.loadConversation('run-1', { strict: true }))).toBeInstanceOf(
        Error,
      );
      expect(await store.loadConversation('run-1')).toBeNull();
    });

    it('keeps a genuinely absent checkpoint a zeroed cursor in strict mode', async () => {
      const store = createCheckpointStore(createStore());
      const checkpoint = await store.loadCheckpoint('never-written', { strict: true });
      expect(checkpoint.cursor).toEqual(cursor(0));
      expect(checkpoint.conversation).toBeNull();
      expect(checkpoint.steps).toEqual([]);
    });
  });

  describe('loadCheckpoint', () => {
    it('assembles cursor, conversation, and steps into one checkpoint', async () => {
      const store = createCheckpointStore(createStore());
      const conversation = new Conversation(createConversationHistory({ id: 'conv-1' }));
      conversation.appendUserMessage('Hi');

      await store.saveCursor('run-1', cursor(2));
      await store.saveConversation('run-1', conversation.snapshot());
      await store.saveStep('run-1', {
        schemaVersion: 2,
        parts: [],
        step: 0,
        content: 'first',
        toolCalls: [],
        results: [],
        final: false,
      });

      const checkpoint = await store.loadCheckpoint('run-1');
      expect(checkpoint.runId).toBe('run-1');
      expect(checkpoint.cursor).toEqual(cursor(2));
      expect(checkpoint.conversation).not.toBeNull();
      expect(checkpoint.steps).toHaveLength(1);
      expect(checkpoint.steps[0]!.content).toBe('first');
    });

    it('defaults the cursor to step 0 when none is persisted', async () => {
      const store = createCheckpointStore(createStore());
      const checkpoint = await store.loadCheckpoint('fresh');
      expect(checkpoint.cursor).toEqual(cursor(0));
      expect(checkpoint.conversation).toBeNull();
      expect(checkpoint.steps).toEqual([]);
    });

    it('defaults lastAppliedConfigVersion to 0 for a current-version cursor persisted without the field', async () => {
      // A cursor written without `lastAppliedConfigVersion`, directly through the underlying
      // text-value store so the test does not depend on `saveCursor`'s current `RunCursor` shape.
      const preAb221Cursor = {
        schemaVersion: 2 as const,
        step: 2,
        totalUsage: { prompt: 10, completion: 5, total: 15 },
        lastContent: 'partial',
        lastParts: [],
        finalRowIsReplacement: false,
        schemaAttempts: 1,
      };
      const underlying = createStore();
      await underlying.set('durable-run:run-1:cursor', JSON.stringify(preAb221Cursor));

      const store = createCheckpointStore(underlying);
      const checkpoint = await store.loadCheckpoint('run-1');
      expect(checkpoint.cursor).toEqual({ ...preAb221Cursor, lastAppliedConfigVersion: 0 });
    });
  });

  describe('clear', () => {
    it('removes every key for a run and returns the count', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('run-1', cursor(1));
      await store.saveConversation(
        'run-1',
        new Conversation(createConversationHistory()).snapshot(),
      );
      await store.saveStep('run-1', {
        schemaVersion: 2,
        parts: [],
        step: 0,
        content: 'x',
        toolCalls: [],
        results: [],
        final: true,
      });

      const deleted = await store.clear('run-1');
      expect(deleted).toBe(3);
      expect(await store.loadCursor('run-1')).toBeNull();
      expect(await store.loadSteps('run-1')).toEqual([]);
    });

    it('does not touch other runs', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('run-1', cursor(1));
      await store.saveCursor('run-2', cursor(9));

      await store.clear('run-1');
      expect(await store.loadCursor('run-2')).toEqual(cursor(9));
    });
  });

  describe('run ids that contain the key delimiter', () => {
    // A run id is caller-chosen (a child run, a goal's attempt). Keys are
    // `durable-run:<id>:<part>`, so an unencoded `:` let one run's keys land
    // inside another run's prefix.
    const victim = 'goal-x-a0';
    const intruder = 'goal-x-a0:step:q';

    it('does not surface another run cursor or transcript as a step record', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveStep(victim, {
        schemaVersion: 2,
        parts: [],
        step: 0,
        content: 'v',
        toolCalls: [],
        results: [],
        final: true,
      });
      await store.saveCursor(intruder, cursor(4));
      await store.saveConversation(
        intruder,
        new Conversation(createConversationHistory()).snapshot(),
      );

      const steps = await store.loadSteps(victim);

      expect(steps).toHaveLength(1);
      expect(steps.map((record) => record.content)).toEqual(['v']);
      const checkpoint = await store.loadCheckpoint(victim);
      expect(checkpoint.cursor.step).toBe(0);
    });

    it('does not clear another run when a run is cleared, in either direction', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor(victim, cursor(1));
      await store.saveCursor(intruder, cursor(2));

      await store.clear(victim);
      expect(await store.loadCursor(intruder)).toEqual(cursor(2));

      await store.saveCursor(victim, cursor(1));
      await store.clear(intruder);
      expect(await store.loadCursor(victim)).toEqual(cursor(1));
    });

    it('keeps ids that differ only by an encoded delimiter apart', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('a:b', cursor(1));
      await store.saveCursor('a%3Ab', cursor(2));

      expect(await store.loadCursor('a:b')).toEqual(cursor(1));
      expect(await store.loadCursor('a%3Ab')).toEqual(cursor(2));
    });
  });

  describe('legacy unescaped keys written by Operative 0.15.x', () => {
    // 0.15.x laid keys out as `durable-run:{runId}:{part}` with the run id
    // verbatim. A session run id is `${sessionId}:${sequence}`, so it contains
    // `:` and 0.16.0 must still read what 0.15.x persisted.
    const sessionRunId = 'user-123:2';
    const legacyStepKey = (runId: string, step: number) =>
      `durable-run:${runId}:step:${String(step).padStart(10, '0')}`;
    const stepRecord = (step: number, content = `step-${step}`): StepRecord => ({
      schemaVersion: 2,
      step,
      content,
      parts: [],
      toolCalls: [],
      results: [],
      final: false,
    });
    async function failure(read: () => Promise<unknown>): Promise<unknown> {
      try {
        await read();
      } catch (error) {
        return error;
      }
      return undefined;
    }
    const persistedSnapshot = new Conversation(createConversationHistory()).snapshot();

    it('reads the cursor, transcript, and steps persisted in the legacy layout', async () => {
      const underlying = createStore();
      await underlying.set(`durable-run:${sessionRunId}:cursor`, JSON.stringify(cursor(2)));
      await underlying.set(
        `durable-run:${sessionRunId}:transcript`,
        JSON.stringify(persistedSnapshot),
      );
      for (const step of [0, 1]) {
        await underlying.set(legacyStepKey(sessionRunId, step), JSON.stringify(stepRecord(step)));
      }

      const store = createCheckpointStore(underlying);

      expect(await store.loadCursor(sessionRunId)).toEqual(cursor(2));
      expect(await store.loadConversation(sessionRunId)).toEqual(
        JSON.parse(JSON.stringify(persistedSnapshot)),
      );
      const loadedSteps = await store.loadSteps(sessionRunId);
      expect(loadedSteps.map((record) => record.step)).toEqual([0, 1]);
      const checkpoint = await store.loadCheckpoint(sessionRunId);
      expect(checkpoint.cursor).toEqual(cursor(2));
      expect(checkpoint.conversation).toEqual(JSON.parse(JSON.stringify(persistedSnapshot)));
      expect(checkpoint.steps).toHaveLength(2);
    });

    it('merges legacy and escaped steps in step order, and the escaped cursor wins', async () => {
      const underlying = createStore();
      await underlying.set(`durable-run:${sessionRunId}:cursor`, JSON.stringify(cursor(1)));
      for (const step of [0, 1, 2]) {
        await underlying.set(legacyStepKey(sessionRunId, step), JSON.stringify(stepRecord(step)));
      }
      const store = createCheckpointStore(underlying);
      await store.saveStep(sessionRunId, stepRecord(3));
      await store.saveCursor(sessionRunId, cursor(4));

      const mergedSteps = await store.loadSteps(sessionRunId);
      expect(mergedSteps.map((record) => record.step)).toEqual([0, 1, 2, 3]);
      expect(await store.loadCursor(sessionRunId)).toEqual(cursor(4));
    });

    it('prefers the escaped step record over a legacy one with the same step number', async () => {
      const underlying = createStore();
      await underlying.set(legacyStepKey(sessionRunId, 1), JSON.stringify(stepRecord(1, 'legacy')));
      const store = createCheckpointStore(underlying);
      await store.saveStep(sessionRunId, stepRecord(1, 'escaped'));
      await store.saveStep(sessionRunId, stepRecord(0));

      const steps = await store.loadSteps(sessionRunId);

      expect(steps.map((record) => [record.step, record.content])).toEqual([
        [0, 'step-0'],
        [1, 'escaped'],
      ]);
    });

    it('never reads another run key under a legacy step prefix as a step, or clears it', async () => {
      const victim = 'x-a0';
      const intruder = 'x-a0:step:q';
      const underlying = createStore();
      // The intruder's legacy keys sit beneath the victim's legacy step prefix.
      await underlying.set(`durable-run:${intruder}:cursor`, JSON.stringify(cursor(7)));
      await underlying.set(`durable-run:${intruder}:transcript`, JSON.stringify(persistedSnapshot));
      await underlying.set(legacyStepKey(intruder, 0), JSON.stringify(stepRecord(0, 'intruder')));
      const store = createCheckpointStore(underlying);
      await store.saveStep(victim, stepRecord(0, 'victim'));

      const victimSteps = await store.loadSteps(victim);
      expect(victimSteps.map((record) => record.content)).toEqual(['victim']);

      await store.clear(victim);

      expect(await underlying.get(`durable-run:${intruder}:cursor`)).not.toBeNull();
      expect(await underlying.get(`durable-run:${intruder}:transcript`)).not.toBeNull();
      expect(await underlying.get(legacyStepKey(intruder, 0))).not.toBeNull();
    });

    it('clear removes the exact keys of both layouts', async () => {
      const underlying = createStore();
      await underlying.set(`durable-run:${sessionRunId}:cursor`, JSON.stringify(cursor(1)));
      await underlying.set(
        `durable-run:${sessionRunId}:transcript`,
        JSON.stringify(persistedSnapshot),
      );
      await underlying.set(legacyStepKey(sessionRunId, 0), JSON.stringify(stepRecord(0)));
      const store = createCheckpointStore(underlying);
      await store.saveCursor(sessionRunId, cursor(2));
      await store.saveStep(sessionRunId, stepRecord(1));

      const deleted = await store.clear(sessionRunId);

      expect(deleted).toBe(5);
      expect(await underlying.list('durable-run:')).toEqual([]);
    });

    it('clear leaves legacy keys that are not exact cursor, transcript, or step keys', async () => {
      const underlying = createStore();
      const unrelated = `durable-run:${sessionRunId}:step:not-a-number`;
      await underlying.set(unrelated, '{}');
      await underlying.set(`durable-run:${sessionRunId}:cursor`, JSON.stringify(cursor(1)));
      const store = createCheckpointStore(underlying);

      await store.clear(sessionRunId);

      expect(await underlying.list('durable-run:')).toEqual([unrelated]);
    });

    it('rejects malformed legacy JSON in strict mode and reads it as absent otherwise', async () => {
      const underlying = createStore();
      await underlying.set(`durable-run:${sessionRunId}:cursor`, '{not json');
      await underlying.set(`durable-run:${sessionRunId}:transcript`, '{not json');
      await underlying.set(legacyStepKey(sessionRunId, 0), '{not json');
      const store = createCheckpointStore(underlying);

      const strictFailures = [
        await failure(() => store.loadCursor(sessionRunId, { strict: true })),
        await failure(() => store.loadConversation(sessionRunId, { strict: true })),
        await failure(() => store.loadSteps(sessionRunId, { strict: true })),
      ];
      expect(strictFailures.map((error) => (error as Error).message)).toEqual([
        expect.stringContaining(`durable-run:${sessionRunId}:cursor`),
        expect.stringContaining(`durable-run:${sessionRunId}:transcript`),
        expect.stringContaining(legacyStepKey(sessionRunId, 0)),
      ]);
      expect(await store.loadCursor(sessionRunId)).toBeNull();
      expect(await store.loadConversation(sessionRunId)).toBeNull();
      expect(await store.loadSteps(sessionRunId)).toEqual([]);
    });

    it('gives an id with an escape sequence but no delimiter no fallback into another run', async () => {
      const underlying = createStore();
      const store = createCheckpointStore(underlying);
      // `a%3Ab`'s unescaped prefix is `durable-run:a%3Ab:`, which is run `a:b`'s escaped prefix.
      await store.saveCursor('a:b', cursor(4));
      await store.saveConversation('a:b', persistedSnapshot);
      await store.saveStep('a:b', stepRecord(0));

      expect(await store.loadCursor('a%3Ab')).toBeNull();
      expect(await store.loadConversation('a%3Ab')).toBeNull();
      expect(await store.loadSteps('a%3Ab')).toEqual([]);
      expect(await store.clear('a%3Ab')).toBe(0);
      expect(await store.loadCursor('a:b')).toEqual(cursor(4));
      expect(await store.loadSteps('a:b')).toEqual([stepRecord(0)]);
    });

    it('reads the legacy keys of an id with a percent sign that escapes no other id', async () => {
      const underlying = createStore();
      await underlying.set('durable-run:job%one:cursor', JSON.stringify(cursor(3)));
      await underlying.set('durable-run:job%one:transcript', JSON.stringify(persistedSnapshot));
      await underlying.set(legacyStepKey('job%one', 0), JSON.stringify(stepRecord(0)));
      const store = createCheckpointStore(underlying);

      expect(await store.loadCursor('job%one')).toEqual(cursor(3));
      expect(await store.loadConversation('job%one')).toEqual(persistedSnapshot);
      expect(await store.loadSteps('job%one')).toEqual([stepRecord(0)]);
      expect(await store.clear('job%one')).toBe(3);
      expect(await underlying.list('durable-run:')).toEqual([]);
    });

    it('reads, orders, and clears legacy steps numbered past ten digits', async () => {
      const underlying = createStore();
      await underlying.set(
        legacyStepKey(sessionRunId, 10_000_000_000),
        JSON.stringify(stepRecord(10_000_000_000)),
      );
      await underlying.set(legacyStepKey(sessionRunId, 9), JSON.stringify(stepRecord(9)));
      const store = createCheckpointStore(underlying);

      const legacySteps = await store.loadSteps(sessionRunId);
      expect(legacySteps.map((record) => record.step)).toEqual([9, 10_000_000_000]);
      expect(await store.clear(sessionRunId)).toBe(2);
      expect(await underlying.list('durable-run:')).toEqual([]);
    });
  });

  describe('steps numbered past ten digits', () => {
    const stepRecord = (step: number): StepRecord => ({
      schemaVersion: 2,
      step,
      content: `step-${step}`,
      parts: [],
      toolCalls: [],
      results: [],
      final: false,
    });

    it('loads them in numeric order and clears them, for ordinary and delimited ids', async () => {
      for (const runId of ['run-wide', 'user-9:1']) {
        const underlying = createStore();
        const store = createCheckpointStore(underlying);
        await store.saveStep(runId, stepRecord(10_000_000_000));
        await store.saveStep(runId, stepRecord(9_999_999_999));
        await store.saveStep(runId, stepRecord(2));

        const steps = await store.loadSteps(runId);
        expect(steps.map((record) => record.step)).toEqual([2, 9_999_999_999, 10_000_000_000]);
        expect(await store.clear(runId)).toBe(3);
        expect(await underlying.list('durable-run:')).toEqual([]);
      }
    });
  });

  describe('durable shape version (COR-713)', () => {
    const thinking = { type: 'thinking', thinking: 'Plan.', signature: 'sig-1' } as const;
    const generatedImage = {
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'managed-asset', assetId: 'asset-7', revision: 2 },
    } as const;

    async function failure(read: () => Promise<unknown>): Promise<unknown> {
      try {
        await read();
      } catch (error) {
        return error;
      }
      return undefined;
    }

    it('round-trips a step record with its parts, asset references and row id', async () => {
      const store = createCheckpointStore(createStore());
      const record: StepRecord = {
        schemaVersion: 2,
        step: 0,
        content: 'Done',
        parts: [thinking, generatedImage, { type: 'text', text: 'Done' }],
        messageId: 'row-1',
        toolCalls: [],
        results: [],
        final: true,
      };
      await store.saveStep('run-1', record);
      expect(await store.loadSteps('run-1', { strict: true })).toEqual([record]);
    });

    it('round-trips the context epoch a step ran under', async () => {
      const store = createCheckpointStore(createStore());
      const record: StepRecord = {
        schemaVersion: 2,
        step: 0,
        content: 'Done',
        parts: [{ type: 'text', text: 'Done' }],
        toolCalls: [],
        results: [],
        contextEpochId: 'epoch-1',
        final: true,
      };
      await store.saveStep('run-1', record);
      expect(await store.loadSteps('run-1', { strict: true })).toEqual([record]);
    });

    it('round-trips the plan reason and effective context a step ran under (COR-1810)', async () => {
      const store = createCheckpointStore(createStore());
      const record: StepRecord = {
        schemaVersion: 2,
        step: 0,
        content: 'Done',
        parts: [{ type: 'text', text: 'Done' }],
        toolCalls: [],
        results: [],
        contextEpochId: 'epoch-1',
        planReason: {
          code: 'cost',
          detail: 'a ranked ahead of b on cost',
          rejected: [{ provider: 'openai', model: 'gpt-4o', code: 'policy' }],
        },
        effectiveContext: {
          version: 1,
          kind: 'delta',
          epochId: 'epoch-1',
          baselineDigest: '0123456789abcdef',
          sources: [{ sourceId: 'conversation', trust: 'per-message', disposition: 'included' }],
          messageCount: 2,
          conversationDigest: 'sha256:00',
          messagesFrom: 1,
          prefixDigest: 'sha256:01',
          messages: [{ id: 'message-2', role: 'user', digest: 'fedcba9876543210' }],
        },
        final: true,
      };
      await store.saveStep('run-1', record);
      expect(await store.loadSteps('run-1', { strict: true })).toEqual([record]);
    });

    it('reads a step record written before the plan reason and effective context existed, with neither', async () => {
      const underlying = createStore();
      const store = createCheckpointStore(underlying);
      await store.saveStep('run-1', {
        schemaVersion: 2,
        step: 0,
        content: 'Done',
        parts: [{ type: 'text', text: 'Done' }],
        toolCalls: [],
        results: [],
        contextEpochId: 'epoch-1',
        final: true,
      });

      const [loaded] = await store.loadSteps('run-1', { strict: true });
      const checkpoint = await store.loadCheckpoint('run-1', { strict: true });

      expect(loaded?.planReason).toBeUndefined();
      expect(loaded?.effectiveContext).toBeUndefined();
      expect(loaded?.contextEpochId).toBe('epoch-1');
      expect(checkpoint.steps).toEqual([loaded!]);
    });

    it('round-trips a cursor with the final row parts and the replacement flag', async () => {
      const store = createCheckpointStore(createStore());
      const replaced: RunCursor = {
        ...cursor(2),
        lastContent: 'Summary',
        lastParts: [{ type: 'text', text: 'Summary' }],
        finalRowIsReplacement: true,
      };
      await store.saveCursor('run-1', replaced);
      expect(await store.loadCursor('run-1', { strict: true })).toEqual(replaced);
    });

    it('fails a versionless cursor with the explicit error, in strict and tolerant reads', async () => {
      const underlying = createStore();
      await underlying.set(
        'durable-run:run-1:cursor',
        JSON.stringify({
          step: 1,
          totalUsage: { prompt: 1, completion: 1, total: 2 },
          lastContent: 'old',
          schemaAttempts: 0,
          lastAppliedConfigVersion: 0,
        }),
      );
      const store = createCheckpointStore(underlying);

      for (const options of [undefined, { strict: true }]) {
        const error = await failure(() => store.loadCursor('run-1', options));
        expect(error).toBeInstanceOf(UnsupportedCheckpointRecordVersionError);
        expect((error as UnsupportedCheckpointRecordVersionError).record).toBe('cursor');
        expect((error as UnsupportedCheckpointRecordVersionError).version).toBeUndefined();
        expect(await failure(() => store.loadCheckpoint('run-1', options))).toBeInstanceOf(
          UnsupportedCheckpointRecordVersionError,
        );
      }
    });

    it('fails a versionless step record with the explicit error, in strict and tolerant reads', async () => {
      const underlying = createStore();
      await underlying.set(
        'durable-run:run-1:step:0000000000',
        JSON.stringify({ step: 0, content: 'old', toolCalls: [], results: [], final: true }),
      );
      const store = createCheckpointStore(underlying);

      for (const options of [undefined, { strict: true }]) {
        const error = await failure(() => store.loadSteps('run-1', options));
        expect(error).toBeInstanceOf(UnsupportedCheckpointRecordVersionError);
        expect((error as UnsupportedCheckpointRecordVersionError).record).toBe('step');
      }
    });

    it('treats a current-version record that lacks its parts as malformed, never as a derivation from content', async () => {
      const underlying = createStore();
      await underlying.set(
        'durable-run:run-1:step:0000000000',
        JSON.stringify({ schemaVersion: 2, step: 0, content: 'no parts', final: true }),
      );
      await underlying.set(
        'durable-run:run-1:cursor',
        JSON.stringify({ ...cursor(1), lastParts: undefined }),
      );
      const store = createCheckpointStore(underlying);

      expect(await failure(() => store.loadSteps('run-1', { strict: true }))).toBeInstanceOf(Error);
      expect(await store.loadSteps('run-1')).toEqual([]);
      expect(await failure(() => store.loadCursor('run-1', { strict: true }))).toBeInstanceOf(
        Error,
      );
      expect(await store.loadCursor('run-1')).toBeNull();
    });

    it('refuses to write a cursor or step record at any other version, or without its parts', async () => {
      const store = createCheckpointStore(createStore());

      expect(
        await failure(() => store.saveCursor('run-1', { ...cursor(1), schemaVersion: 1 } as never)),
      ).toBeInstanceOf(UnsupportedCheckpointRecordVersionError);
      expect(
        await failure(() =>
          store.saveCursor('run-1', { ...cursor(1), lastParts: undefined } as never),
        ),
      ).toBeInstanceOf(UnsupportedCheckpointRecordVersionError);
      expect(
        await failure(() =>
          store.saveStep('run-1', {
            step: 0,
            content: 'x',
            toolCalls: [],
            results: [],
            final: true,
          } as never),
        ),
      ).toBeInstanceOf(UnsupportedCheckpointRecordVersionError);
      expect(
        await failure(() =>
          store.saveStep('run-1', {
            schemaVersion: 2,
            step: 0,
            content: 'x',
            toolCalls: [],
            results: [],
            final: true,
          } as never),
        ),
      ).toBeInstanceOf(UnsupportedCheckpointRecordVersionError);
    });

    it('gives a run with no cursor a current-version default', async () => {
      const store = createCheckpointStore(createStore());
      const { cursor: defaulted } = await store.loadCheckpoint('missing');
      expect(defaulted).toMatchObject({
        schemaVersion: 2,
        lastParts: [],
        finalRowIsReplacement: false,
      });
    });
  });
});
