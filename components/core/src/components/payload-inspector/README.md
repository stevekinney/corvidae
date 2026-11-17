# PayloadInspector

One card for any payload: a header row with a Fields / JSON switch at the start and the count and a single copy action at the end, and a body under a divider. Fields is the default, with sentence-case labels; JSON is the escape hatch and always shows the stored payload with its raw keys.

## Overview

`PayloadInspector` composes `SegmentedControl`, `CopyButton`, `JsonViewer`, `Table`, `Badge`, `Button` and `CodeBlock` into one component for operational dashboards: workflow engines, tool calls, API consoles, webhook debuggers. Pass any JSON-serializable value, or the JSON text itself; the inspector parses it, hides secrets, chooses a layout, and handles every state.

What the Fields view draws:

- Nothing to show: one muted line (`emptyLabel`), with no card, no switch and no copy button.
- A value that is not an object: the value alone, in monospace. The header reads "1 value".
- A few short pairs: one line, "Order ID 4471, Amount $42.00", labels regular and values bold.
- Many short pairs: a wrapping key and value grid sized to its content.
- Anything else: one pair per row. A nested object is a collapsible tree (objects open, arrays closed); an array of scalars is a bulleted list; an array of objects that share keys is a table with real headers, capped at eight rows with "Showing 8 of 2,140" and Load more; an array of objects that do not share keys is one block of fields per item, headed "Item 1 of 3".
- Long text clamps to two lines with Show all, and a unified patch goes through the diff viewer.

Fields formats only what the JSON says unambiguously: an ISO date reads "Oct 24, 2026", a boolean "Yes" or "No", null "None", an empty string "Empty". A number reads as stored; anything else (cents as dollars) comes from `formatValue`, keyed by path.

The header counts top-level keys in words ("1 field", "3 fields"), adds the size only above 1 KB ("2 fields, 1.4 KB"), and a nested label carries its own count ("Parts, 3 items").

States, in the order they win over each other:

- `failed`: the switch is hidden, Copy is disabled, and a red line says what failed, with a Try again button when `onRetry` is passed.
- No value: the muted line above.
- A value that can't be serialized (circular references, BigInt): an explanation, with no switch and no copy.
- Over `maxBytes` (1 MB by default): nothing is rendered. The header holds only the size and Copy, and the body offers Download JSON.
- Text that is not valid JSON: the switch shows disabled, the header reads "Text", an amber line says so, and the raw text follows in a code block. Copy reads "Copy text".
- `streaming`: pass the JSON text received so far. Fields appear as they complete, the last one shows "Receiving…", the count reads "2 fields so far", and Copy waits.

## Usage

```svelte
<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
</script>

<PayloadInspector
  value={{ userId: 'u_123', action: 'checkout', items: [42, 43] }}
  label="Checkout payload"
/>
```

`label` is optional. When given, it is drawn at the start of the header (before the switch) and names the card; without it the card is named "Payload".

### With a JSON string

When your data arrives as a serialized string (e.g. from a message queue or API response body), pass it directly. The component parses it automatically:

```svelte
<PayloadInspector value={rawJsonString} />
```

### With truncation flag

When the producer truncates a payload before sending (e.g. due to wire limits), set `truncated` to signal this to the reader:

```svelte
<PayloadInspector value={truncatedPayload} truncated />
```

### Copy behavior

The copy button in the header copies pretty-printed JSON of the parsed value. When the payload itself is a string, including a JSON-encoded string primitive like `'"hello"'`, it copies that original string verbatim instead, so the copied text always matches what was passed as `value`. Unless a secret in it was hidden: then the hidden copy is written, so Copy never holds a stored secret. After a copy, the icon turns into a check with the word "Copied" for two seconds, announced politely, with no toast.

### Hiding secrets

Pass the secret paths as `redact`. Those values are hidden in both views and in Copy before anything is laid out: Fields shows bullets and the word "Hidden", and JSON and Copy hold bullets.

```svelte
<script lang="ts">
  import { PayloadInspector, readSecretPaths } from '@lostgradient/cinder';

  // writeOnly, format: "password" and x-secret properties of a JSON Schema.
  const secretPaths = readSecretPaths(toolInputSchema);
</script>

<PayloadInspector value={input} redact={secretPaths} />
```

A path is dot-separated property names from the root, array positions count from 1, and `*` stands for any one name or position (`headers.authorization`, `attachments.*.token`). When `redact` is not passed, a property whose name reads as a secret (token, key, password, authorization) is hidden as a fallback, because nothing else says which values are. Pass `[]` to hide nothing. Text that is not valid JSON cannot be searched for secrets, so it is shown as written.

### Writing a value your own way

`formatValue` receives `{ path, key, value }` and returns the text to show, or `undefined` to keep the default. It only changes the Fields view.

```svelte
<PayloadInspector
  value={{ amountCents: 4200 }}
  formatValue={({ key, value }) =>
    key === 'amountCents' && typeof value === 'number' ? `$${(value / 100).toFixed(2)}` : undefined}
/>
```

### Custom parser for non-JSON formats

Pass a `parse` function to support alternative serialization formats:

```svelte
<PayloadInspector value={encodedString} parse={(raw) => myDecoder.decode(raw)} />
```

