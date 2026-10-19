<script lang="ts">
  /**
   * What a schedule starts, labelled by what kind of thing it is and linked to it: an agent run to
   * the agent's page, and a workflow type, defined in code or authored by an agent, to the
   * workflow's page. Until the Bureau says what kind it is, the type is shown without a link, so a
   * schedule never links to a page that is not what it starts.
   */
  import { Badge } from '@lostgradient/cinder';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { ScheduleKind } from '../../lib/schedule-kinds.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';

  interface Props {
    schedule: { readonly workflowType: string };
    kind: ScheduleKind;
    /** In a table row, whose own click opens the schedule: a click on the link is the link's alone. */
    stopPropagation?: boolean;
  }

  let { schedule, kind, stopPropagation = false }: Props = $props();

  const target = $derived.by<{ label: string; path: string | null }>(() => {
    switch (kind.kind) {
      case 'agent-run':
        return kind.agentName === null
          ? { label: SCHEDULE_COPY.unnamedAgent, path: null }
          : { label: kind.agentName, path: agentPath(kind.agentName) };
      case 'workflow-file':
      case 'code':
        return { label: schedule.workflowType, path: workflowTypePath(schedule.workflowType) };
      case 'unknown':
        return { label: schedule.workflowType, path: null };
    }
  });
  const kindLabel = $derived(kind.kind === 'unknown' ? null : SCHEDULE_COPY.kind[kind.kind]);

  function go(event: MouseEvent, path: string): void {
    if (stopPropagation) event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<span class="weft-schedule-target" data-testid="schedule-target">
  {#if kindLabel !== null}
    <Badge variant="neutral" size="sm">{kindLabel}</Badge>
  {/if}
  {#if target.path !== null}
    {@const path = target.path}
    <a
      class="weft-schedule-target__link"
      href={router.href(path)}
      onclick={(event) => go(event, path)}>{target.label}</a
    >
  {:else}
    <span>{target.label}</span>
  {/if}
</span>

<style>
  .weft-schedule-target {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: center;
  }

  .weft-schedule-target__link {
    color: inherit;
    overflow-wrap: anywhere;
  }
</style>
