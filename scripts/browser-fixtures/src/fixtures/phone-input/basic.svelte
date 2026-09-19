<script lang="ts">
  import { PhoneInput } from '@corvidae/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-field`);

  let phone = $state('');
</script>

<PhoneInput id={fieldId} bind:value={phone} label="Phone number" />

{#if phone}
  <p style="margin-top: 0.75rem; color: var(--cinder-text-muted);">E.164: {phone}</p>
{/if}
