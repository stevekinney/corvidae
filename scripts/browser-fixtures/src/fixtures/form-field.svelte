<script lang="ts">
  import { FormField, Input, Label } from '@lostgradient/cinder';

  let name = $state('');
  let nickname = $state('');
  let timezone = $state('');
</script>

<FormField
  id="full-name"
  label="Full name"
  warning={name.length > 0 && name.length < 3
    ? 'Short names may be difficult to identify.'
    : undefined}
  managed={{ by: 'Workspace policy', reason: 'Displayed on shared reports' }}
>
  <Input id="full-name" bind:value={name} placeholder="Jane Smith" />
</FormField>

<section id="example-mount-optional-labels" aria-label="Optional field labels">
  <div>
    <Label for="optional-timezone" optional>Timezone</Label>
    <Input id="optional-timezone" bind:value={timezone} />
  </div>

  <FormField id="optional-nickname" label="Nickname" optional>
    <Input id="optional-nickname" bind:value={nickname} />
  </FormField>
</section>
