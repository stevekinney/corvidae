<script lang="ts">
  /**
   * What a schedule starts, linked to it: an agent run to the agent's page, and a workflow type,
   * defined in code or authored by an agent, to the workflow's page, with a word for which kind of
   * workflow it is. The name of an agent or a type is an identifier, so it is set in monospace.
   * Until the Bureau says what kind it is, the type is shown without a link, so a schedule never
   * links to a page that is not what it starts.
   */
  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { ScheduleKind } from '../../lib/schedule-kinds.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';

  interface Props {
    schedule: { readonly workflowType: string };
    kind: ScheduleKind;
    /** In a list row, whose own click opens the schedule: a click on the link is the link's alone. */
    stopPropagation?: boolean;
    /** In the middle of a sentence ("Runs assistant every day"): a workflow does not say which kind it is, and an agent the caller may not read is "an agent". */
    inSentence?: boolean;
  }

  let { schedule, kind, stopPropagation = false, inSentence = false }: Props = $props();

  const target = $derived.by<{ label: string; path: string | null; identifier: boolean }>(() => {
    switch (kind.kind) {
      case 'agent-run':
        return kind.agentName === null
          ? {
              label: inSentence ? SCHEDULE_COPY.anAgent : SCHEDULE_COPY.unnamedAgent,
              path: null,
              identifier: false,
            }
          : { label: kind.agentName, path: agentPath(kind.agentName), identifier: true };
      case 'workflow-file':
      case 'code':
        return {
          label: schedule.workflowType,
          path: workflowTypePath(schedule.workflowType),
          identifier: true,
        };
      case 'unknown':
        return { label: schedule.workflowType, path: null, identifier: true };
    }
  });
  // An agent run is said by its agent alone; a workflow says which kind of workflow it is.
  const kindLabel = $derived(
    !inSentence && (kind.kind === 'workflow-file' || kind.kind === 'code')
      ? SCHEDULE_COPY.kind[kind.kind]
      : null,
  );

  function go(event: MouseEvent, path: string): void {
    if (stopPropagation) event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<span class="ib-schedule-target" data-testid="schedule-target">
  {#if kindLabel !== null}
    <span class="ib-schedule-target__kind">{kindLabel}</span>
  {/if}
  {#if target.path !== null}
    {@const path = target.path}
    <a
      class="ib-schedule-target__link"
      href={router.href(path)}
      onclick={(event) => go(event, path)}><code class="ib-identifier">{target.label}</code></a
    >
  {:else if target.identifier}
    <code class="ib-identifier">{target.label}</code>
  {:else}
    <span>{target.label}</span>
  {/if}
</span>
