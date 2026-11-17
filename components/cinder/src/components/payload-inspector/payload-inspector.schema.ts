import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      description:
        'The payload value to inspect. Pass any JSON-serializable value — object,\narray, string, number, boolean, or null. Plain strings are rendered as\nstring values; strings that look like serialized JSON are parsed, and one\nthat does not parse is shown as text. Pass `undefined` when there is no\npayload, which draws one muted line and no card. While `streaming`, pass\nthe JSON text received so far.',
    },
    truncated: {
      type: 'boolean',
      description:
        'When true, the payload has been truncated by the producer (e.g. because it\nexceeded a wire size limit). The inspector renders a truncation badge in\nthe header.',
    },
    maxBytes: {
      type: 'number',
      description:
        'Maximum serialized size before nothing is rendered. A payload over it shows\nonly its size, a Copy button and a Download JSON button. Defaults to\n1,048,576 (1 MB).',
    },
    initialDepth: {
      type: 'number',
      description:
        'Initial collapse depth. In the JSON view, nodes deeper than this start\ncollapsed; in the Fields view, an object nested deeper than this starts\ncollapsed. Defaults to 1.',
    },
    maxDepth: {
      type: 'number',
      description:
        'Hard depth cap. Nodes deeper than this never render their children.\nDefaults to 50.',
    },
    view: {
      enum: ['fields', 'json'],
      description:
        "Which view the payload shows. `'fields'` lists each property with a\nsentence-case label; `'json'` shows the stored payload with its raw keys.\nBindable, and switched by the Fields / JSON control in the header row.",
      default: 'fields',
    },
    label: {
      type: 'string',
      description:
        'A heading drawn at the left of the header row, before the Fields / JSON\nswitch, such as "Input" or "Output". It also names the card for assistive\ntechnology; without one the card is named "Payload".',
    },
    redact: {
      type: 'array',
      items: {
        type: 'string',
      },
      description:
        'Secret paths: values to hide in both views and in Copy, before anything is\nlaid out. Each path is dot-separated property names from the root, array\npositions count from 1, and `*` stands for any one name or position (`headers.authorization`,\n`attachments.*.token`). Read them from a JSON Schema with\n`readSecretPaths`. When this is not passed, a property whose name reads as\na secret (token, key, password, authorization) is hidden as a fallback;\npass `[]` to hide nothing.',
    },
    streaming: {
      type: 'boolean',
      description:
        'True while the payload is still arriving. `value` is the JSON text received\nso far: fields appear as they complete, the last one shows "Receiving…", the\ncount reads "so far", and Copy waits until the stream ends.',
    },
    failed: {
      type: 'boolean',
      description:
        'True when the payload failed to load. The card keeps its header, hides the\nswitch, disables Copy, and shows `failedMessage` with a Try again button.',
    },
    failedMessage: {
      type: 'string',
      description: 'What a failed load says. Defaults to "Couldn\'t load the full result."',
    },
    emptyLabel: {
      type: 'string',
      description: 'The muted line shown when there is no payload. Defaults to "No payload".',
    },
    downloadFilename: {
      type: 'string',
      description:
        'The file name Download JSON saves a payload over `maxBytes` as. Defaults to "payload.json".',
    },
    bare: {
      type: 'boolean',
      description:
        'Draws the payload without its card, for a pane that already is one: no border, no divider under\nthe header, and no count or Copy button, since the pane carries its own Copy. The Fields view is\nalways one label and value per row with a quiet rule between rows, never the inline or grid\nlayouts, so a person reads a record as a list. The Fields / JSON switch sits at the end of the\nheader row, across from the label.',
      default: false,
    },
    plain: {
      type: 'boolean',
      description:
        'Shows a string `value` as it is, as text in a code block under the label, whatever it holds:\nthe Fields / JSON switch is not drawn, nothing is parsed and no invalid-JSON notice appears.\nUse it for a value that is not JSON, or one too long to lay out as fields, and say so beside\nit. A value that is not a string is shown as usual.',
      default: false,
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
        name: 'formatValue',
        reason: 'function-or-snippet',
        description:
          'Writes a value in the Fields view as the caller wants it, such as cents as\ndollars. It receives the path and the stored value; return `undefined` to\nkeep the default. The JSON view and Copy always show the stored value.',
      },
      {
        name: 'linkFor',
        reason: 'function-or-snippet',
        description:
          'Returns the address a value in the Fields view leads to, so a value that\nnames something (a run, a workflow, a user) can link to it. Return\n`undefined` to leave the value as text. The JSON view is never linked.',
      },
      {
        name: 'onRetry',
        reason: 'function-or-snippet',
        description:
          'Called when Try again is pressed after a failed load. Without it, no button is drawn.',
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
