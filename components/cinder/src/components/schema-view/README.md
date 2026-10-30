# SchemaView

A read-only view of a JSON Schema. It shows one line per field: the field's label, a red dot when the field is required, its type in small monospace, and its description. Nested objects are indented under their field, and the raw schema document sits behind a _View JSON Schema_ disclosure, so the schema is never dumped as raw JSON.

Labels come from Cinder's identifier formatter, so `orderId` reads "Order ID". Local `$ref`s into `$defs` or `definitions` are followed and `allOf` members are merged. A schema that is not an object with properties shows one _Value_ line that names its type.

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
| `class` | `string` | no | — | Additional class merged onto the `.cinder-schema-view` root element. |
| `emptyLabel` | `string` | no | `"This schema declares no fields."` | Text shown when the schema declares no fields. |
| `label` | `string` | no | `"Schema"` | Accessible name of the view, for example "Workflow input". It is the `aria-label` of the region, so name what the schema describes. |
| `maxDepth` | `number` | no | `8` | How many levels of nested objects are expanded. Deeper objects show their line without their fields, and the raw document still holds them. |
| `rawLabel` | `string` | no | `"View JSON Schema"` | Label of the disclosure that reveals the raw schema document. |
| `schema` | `(opaque)` | yes | — | The JSON Schema to show, as a parsed object. Local `$ref`s into `$defs` or `definitions` are followed and `allOf` members are merged. A schema that is not an object with properties shows one `Value` line naming its type. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
