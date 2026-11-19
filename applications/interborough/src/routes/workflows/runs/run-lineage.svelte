<script lang="ts">
  /**
   * What started a run, and what started that: a list that opens with this run's origin (the chat,
   * the schedule, the goal, the person, the API) and, when the origin is another run (an agent's
   * child, or a step of a workflow), goes on to that run's own origin, up to three levels. A step
   * links to the workflow instance it is part of, which is the run it names (row 14c). When the chain holds
   * another run, the list ends with a row for the run itself ("Run", "This run"), one level in from
   * the last origin; a run that is the whole chain has no such row.
   *
   * The page has already read this run, its goal and its chat. The runs above it are read here, one
   * after another, because each names the next; a run that cannot be read ends the list there: the
   * origin line above it is still true, and an ancestor the caller may not read says nothing it
   * should not. It draws list items, which the Details rail's list holds.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { getContext, type ChatContext } from '../../../lib/bureau-client.ts';
  import type { Goal } from '../../../lib/bureau-goals.ts';
  import type { BureauSchedule } from '../../../lib/bureau-schedules.ts';
  import { getTask, type TaskView } from '../../../lib/bureau-tasks.ts';
  import { dayStamp, viewerTimeZone } from '../../../lib/format/clock.ts';
  import { usePluginTitle } from '../../../lib/plugin-title.svelte.ts';
  import { scheduleDetailPath } from '../../../lib/router.svelte.ts';
  import { cadenceClauseOf } from './run-schedule-cadence.ts';
  import RunOrigin from './run-origin.svelte';
  import {
    buildRunRows,
    personOrigin,
    type RunAttempt,
    type RunOrigin as Origin,
  } from './run-rows.ts';

  interface RunLineageProps {
    runId: string;
    /** The Bureau's task for the run, when there is one. */
    task?: TaskView | undefined;
    /** The goal whose attempt the run is, when it is one. */
    goal?: Goal | undefined;
    /** The chat the run ran in, when the page has read it. */
    chat?: ChatContext | undefined;
    /** The schedule that started the run, when the page has read it. */
    schedule?: BureauSchedule | undefined;
    /**
     * The origin the Bureau recorded for an instance of a workflow file, which has no task: a person
     * who started it by hand is said as "You" when they are the viewer (COR-2424, row 54l).
     */
    recordOrigin?: object | null | undefined;
    /** Who is viewing the page, the principal's subject. */
    viewer?: string | null | undefined;
    /**
     * The run a person started, as the chain names it between the person and "This run" (row 54l):
     * "Run Release notes, Mon, Nov 2, 10:45 AM". Drawn only after a person, for a run with no task.
     */
    startedRun?: { readonly title: string; readonly startedAt: number } | undefined;
  }

  /** How many origins the list follows, this run's included. */
  const MAX_LEVELS = 3;

  /** One level above the run: the run an origin names, and what started it. */
  interface Ancestor {
    readonly runId: string;
    readonly origin: Origin;
  }

  let {
    runId,
    task,
    goal,
    chat,
    schedule,
    recordOrigin = undefined,
    viewer = undefined,
    startedRun = undefined,
  }: RunLineageProps = $props();

  function rowOf(
    id: string,
    taskOf: TaskView | undefined,
    goalOf: Goal | undefined,
    chatOf: ChatContext | undefined,
  ) {
    const rows = buildRunRows({
      tasks: taskOf === undefined ? [] : [taskOf],
      goals: goalOf === undefined ? [] : [goalOf],
      chats: chatOf === undefined ? [] : [chatOf],
    });
    return rows.find((row) => row.id === id);
  }

  function originOf(
    id: string,
    taskOf: TaskView | undefined,
    goalOf: Goal | undefined,
    chatOf: ChatContext | undefined,
  ): Origin {
    return rowOf(id, taskOf, goalOf, chatOf)?.origin ?? { kind: 'none' };
  }

  /** The run an origin names as the one that started it, when it names one. */
  function parentOf(origin: Origin): string | undefined {
    return origin.kind === 'agent' || origin.kind === 'parent' ? origin.parentRunId : undefined;
  }

  // A run a trigger started names its plugin by its title.
  const pluginTitle = usePluginTitle();
  const recordedOriginOfRun = $derived(originOf(runId, task, goal, chat));
  // An instance of a workflow file a schedule fired records no origin of its own: the schedule the
  // page read for it is what started it (COR-2424).
  const origin: Origin = $derived(
    recordedOriginOfRun.kind === 'none' && schedule !== undefined
      ? {
          kind: 'schedule',
          title: '',
          href: null,
          scheduleId: schedule.id,
          schedulePath: scheduleDetailPath(schedule.id),
          manual: false,
        }
      : recordedOriginOfRun.kind === 'none' &&
          recordOrigin !== null &&
          recordOrigin !== undefined &&
          Reflect.get(recordOrigin, 'kind') === 'person'
        ? personOrigin(recordOrigin)
        : recordedOriginOfRun,
  );
  // The schedule as the chain says it: its name and when it runs, in the viewer's time (row 55i).
  const scheduleLine = $derived(
    origin.kind !== 'schedule' || schedule === undefined
      ? undefined
      : { name: schedule.description ?? schedule.id, cadence: cadenceClauseOf(schedule) },
  );
  const attempt: RunAttempt | null = $derived(rowOf(runId, task, goal, chat)?.attempt ?? null);
  const parentRunId = $derived(parentOf(origin));

  const ancestors = createQuery(
    () => ({
      queryKey: ['run-lineage', runId, parentRunId ?? ''] as const,
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Ancestor[]> => {
        const found: Ancestor[] = [];
        let next = parentRunId;
        while (next !== undefined && found.length < MAX_LEVELS - 1) {
          try {
            const above = await getTask(next, { signal });
            const context = await getContext(above.contextId, { signal }).catch(() => undefined);
            const aboveOrigin = originOf(next, above, undefined, context);
            found.push({ runId: next, origin: aboveOrigin });
            next = parentOf(aboveOrigin);
          } catch {
            break;
          }
        }
        return found;
      },
      enabled: parentRunId !== undefined,
      retry: false,
    }),
    undefined,
  );
