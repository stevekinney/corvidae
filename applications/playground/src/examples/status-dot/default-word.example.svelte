<script lang="ts" module>
  export const title = 'Status dot default word';
  export const description =
    'With only a status, a StatusDot renders a word derived from it, so a status is never a dot alone.';
</script>

<script lang="ts">
  import { StatusDot } from '@lostgradient/cinder';
</script>

<div class="example-preview-row">
  <StatusDot status="online" />
  <StatusDot status="warning" />
  <StatusDot status="danger" />
  <StatusDot status="pending" label="Deploying" />
</div>
