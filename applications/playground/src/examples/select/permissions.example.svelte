<script lang="ts" module>
  export const title = 'Permissions select with help under each option';
  export const description =
    'A ghost listbox select. The current option carries a check, its help sits under it, and the control keeps its tint and quiet ring while open.';
</script>

<script lang="ts">
  import { Select } from '@lostgradient/cinder';

  const permissions = [
    {
      value: 'asks',
      label: 'On changes asks',
      description: 'Tools set to On changes ask before they run.',
    },
    {
      value: 'all',
      label: 'Allow all',
      description:
        'Skips the On changes asks for this chat. Tools set to Always still ask; Blocked tools stay blocked.',
    },
  ];
  let permission = $state('asks');
</script>

<Select
  id="permissions"
  label="Permissions"
  labelVisible={false}
  presentation="listbox"
  variant="ghost"
  size="sm"
  options={permissions}
  bind:value={permission}
/>
