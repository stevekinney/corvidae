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

`SettingRow` requires a stable `id`, `label`, and `control` snippet. `warning` is advisory and `error` is corrective; both are forwarded through the `FormField` context to the composed control. Use `managed` with [`PolicyLock`](../policy-lock/README.md) when a policy owns the value. The row does not save settings or disable a control automatically—pass `disabled` to the row or control when the host is submitting or unavailable.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `description` | `string` | no | — | Guidance text describing the setting. |
| `disabled` | `boolean` | no | `false` | Forwards a disabled state into `FormField` context for the row's control. Only takes effect for a control that opts into and reads that context—a native element or a third-party component that doesn't consume it stays interactive and must receive `disabled` directly. Does not disable automatically while saving. `SettingRow` forwards `undefined` when omitted; `FormField` normalizes that to `false`. Defaults to `false`. |
| `error` | `string` | no | — | Corrective error message forwarded through `FormField` context. |
| `id` | `string` | yes | — | Stable id shared with the composed control. |
| `label` | `string` | yes | — | Visible setting label. |
| `managed` | { by?: `string`; reason?: `string` } | no | — | Renders a managed-policy indicator; pair with `PolicyLock`. |
| `required` | `boolean` | no | `false` | Renders the required marker and forwards `required` into `FormField` context. Only takes effect for a control that opts into and reads that context—it never adds a native `required` attribute, so a control that doesn't consume the context still passes browser constraint validation and must receive `required` directly. `SettingRow` forwards `undefined` when omitted; `FormField` normalizes that to `false`. Defaults to `false`. |
| `warning` | `string` | no | — | Advisory message forwarded through `FormField` context. |
| `control` | `(opaque)` | yes | — | The setting's control, rendered with `FormField` context applied. Not expressible in JSON Schema; see the component types for the signature. |
| `disclosure` | `(opaque)` | no | — | Optional disclosure content rendered beneath the row. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
