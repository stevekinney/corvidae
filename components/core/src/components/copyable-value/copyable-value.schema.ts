import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      type: 'string',
      description:
        'The text shown, in monospace, and the text the copy control writes to the clipboard, such as an address or an identifier.',
    },
    label: {
      type: 'string',
      description:
        'Accessible name of the copy control, also its tooltip. Defaults to "Copy to clipboard".',
    },
    copiedLabel: {
      type: 'string',
      description:
        'What is announced once the copy succeeds. Defaults to "Copied"; say what was copied when `label` does ("Address copied").',
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-copyable-value`.',
    },
  },
  additionalProperties: false,
  required: ['value'],
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
