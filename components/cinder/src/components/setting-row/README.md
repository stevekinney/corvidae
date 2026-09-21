# SettingRow

SettingRow arranges settings-page guidance and a control while publishing FormField context to composed Input, Toggle, or Select controls. It supports advisory, error, managed-policy, and optional disclosure content without duplicating those semantics at each call site.

## Usage

```svelte
<script lang="ts">
  import { Input } from '@lostgradient/cinder';
  import { SettingRow } from '@lostgradient/cinder';
</script>

<SettingRow id="display-name" label="Display name" description="Shown to collaborators.">
  {#snippet control()}
    <Input id="display-name" value="" placeholder="Ada Lovelace" />
  {/snippet}
</SettingRow>
```

`SettingRow` requires a stable `id`, `label`, and `control` snippet. `warning` is advisory and `error` is corrective; both are forwarded through the `FormField` context to the composed control. Use `managed` with [`PolicyLock`](../policy-lock/README.md) when a policy owns the value. The row does not save settings or disable a control automatically—pass `disabled` to the row or control when the host is submitting or unavailable.
