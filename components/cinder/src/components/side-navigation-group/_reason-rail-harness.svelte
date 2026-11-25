<script lang="ts">
  import Sidebar from '../sidebar/sidebar.svelte';
  import SideNavigation from '../side-navigation/side-navigation.svelte';
  import SideNavigationGroup from './side-navigation-group.svelte';
  import SideNavigationItem from '../side-navigation-item/side-navigation-item.svelte';

  // Test-only harness (COR-2680): a group reason inside a collapsed Sidebar (an icon rail).
  let { collapsed = true }: { collapsed?: boolean } = $props();
</script>

<Sidebar label="Workspace" {collapsed}>
  {#snippet navigation()}
    <SideNavigation ariaLabel="Views">
      <SideNavigationGroup label="Namespace" disabledReason="Choose a connection first">
        <SideNavigationItem disabled label="Workflows">
          {#snippet icon()}<svg viewBox="0 0 16 16" width="16" height="16"></svg>{/snippet}
          Workflows
        </SideNavigationItem>
      </SideNavigationGroup>
    </SideNavigation>
  {/snippet}
</Sidebar>
