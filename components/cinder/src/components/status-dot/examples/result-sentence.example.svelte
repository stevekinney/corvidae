<script lang="ts" module>
  export const title = 'Result sentence';
  export const description =
    'A status word on a list row stays muted so the dot carries the tone. A result sentence beside a dot, such as the outcome of a connection test, takes wordTone="status" so the words read in the status colour too.';
</script>

<script lang="ts">
  import { StatusDot } from '@lostgradient/cinder';
</script>

<div class="example-preview-column">
  <StatusDot word="Connected" />
  <StatusDot status="success" label="Found 3 tools" wordTone="status" />
  <StatusDot status="danger" label="Could not reach the server" />
</div>
