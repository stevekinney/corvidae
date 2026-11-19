/**
 * Retry from this step on a failed run of a workflow file (COR-2424, rows 54z, 14t, 55b): the write
 * that runs the run again in place from the step it failed at (`bureau.workflows.runs.retry`), and
 * what the page reads again once it has. Created while a component initializes, because it opens a
 * mutation.
 *
 * Each press is one request with an identifier of its own, so the Bureau answers a repeat of it as
 * the first and never runs the step twice; the button is held while the request is out.
 */
import { HttpClientError } from '@lostgradient/weft';
import { createMutation, useQueryClient } from '@tanstack/svelte-query';

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import { showFault } from '../../../app/toast-host.svelte';
import { faultTreatment } from '../../../lib/faults.ts';
import { queryKeys } from '../../../lib/query.ts';
import { retryWorkflowRun } from '../../../lib/workflow-files.ts';

/** What the page knows of the run that decides whether it can be retried. */
export interface RunRetrySource {
  readonly runId: string;
  /** The step the run failed at, counted from one, when the history says. */
  readonly failedStep: number | undefined;
  /** Whether the run is a failed instance of a workflow file. */
  readonly failedInstance: boolean;
}

/** The words for a refusal the Bureau gave, by its reason, or `undefined` for another failure. */
export function retryRefusalWords(error: unknown): string | undefined {
  if (!(error instanceof HttpClientError)) return undefined;
  const reason = error.data?.['reason'];
  if (typeof reason !== 'string') return undefined;
  const words = RUN_DETAIL_COPY.instance.retryRefused;
  return Object.hasOwn(words, reason) ? words[reason] : undefined;
}

export class RunRetry {
  readonly #source: () => RunRetrySource;
  readonly #retry;

  constructor(source: () => RunRetrySource) {
    this.#source = source;
    const queryClient = useQueryClient();
    this.#retry = createMutation(() => ({
      mutationFn: (request: { runId: string; step: number }) =>
        retryWorkflowRun(request.runId, request.step, crypto.randomUUID()),
      onSuccess: () => {
        const runId = this.#source().runId;
        void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(runId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.fileRun(runId) });
        void queryClient.invalidateQueries({ queryKey: ['run-instance'] });
      },
      onError: (error: unknown) => {
        const refused = retryRefusalWords(error);
        showFault({
          ...faultTreatment(error),
          message: `${RUN_DETAIL_COPY.instance.retryFailed}. ${refused ?? faultTreatment(error).message}`,
        });
      },
    }));
  }

  /** The step Retry from this step runs again, or `undefined` when the run offers no retry. */
  get step(): number | undefined {
    const read = this.#source();
    return read.failedInstance ? read.failedStep : undefined;
  }

  /** Whether the request is out. */
  get busy(): boolean {
    return this.#retry.isPending;
  }

  /** Runs the failed step again; a second press while the first is out does nothing. */
  retry(): void {
    const step = this.step;
    if (step === undefined || this.busy) return;
    this.#retry.mutate({ runId: this.#source().runId, step });
  }
}
