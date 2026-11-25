<script lang="ts">
  import SideNavigationGroup from './side-navigation-group.svelte';
  import SideNavigationItem from '../side-navigation-item/side-navigation-item.svelte';

  // Test-only harness (COR-2680): a group that states one reason for its disabled rows, with a
  // row that repeats it, a row that says something else, a row with no reason, and an enabled row.
  let {
    reason = 'Choose a connection first',
    expanded = true,
  }: { reason?: string; expanded?: boolean } = $props();
</script>

<ul>
  <SideNavigationGroup label="Namespace" disabledReason={reason} {expanded}>
    <SideNavigationItem disabled label="Workflows">Workflows</SideNavigationItem>
    <SideNavigationItem disabled label="Schedules" disabledReason="  Choose a connection first ">
      Schedules
    </SideNavigationItem>
    <SideNavigationItem disabled label="Task queue" disabledReason="Open a task queue first">
      Task queue
    </SideNavigationItem>
    <SideNavigationItem href="/connections" label="Connections">Connections</SideNavigationItem>
  </SideNavigationGroup>
</ul>
