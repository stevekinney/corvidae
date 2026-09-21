<script lang="ts">
  import { PinInput } from '@lostgradient/cinder';
  let value = $state('');
</script>

<PinInput id="basic-pin" bind:value label="Verification code" />
