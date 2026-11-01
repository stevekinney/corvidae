/**
 * Pause, resume, skip next, run now, and cancel for the schedules list and a schedule's page, sharing one way of
 * answering a write that did not go through. Called while a component initialises, because it
 * creates mutations.
 *
 * A write that named a revision or a hash that is no longer current is refused, and nothing is
 * written. That is not a failure of the person's: the page says the schedule changed since it was
 * loaded, reloads it, and leaves the next move to them. A workflow file's write that reached the
 * file but that the engine could not follow is the same kind of answer. Anything else is a toast.
 */
import { createMutation, useQueryClient } from '@tanstack/svelte-query';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import { showFault } from '../../app/toast-host.svelte';
import { agentFaultOf } from '../../lib/agent-definitions.ts';
import type { RunNowOutcome } from '../../lib/bureau-schedules.ts';
import { getClient } from '../../lib/client.ts';
import { faultTreatment } from '../../lib/faults.ts';
import { isApplyFailure } from '../../lib/workflow-files.ts';
import {
  cancelTarget,
  pauseTarget,
  resumeTarget,
  runNowTarget,
  skipNextTarget,
  StaleScheduleError,
  type ScheduleTarget,
} from './schedule-writes.ts';

/** What the page says after a write that was refused for being stale, or applied late. */
export type ScheduleNotice = {
  readonly kind: 'stale' | 'unapplied';
  readonly scheduleId: string;
};

export function createScheduleActions() {
  const client = getClient();
  const queryClient = useQueryClient();
  let notice = $state<ScheduleNotice | null>(null);
  /** What the last run now did, for the page to say and to link to the run. */
  let runNowResult = $state.raw<(RunNowOutcome & { readonly scheduleId: string }) | null>(null);

  /** Reads every schedule query again: the list, the page, its runs, and what the Bureau knows. */
  function reload(): void {
    void queryClient.invalidateQueries({ queryKey: ['schedules'] });
  }

  function answer(error: unknown, target: ScheduleTarget, title: string): void {
    if (isApplyFailure(error)) {
      notice = { kind: 'unapplied', scheduleId: target.schedule.id };
      reload();
      return;
    }
    if (error instanceof StaleScheduleError || agentFaultOf(error).kind === 'stale') {
      notice = { kind: 'stale', scheduleId: target.schedule.id };
      reload();
      return;
    }
    showFault({ ...faultTreatment(error), message: `${title}. ${faultTreatment(error).message}` });
  }

  function writer(write: typeof pauseTarget, title: string) {
    return createMutation(() => ({
      mutationFn: (target: ScheduleTarget) => write(client, target),
      onMutate: () => {
        notice = null;
      },
      onSuccess: reload,
      onError: (error: unknown, target: ScheduleTarget) => answer(error, target, title),
    }));
  }

  const pause = writer(pauseTarget, SCHEDULE_COPY.pauseFailed);
  const resume = writer(resumeTarget, SCHEDULE_COPY.resumeFailed);
  const cancel = writer(cancelTarget, SCHEDULE_COPY.cancelFailed);
  /** A skip names the run the person saw, which the server compares inside its own write. */
  const skipNext = createMutation(() => ({
    mutationFn: ({ target, occurrence }: { target: ScheduleTarget; occurrence: number }) =>
      skipNextTarget(client, target, occurrence),
    onMutate: () => {
      notice = null;
    },
    onSuccess: reload,
    onError: (error: unknown, { target }: { target: ScheduleTarget; occurrence: number }) =>
      answer(error, target, SCHEDULE_COPY.skipFailed),
  }));
  const runNow = createMutation(() => ({
    mutationFn: (target: ScheduleTarget) => runNowTarget(client, target),
    onMutate: () => {
      notice = null;
      runNowResult = null;
    },
    onSuccess: (outcome: RunNowOutcome, target: ScheduleTarget) => {
      runNowResult = { ...outcome, scheduleId: target.schedule.id };
      reload();
    },
    onError: (error: unknown, target: ScheduleTarget) =>
      answer(error, target, SCHEDULE_COPY.runNowFailed),
  }));

  return {
    pause,
    resume,
    cancel,
    skipNext,
    runNow,
    get runNowResult(): (RunNowOutcome & { readonly scheduleId: string }) | null {
      return runNowResult;
    },
    dismissRunNow(): void {
      runNowResult = null;
    },
    get notice(): ScheduleNotice | null {
      return notice;
    },
    dismiss(): void {
      notice = null;
    },
    get busy(): boolean {
      return (
        pause.isPending ||
        resume.isPending ||
        cancel.isPending ||
        skipNext.isPending ||
        runNow.isPending
      );
    },
  };
}
