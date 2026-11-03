<script lang="ts">
  import Sidebar from '../sidebar/sidebar.svelte';
  import SideNavigation from '../side-navigation/side-navigation.svelte';
  import SideNavigationItem from './side-navigation-item.svelte';

  // Test-only harness: a real Sidebar publishes its collapsed state, and a row inside it follows
  // that state without being told.
  let { collapsed = false }: { collapsed?: boolean } = $props();
</script>

<Sidebar label="Workspace" {collapsed}>
  {#snippet navigation()}
    <SideNavigation ariaLabel="Views">
      <SideNavigationItem href="/reviews" label="Reviews" count={2} countLabel="need you">
        {#snippet icon()}<svg viewBox="0 0 16 16" width="16" height="16"></svg>{/snippet}
        Reviews
      </SideNavigationItem>
    </SideNavigation>
  {/snippet}
</Sidebar>
