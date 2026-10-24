<script lang="ts">
  /**
   * Aggregate-cards band (plan §9.1, this track's brief): this track's own
   * stat card (`GET /api/v1/workflows/aggregate?group_by=status`) plus the frozen card-slot registry
   * (`./cards.ts` — schedules and reviews, each owned by its
   * own track and possibly still a placeholder). The registry's contract is
   * "render whatever it provides" — this band renders every registered
   * card in a responsive auto-fit grid without assuming a fixed count or
   * final visual shape from any of them.
   */
  import type { CreateQueryResult } from '@tanstack/svelte-query';

  import type { WorkflowAggregateResult } from './aggregate-output.ts';
  import { dashboardCards } from './cards.ts';
  import WorkflowStatusCard from './workflow-status-card.svelte';

  interface AggregateCardsBandProps {
    statusQuery: CreateQueryResult<WorkflowAggregateResult>;
  }

  let { statusQuery }: AggregateCardsBandProps = $props();
</script>

<div class="weft-aggregate-cards-band">
  <div class="weft-aggregate-cards-band__full">
    <WorkflowStatusCard query={statusQuery} />
  </div>
  {#each dashboardCards as entry (entry.id)}
    {@const CardComponent = entry.component}
    <CardComponent />
  {/each}
</div>
