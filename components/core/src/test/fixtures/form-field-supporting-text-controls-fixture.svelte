<script lang="ts">
  import FormField from '@lostgradient/form-field/components/form-field/form-field.svelte';
  import PhoneInput from '@lostgradient/phone-input/components/phone-input/phone-input.svelte';
  import PinInput from '@lostgradient/pin-input/components/pin-input/pin-input.svelte';
  import Rating from '@lostgradient/rating/components/rating/rating.svelte';
  import Toggle from '@lostgradient/toggle/components/toggle/toggle.svelte';
</script>

<FormField
  id="supporting-pin"
  label="Verification code"
  warning="This code expires soon."
  managed={{ by: 'Security policy' }}
>
  <PinInput id="supporting-pin" />
</FormField>

<FormField
  id="supporting-toggle"
  label="Telemetry"
  warning="Usage data may include metadata."
  managed={{ by: 'Organization policy' }}
>
  <Toggle id="supporting-toggle" label="Telemetry" />
</FormField>

<FormField
  id="supporting-phone"
  label="Phone number"
  warning="Carrier charges may apply."
  managed={{ reason: 'Required for recovery' }}
>
  <PhoneInput id="supporting-phone" />
</FormField>

<FormField
  id="supporting-rating"
  label="Rating"
  warning="This response is public."
  managed={{ by: 'Feedback policy' }}
>
  <Rating id="supporting-rating" />
</FormField>
