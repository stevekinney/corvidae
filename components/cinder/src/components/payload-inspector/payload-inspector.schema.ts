import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      description:
        'The payload value to inspect. Pass any JSON-serializable value — object,\narray, string, number, boolean, or null. Plain strings are rendered as\nstring values; strings that look like serialized JSON are parsed. Pass\n`undefined` when no payload is available yet.',
    },
    truncated: {
      type: 'boolean',
      description:
        'When true, the payload has been truncated by the producer (e.g. because it\nexceeded a wire size limit). The inspector renders a truncation badge in\nthe header.',
    },
    maxBytes: {
      type: 'number',
      description:
        'Maximum byte size before the tree view is replaced with an oversize\nplaceholder. Defaults to 1,048,576 (1 MB).',
    },
    initialDepth: {
      type: 'number',
      description:
        'Initial collapse depth for the JSON tree. Nodes deeper than this start\ncollapsed. Defaults to 1.',
    },
    maxDepth: {
      type: 'number',
      description:
        'Hard depth cap for the JSON tree. Nodes deeper than this never render\ntheir children. Defaults to 50.',
    },
    view: {
      enum: ['fields', 'json'],
      description:
        "Which view a structured payload (an object or array) shows. `'fields'`\nlists each property with a formatted label; `'json'` shows the collapsible\nJSON tree. Bindable, and switched by the Fields / JSON control in the\nheading row.",
      default: 'fields',
    },
    label: {
      type: 'string',
      description: 'Visible header label for the inspector. Defaults to "Payload inspector".',
    },
    class: {
      type: 'string',
      description: 'Additional CSS classes applied to the root element.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'linkFor',
        reason: 'function-or-snippet',
        description:
          'Returns the address a value in the Fields view leads to, so a value that\nnames something (a run, a workflow, a user) can link to it. Return\n`undefined` to leave the value as text. The JSON view is never linked.',
      },
      {
        name: 'parse',
        reason: 'function-or-snippet',
        description:
          'Custom parser applied when `value` is a string. Receives the raw string\nand must return a parsed value or throw. Defaults to JSON.parse. Use this\nto support alternative serialization formats.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
