<script lang="ts" module>
  export const title = 'Every connection preset';
  export const description =
    'The presets in the order the design lists them: offline, unreachable (with and without the changes sentence), stopped, out of date, refresh failed, restarting, reconnecting, restart failed and back online. Each fixes its tone, glyph, copy and actions, and none is dismissible.';
</script>

<script lang="ts">
  import { Banner } from '@lostgradient/cinder';

  // The time the data on screen was loaded, written as an absolute time with its zone.
  const loadedAt = new Date(Date.now() - 120_000);
  const common = {
    dataUpdatedAt: loadedAt,
    timeZone: 'America/Chicago',
    onRetry: () => {},
  };
</script>

<div class="example-preview-column" style="gap: var(--cinder-space-3)">
  <Banner preset="offline" {...common} retryInSeconds={8} />
  <Banner preset="unreachable" {...common} retryInSeconds={4} attempt={3} />
  <Banner preset="unreachable" {...common} retryInSeconds={8} attempt={3} consequence={false} />
  <Banner preset="stopped" {...common} />
  <Banner preset="out-of-date" {...common} />
  <Banner preset="refresh-failed" {...common} />
  <Banner preset="restarting" />
  <Banner preset="reconnecting" attempt={2} onRetry={() => {}} />
  <Banner preset="restart-failed" onRestart={() => {}} onOpenHealth={() => {}} />
  <Banner preset="back-online" />
</div>
