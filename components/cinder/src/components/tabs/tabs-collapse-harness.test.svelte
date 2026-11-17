<script lang="ts">
  import Tab from '../tab/tab.svelte';
  import TabList from '../tab-list/tab-list.svelte';
  import TabPanel from '../tab-panel/tab-panel.svelte';
  import Tabs from './tabs.svelte';

  let {
    active = 'overview',
    onChange,
    labelled = false,
    collapseBelow,
    collapseLabel,
    orientation,
    refuseTo,
  }: {
    active?: string;
    onChange?: (next: string) => void;
    labelled?: boolean;
    collapseBelow?: string | false;
    collapseLabel?: string;
    orientation?: 'horizontal' | 'vertical';
    /** When set, the request hook returns this tab instead of the one proposed. */
    refuseTo?: string;
  } = $props();

  let value = $derived(active);
</script>

<Tabs
  bind:value
  {...onChange === undefined ? {} : { onValueChange: onChange }}
  {...collapseBelow === undefined ? {} : { collapseBelow }}
  {...collapseLabel === undefined ? {} : { collapseLabel }}
  {...orientation === undefined ? {} : { orientation }}
  {...refuseTo === undefined ? {} : { onValueChangeRequest: () => refuseTo }}
>
  <TabList label="Agent sections">
    <Tab value="overview" {...labelled ? { label: 'Project overview' } : {}}>Overview</Tab>
    <Tab value="access">Access</Tab>
    <Tab value="memory" disabled>Memory</Tab>
    <Tab value="settings">Settings</Tab>
  </TabList>
  <TabPanel value="overview">Overview panel</TabPanel>
  <TabPanel value="access">Access panel</TabPanel>
  <TabPanel value="memory">Memory panel</TabPanel>
  <TabPanel value="settings">Settings panel</TabPanel>
</Tabs>
