<script lang="ts">
  /**
   * The one toolbar every records page has under its heading (Runs, Workflows, Internal workflows,
   * Agents and Goals): how many there are, the filters that narrow them, and the page's primary
   * action. The count is a status, so a filter that changes it is announced; the filters and the
   * action are the page's own.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    /** The count as a sentence, such as "12 runs". */
    count: string;
    /** The page's FilterBar, when it has one. */
    filters?: Snippet;
    /** The page's primary action, when it has one. */
    action?: Snippet;
  }

  let { count, filters, action }: Props = $props();
</script>

<div class="ib-records-toolbar" data-testid="records-toolbar">
  <p class="ib-records-toolbar__count" role="status" data-testid="records-count">{count}</p>
  {#if filters}
    <div class="ib-records-toolbar__filters">{@render filters()}</div>
  {/if}
  {#if action}
    <div class="ib-records-toolbar__action">{@render action()}</div>
  {/if}
</div>
