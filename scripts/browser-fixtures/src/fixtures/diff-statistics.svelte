<script lang="ts">
  import { DiffStatistics } from '@lostgradient/cinder';
</script>

<div class="example-grid gap-3">
  <DiffStatistics added={12} removed={4} modified={3} />
  <DiffStatistics added={12} removed={0} modified={0} variant="compact" zeroVisible={false} />
</div>

<style>
  .example-grid {
    display: grid;
  }
</style>
