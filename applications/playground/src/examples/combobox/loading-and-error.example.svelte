<script lang="ts" module>
  export const title = 'Loading and a failed load';
  export const description =
    "While loading the field stays a combobox and shows its loading label; after the threshold Skeleton's status line offers Cancel. A failed load shows its message and a retry above the options that did load.";
</script>

<script lang="ts">
  import { Combobox } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let loadingId = $derived(`${mountIdPrefix ?? uid}-workflow-loading`);
  let failedId = $derived(`${mountIdPrefix ?? uid}-workflow-failed`);
</script>

<Combobox
  id={loadingId}
  label="Workflow"
  required
  options={[]}
  loading
  loadingLabel="Loading workflows…"
  stillLoadingAfter={10000}
  onCancel={() => {}}
/>

<Combobox
  id={failedId}
  label="Workflow"
  required
  presentation="picker"
  placeholder="Pick a workflow"
  options={[{ value: 'chat', label: 'Chat with an agent', suffix: 'built in' }]}
  loadError={{
    title: 'Couldn’t load workflows.',
    description: 'Interborough didn’t answer. Chat with an agent is built in and still works.',
  }}
  onRetry={() => {}}
/>
