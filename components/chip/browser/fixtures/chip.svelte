<script lang="ts">
  import { default as Chip } from '@lostgradient/chip/components/chip/index.ts';
</script>

<div class="example-preview-row">
  <Chip mode="toggle" label="Disabled toggle" pressed={false} disabled />
  <Chip mode="removable" label="Disabled removable" disabled />
</div>
