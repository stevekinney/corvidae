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

`SettingRow` requires a stable `id`, `label`, and `control` snippet. `warning` is advisory and `error` is corrective; `FormField` renders both messages itself as siblings of the control, and exposes only `warningId`/`errorId`/`describedBy`/`invalid` through context—a custom `control` that reads that context associates with the messages, it doesn't receive their text. Use `managed` with [`PolicyLock`](../policy-lock/README.md) when a policy owns the value. The row does not save settings or disable a control automatically—pass `disabled` to the row or control when the host is submitting or unavailable.

## One save model

A setting saves when the person leaves its field and shows what happened on its own row; there is no page-level Save. The label, the raw key (`identifier`, small and monospaced, outside the label so it stays out of the accessible name) and the description sit on the left with the status line, the error and the managed line under them, and the control on the right. Below 30rem of row width the control stacks under the label.

- `status` draws one of four lines in a polite live region that is always mounted: `saving` ("Saving…", spinning glyph), `saved` ("Saved just now", success tone), `restart` ("Applies after restart", restart glyph) and `saved-restart` ("Saved, waiting for a restart", amber dot). `statusLabel` replaces the words.
- `error` marks the control invalid and says what is wrong at the field: an invalid value ("Enter a number from 1 to 3650. Nothing was saved.") or a failed save. `onRetry` adds a quiet Retry beside a failed save; the value stays in the field.
- `managed` with a `message` draws a locked setting with the lock glyph. The control is the page's to make read-only.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `description` | `string` | no | — | Guidance text describing the setting. |
| `disabled` | `boolean` | no | `false` | Forwards a disabled state into `FormField` context for the row's control. Only takes effect for a control that opts into and reads that context—a native element or a third-party component that doesn't consume it stays interactive and must receive `disabled` directly. Does not disable automatically while saving. `SettingRow` forwards `undefined` when omitted; `FormField` normalizes that to `false`. Defaults to `false`. |
| `error` | `string` | no | — | Corrective error message. `FormField` renders this text itself, as a sibling of the control, not through context—a custom `control` that reads `FormField` context sees only the derived `errorId`, `invalid`, and the composed `describedBy`, never the message string itself. |
| `id` | `string` | yes | — | Stable id forwarded into `FormField` context, which associates the generated `<label for={id}>` with it. Only a control that opts into and reads that context receives `id` automatically—for a native element or a third-party component that doesn't, the label is unassociated unless the host also applies `id` to that control directly, the same qualification as `required` and `disabled`. |
| `identifier` | `string` | no | — | The raw key behind the label, drawn small and monospaced beside it ("engine.maxConcurrentRuns"). It sits outside the `<label>`, so it never becomes part of the control's accessible name. |
| `label` | `string` | yes | — | Visible setting label. |
| `managed` | { by?: `string`; message?: `string`; reason?: `string` } | no | — | Renders a managed-policy line with a lock glyph; pair with `PolicyLock`. Give it a `message` for a locked setting ("Locked by your deployment (remote mode). Change it in the deployment's configuration."). The control stays the page's to make read-only. |
| `required` | `boolean` | no | `false` | Renders the required marker and forwards `required` into `FormField` context. Only takes effect for a control that opts into and reads that context—it never adds a native `required` attribute, so a control that doesn't consume the context still passes browser constraint validation and must receive `required` directly. `SettingRow` forwards `undefined` when omitted; `FormField` normalizes that to `false`. Defaults to `false`. |
| `retryLabel` | `string` | no | `"Retry"` | Label of the retry action drawn beside the error when `onRetry` is set. |
| `status` | `"saving"` \| `"saved"` \| `"restart"` \| `"saved-restart"` | no | — | Where the setting's own save has got to: `saving`, `saved`, `restart` or `saved-restart`. It draws a status line under the description, in a polite live region that is always mounted, so a change from Saving to Saved is announced. Leave it unset for a setting at rest. Pair it with `error` for the failures: an invalid value or a save that did not go through. |
| `statusLabel` | `string` | no | — | Replaces the words of the status line, such as "Saved 2 minutes ago" for `saved`. The glyph and tone still follow `status`. |
| `warning` | `string` | no | — | Advisory message. `FormField` renders this text itself, as a sibling of the control, not through context—a custom `control` that reads `FormField` context sees only the derived `warningId` (and the composed `describedBy`) to associate with, never the message string itself. |
| `control` | `(opaque)` | yes | — | The setting's control, rendered with `FormField` context applied. Not expressible in JSON Schema; see the component types for the signature. |
| `disclosure` | `(opaque)` | no | — | Optional disclosure content rendered beneath the row. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | Called by the quiet Retry beside the error, for a save that did not go through ("Couldn't save. Your value is still in the field. Retry"). Leave it unset for an invalid value, where retrying changes nothing and the person fixes the field instead. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