</script>

<li class="ib-run-lineage__item" data-depth="1">
  <RunOrigin {origin} {attempt} {scheduleLine} {viewer} {pluginTitle} />
</li>
{#each ancestors.data ?? [] as ancestor, index (ancestor.runId)}
  <li class="ib-run-lineage__item" data-depth={index + 2}>
    <RunOrigin origin={ancestor.origin} {viewer} {pluginTitle} />
  </li>
{/each}
{#if origin.kind === 'person' && task === undefined && startedRun !== undefined}
  <li class="ib-run-lineage__item" data-depth="2" data-started-run>
    <span class="ib-run-origin__kind">{RUN_DETAIL_COPY.lineage.run}</span>
    {startedRun.title}, {dayStamp(startedRun.startedAt, viewerTimeZone())}
  </li>
{/if}
<!-- The run's own row says where it sits in a chain, so it is drawn when another run is in it, and after a chat, a goal, a schedule or a person, which are what the chain names (rows 06d, 55f, 55i, 54y, 54l). -->
{#if (ancestors.data?.length ?? 0) > 0 || origin.kind === 'chat' || origin.kind === 'goal' || origin.kind === 'schedule' || (origin.kind === 'person' && task === undefined)}
  <li
    class="ib-run-lineage__self"
    data-depth={(ancestors.data?.length ?? 0) + (startedRun === undefined ? 2 : 3)}
  >
    <span class="ib-run-origin__kind">{RUN_DETAIL_COPY.lineage.run}</span>
    {RUN_DETAIL_COPY.lineage.thisRun}
  </li>
{/if}
