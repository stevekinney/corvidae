<script lang="ts">
  import { Button } from '../button/index.ts';
  import { Banner } from './index.ts';

  const loadedAt = new Date('2026-01-01T12:00:00Z');
</script>

{#snippet trialActions()}
  <Button variant="secondary" size="sm" label="Compare plans" />
  <Button variant="primary" size="sm" label="Renew now" />
{/snippet}

{#snippet restartActions()}
  <Button variant="secondary" size="sm" label="Revert 1 change" />
  <Button variant="primary" size="sm" label="Restart now" />
{/snippet}

<div class="banner-actions">
  <div data-testid="wide">
    <Banner variant="warning" title="Your trial ends in 3 days." actions={trialActions}>
      Renew to keep your workspace and its history.
    </Banner>
  </div>
  <div data-testid="preset">
    <Banner
      preset="unreachable"
      dataUpdatedAt={loadedAt}
      timeZone="UTC"
      retryInSeconds={4}
      attempt={3}
      onRetry={() => {}}
    />
  </div>
  <div class="banner-actions__narrow" data-testid="narrow">
    <Banner variant="warning" title="Your trial ends in 3 days." actions={trialActions}>
      Renew to keep your workspace and its history.
    </Banner>
  </div>
  <div data-testid="stacked">
    <Banner variant="info" dismissible={false} stackActions actions={restartActions}>
      1 change waits for a restart.
    </Banner>
  </div>
</div>

<style>
  .banner-actions {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .banner-actions__narrow {
    inline-size: 24rem;
    max-inline-size: 100%;
  }
</style>
