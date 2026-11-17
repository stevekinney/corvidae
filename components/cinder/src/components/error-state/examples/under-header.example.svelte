<script lang="ts" module>
  export const title = 'Full-page error under a header and tabs';
  export const description =
    'When nothing can show, the error state takes the height left under the heading and tabs, centred, with the header’s + secondary and inert (focusable, with its reason as the description) and Try again the only primary. It is never drawn with a banner.';
</script>

<script lang="ts">
  import { ErrorState, PageHeader, Tab, TabList, Tabs } from '@lostgradient/cinder';

  let tab = $state('overview');
</script>

<div
  style="display: flex; flex-direction: column; block-size: 30rem; border: 1px solid var(--cinder-border); border-radius: var(--cinder-radius-lg); padding: var(--cinder-space-4)"
>
  <PageHeader
    headingLevel={2}
    title="Workflows"
    description="Agent-authored workflows and their runs."
    error
    createAction={{ label: 'New workflow', inertReason: 'Off until the list loads' }}
  />
  <Tabs bind:value={tab}>
    <TabList label="Sections">
      <Tab value="overview">Overview</Tab>
      <Tab value="workers">Workers</Tab>
      <Tab value="storage">Storage</Tab>
    </TabList>
  </Tabs>
  <div style="flex: 1 1 auto; min-block-size: 0; position: relative">
    <ErrorState
      title="Couldn’t load workflows"
      description="The server answered with an error (500). Nothing you did caused it."
      onRetry={() => {}}
    />
  </div>
</div>
