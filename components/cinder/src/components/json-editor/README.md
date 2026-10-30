# JsonEditor

Controlled free-form JSON editing on a lazily loaded CodeMirror 6 editor. It adds line numbers, code folding, bracket matching, schema completion, inline syntax errors, a Format action, and a height that fits the content, and it keeps a native textarea behind it for form posting and as a fallback.

The editor runtime is a separate chunk. It loads through a dynamic `import()` when the first `JsonEditor` mounts, so a page without one never downloads it. Until it arrives, on the server, and if it fails to load, the textarea is the editor. The `value`, `onValueChange`, `id`, `label`, and form posting contract is the same in both modes, and the textarea carries any `name` or `form` attribute you pass, so the field posts whichever editor is showing.

## Usage

```svelte
<script lang="ts">
  import { JsonEditor } from '@lostgradient/cinder';

  let value = $state('{}');
</script>

<JsonEditor id="payload" label="Payload" {value} onValueChange={(next) => (value = next)} />
```

## Empty values

An empty optional field is valid. It shows no error and no lint glyph, announces no "Valid JSON.", and reads "Not set" through its placeholder. Pass `required` to make an empty value an error again, or pass `placeholder` to replace the text.

## Read-only and disabled

`readonly` keeps the field focusable and selectable and posts it with its form, but refuses edits and disables Format, in the editor and in the textarea fallback. `disabled` also removes it from the form post and from the tab order.

## Required

`required` keeps the native constraint on the posted textarea after the editor mounts, so an empty required field blocks form submission. The textarea is hidden and cannot take focus, so the invalid-field focus is sent to the visible editor.

## Height

The editor grows with its content, so a short value is not a large empty box. `rows` is the most lines it shows before it scrolls, and it defaults to 8.

## Schema completion

Pass a JSON Schema as `schema` to complete property names and values. Completion follows `properties`, `items`, local `$ref` pointers, and `allOf`, `anyOf`, and `oneOf`, and it offers `enum` and `const` values and `true` or `false` for booleans. It never rejects what the user types, and a keyword it does not read is ignored.

```ts
import type { JsonEditorSchema } from '@lostgradient/cinder';

export const schema: JsonEditorSchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['fast', 'safe'] },
    retries: { type: 'number' },
  },
};
```

Then pass it to the component with `schema={schema}`.

## Format

The Format button and `Shift+Alt+F` rewrite the document as JSON indented by two spaces. Both are disabled for empty or invalid JSON. Formatting parses and re-serializes the document, so digits beyond double precision are lost and duplicate keys collapse.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Extra class names merged onto the field wrapper. |
| `description` | `string` | no | — | Supporting text announced with the editor. |
| `disabled` | `boolean` | no | — | Disables the editor. A disabled field is not posted with its form. |
| `error` | `string` | no | — | External validation error. Takes precedence over JSON parse feedback. |
| `id` | `string` | yes | — | Unique identifier used for the label and feedback relationships. |
| `label` | `string` | yes | — | Visible label for the editor. |
| `readonly` | `boolean` | no | — | Makes the editor read-only. A read-only field stays focusable and selectable and is posted with its form, but cannot be edited or formatted. |
| `required` | `boolean` | no | — | Marks the editor as required. An empty value is valid and reads "Not set" unless the field is required. |
| `rows` | `number` | no | `8` | The most lines the editor shows before it scrolls. It grows with its content up to this height, so a short value is not a large empty box. Defaults to 8. |
| `validFeedbackVisible` | `boolean` | no | `true` | Whether valid JSON should render an announced success message. Defaults to true. |
| `value` | `string` | yes | — | Controlled JSON source text. |
| `onValueChange` | `(opaque)` | no | — | Called with the proposed JSON source whenever the user edits the field. Not expressible in JSON Schema; see the component types for the signature. |
| `schema` | `(opaque)` | no | — | A JSON Schema that drives property-name and value completion. Without one the editor offers no completions. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

<!-- generated:subcomponents:end -->
