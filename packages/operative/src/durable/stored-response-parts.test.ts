/**
 * COR-1581 — every reader of stored response parts validates them through one function. Each reader
 * keeps its own way of refusing, so each is exercised here with `parts: [null]` and an inline-bytes
 * part (inline bytes are admitted as managed assets before a row is persisted, so a stored part that
 * still carries them was never admitted).
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { InvalidRunResultError } from '../run-envelope';
import { validateStoredResponseParts } from '../stored-parts';
import { createCheckpointStore } from './checkpoint-store';
import {
  assertCurrentStepMemo,
  isCurrentCheckpointRecord,
  UnsupportedCheckpointRecordVersionError,
} from './checkpoint-version';
import { normalizeAgentRunWorkflowResult } from './run-workflow-result';
import type { RunCursor, StepRecord } from './types';

const inlineImage = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'inline', data: 'AAAA', encoding: 'base64' },
} as const;

const managedImage = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'managed-asset', assetId: 'asset-1' },
} as const;

const badParts = [
  ['a null element', [null]],
  ['an inline-bytes part', [inlineImage]],
  ['an inline part after a valid one', [{ type: 'text', text: 'ok' }, inlineImage]],
] as const;

const createStore = () => textValueStore(new MemoryStorage());

function cursorWith(lastParts: unknown): RunCursor {
  return {
    schemaVersion: 2,
    step: 1,
    totalUsage: { prompt: 0, completion: 0, total: 0 },
    lastContent: '',
    lastParts,
    finalRowIsReplacement: false,
    schemaAttempts: 0,
    lastAppliedConfigVersion: 0,
  } as RunCursor;
}

function stepWith(parts: unknown): StepRecord {
  return {
    schemaVersion: 2,
    step: 0,
    content: 'x',
    parts,
    toolCalls: [],
    results: [],
    final: true,
  } as StepRecord;
}

function summaryWith(parts: unknown) {
  return {
    schemaVersion: 3,
    runId: 'run-1',
    steps: 1,
    content: 'x',
    parts,
    finishReason: 'stop-condition',
  };
}

async function failure(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('validateStoredResponseParts', () => {
  it('accepts text and managed-asset parts', () => {
    expect(validateStoredResponseParts([])).toEqual({ valid: true });
    expect(validateStoredResponseParts([{ type: 'text', text: 'hi' }, managedImage])).toEqual({
      valid: true,
    });
  });

  it('refuses a non-array, a null element and an inline source, naming the element', () => {
    expect(validateStoredResponseParts(undefined)).toEqual({
      valid: false,
      reason: 'parts must be an array',
    });
    expect(validateStoredResponseParts([null])).toEqual({
      valid: false,
      reason: 'parts[0] is not a valid content part',
    });
    expect(validateStoredResponseParts([{ type: 'text', text: 'ok' }, inlineImage])).toEqual({
      valid: false,
      reason: 'parts[1] carries inline bytes',
    });
  });
});

describe('stored response parts readers (COR-1581)', () => {
  describe('the durable run result', () => {
    it('accepts valid parts', () => {
      expect(normalizeAgentRunWorkflowResult(summaryWith([managedImage])).parts).toEqual([
        managedImage,
      ]);
    });

    for (const [name, parts] of badParts) {
      it(`throws InvalidRunResultError for ${name}`, () => {
        expect(() => normalizeAgentRunWorkflowResult(summaryWith(parts))).toThrow(
          InvalidRunResultError,
        );
      });
    }
  });

  describe('the checkpoint record check', () => {
    for (const [name, parts] of badParts) {
      it(`reports a step record with ${name} as not current`, () => {
        expect(isCurrentCheckpointRecord('step', stepWith(parts))).toBe(false);
      });

      it(`reports a cursor with ${name} in lastParts as not current`, () => {
        expect(isCurrentCheckpointRecord('cursor', cursorWith(parts))).toBe(false);
      });
    }

    it('reports a valid record as current', () => {
      expect(isCurrentCheckpointRecord('step', stepWith([managedImage]))).toBe(true);
      expect(isCurrentCheckpointRecord('cursor', cursorWith([managedImage]))).toBe(true);
    });
  });

  describe('the checkpoint store loads', () => {
    for (const [name, parts] of badParts) {
      it(`fails a strict load and skips a tolerant one for a step record with ${name}`, async () => {
        const underlying = createStore();
        await underlying.set('durable-run:run-1:step:0000000000', JSON.stringify(stepWith(parts)));
        const store = createCheckpointStore(underlying);

        expect(await failure(() => store.loadSteps('run-1', { strict: true }))).toBeInstanceOf(
          Error,
        );
        expect(await store.loadSteps('run-1')).toEqual([]);
      });

      it(`fails a strict load and reads null for a cursor with ${name}`, async () => {
        const underlying = createStore();
        await underlying.set('durable-run:run-1:cursor', JSON.stringify(cursorWith(parts)));
        const store = createCheckpointStore(underlying);

        expect(await failure(() => store.loadCursor('run-1', { strict: true }))).toBeInstanceOf(
          Error,
        );
        expect(await store.loadCursor('run-1')).toBeNull();
      });
    }
  });

  describe('the write check and step replay', () => {
    for (const [name, parts] of badParts) {
      it(`refuses to write a step record with ${name}`, async () => {
        const store = createCheckpointStore(createStore());
        expect(await failure(() => store.saveStep('run-1', stepWith(parts)))).toBeInstanceOf(
          UnsupportedCheckpointRecordVersionError,
        );
      });

      it(`refuses to write a cursor with ${name} in lastParts`, async () => {
        const store = createCheckpointStore(createStore());
        expect(await failure(() => store.saveCursor('run-1', cursorWith(parts)))).toBeInstanceOf(
          UnsupportedCheckpointRecordVersionError,
        );
      });

      it(`refuses to replay a step memo whose record has ${name}`, () => {
        expect(() =>
          assertCurrentStepMemo({
            record: stepWith(parts),
            nextAccumulators: { lastParts: [], finalRowIsReplacement: false },
          }),
        ).toThrow(UnsupportedCheckpointRecordVersionError);
      });

      it(`refuses to replay a step memo whose carried lastParts has ${name}`, () => {
        expect(() =>
          assertCurrentStepMemo({
            record: null,
            nextAccumulators: { lastParts: parts, finalRowIsReplacement: false },
          }),
        ).toThrow(UnsupportedCheckpointRecordVersionError);
      });
    }

    it('replays a valid memo', () => {
      expect(() =>
        assertCurrentStepMemo({
          record: stepWith([managedImage]),
          nextAccumulators: { lastParts: [managedImage], finalRowIsReplacement: false },
        }),
      ).not.toThrow();
    });
  });
});
