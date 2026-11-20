<script lang="ts">
  import { AppBar, PageHeader } from '@lostgradient/cinder';

  // The large title's `collapsed`, bound to the bar's `titleVisible`: the bar shows its title once
  // the large title scrolls away (COR-2445).
  let collapsed = $state(false);

  // At the top of the scroller nothing sits under the sticky bar; scrolled a little, a coloured row
  // does, and the bar's translucency shows.
  let scroller: HTMLDivElement | undefined = $state();
  $effect(() => {
    scroller?.scrollTo({ top: 72 });
  });
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
  bind:this={scroller}
  class="app-bar-over-content-layout margin-block-start-4"
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
  <div class="padding-block-4 padding-inline-4">
    {#each [1, 2, 3, 4, 5, 6] as row (row)}
      <div aria-hidden="true" class="example-content margin-block-end-3"></div>
    {/each}
  </div>
</div>

<!-- The large-title pairing: the bar's title appears once the header's large title scrolls away. -->
<div data-testid="app-bar-large-title-pairing" class="margin-block-start-4">
  <AppBar title="Runs" titleVisible={collapsed} />
  <PageHeader variant="large" title="Runs" bind:collapsed collapsedBar={false} />
</div>

<style>
  .app-bar-over-content-layout {
    block-size: 14rem;
    overflow: auto;
    border: 1px solid var(--cinder-border-muted);
  }

  .example-content {
    block-size: 3rem;
    background: var(--cinder-accent-solid);
  }
</style>
