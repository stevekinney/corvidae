/**
 * The main-thread half of the off-thread runtime evaluator (COR-254). The first evaluation of
 * a draft runs the whole token runtime, which holds the thread it runs on for hundreds of
 * milliseconds on a fast machine and seconds on a loaded one. The builder runs that work in a
 * module worker and keeps the page interactive; this adapter implements the same
 * `ThemeEvaluator` seam as the in-thread evaluator, so no caller changes.
 *
 * Results are kept per envelope object (every commit makes a new one), like the in-thread
 * evaluator, so asking again for the same revision and context never reaches the worker.
 */

import type { ThemeEvaluation, ThemeEvaluator } from './theme-draft-evaluation.ts';
import type { ThemeBase, ThemeContextId, ThemeEnvelope } from './theme-draft-types.ts';

/**
 * A request carries the envelope without its base. The base is the whole Cinder source
 * snapshot, it never changes while a theme is open, and copying it into the worker on every
 * edit would cost more than the edit's evaluation. It travels once per worker, in `base`, and
 * the worker looks it up by `baseId` afterwards.
 */
export type EvaluationRequest = {
  id: number;
  baseId: number;
  base?: ThemeBase;
  source: Omit<ThemeEnvelope, 'base'>;
  revision: number;
  context: ThemeContextId;
};

export type EvaluationResponse =
  { id: number; evaluation: ThemeEvaluation } | { id: number; failure: string };

/** The slice of `Worker` the adapter uses, so tests drive it with a fake. */
export type EvaluationWorker = {
  postMessage(message: EvaluationRequest): void;
  addEventListener(type: 'message', listener: (event: { data: EvaluationResponse }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  terminate(): void;
};

type Pending = {
  resolve: (evaluation: ThemeEvaluation) => void;
  reject: (error: Error) => void;
};

export function createWorkerEvaluator(createWorker: () => EvaluationWorker): ThemeEvaluator {
  const results = new WeakMap<ThemeEnvelope, Map<string, Promise<ThemeEvaluation>>>();
  const pending = new Map<number, Pending>();
  let worker: EvaluationWorker | null = null;
  let nextId = 1;
  const baseIds = new WeakMap<ThemeBase, number>();
  let nextBaseId = 1;
  // The bases the current worker already holds; a fresh worker holds none.
  let sentBases = new WeakSet<ThemeBase>();

  const failAll = (reason: string): void => {
    const waiting = [...pending.values()];
    pending.clear();
    worker?.terminate();
    // The next request starts a fresh worker rather than talking to a dead one.
    worker = null;
    sentBases = new WeakSet();
    for (const entry of waiting) entry.reject(new Error(reason));
  };

  const start = (): EvaluationWorker => {
    const created = createWorker();
    created.addEventListener('message', (event) => {
      const response = event.data;
      const entry = pending.get(response.id);
      if (entry === undefined) return;
      pending.delete(response.id);
      if ('failure' in response) entry.reject(new Error(response.failure));
      else entry.resolve(response.evaluation);
    });
    created.addEventListener('error', (event) => {
      failAll(`the theme evaluation worker failed: ${event.message ?? 'unknown error'}`);
    });
    return created;
  };

  return {
    evaluate(source, revision, context): Promise<ThemeEvaluation> {
      const key = `${revision}:${context}`;
      const forEnvelope = results.get(source) ?? new Map<string, Promise<ThemeEvaluation>>();
      results.set(source, forEnvelope);
      const remembered = forEnvelope.get(key);
      if (remembered !== undefined) return remembered;
      const id = nextId;
      nextId += 1;
      const evaluation = new Promise<ThemeEvaluation>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker ??= start();
        const { base, ...rest } = source;
        let baseId = baseIds.get(base);
        if (baseId === undefined) {
          baseId = nextBaseId;
          nextBaseId += 1;
          baseIds.set(base, baseId);
        }
        const firstSend = !sentBases.has(base);
        sentBases.add(base);
        const request: EvaluationRequest = {
          id,
          baseId,
          ...(firstSend ? { base } : {}),
          source: rest,
          revision,
          context,
        };
        // A dedicated worker has no target origin; this is not Window.postMessage.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        worker.postMessage(request);
      });
      forEnvelope.set(key, evaluation);
      // A failed evaluation is not remembered, so asking again retries on a fresh worker.
      evaluation.catch(() => forEnvelope.delete(key));
      return evaluation;
    },
  };
}
