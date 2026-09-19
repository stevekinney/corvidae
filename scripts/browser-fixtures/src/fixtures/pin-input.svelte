<script lang="ts">
  import { PinInput } from '@corvidae/cinder';
  let value = $state('');
</script>

<PinInput id="basic-pin" bind:value label="Verification code" />
