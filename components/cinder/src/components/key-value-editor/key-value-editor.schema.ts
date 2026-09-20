import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    addLabel: {
      type: 'string',
      description:
        'Label for the add-row action. Give it concrete wording when more than one editor is on the page.',
    },
    class: {
      type: 'string',
      description: "Additional class merged with the component's root class.",
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'entries',
        reason: 'unknown-shape',
        description: 'The editable list of key/value rows. Bindable.',
      },
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description:
          'Callback form of the resulting array, for when the parent does not use `bind:entries`.',
      },
      {
        name: 'removeLabel',
        reason: 'function-or-snippet',
        description:
          "Label for a row's remove action, given that row's key. Give it concrete wording when more than one editor is on the page.",
      },
      {
        name: 'secret',
        reason: 'function-or-snippet',
        description:
          "Predicate receiving a row's key; routes that row's value through a password input when it returns `true`.",
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
