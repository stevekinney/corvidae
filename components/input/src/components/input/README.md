# Input

Single-line text input with support for labels, addons, validation states, and helper text.

## Usage

```svelte
<script lang="ts">
  import { Input } from '@lostgradient/cinder';

  let name = $state('');
</script>

<Input id="field" bind:value={name} label="Full name" placeholder="Jane Smith" />
{#if name}
  <p style="margin-top: 0.5rem; color: var(--cinder-text-muted);">Hello, {name}!</p>
{/if}
```

## Filled appearance

`appearance="filled"` draws an inset fill inside the same 1px `--cinder-control-border` edge, a 12px radius and the 2px focus ring. The edge is what keeps the 3:1 boundary: the fill alone measures about 1.1:1 against its surface and would fail WCAG 1.4.11. Hover darkens the edge, focus lifts the fill to the control surface under the ring, an invalid field keeps its danger edge, and a disabled field drops to the disabled fill. A read-only value drops the fill and keeps its dashed edge, so an editable field and a read-only value stay apart. Under `data-density="comfortable"` a field with no `appearance` is filled and 48px tall; the default density stays outlined, and `appearance="outlined"` opts a field out. The same prop is on Select, Textarea and SearchField.

```svelte
<script lang="ts">
  import { Input } from '@lostgradient/cinder';

  let email = $state('');
</script>

<Input id="email" appearance="filled" bind:value={email} label="Email" />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `appearance` | `"outlined"` \| `"filled"` | no | — | How the field is drawn. `"outlined"` is the control fill inside a 1px edge. `"filled"` is an inset fill inside the same 1px `--cinder-control-border` edge, which keeps the 3:1 boundary the fill alone would lose, with a 12px radius, a 48px height in the comfortable density and the 2px focus ring. Left unset, the field follows its density: `filled` under `data-density="comfortable"`, `outlined` otherwise. |
| `class` | `string` | no | — | Custom class merged with `.cinder-input`. |
| `description` | `string` | no | — | Helper text rendered below the input and associated via `aria-describedby`. |
| `disabled` | `boolean` | no | — | When true, disables the input, matching the native `disabled` attribute. |
| `error` | `string` | no | — | Error message rendered below the input; also sets `aria-invalid` on the input. |
| `groupClassName` | `string` | no | — | Additional class names applied to the grouped control frame when leading or trailing content is present. |
| `id` | `string` | yes | — | HTML `id` for the underlying input, used to associate the `<label>` and ARIA attributes. Required. |
| `label` | `string` | no | — | Visible label text rendered above the input and linked via `for`/`id`. |
| `labelVisible` | `boolean` | no | `true` | Whether the `label` is visibly rendered. Set `false` to visually hide it while keeping it programmatically associated. |
| `leadingInteractive` | `boolean` | no | — | When true, the leading adornment is interactive and included in the accessibility tree. Default `false`. |
| `required` | `boolean` | no | — | Marks the input as required for form validation, matching the native `required` attribute. |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | `"md"` | Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px, `lg` 40px, the same heights as a Button of that size. Replaces the native character-width `size` attribute, which Cinder does not forward; set a width with CSS instead. |
| `trailingInteractive` | `boolean` | no | — | When true, the trailing adornment is interactive and included in the accessibility tree. Default `false`. |
| `type` | `"number"` \| `"date"` \| `"email"` \| `"password"` \| `"search"` \| `"tel"` \| `"text"` \| `"time"` \| `"url"` | no | — | Input type controlling the browser's built-in validation and keyboard. Default `"text"`. |
| `variant` | `"default"` \| `"code"` \| `"bare"` | no | `"default"` | Visual style. `"code"` applies a shared monospace metric set (font-family, font-size, line-height, tab-size) for source-like values such as regular expressions, URIs, or identifiers. `"bare"` is an editable title: text that looks like a 600-weight title, with no border at rest, a hover tint, a focus ring over the control fill, and a width that follows its content. |
| `descriptionAction` | `(opaque)` | no | — | Rendered after the helper text inside the same paragraph, so it joins `aria-describedby`: a quiet link such as "Where do I get one?". Shown only with `description`. Not expressible in JSON Schema; see the component types for the signature. |
| `inputAttachment` | `(opaque)` | no | — | Attachment for native input access and lifecycle-scoped listeners. Not expressible in JSON Schema; see the component types for the signature. |
| `leading` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onValueChange` | `(opaque)` | no | — | Notify after the bindable value has been committed. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChangeRequest` | `(opaque)` | no | — | Intercept a proposed value before the bindable value is written. Return a replacement value to transform it. Not expressible in JSON Schema; see the component types for the signature. |
| `trailing` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `value` | `(opaque)` | yes | — | Bindable current text value of the input. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
