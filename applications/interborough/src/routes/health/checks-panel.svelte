<script lang="ts">
  /**
   * The Checks panel under Advanced: the areas the Bureau checks (storage, schedules, providers,
   * hooks, plugins, workers and runs), each with how many problems it found and what they are. It reads the
   * same list as Needs attention, so the two cannot disagree. Below it, lease and recovery, which
   * is what the engine reports about its own health.
   */
  import { Badge } from '@lostgradient/cinder';

  import { ATTENTION_AREAS, type Attention } from '../../lib/bureau-attention.ts';
  import HealthTab from '../system/health-tab.svelte';
  import { attentionRow } from './attention-rows.ts';
  import { HEALTH_ADVANCED_COPY as copy } from './health-copy.ts';

  interface Props {
    attention: Attention | undefined;
  }

  let { attention }: Props = $props();

  const items = $derived(
    ATTENTION_AREAS.map((area) => {
      const problems = (attention?.items ?? []).filter((item) => item.area === area);
      return {
        term: copy.areas[area],
        definition:
          problems.length === 0
            ? copy.checks.passes
            : definitionOf(problems.map((item) => attentionRow(item).title)),
        count: problems.length,
      };
    }),
  );

  function definitionOf(titles: readonly string[]): string {
    return titles.join('; ');
  }
</script>

<div class="ib-checks" data-testid="checks-panel">
  <ul class="ib-checks__areas">
    {#each items as item (item.term)}
      <li class="ib-checks__area" data-area={item.term.toLowerCase()}>
        <span class="ib-checks__term">{item.term}</span>
        {#if item.count > 0}
          <Badge variant="warning" size="sm">{item.count}</Badge>
        {/if}
        <span class="ib-checks__definition">{item.definition}</span>
      </li>
    {/each}
  </ul>
  <HealthTab />
</div>

<style>
  .ib-checks {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  .ib-checks__areas {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-checks__area {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    padding-block: var(--cinder-space-2);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  .ib-checks__term {
    min-inline-size: 7rem;
    font-weight: 600;
  }

  .ib-checks__definition {
    color: var(--cinder-text-muted);
  }
</style>
