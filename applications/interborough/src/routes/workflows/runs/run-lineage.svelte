<script lang="ts">
  /**
   * What started a run, and what started that: a list that opens with this run's origin (the chat,
   * the schedule, the goal, the person, the API) and, when the origin is another run (an agent's
   * child, or a step of a workflow), goes on to that run's own origin, up to three levels. A step
   * links to the workflow instance it is part of, which is the run it names (row 14c).
   *
   * The page has already read this run, its goal and its chat. The runs above it are read here, one
   * after another, because each names the next; a run that cannot be read ends the list there: the
   * origin line above it is still true, and an ancestor the caller may not read says nothing it
   * should not. It draws list items, for the Details rail's list to hold.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { getContext, type ChatContext } from '../../../lib/bureau-client.ts';
  import type { Goal } from '../../../lib/bureau-goals.ts';
  import { getTask, type TaskView } from '../../../lib/bureau-tasks.ts';
  import RunOrigin from './run-origin.svelte';
  import { buildRunRows, type RunOrigin as Origin } from './run-rows.ts';

  interface RunLineageProps {
    runId: string;
    /** The Bureau's task for the run, when there is one. */
    task?: TaskView | undefined;
    /** The goal whose attempt the run is, when it is one. */
    goal?: Goal | undefined;
    /** The chat the run ran in, when the page has read it. */
    chat?: ChatContext | undefined;
  }

  /** How many origins the list follows, this run's included. */
  const MAX_LEVELS = 3;

  /** One level above the run: the run an origin names, and what started it. */
  interface Ancestor {
    readonly runId: string;
    readonly origin: Origin;
  }

  let { runId, task, goal, chat }: RunLineageProps = $props();

  function originOf(
    id: string,
    taskOf: TaskView | undefined,
    goalOf: Goal | undefined,
    chatOf: ChatContext | undefined,
  ): Origin {
    const rows = buildRunRows({
      tasks: taskOf === undefined ? [] : [taskOf],
      goals: goalOf === undefined ? [] : [goalOf],
      chats: chatOf === undefined ? [] : [chatOf],
    });
    return rows.find((row) => row.id === id)?.origin ?? { kind: 'none' };
  }

  /** The run an origin names as the one that started it, when it names one. */
  function parentOf(origin: Origin): string | undefined {
    return origin.kind === 'agent' || origin.kind === 'parent' ? origin.parentRunId : undefined;
  }

  const origin = $derived(originOf(runId, task, goal, chat));
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

<li class="ib-run-lineage__item" data-depth="1"><RunOrigin {origin} /></li>
{#each ancestors.data ?? [] as ancestor, index (ancestor.runId)}
  <li class="ib-run-lineage__item" data-depth={index + 2}>
    <RunOrigin origin={ancestor.origin} />
  </li>
{/each}
