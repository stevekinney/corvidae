import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    header: {
      type: 'string',
      description:
        'A header drawn above the group, outside its surface, in small muted text. It also names the list.',
    },
    footer: {
      type: 'string',
      description: 'A note drawn under the group, outside its surface, in small muted text.',
    },
    addLabel: {
      type: 'string',
      description: 'Accessible name of the quick-add input.',
      default: 'Add an item',
    },
    addPlaceholder: {
      type: 'string',
      description: 'Placeholder text of the quick-add input. Left unset, it shows the label.',
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-grouped-list`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        description: 'The rows: GroupedListItem elements.',
      },
      {
        name: 'onItemAdd',
        reason: 'function-or-snippet',
        description:
          'Adds a quick-add first row: a leading accent "+" and a borderless input. Return submits the\ntrimmed text here and clears the input; an empty entry is ignored.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
