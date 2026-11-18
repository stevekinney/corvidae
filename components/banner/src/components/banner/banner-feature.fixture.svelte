<script lang="ts">
  import Sparkles from '@lucide/svelte/icons/sparkles';

  import { Button } from '@lostgradient/button/components/button/index.ts';
  import { Banner } from './index.ts';
</script>

{#snippet art()}<Sparkles aria-hidden="true" />{/snippet}

{#snippet featureActions()}
  <Button variant="secondary" size="sm" label="Maybe later" />
  <Button variant="primary" size="sm" label="Try it now" />
{/snippet}

<div class="banner-feature">
  <div data-testid="feature">
    <Banner
      variant="feature"
      title="Meet Backchannel."
      {art}
      actions={featureActions}
      onDismiss={() => {}}
    >
      Hand a long review to an agent and read what it did when you are back at your desk.
    </Banner>
  </div>
  <div data-testid="feature-short">
    <Banner variant="feature" title="New: dark mode." {art} actions={featureActions}>
      Switch themes from Settings.
    </Banner>
  </div>
</div>

<style>
  .banner-feature {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
