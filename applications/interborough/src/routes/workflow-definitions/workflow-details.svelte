<script lang="ts">
  /**
   * What the engine's contract declares of a workflow: the signals, updates, and queries it
   * accepts. Only what the workflow has is shown: a fact it does not have is no row. The schemas
   * are not here (the Overview shows them as field lists), and neither are the trigger and the
   * file, which are the header's lines.
   */
  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import type { DefinitionDetails } from './workflow-presentation.ts';

  interface Props {
    details: DefinitionDetails;
  }

  let { details }: Props = $props();

  const copy = WORKFLOW_COPY;
</script>

{#snippet identifiers(label: string, entries: readonly string[], testId?: string)}
  {#if entries.length > 0}
    <dt>{label}</dt>
    <dd data-testid={testId}>
      {#each entries as entry, index (entry)}{#if index > 0}{', '}{/if}<code>{entry}</code>{/each}
    </dd>
  {/if}
{/snippet}

<div class="ib-workflow__section" data-testid="workflow-definition">
  <dl class="weft-workflow-facts">
    {@render identifiers(copy.page.signals, details.signals, 'workflow-accepted-signals')}
    {@render identifiers(copy.page.updates, details.updates)}
    {@render identifiers(copy.page.queries, details.queries)}
  </dl>
</div>
