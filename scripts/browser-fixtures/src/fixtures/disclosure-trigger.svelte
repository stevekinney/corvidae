<script lang="ts">
  import { DisclosureTrigger } from '@lostgradient/cinder';

  let open = $state(true);
</script>

<!-- The one disclosure trigger (board row X3): closed, open with its region under it, a longer
     label that wraps beside the chevron's first line, and disabled. -->
<div style="display: grid; gap: 1rem; max-inline-size: 20rem;">
  <DisclosureTrigger open={false} controls="fixture-closed">Details</DisclosureTrigger>
  <div>
    <DisclosureTrigger {open} controls="fixture-open" onclick={() => (open = !open)}>
      Thought for 4 s
    </DisclosureTrigger>
    {#if open}
      <p id="fixture-open">Checked the refund policy, then the order's payment record.</p>
    {/if}
  </div>
  <DisclosureTrigger open={false} controls="fixture-long">
    Why the agent wants to do this, in a label long enough to wrap onto a second line
  </DisclosureTrigger>
  <DisclosureTrigger open={false} controls="fixture-disabled" disabled>
    Show the error details
  </DisclosureTrigger>
</div>
