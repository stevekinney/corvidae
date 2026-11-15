# JsonEditor

Controlled free-form JSON editing on a lazily loaded CodeMirror 6 editor, drawn as one frame with no header band. The validity status and a Format button float quietly in the frame's top inline-end corner, over the code; the frame holds line numbers, code folding, bracket matching, schema completion, marked problem lines, and a height that fits the content. A native textarea stays behind the editor for form posting and as a fallback.

The editor runtime is a separate chunk. It loads through a dynamic `import()` when the first `JsonEditor` mounts, so a page without one never downloads it. Until it arrives, on the server, and if it fails to load, the textarea is the editor. The `value`, `onValueChange`, `id`, `label`, and form posting contract is the same in both modes, and the textarea carries any `name` or `form` attribute you pass, so the field posts whichever editor is showing.

## Usage

```svelte
<script lang="ts">
  import { JsonEditor } from '@lostgradient/cinder';

  let value = $state('{}');
</script>

<JsonEditor id="payload" label="Payload" {value} onValueChange={(next) => (value = next)} />
```

## The frame and its status

The border, the corner radius, and the quiet focus ring belong to the frame, so the line-number gutter is clipped to the radius. The status and Format sit in the top inline-end corner with no band, border, or fill of their own: the editor's surface fades in behind them, so a long first line slides under them, and a status too long for the corner is cut with an ellipsis while the live region still holds the whole text. They come before the text in tab order. The status is a live region and reads one of:

- **Empty**: an optional field with no source. Format is off, the body has no line numbers, and the muted example (`example`, shown after "e.g.") fills the body, which is still three rows tall so it reads as an editor.
- **Valid JSON**, with a check, in the success tone. `statusLabel` replaces the words while the source parses, such as "Valid JSON, not a valid workflow". `validFeedbackVisible={false}` leaves the status out.
- **Line 2: expected a comma**, with an error icon, in the danger tone. It is a button that moves the caret to that line.
- **Read only**, with a lock. A read-only editor has no Format button; its content and gutter still show.

A disabled editor is dimmed whole and cannot be focused, but it keeps the status, and its Format button is off. The line-number gutter appears at two or more lines, so an empty field or a one-line value is a plain text box.

## Marked lines

When the source does not parse, the editor marks the line to fix: the line and the message under it are one tinted rectangle, the width of the text area, with a red bar down its inline start, and the line number turns red. The gutter takes no fill. A missing comma or colon is noticed when the parser reaches the next token, which is often on the next line, so the mark is anchored at the end of the last token before the position where the parser stopped. The line the parser stops at is never the line that is marked. The editor locates the problem itself rather than reading the engine's error message, so the line is the same in every browser.

`diagnostics` marks lines of a document that parses, for what only the page can know, such as a valid workflow that names an agent which is unavailable:

```svelte
<JsonEditor
  id="workflow"
  label="Workflow"
  {value}
  onValueChange={(next) => (value = next)}
  statusLabel="Valid JSON, not a valid workflow"
  diagnostics={[{ line: 21, message: 'No agent with the ID release-helper is available.' }]}
/>
```

The `error` prop is for a message that belongs to the whole field. It turns the frame's border red and shows the message under the field with an error glyph. Bind the component with `bind:this` and call `focusProblem()` to take a person to the first marked line when they press Save, or `focusLine(n)` for a specific line. Both work before the editor chunk loads, by placing the caret in the textarea.

## Empty values

An empty optional field is valid. It shows no error and no mark, reads "Empty" in the status, and shows the muted example in the body: `example`, prefixed "e.g.", which defaults to `{ "key": "value" }`. Pass `placeholder` to replace the whole text. Pass `required` to make an empty value an error again.

## Read-only and disabled

`readonly` keeps the field focusable and selectable and posts it with its form, but refuses edits and removes the Format button, in the editor and in the textarea fallback. `disabled` also removes it from the form post and from the tab order.

## Required

`required` keeps the native constraint on the posted textarea after the editor mounts, so an empty required field blocks form submission. The textarea is hidden and cannot take focus, so the invalid-field focus is sent to the visible editor.

## Height and long lines

The editor grows with its content from a three-row minimum, so a short value is not a large empty box and an empty one still reads as an editor. `rows` is the most lines it shows before it scrolls inside itself, with a visible scrollbar, and it defaults to 8. This rule is for answer and setting fields; a view that only shows code uses a read-only `CodeBlock`.

A line longer than the frame scrolls sideways inside the editor: the gutter stays put and the control never widens. Below 640px a long line wraps instead, because sideways scrolling is hard to use on a phone. `wrap="off"` always scrolls and `wrap="soft"` always wraps.

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

The Format button and `Shift+Alt+F` rewrite the document as JSON indented by two spaces. Both do nothing for empty or invalid JSON, and the button is disabled then. Formatting parses and re-serializes the document, so digits beyond double precision are lost and duplicate keys collapse.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Extra class names merged onto the field wrapper. |
| `description` | `string` | no | — | Supporting text announced with the editor. |
| `disabled` | `boolean` | no | — | Disables the editor. A disabled field is not posted with its form. |
| `error` | `string` | no | — | External validation error. Takes precedence over JSON parse feedback. |
| `example` | `string` | no | — | The sample that shows muted, after "e.g.", while the editor is empty, such as `{ "timeoutSeconds": 300 }`. Defaults to `{ "key": "value" }`. A `placeholder` replaces the whole text. |
| `id` | `string` | yes | — | Unique identifier used for the label and feedback relationships. |
| `label` | `string` | yes | — | Visible label for the editor. |
| `readonly` | `boolean` | no | — | Makes the editor read-only. The status reads "Read only" and there is no Format button. A read-only field stays focusable and selectable and is posted with its form, but cannot be edited or formatted. |
| `required` | `boolean` | no | — | Marks the editor as required. An empty value is valid and reads "Not set" unless the field is required. |
| `rows` | `number` | no | `8` | The most lines the editor shows before it scrolls. It grows with its content from a three-line minimum up to this height, so a short value is not a large empty box. Defaults to 8. |
| `statusLabel` | `string` | no | — | Replaces the "Valid JSON" status while the source parses, for a caller whose own validation says more, such as "Valid JSON, not a valid workflow". Never replaces an invalid or empty status. |
| `validFeedbackVisible` | `boolean` | no | `true` | Whether valid JSON should render an announced success message. Defaults to true. |
| `value` | `string` | yes | — | Controlled JSON source text. |
| `wrap` | `"soft"` \| `"hard"` \| `"off"` | no | — | How a line longer than the editor is shown. Left unset, it scrolls sideways inside the editor with the line-number gutter fixed, and wraps below 640px, where sideways scrolling is hard to use. `'off'` always scrolls; `'soft'` and `'hard'` always wrap. |
| `diagnostics` | `(opaque)` | no | — | Problems the caller found at specific lines of a document that parses. Each line is marked and shows its message under it. Not expressible in JSON Schema; see the component types for the signature. |
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
