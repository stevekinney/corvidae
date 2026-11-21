<script lang="ts">
  import { StatusDot } from '@lostgradient/cinder';
</script>

<div class="example-preview-column">
  <div class="example-preview-row">
    <StatusDot status="online" label="Online" labelVisible={true} />
    <StatusDot status="offline" label="Offline" labelVisible={true} />
    <StatusDot status="pending" label="Pending" labelVisible={true} />
  </div>
  <div class="example-preview-row example-preview-row-layout">
    <StatusDot status="online" label="Small" size="sm" labelVisible={true} />
    <StatusDot status="online" label="Medium" size="md" labelVisible={true} />
  </div>
</div>

<style>
  .example-preview-row-layout {
    align-items: center;
  }
</style>
