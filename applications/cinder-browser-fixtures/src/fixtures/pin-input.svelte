<script lang="ts">
  import { PinInput } from '@repo/cinder';
  let value = $state('');
</script>

<PinInput id="basic-pin" bind:value label="Verification code" />
