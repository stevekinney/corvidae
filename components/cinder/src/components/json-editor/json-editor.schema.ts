import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    disabled: {
      type: 'boolean',
      description: 'Disables the editor. A disabled field is not posted with its form.',
    },
    required: {
      type: 'boolean',
      description:
        'Marks the editor as required. An empty value is valid and reads "Not set" unless the field is required.',
    },
    rows: {
      type: 'number',
      description:
        'The most lines the editor shows before it scrolls. It grows with its content up to this height, so a short value is not a large empty box. Defaults to 8.',
      default: 8,
    },
    id: {
      type: 'string',
      description: 'Unique identifier used for the label and feedback relationships.',
    },
    value: {
      type: 'string',
      description: 'Controlled JSON source text.',
    },
    label: {
      type: 'string',
      description: 'Visible label for the editor.',
    },
    description: {
      type: 'string',
      description: 'Supporting text announced with the editor.',
    },
    error: {
      type: 'string',
      description: 'External validation error. Takes precedence over JSON parse feedback.',
    },
    validFeedbackVisible: {
      type: 'boolean',
      description:
        'Whether valid JSON should render an announced success message. Defaults to true.',
      default: true,
    },
    class: {
      type: 'string',
      description: 'Extra class names merged onto the field wrapper.',
    },
  },
  additionalProperties: false,
  required: ['id', 'label', 'value'],
  metadata: {
    unsupportedProps: [
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description: 'Called with the proposed JSON source whenever the user edits the field.',
      },
      {
        name: 'schema',
        reason: 'unknown-shape',
        description:
          'A JSON Schema that drives property-name and value completion. Without one the editor offers no completions.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
