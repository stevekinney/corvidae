<script lang="ts">
  /**
   * How the run ran: the disclosure under what happened that holds what only an operator reads, the
   * steps and tool calls, the raw payloads, the change or ask forms, the events and the panels
   * plugins add. The page gives it closed for a finished run of the Bureau's and open for a run that
   * is still going, because a person watching a run answers its approvals there. A person can open
   * or close it either way, and the link under a reply that says Show raw payloads opens it.
   */
  import { Collapsible } from '@lostgradient/cinder';
  import type { Snippet } from 'svelte';

  import { RUN_DETAIL_COPY } from '../../../app/copy.ts';

  interface RunHowItRanProps {
    /** Whether the disclosure is open. */
    open?: boolean;
    /** What the disclosure holds. */
    children: Snippet;
  }

  let { open = $bindable(false), children }: RunHowItRanProps = $props();
</script>

<div class="ib-run__section" data-section="how-it-ran">
  <Collapsible bind:open animated={false} trigger={RUN_DETAIL_COPY.howItRan.heading}>
    <p class="ib-run__note">{RUN_DETAIL_COPY.howItRan.caption}</p>
    {@render children()}
  </Collapsible>
</div>