### Showing a value as text

Set `plain` to show a string as it is: text in a code block under the label, with no Fields / JSON switch, no parsing and no invalid-JSON notice. Use it for a value that is not JSON, or one too long to lay out as fields, and say what it is in the label.

```svelte
<PayloadInspector value={firstPartOfTheLog} label="Value, text, 2.1 MB" bare plain />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `bare` | `boolean` | no | `false` | Draws the payload without its card, for a pane that already is one: no border, no divider under the header, and no count or Copy button, since the pane carries its own Copy. The Fields view is always one label and value per row with a quiet rule between rows, never the inline or grid layouts, so a person reads a record as a list. The Fields / JSON switch sits at the end of the header row, across from the label. |
| `class` | `string` | no | — | Additional CSS classes applied to the root element. |
| `downloadFilename` | `string` | no | — | The file name Download JSON saves a payload over `maxBytes` as. Defaults to "payload.json". |
| `emptyLabel` | `string` | no | — | The muted line shown when there is no payload. Defaults to "No payload". |
| `failed` | `boolean` | no | — | True when the payload failed to load. The card keeps its header, hides the switch, disables Copy, and shows `failedMessage` with a Try again button. |
| `failedMessage` | `string` | no | — | What a failed load says. Defaults to "Couldn't load the full result." |
| `initialDepth` | `number` | no | — | Initial collapse depth. In the JSON view, nodes deeper than this start collapsed; in the Fields view, an object nested deeper than this starts collapsed. Defaults to 1. |
| `label` | `string` | no | — | A heading drawn at the left of the header row, before the Fields / JSON switch, such as "Input" or "Output". It also names the card for assistive technology; without one the card is named "Payload". |
| `maxBytes` | `number` | no | — | Maximum serialized size before nothing is rendered. A payload over it shows only its size, a Copy button and a Download JSON button. Defaults to 1,048,576 (1 MB). |
| `maxDepth` | `number` | no | — | Hard depth cap. Nodes deeper than this never render their children. Defaults to 50. |
| `plain` | `boolean` | no | `false` | Shows a string `value` as it is, as text in a code block under the label, whatever it holds: the Fields / JSON switch is not drawn, nothing is parsed and no invalid-JSON notice appears. Use it for a value that is not JSON, or one too long to lay out as fields, and say so beside it. A value that is not a string is shown as usual. |
| `redact` | `string`[] | no | — | Secret paths: values to hide in both views and in Copy, before anything is laid out. Each path is dot-separated property names from the root, array positions count from 1, and `*` stands for any one name or position (`headers.authorization`, `attachments.*.token`). Read them from a JSON Schema with `readSecretPaths`. When this is not passed, a property whose name reads as a secret (token, key, password, authorization) is hidden as a fallback; pass `[]` to hide nothing. |
| `streaming` | `boolean` | no | — | True while the payload is still arriving. `value` is the JSON text received so far: fields appear as they complete, the last one shows "Receiving…", the count reads "so far", and Copy waits until the stream ends. |
| `truncated` | `boolean` | no | — | When true, the payload has been truncated by the producer (e.g. because it exceeded a wire size limit). The inspector renders a truncation badge in the header. |
| `value` | `unknown` | no | — | The payload value to inspect. Pass any JSON-serializable value — object, array, string, number, boolean, or null. Plain strings are rendered as string values; strings that look like serialized JSON are parsed, and one that does not parse is shown as text. Pass `undefined` when there is no payload, which draws one muted line and no card. While `streaming`, pass the JSON text received so far. |
| `view` | `"fields"` \| `"json"` | no | `"fields"` | Which view the payload shows. `'fields'` lists each property with a sentence-case label; `'json'` shows the stored payload with its raw keys. Bindable, and switched by the Fields / JSON control in the header row. |
| `formatValue` | `(opaque)` | no | — | Writes a value in the Fields view as the caller wants it, such as cents as dollars. It receives the path and the stored value; return `undefined` to keep the default. The JSON view and Copy always show the stored value. Not expressible in JSON Schema; see the component types for the signature. |
| `linkFor` | `(opaque)` | no | — | Returns the address a value in the Fields view leads to, so a value that names something (a run, a workflow, a user) can link to it. Return `undefined` to leave the value as text. The JSON view is never linked. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | Called when Try again is pressed after a failed load. Without it, no button is drawn. Not expressible in JSON Schema; see the component types for the signature. |
| `parse` | `(opaque)` | no | — | Custom parser applied when `value` is a string. Receives the raw string and must return a parsed value or throw. Defaults to JSON.parse. Use this to support alternative serialization formats. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Accessibility

The root is a named `group`, not a landmark, so a dashboard rendering many inspectors adds nothing to the screen reader's landmark list. The `label` (or "Payload") names it, and the JSON tree is cinder's `JsonViewer`, a WAI-ARIA tree composite; see [json-viewer accessibility documentation](../json-viewer/json-viewer.a11y.md) for its keyboard contract.

A failed load carries `role="alert"`. The copy confirmation is announced by the copy button's own polite live region. See [payload-inspector.a11y.md](./payload-inspector.a11y.md) for the full pattern.
