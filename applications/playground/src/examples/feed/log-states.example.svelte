<script lang="ts" module>
  export const title = 'Log states';
  export const description =
    'The log arm’s loading skeleton, truncation notice, and connection states, driven by controls.';
</script>

<script lang="ts">
  import { Checkbox, Feed, type FeedConnectionState, Select } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let loadingId = $derived(`${mountIdPrefix ?? uid}-loading`);
  let truncatedId = $derived(`${mountIdPrefix ?? uid}-truncated`);
  let connectionId = $derived(`${mountIdPrefix ?? uid}-connection`);

  let loading = $state(false);
  let truncated = $state(true);
  let connectionState = $state<FeedConnectionState>('connecting');

  const connectionOptions: { value: FeedConnectionState; label: string }[] = [
    { value: 'connected', label: 'connected' },
    { value: 'connecting', label: 'connecting' },
    { value: 'disconnected', label: 'disconnected' },
    { value: 'error', label: 'error' },
  ];
</script>

<div
  style="display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; margin-block-end: 1rem;"
>
  <Select
    id={connectionId}
    bind:value={connectionState}
    options={connectionOptions}
    label="Connection"
  />
  <Checkbox id={loadingId} bind:checked={loading} label="Loading" />
  <Checkbox id={truncatedId} bind:checked={truncated} label="Truncated" />
</div>

<Feed kind="log" label="Deployment events" {connectionState} {loading} {truncated}>
  <Feed.Event variant="minimal" datetime="2026-05-12T14:30:00Z" timestamp="14:30:00" tone="info">
    Deploy pipeline started for release 2026.05.12
  </Feed.Event>
  <Feed.Event variant="minimal" datetime="2026-05-12T14:31:12Z" timestamp="14:31:12" tone="success">
    Build artifacts published
  </Feed.Event>
  <Feed.Event variant="minimal" datetime="2026-05-12T14:33:40Z" timestamp="14:33:40" tone="warning">
    Canary latency above baseline — holding rollout at 25%
  </Feed.Event>
</Feed>
