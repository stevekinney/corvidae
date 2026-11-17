<script lang="ts">
  import { AppBar, PageHeader } from '@lostgradient/cinder';

  // The large title's `collapsed`, bound to the bar's `titleVisible`: the bar shows its title once
  // the large title scrolls away (COR-2445).
  let collapsed = $state(false);
</script>

{#snippet shareIcon()}
  <svg class="cinder-icon-md" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    />
  </svg>
{/snippet}

{#snippet saveIcon()}
  <svg class="cinder-icon-md" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 3h12v18l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
{/snippet}

{#snippet searchIcon()}
  <svg class="cinder-icon-md" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    />
  </svg>
{/snippet}

<AppBar
  title="Death & Co"
  headingLevel={1}
  back={{ href: '/' }}
  actions={[{ label: 'Share', icon: shareIcon, onclick: () => {} }]}
/>

<!-- Three icon actions over content that scrolls under the bar, so its translucency shows. -->
<div
  data-testid="app-bar-over-content"
  style="block-size: 14rem; overflow: auto; margin-top: var(--cinder-space-4); border: 1px solid var(--cinder-border-muted);"
>
  <AppBar
    title="Saved bars"
    back={{ href: '/' }}
    actions={[
      { label: 'Search', icon: searchIcon, onclick: () => {} },
      { label: 'Save', icon: saveIcon, onclick: () => {} },
      { label: 'Share', icon: shareIcon, onclick: () => {} },
    ]}
  />
  <div style="padding: var(--cinder-space-4);">
    {#each ['Death & Co', 'Williams & Graham', 'Little Pepper', 'Ace Eat Serve', 'Bar Helix', 'Fire'] as bar (bar)}
      <div
        style="margin-block-end: var(--cinder-space-3); padding: var(--cinder-space-3); background: var(--cinder-accent-solid); color: var(--cinder-text-inverse);"
      >
        {bar}
      </div>
    {/each}
  </div>
</div>

<!-- The large-title pairing: the bar's title appears once the header's large title scrolls away. -->
<div data-testid="app-bar-large-title-pairing" style="margin-top: var(--cinder-space-4);">
  <AppBar title="Runs" titleVisible={collapsed} />
  <PageHeader variant="large" title="Runs" bind:collapsed collapsedBar={false} />
</div>
