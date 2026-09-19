<script lang="ts">
  import { Checkbox, CheckboxGroup } from '@corvidae/cinder';
</script>

<div id="example-mount-disabled-fieldset">
  <CheckboxGroup label="Notification channels" disabled>
    <Checkbox id="disabled-fieldset-email" label="Email" checked />
    <Checkbox id="disabled-fieldset-sms" label="SMS" />
  </CheckboxGroup>
</div>
