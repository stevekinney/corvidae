<script lang="ts">
  import { Calendar } from '@lostgradient/cinder';

  let value = $state<string | undefined>('2026-06-29');
</script>

<div class="example-frame gap-3">
  <Calendar bind:value />
  <code>{value ?? 'undefined'}</code>
</div>

<style>
  .example-frame {
    display: grid;
    max-inline-size: 22rem;
  }
</style>
