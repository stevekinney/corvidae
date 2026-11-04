# SchemaView

A read-only view of a JSON Schema as one aligned grid with the columns Field, Type and Description. Every field is a row: the label, a small red dot after it when the field is required, its type in plain words, and the first paragraph of its description. Nested objects are indented under their field, and the raw schema document sits behind a _JSON schema_ disclosure, so the schema is never dumped as raw JSON.

How to read it, and what feeds it:

- **required first**: the top-level required fields come first, then a single hairline, then the optional ones, with no group headers. Nested rows keep the schema's order and carry their own dots. The raw document keeps the file's order.
- **plain types**: `text`, `number`, `whole number`, `yes or no`, `list of steps` (a list of objects names them by the item's `title` or the field's label), `list of text`, `one of: activity, wait` (an enum), `group of fields` and `JSON schema` (a field whose `format` is `json-schema` or that refers to the JSON Schema meta-schema).
- **choices**: a `oneOf` or `anyOf` whose members are objects lists each branch's fields under the choice, labelled `If email: Address`. The branches are told apart by a property that is a constant in each one (`kind: { const: 'email' }`, with `type`, `mode` and `variant` tried first); that property is the choice's name for the branch and is not a row. Without one, a branch is named by its `title`, then by position (`option 1`). A branch's own `required` list gives its dots, so only the chosen branch's dots apply.
- **descriptions**: a description is shown up to its first blank line. Anything after it is text written for a model, and a _More_ link opens it in place (the link turns into _Less_). Write the line a person reads first, then a blank line, then the rest.
- **sentence-case labels**: `timeZone` reads "Time zone", `orderId` "Order ID", through `humanizeIdentifier` in sentence case.
- **long values**: a long field name truncates on one line with the full label as its tooltip, and the dot stays after it; a value with no spaces breaks anywhere inside its cell and never widens the grid.
- **phone width**: when the view itself is narrower than 30rem the columns restack, with the label and type on one line, the type at the end, and the description below it with _More_ inline after it.

Local `$ref`s into `$defs` or `definitions` are followed and `allOf` members are merged, including properties that more than one member declares. A reference that points back into the object being shown is not expanded again; its type reads, for example, `node (recursive)`. The view lists at most 500 expanded fields, and an object it did not open past that shows the same note as one beyond `maxDepth`. A schema that is not an object with properties shows one _Value_ row that names its type, and a schema with no fields shows one line, "This schema takes no fields, so there is nothing to fill in.", in a bordered box instead of an empty grid.

Use it wherever a schema is shown for reading: a workflow's input and output, a tool's input, the payload of a signal or an update, a question's answer. Use `JsonSchemaEditor` when the schema must be edited, and `PayloadInspector` when you are showing a value rather than the shape it must have.

## Usage

```svelte
<script lang="ts">
  import { SchemaView } from '@lostgradient/cinder';

  const refundInput = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['orderId', 'customer'],
    properties: {
      orderId: { type: 'string', description: 'The order to refund.' },
      refundAmount: { type: 'number', description: 'Amount in cents. Defaults to the full order.' },
      customer: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', description: 'Where the receipt is sent.' },
          loyaltyTier: { type: 'string' },
        },
      },
    },
  };
</script>

<SchemaView schema={refundInput} label="Refund input" />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `caption` | `string` | no | — | A note shown as the last line of the frame, below the rows. Use it to say how to read the grid, for example how a choice's branches are labelled. |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-schema-view` root element. |
| `emptyLabel` | `string` | no | `"This schema takes no fields, so there is nothing to fill in."` | Text shown, in a bordered box instead of an empty grid, when the schema declares no fields. |
| `label` | `string` | no | `"Schema"` | Accessible name of the view, for example "Workflow input". It is the `aria-label` of the region, so name what the schema describes. |
| `maxDepth` | `number` | no | `8` | How many levels of nested objects are expanded. Deeper objects show their line without their fields, and the raw document still holds them. |
| `rawLabel` | `string` | no | `"JSON schema"` | Label of the disclosure that reveals the raw schema document. |
| `schema` | `(opaque)` | yes | — | The JSON Schema to show, as a parsed object. Local `$ref`s into `$defs` or `definitions` are followed and `allOf` members are merged. A schema that is not an object with properties shows one `Value` line naming its type. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
