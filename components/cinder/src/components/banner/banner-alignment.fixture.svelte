<script lang="ts">
  import { Banner } from './index.ts';

  // A fixed age, so the generated copy does not change between runs.
  const loadedAt = new Date('2026-01-01T12:00:00Z');
</script>

<div class="banner-alignment">
  <div data-testid="unreachable">
    <Banner
      preset="unreachable"
      dataUpdatedAt={loadedAt}
      timeZone="UTC"
      retryInSeconds={4}
      attempt={3}
      onRetry={() => {}}
    />
  </div>
  <div data-testid="offline">
    <Banner preset="offline" dataUpdatedAt={loadedAt} timeZone="UTC" />
  </div>
  <div data-testid="success">
    <Banner variant="success">Saved.</Banner>
  </div>
</div>

<style>
  .banner-alignment {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
