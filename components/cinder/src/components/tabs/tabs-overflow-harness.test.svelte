<script lang="ts">
  import Tab from '../tab/tab.svelte';
  import TabList from '../tab-list/tab-list.svelte';
  import TabPanel from '../tab-panel/tab-panel.svelte';
  import Tabs from './tabs.svelte';

  let {
    names = ['Overview', 'Workers', 'Settings'],
    collapseOnOverflow,
  }: { names?: string[]; collapseOnOverflow?: boolean } = $props();

  let value = $state('tab-0');
</script>

<Tabs bind:value {...collapseOnOverflow === undefined ? {} : { collapseOnOverflow }}>
  <TabList label="Sections">
    {#each names as name, index (name)}
      <Tab value={`tab-${index}`}>{name}</Tab>
    {/each}
  </TabList>
  {#each names as name, index (name)}
    <TabPanel value={`tab-${index}`}>{name} panel</TabPanel>
  {/each}
</Tabs>
