<script lang="ts" module>
  /** Test-only fixture composing Tabs where Workers and Storage carry a count and Overview does not. */
  export type TabsCountFixtureProps = {
    value?: string;
    workers?: number;
    storage?: number;
    countLabel?: string;
  };
</script>

<script lang="ts">
  import Tab from '../../components/tab/tab.svelte';
  import TabList from '../../components/tab-list/tab-list.svelte';
  import TabPanel from '../../components/tab-panel/tab-panel.svelte';
  import Tabs from '../../components/tabs/tabs.svelte';

  let {
    value = $bindable('overview'),
    workers = 1,
    storage = 1,
    countLabel = 'needs attention',
  }: TabsCountFixtureProps = $props();
</script>

<Tabs bind:value>
  <TabList label="Health sections">
    <Tab value="overview">Overview</Tab>
    <Tab value="workers" count={workers} {countLabel}>Workers</Tab>
    <Tab value="storage" count={storage} {countLabel}>Storage</Tab>
    <Tab value="audit">Audit log</Tab>
  </TabList>
  <TabPanel value="overview">Overview body</TabPanel>
  <TabPanel value="workers">Workers body</TabPanel>
  <TabPanel value="storage">Storage body</TabPanel>
  <TabPanel value="audit">Audit body</TabPanel>
</Tabs>
