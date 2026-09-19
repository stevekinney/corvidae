# SettingRow

SettingRow arranges settings-page guidance and a control while publishing FormField context to composed Input, Toggle, or Select controls. It supports advisory, error, managed-policy, and optional disclosure content without duplicating those semantics at each call site.

## Usage

```svelte
<script lang="ts">
  import { Input } from '@corvidae/cinder';
  import { SettingRow } from '@corvidae/cinder';
</script>

<SettingRow id="display-name" label="Display name" description="Shown to collaborators.">
  {#snippet control()}
    <Input id="display-name" value="" placeholder="Ada Lovelace" />
  {/snippet}
</SettingRow>
```
