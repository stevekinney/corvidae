<script lang="ts" module>
  export const title = 'Narrow collapse to a select';
  export const description =
    'Below collapseBelow (640px by default) a horizontal tab bar becomes one full-width select reading "Tab: Access". The tabs stay mounted, hidden, so the panels keep their names. This example sets collapseBelow wide enough to show the narrow form at any width.';
</script>

<script lang="ts">
  import { Tabs } from '@lostgradient/cinder';

  let active = $state('access');
</script>

<Tabs bind:value={active} collapseBelow="9999px">
  <Tabs.List label="Agent sections">
    <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
    <Tabs.Trigger value="access">Access</Tabs.Trigger>
    <Tabs.Trigger value="memory" count={2} countLabel="to review">Memory</Tabs.Trigger>
    <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
  </Tabs.List>

  <Tabs.Panel value="overview"><p>Overview.</p></Tabs.Panel>
  <Tabs.Panel value="access"><p>Three of nine tools are allowed.</p></Tabs.Panel>
  <Tabs.Panel value="memory"><p>Two memories wait for review.</p></Tabs.Panel>
  <Tabs.Panel value="settings"><p>Settings.</p></Tabs.Panel>
</Tabs>
