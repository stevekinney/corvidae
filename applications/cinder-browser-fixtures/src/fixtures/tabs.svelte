<script lang="ts">
  import { Tabs } from '@repo/cinder';

  const tabItems = [
    { value: 'design', label: 'Design' },
    { value: 'build', label: 'Build' },
    { value: 'review', label: 'Review' },
    { value: 'ship', label: 'Ship' },
  ];
</script>

<div class="tabs-focus-fixture">
  <Tabs value="design" activateOnFocus>
    <Tabs.List label="Workflow stages">
      {#each tabItems as item}
        <Tabs.Trigger value={item.value} disabled={item.value === 'ship'}>{item.label}</Tabs.Trigger
        >
      {/each}
    </Tabs.List>
    {#each tabItems as item}
      <Tabs.Panel value={item.value}><p>{item.label} stage.</p></Tabs.Panel>
    {/each}
  </Tabs>

  <Tabs value="design" orientation="vertical" activateOnFocus={false}>
    <Tabs.List label="Workflow stages (vertical)">
      {#each tabItems as item}
        <Tabs.Trigger value={item.value} disabled={item.value === 'ship'}>{item.label}</Tabs.Trigger
        >
      {/each}
    </Tabs.List>
    {#each tabItems as item}
      <Tabs.Panel value={item.value}><p>{item.label} stage.</p></Tabs.Panel>
    {/each}
  </Tabs>
</div>

<style>
  .tabs-focus-fixture {
    display: grid;
    gap: 2rem;
    max-inline-size: 36rem;
  }
</style>
