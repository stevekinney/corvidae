import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-approval-group`.',
    },
    heading: {
      type: 'string',
      description:
        "The group's heading, which also names it, such as `2 approvals waiting`. Written at the top of\nthe one bordered surface the rows share.",
    },
    headingLevel: {
      enum: [2, 3, 4, 5, 6],
      description: "The heading's level, so the group slots into the page's outline. Default `3`.",
    },
  },
  additionalProperties: false,
  required: ['heading'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description:
          "The rows: ApprovalCards in the `row` layout, each in an element of its own. They lose their own\nborder and stand one inset separator apart on the group's surface.",
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema;
