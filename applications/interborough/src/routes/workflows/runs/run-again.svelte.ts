/**
 * Run again on a run's page: what it does for the run (`run-again.ts`), whether it is held for want
 * of a model provider, and the write that starts a schedule's run now. Created while a component
 * initializes, because it opens a query and a mutation.
 *
 * Whether a provider is connected and which agents name a model are read only for a run that has a
 * Run again, and a read that fails leaves the button live: it is never said to be blocked on a guess.
 */
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

import { SCHEDULE_COPY } from '../../../app/copy/schedules.ts';
import { showFault, showToast } from '../../../app/toast-host.svelte';
import { readScheduleAttention } from '../../../lib/bureau-attention.ts';
import { runNowAgentSchedule, type RunNowOutcome } from '../../../lib/bureau-schedules.ts';
import { faultTreatment } from '../../../lib/faults.ts';
import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
import { loadModelAgents } from '../../schedules/schedule-row-context.ts';
import { runAgainBlocked, runAgainOf, type RunAgainInput, type RunAgainKind } from './run-again.ts';

/** What the page hands Run again: what it has read of the run, and the agents the run uses. */
export type RunAgainSource = RunAgainInput & {
  /** The agents the run uses, whose models decide whether a missing provider holds it. */
  readonly agents: readonly string[];
};

export class RunAgain {
  readonly #source: () => RunAgainSource;
  readonly #provider;
  readonly #start;

  constructor(source: () => RunAgainSource) {
    this.#source = source;
    const queryClient = useQueryClient();
    this.#provider = createQuery(() => {
      const read = source();
      return {
        queryKey: ['run-again', 'provider', read.agents.toSorted().join(',')] as const,
        queryFn: async ({ signal }: { signal: AbortSignal }) => {
          const [attention, modelAgents] = await Promise.all([
            readScheduleAttention({ signal }),
            loadModelAgents(read.agents, { signal }),
          ]);
          return { noProvider: attention.noProvider, modelAgents };
        },
        enabled: runAgainOf(read) !== undefined && read.agents.length > 0,
        retry: false,
      };
    });
    this.#start = createMutation(() => ({
      mutationFn: (scheduleId: string) => runNowAgentSchedule(scheduleId),
      onSuccess: (outcome: RunNowOutcome) => {
        const copy = SCHEDULE_COPY.detail;
        if (outcome.outcome === 'skipped') {
          showToast(copy.runNowOutcome.skipped, { variant: 'warning' });
          return;
        }
        const path = workflowDetailPath(outcome.runId);
        showToast(
          outcome.outcome === 'queued' ? copy.runNowOutcome.queued : copy.runNowOutcome.started,
          {
            variant: 'success',
            showIcon: true,
            action: { label: copy.openRun, onAction: () => router.navigate(path) },
          },
        );
        void queryClient.invalidateQueries({ queryKey: ['bureau-tasks'] });
      },
      onError: (error: unknown) =>
        showFault({
          ...faultTreatment(error),
          message: `${SCHEDULE_COPY.runNowFailed}. ${faultTreatment(error).message}`,
        }),
    }));
  }

  /** What Run again does, or `undefined` when the run has none. */
  get kind(): RunAgainKind | undefined {
    return runAgainOf(this.#source());
  }

  /** Whether Run again is held for want of a model provider. */
  get blocked(): boolean {
    const read = this.#provider.data;
    return (
      read !== undefined &&
      runAgainBlocked({
        noProvider: read.noProvider,
        agents: this.#source().agents,
        modelAgents: read.modelAgents,
      })
    );
  }

  /** Whether the schedule's run is being started. */
  get busy(): boolean {
    return this.#start.isPending;
  }

  /** Starts the schedule's run now; a run that opens a page is opened by the header's link. */
  run(): void {
    const kind = this.kind;
    if (kind?.kind === 'schedule' && !this.blocked && !this.busy)
      this.#start.mutate(kind.scheduleId);
  }
}
