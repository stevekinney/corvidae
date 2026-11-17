<script lang="ts" module>
  export const title = 'Tabs with an attention count';
  export const description =
    'A tab that holds something needing attention carries an amber count pill from `count`; a healthy tab (zero or no count) carries none. The count is part of the tab’s accessible name, so it never depends on colour.';
</script>

<script lang="ts">
  import { Tabs } from '@lostgradient/cinder';

  let active = $state('workers');
</script>

<Tabs bind:value={active}>
  <Tabs.List label="Health">
    <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
    <Tabs.Trigger value="workers" count={1} countLabel="needs attention">Workers</Tabs.Trigger>
    <Tabs.Trigger value="storage" count={1} countLabel="needs attention">Storage</Tabs.Trigger>
    <Tabs.Trigger value="audit" count={0}>Audit log</Tabs.Trigger>
  </Tabs.List>

  <Tabs.Panel value="overview">
    <p>Overview and Audit log carry no chip.</p>
  </Tabs.Panel>
  <Tabs.Panel value="workers">
    <p>One disconnected worker needs a look.</p>
  </Tabs.Panel>
  <Tabs.Panel value="storage">
    <p>One storage alert is firing.</p>
  </Tabs.Panel>
  <Tabs.Panel value="audit">
    <p>Nothing needs attention.</p>
  </Tabs.Panel>
</Tabs>
