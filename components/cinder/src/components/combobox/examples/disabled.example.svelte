<script lang="ts" module>
  export const title = 'Disabled combobox';
  export const description = 'Disabled combobox cannot be focused or edited.';
  // Featured so the Overview stage previews the exact control the README's usage
  // snippet documents; the stage shows this file's source, so the two agree.
  export const featured = true;
</script>

<script lang="ts">
  import { Combobox } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-combobox-disabled`);

  const options = [
    { value: 'free', label: 'Free' },
    { value: 'pro', label: 'Pro' },
    { value: 'enterprise', label: 'Enterprise', disabled: true },
  ];
</script>

<Combobox
  id={fieldId}
  label="Plan"
  placeholder="Locked plan selection"
  {options}
  value="pro"
  disabled
/>
