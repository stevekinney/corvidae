<script lang="ts">
  import { default as FormField } from '@lostgradient/form-field/components/form-field/index.ts';
  import { default as Input } from '@lostgradient/input/components/input/index.ts';

  let name = $state('');
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
