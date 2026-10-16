import { throwingRejectionOf } from '@lostgradient/testing';
import { describe, expect, it } from 'bun:test';

import { cinderThemeBase } from './theme-builder-base.ts';
import type { ThemeEvaluation } from './theme-draft-evaluation.ts';
import { createDraft } from './theme-draft.ts';
import { createEnvelope } from './theme-envelope.ts';
import {
  createRuntimeEvaluator,
  defaultThemeEvaluator,
  installThemeEvaluator,
} from './theme-runtime-evaluator.ts';
import {
  createWorkerEvaluator,
  type EvaluationRequest,
  type EvaluationResponse,
  type EvaluationWorker,
} from './theme-worker-evaluator.ts';
import { createEvaluationHandler } from './theme-worker-handler.ts';

/**
 * A worker that answers from the in-thread evaluator, the way `theme-runtime-worker.ts` does,
 * and that records what it was asked and can be told to fail.
 */
class FakeWorker implements EvaluationWorker {
  static created: FakeWorker[] = [];
  requests: EvaluationRequest[] = [];
  terminated = false;
  #message: Array<(event: { data: EvaluationResponse }) => void> = [];
  #error: Array<(event: { message?: string }) => void> = [];
  #handle = createEvaluationHandler((response) => this.#reply(response));

  constructor() {
    FakeWorker.created.push(this);
  }

  postMessage(request: EvaluationRequest): void {
    // Structured clone, as a real worker boundary does: nothing shared survives it.
    const delivered = structuredClone(request);
    this.requests.push(request);
    this.#handle(delivered);
  }

  addEventListener(type: 'message' | 'error', listener: never): void {
    if (type === 'message') this.#message.push(listener);
    else this.#error.push(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(message: string): void {
    for (const listener of this.#error) listener({ message });
  }

  #reply(response: EvaluationResponse): void {
    for (const listener of this.#message) listener({ data: response });
  }
}

const envelope = createDraft(createEnvelope('theme-1', 'Test theme', cinderThemeBase())).envelope;
// Evaluate once at module scope: Bun's per-test budget must not cover the cold runtime.
const direct = await createRuntimeEvaluator().evaluate(envelope, 1, 'light/default');

function properties(evaluation: ThemeEvaluation) {
  if (!evaluation.ok) throw new Error('evaluation failed');
  return evaluation.properties;
}

describe('createWorkerEvaluator', () => {
  it('returns what the in-thread evaluator returns, tagged with its revision and context', async () => {
    FakeWorker.created = [];
    const evaluator = createWorkerEvaluator(() => new FakeWorker());
    const result = await evaluator.evaluate(envelope, 1, 'light/default');
    expect(result.revision).toBe(1);
    expect(result.context).toBe('light/default');
    expect(properties(result)).toEqual(properties(direct));
  });

  it('asks the worker once per envelope, revision and context', async () => {
    FakeWorker.created = [];
    const evaluator = createWorkerEvaluator(() => new FakeWorker());
    const first = await evaluator.evaluate(envelope, 1, 'light/default');
    const again = await evaluator.evaluate(envelope, 1, 'light/default');
    expect(again).toBe(first);
    await evaluator.evaluate(envelope, 1, 'dark/default');
    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0]!.requests).toHaveLength(2);
  });

  it('sends the base once per worker, not with every request', async () => {
    FakeWorker.created = [];
    const evaluator = createWorkerEvaluator(() => new FakeWorker());
    await evaluator.evaluate(envelope, 1, 'light/default');
    await evaluator.evaluate({ ...envelope }, 2, 'light/default');
    await evaluator.evaluate({ ...envelope }, 3, 'dark/default');
    const requests = FakeWorker.created[0]!.requests;
    expect(requests.map((request) => request.base !== undefined)).toEqual([true, false, false]);
    expect(new Set(requests.map((request) => request.baseId)).size).toBe(1);
    expect(requests.every((request) => !('base' in request.source))).toBe(true);
  });

  it('sends the base again to a replacement worker', async () => {
    FakeWorker.created = [];
    const evaluator = createWorkerEvaluator(() => new FakeWorker());
    const waiting = evaluator.evaluate(envelope, 5, 'light/default');
    FakeWorker.created[0]!.crash('gone');
    await throwingRejectionOf(waiting);
    await evaluator.evaluate({ ...envelope }, 6, 'light/default');
    expect(FakeWorker.created[1]!.requests[0]!.base).toBeDefined();
  });

  it('keeps concurrent requests apart', async () => {
    FakeWorker.created = [];
    const evaluator = createWorkerEvaluator(() => new FakeWorker());
    const [light, dark] = await Promise.all([
      evaluator.evaluate(envelope, 1, 'light/default'),
      evaluator.evaluate(envelope, 1, 'dark/default'),
    ]);
    expect(light.context).toBe('light/default');
    expect(dark.context).toBe('dark/default');
  });

  it('rejects the waiting requests when the worker crashes and starts a fresh worker next time', async () => {
    FakeWorker.created = [];
    const evaluator = createWorkerEvaluator(() => new FakeWorker());
    const waiting = evaluator.evaluate(envelope, 2, 'light/default');
    const crashed = FakeWorker.created[0]!;
    crashed.crash('boom');
    expect(await throwingRejectionOf(waiting)).toThrow('boom');
    expect(crashed.terminated).toBe(true);
    const retried = await evaluator.evaluate(envelope, 2, 'light/default');
    expect(retried.ok).toBe(true);
    expect(FakeWorker.created).toHaveLength(2);
  });
});

describe('the shared evaluator', () => {
  it('is the installed evaluator, and the in-thread one otherwise', () => {
    installThemeEvaluator(null);
    const inThread = defaultThemeEvaluator();
    expect(defaultThemeEvaluator()).toBe(inThread);
    const installed = createWorkerEvaluator(() => new FakeWorker());
    installThemeEvaluator(installed);
    expect(defaultThemeEvaluator()).toBe(installed);
    installThemeEvaluator(null);
    expect(defaultThemeEvaluator()).toBe(inThread);
  });
});
