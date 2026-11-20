<script lang="ts">
  import { Calendar } from '@lostgradient/cinder';

  let value = $state<string | undefined>('2026-06-29');
</script>

<div style="display: grid; gap: var(--cinder-space-3); max-inline-size: 22rem;">
  <Calendar bind:value />
  <code>{value ?? 'undefined'}</code>
</div>
