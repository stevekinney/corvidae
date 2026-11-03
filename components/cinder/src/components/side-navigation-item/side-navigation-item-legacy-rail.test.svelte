<script lang="ts">
  import Sidebar from '../sidebar/sidebar.svelte';
  import SideNavigation from '../side-navigation/side-navigation.svelte';
  import SideNavigationItem from './side-navigation-item.svelte';

  // Test-only harness: the legacy row shape, where the consumer draws its own icon and label as
  // the row's children and passes no `icon` snippet (the Interborough shell does exactly this).
  let { collapsed = false }: { collapsed?: boolean } = $props();
</script>

<Sidebar label="Workspace" {collapsed}>
  {#snippet navigation()}
    <SideNavigation ariaLabel="Views">
      <SideNavigationItem href="/reviews" aria-label="Reviews">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"></svg>
        <span class="shell-label">Reviews</span>
      </SideNavigationItem>
    </SideNavigation>
  {/snippet}
</Sidebar>
