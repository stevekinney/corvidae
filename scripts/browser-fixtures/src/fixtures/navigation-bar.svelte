<script lang="ts">
  import { Button, NavigationBar, NavigationItem } from '@corvidae/cinder';
  let active = $state('home');
  let mobileMenuOpen = $state(false);
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
