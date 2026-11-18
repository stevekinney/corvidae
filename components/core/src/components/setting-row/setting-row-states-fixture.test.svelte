<script lang="ts">
  import SettingRow from './setting-row.svelte';
  import type { SettingRowProps } from './setting-row.types.ts';
  import Input from '../input/input.svelte';

  let {
    value = '4',
    readonly = false,
    ...rest
  }: Partial<Omit<SettingRowProps, 'control'>> & { value?: string; readonly?: boolean } = $props();
</script>

<SettingRow id="max-runs" label="Max concurrent runs" {...rest}>
  {#snippet control()}<Input id="max-runs" {value} {readonly} />{/snippet}
</SettingRow>
