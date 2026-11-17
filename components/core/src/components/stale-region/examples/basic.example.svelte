<script lang="ts" module>
  export const title = 'Old data with inert writes';
  export const description =
    'The server is unreachable, so the page keeps its data at full contrast under a warning banner. Only the button that changes something is inert (aria-disabled, still focusable, described by "Off until it’s back"); the link and Retry now stay live.';
</script>

<script lang="ts">
  import { Banner, Button, Link, StaleRegion } from '@lostgradient/cinder';

  let stale = $state(true);
  const loadedAt = new Date(Date.now() - 120_000);
</script>

<StaleRegion {stale}>
  {#if stale}
    <Banner
      preset="unreachable"
      dataUpdatedAt={loadedAt}
      retryInSeconds={4}
      attempt={3}
      onRetry={() => (stale = false)}
    />
  {/if}
  <div style="display: grid; gap: 0.75rem; margin-block-start: 0.75rem;">
    <div style="display: flex; align-items: center; justify-content: space-between;">
      <strong>Agents</strong>
      <Button mutating iconOnly aria-label="New agent">+</Button>
    </div>
    <div>
      <Link href="#tool-runner">Tool runner</Link>, Available
    </div>
    <div>
      <Link href="#assistant">Assistant</Link>, Available
    </div>
    <div>
      <Button variant="ghost" onclick={() => (stale = !stale)}>
        {stale ? 'Pretend the server is back' : 'Pretend the server is gone'}
      </Button>
    </div>
  </div>
</StaleRegion>
