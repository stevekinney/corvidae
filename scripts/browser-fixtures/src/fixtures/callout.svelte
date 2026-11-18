<script lang="ts">
  import { Button, Callout } from '@lostgradient/cinder';
</script>

<Callout variant="info" title="Note">
  This setting applies to all projects in your organization and cannot be overridden per-project.
</Callout>

<!-- COR-2445 AC3: neutral callouts with actions, measured at 360, 768 and 1280 px. -->
<div style="display: grid; gap: 1rem; margin-block-start: 1rem;" data-testid="callout-actions">
  <Callout variant="neutral" title="Run paused" data-testid="callout-action-inline">
    The nightly backup is waiting for a person to approve the retention change.
    {#snippet action()}<Button size="sm" variant="secondary" label="Open run" />{/snippet}
  </Callout>
  <Callout
    variant="neutral"
    title="Two actions"
    actionLayout="stacked"
    data-testid="callout-action-stacked"
  >
    Both actions stay in the callout and keep their labels on one line.
    {#snippet action()}
      <Button size="sm" variant="ghost" label="Dismiss for now" />
      <Button size="sm" variant="secondary" label="Open run" />
    {/snippet}
  </Callout>
</div>
