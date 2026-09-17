<script lang="ts">
  import { DiffStatistics } from '@repo/cinder';
</script>

<div style="display: grid; gap: 0.75rem;">
  <DiffStatistics added={12} removed={4} modified={3} />
  <DiffStatistics added={12} removed={0} modified={0} variant="compact" zeroVisible={false} />
</div>
