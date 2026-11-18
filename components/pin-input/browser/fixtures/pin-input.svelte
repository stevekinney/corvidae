<script lang="ts">
  import { default as PinInput } from '@lostgradient/pin-input/components/pin-input/index.ts';
  let value = $state('');
</script>

<PinInput id="basic-pin" bind:value label="Verification code" />
