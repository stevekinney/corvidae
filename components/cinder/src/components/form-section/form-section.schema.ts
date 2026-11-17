import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'Optional descriptive paragraph rendered under the heading/legend.',
    },
    meta: {
      type: 'string',
      description:
        'A short muted note beside the heading, on its baseline ("Read with every chat", "3 of 9").\nIt says what the section is for or how much is in it; a sentence of guidance is the\n`description`.',
    },
    columns: {
      enum: [1, 2, 3, 4],
      description: 'Column ceiling. Container queries pick the actual rendered count. Default 2.',
    },
    grouped: {
      type: 'boolean',
      description:
        'Draws the children as one bordered card, each child separated from the next by a divider, under\na larger heading and description. For a page of settings: the children are `SettingRow`s, and a\ngrouped section is always one column.',
    },
    class: {
      type: 'string',
      description: 'Additional class merged with `.cinder-form-section`.',
    },
    as: {
      enum: ['section', 'fieldset'],
      description: 'Wrapper element. Default.',
    },
    heading: {
      type: 'string',
      description: 'Heading text rendered as `<h{level}>`.',
    },
    headingLevel: {
      enum: [2, 3, 4, 5, 6],
      description: 'Heading level. Default 2.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        description:
          "Children (FormField instances or arbitrary content). Optional: a section with none draws its\nheading and description alone, for a list that is empty and says so in the page's own words.",
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
