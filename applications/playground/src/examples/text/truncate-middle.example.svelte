<script lang="ts" module>
  export const title = 'Cut in the middle';
  export const description =
    'A long identifier keeps its last four characters when the line is too narrow, because the end of an id tells workers apart. Focus it, or hover it, to read the whole id in the tooltip; it is the only tab stop in the row.';
</script>

<script lang="ts">
  import { StatusDot, Text } from '@lostgradient/cinder';
</script>

<div
  style="display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.25rem 1rem; inline-size: 18rem; align-items: baseline;"
>
  <Text truncate="middle" text="payments-worker-eu-west-1b-7f3a9c2e-4d81-4b06-a9e2-1c5d0f7b3a68" />
  <StatusDot status="success" label="Connected" size="sm" />
  <Text variant="caption">payments · 1 running</Text>
  <Text variant="caption">just now</Text>
</div>
