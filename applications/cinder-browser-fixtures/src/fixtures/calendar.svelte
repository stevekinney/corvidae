<script lang="ts">
  import { Calendar } from '@repo/cinder';

  let value = $state<string | undefined>('2026-06-29');
</script>

<div style="display: grid; gap: 0.75rem; max-inline-size: 22rem;">
  <Calendar bind:value />
  <code>{value ?? 'undefined'}</code>
</div>
