<script lang="ts">
  import { Button, NavigationBar, NavigationItem } from '@lostgradient/cinder';
  let active = $state('home');
  let mobileMenuOpen = $state(false);
  let phoneActive = $state('home');
  const phoneTabs = [
    { id: 'home', glyph: 'H', name: 'Home' },
    { id: 'chat', glyph: 'C', name: 'Chat' },
    { id: 'reviews', glyph: 'R', name: 'Reviews' },
    { id: 'runs', glyph: 'U', name: 'Runs' },
    { id: 'more', glyph: 'M', name: 'More' },
  ];
</script>

<section aria-label="Overview preview">
  <div id="overview-mount-basic" data-overview-preview-rendered="">
    <NavigationBar bind:mobileMenuOpen menuTogglePlacement="before-brand">
      {#snippet brand()}<strong>Acme</strong>{/snippet}
      {#snippet menuToggle(attrs)}<button
          type="button"
          {...attrs}
          aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          ><span aria-hidden="true">☰</span></button
        >{/snippet}
      {#snippet items({ variant })}
        <NavigationItem {variant} onclick={() => (active = 'home')} active={active === 'home'}
          >Home</NavigationItem
        >
        <NavigationItem {variant} onclick={() => (active = 'docs')} active={active === 'docs'}
          >Docs</NavigationItem
        >
        <NavigationItem {variant} href="#blog" active={active === 'blog'}>Blog</NavigationItem>
        <NavigationItem {variant} disabled onclick={() => {}}>Billing</NavigationItem>
      {/snippet}
      {#snippet actions()}<Button variant="primary" size="sm" label="Sign up" />{/snippet}
    </NavigationBar>
  </div>
</section>

<section aria-label="Five tabs on a phone preview">
  <div data-testid="navigation-bar-five-tabs" class="navigation-bar-five-tabs-layout">
    <NavigationBar placement="bottom" label="Phone primary navigation">
      {#snippet items({ variant })}
        {#each phoneTabs as tab (tab.id)}
          <NavigationItem
            {variant}
            onclick={() => (phoneActive = tab.id)}
            active={phoneActive === tab.id}
          >
            <span aria-hidden="true">{tab.glyph}</span>
            <span data-cinder-navigation-label>{tab.name}</span>
          </NavigationItem>
        {/each}
      {/snippet}
    </NavigationBar>
  </div>
</section>

<style>
  .navigation-bar-five-tabs-layout {
    inline-size: 20rem;
    border: 1px solid var(--cinder-border-muted);
  }
</style>
