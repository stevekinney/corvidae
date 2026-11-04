<script lang="ts" module>
  export const title = 'Placeholder, description and note';
  export const description =
    'note is neutral text under the description that says why a field is the way it is. Here the fixed-date field is cleared for a schedule, keeps its placeholder and help text, and explains itself beneath.';
</script>

<script lang="ts">
  import { FormField, Input } from '@lostgradient/cinder';

  const uid = $props.id();
</script>

<div style="max-inline-size: 30rem;">
  <FormField
    id={`${uid}-since`}
    label="Since"
    description="Collect changes made on or after this date."
    note="Cleared for the schedule: a fixed date would re-collect the same changes on every run."
  >
    <Input id={`${uid}-since`} value="" placeholder="mm/dd/yyyy" />
  </FormField>
</div>
